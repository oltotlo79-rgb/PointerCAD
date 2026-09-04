/**
 * タイムラインのつまみ(ロールバック)の判断
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク19、FR-507、FR-506、NFR-PF-3)。
 *
 * 例の文書は計画書のタスク19・タスク9 と同じ:
 * 作業平面1 → 押し出し1 → 穴1 → R面取り1 → 押し出し2(帯は 5 件、通し 0〜4)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  createEmptyPartDocument,
  documentUpTo,
  type ExtrudeFeature,
  type FilletFeature,
  type HoleFeature,
  type PartDocument,
  type ReferenceFeature,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  buildTimelineStops,
  historyGrew,
  historySize,
  isTimelineAtEnd,
  resolveTimelineIndex,
  timelineIndexForClick,
  timelineRollback,
  timelineStopsById,
  timelineStopTooltipKey,
} from './timelineRail.js';

const ev = expressionValueFromNumber;

const WORK_PLANE: ReferenceFeature = {
  id: 'referencePlane-1',
  kind: 'referencePlane',
  name: '作業平面1',
  visible: true,
  plane: { kind: 'workPlane', planeId: 'xy', offset: ev(0) },
};

/** 面・辺の参照。帯の並びだけを見る検査なので、指紋の中身は形が合っていればよい。 */
function subShapeRef(bodyFeatureId: string, kind: 'face' | 'edge'): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint:
      kind === 'face'
        ? {
            kind: 'face',
            surfaceKind: 'plane',
            area: 1200,
            position: [20, 15, 10],
            axis: [0, 0, 1],
            radius: null,
          }
        : {
            kind: 'edge',
            curveKind: 'circle',
            length: 2 * Math.PI * 3,
            position: [10, 10, 10],
            axis: [0, 0, 1],
            radius: 3,
          },
  };
}

function extrude(id: string, name: string, faceFeatureId: string): ExtrudeFeature {
  return {
    id,
    name,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId },
    distance: ev(10),
    reversed: false,
    symmetric: false,
  };
}

const HOLE: HoleFeature = {
  id: 'hole-1',
  name: '穴1',
  suppressed: false,
  kind: 'hole',
  targetFeatureId: 'extrude-1',
  face: subShapeRef('extrude-1', 'face'),
  centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
  diameter: ev(6),
  depth: { kind: 'through' },
  tiltAngle: ev(0),
  tiltAzimuth: ev(0),
};

const FILLET: FilletFeature = {
  id: 'fillet-1',
  name: 'R面取り1',
  suppressed: false,
  kind: 'fillet',
  targetFeatureId: 'hole-1',
  targets: [subShapeRef('hole-1', 'edge')],
  radius: ev(1),
};

/** 作業平面1 → 押し出し1 → 穴1 → R面取り1 → 押し出し2 の 5 段。 */
function fixture(): PartDocument {
  return {
    ...createEmptyPartDocument(),
    references: [WORK_PLANE],
    solids: [
      extrude('extrude-1', '押し出し1', 'face-a'),
      HOLE,
      FILLET,
      extrude('extrude-2', '押し出し2', 'face-b'),
    ],
  };
}

function states(part: PartDocument, index: number | null): readonly string[] {
  return buildTimelineStops(part, index).map((stop) => stop.state);
}

describe('タイムラインのつまみ(FR-507、FR-506)', () => {
  it('帯の段の数は基準ジオメトリと立体の合計(スケッチは数えない)', () => {
    expect(historySize(fixture())).toBe(5);
    expect(historySize(createEmptyPartDocument())).toBe(0);
  });

  it('つまみの位置は null が末尾、範囲外は端へ丸める', () => {
    const part = fixture();
    expect(resolveTimelineIndex(part, null)).toBe(4);
    expect(resolveTimelineIndex(part, 2)).toBe(2);
    // 段を消したあとに範囲外の値が残っても、つまみが宙に浮かないようにする。
    expect(resolveTimelineIndex(part, 99)).toBe(4);
    expect(resolveTimelineIndex(part, -3)).toBe(0);
    // 履歴が空の文書には指せる段が 1 つも無い。
    expect(resolveTimelineIndex(createEmptyPartDocument(), null)).toBeNull();
  });

  it('末尾かどうかの判定が model の documentUpTo と食い違わない', () => {
    const part = fixture();
    for (const index of [null, 4, 5, 99]) {
      expect(isTimelineAtEnd(part, index)).toBe(true);
      // 末尾なら文書はそのまま(=== を保つ)ので、再計算も描画も今までと変わらない。
      expect(documentUpTo(part, index)).toBe(part);
    }
    for (const index of [0, 1, 2, 3]) {
      expect(isTimelineAtEnd(part, index)).toBe(false);
      expect(documentUpTo(part, index)).not.toBe(part);
    }
  });

  it('つまみより前は past、つまみは current、後ろは ahead', () => {
    const part = fixture();
    expect(states(part, 2)).toEqual(['past', 'past', 'current', 'ahead', 'ahead']);
    expect(states(part, 0)).toEqual(['current', 'ahead', 'ahead', 'ahead', 'ahead']);
    // 末尾(null)ならいちばん最後の段が current で、後ろは 1 つも無い。
    expect(states(part, null)).toEqual(['past', 'past', 'past', 'past', 'current']);
  });

  it('帯の段は references(順)→ solids(順)の通しで、名前と種類を持つ', () => {
    const stops = buildTimelineStops(fixture(), null);
    expect(stops.map((stop) => stop.entry.name)).toEqual([
      '作業平面1',
      '押し出し1',
      '穴1',
      'R面取り1',
      '押し出し2',
    ]);
    expect(stops.map((stop) => stop.entry.section)).toEqual([
      'reference',
      'solid',
      'solid',
      'solid',
      'solid',
    ]);
    expect(stops.map((stop) => stop.entry.kind)).toEqual([
      'referencePlane',
      'extrude',
      'hole',
      'fillet',
      'extrude',
    ]);
  });

  it('抑制された段も帯に出る(FR-503。抑制は削除ではない)', () => {
    const part = fixture();
    const suppressed: PartDocument = {
      ...part,
      solids: part.solids.map((solid) =>
        solid.id === 'hole-1' ? { ...solid, suppressed: true } : solid,
      ),
    };
    const stops = buildTimelineStops(suppressed, null);
    expect(stops).toHaveLength(5);
    expect(stops.map((stop) => stop.entry.suppressed)).toEqual([false, false, true, false, false]);
  });

  it('木の行(フィーチャーの id)から帯の段を引ける', () => {
    const byId = timelineStopsById(buildTimelineStops(fixture(), 2));
    expect(byId.size).toBe(5);
    expect(byId.get('hole-1')?.state).toBe('current');
    expect(byId.get('fillet-1')?.state).toBe('ahead');
    expect(byId.get('referencePlane-1')?.state).toBe('past');
    // 木にはスケッチの要素の行もあるが、帯には出ないので引けない。
    expect(byId.get('point-1')).toBeUndefined();
  });

  it('途中まで戻しているときだけ位置を返す(NFR-UX-7)', () => {
    const part = fixture();
    expect(timelineRollback(part, 2)).toEqual({ position: 3, total: 5 });
    expect(timelineRollback(part, 0)).toEqual({ position: 1, total: 5 });
    expect(timelineRollback(part, null)).toBeNull();
    expect(timelineRollback(part, 4)).toBeNull();
    expect(timelineRollback(createEmptyPartDocument(), null)).toBeNull();
  });

  it('つまみを押すと、その段へ置く。同じ段と最後の段は末尾へ戻す', () => {
    const part = fixture();
    expect(timelineIndexForClick(part, null, 1)).toBe(1);
    expect(timelineIndexForClick(part, 1, 3)).toBe(3);
    // もう一度同じ段を押したら戻す(2 回続けて押す = ダブルクリックでも末尾へ戻る)。
    expect(timelineIndexForClick(part, 3, 3)).toBeNull();
    // いちばん最後の段は「戻していない」と同じなので null に揃える(§0.a-0.19)。
    expect(timelineIndexForClick(part, 1, 4)).toBeNull();
  });

  it('つまみの説明はいまの位置で言い分ける(NFR-UX-7)', () => {
    expect(timelineStopTooltipKey('past', false)).toBe('timeline.stopTooltip');
    expect(timelineStopTooltipKey('ahead', false)).toBe('timeline.stopTooltip');
    expect(timelineStopTooltipKey('current', false)).toBe('timeline.stopCurrent');
    expect(timelineStopTooltipKey('current', true)).toBe('timeline.stopEnd');
  });

  it('履歴が伸びたかどうかを、基準ジオメトリと立体の両方で見る', () => {
    const part = fixture();
    expect(historyGrew(part, part)).toBe(false);
    expect(
      historyGrew(part, { ...part, solids: [...part.solids, extrude('extrude-3', '押し出し3', 'face-c')] }),
    ).toBe(true);
    expect(historyGrew(part, { ...part, references: [...part.references, WORK_PLANE] })).toBe(true);
    // 名前を変える・消すのように伸びない差し替えでは真にならない。
    expect(historyGrew(part, { ...part, solids: part.solids.slice(0, 2) })).toBe(false);
  });
});
