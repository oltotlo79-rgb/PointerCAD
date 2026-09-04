/**
 * タイムラインの「途中への差し込み」と「順序の入れ替え」(計画書
 * docs/plans/P4b-スケッチの仕上げ.md タスク20、FR-507、FR-504、NFR-UX-3、NFR-UX-5)。
 *
 * 検証表の文書は計画書と同じ「押し出し1 → 穴1 → R面取り1」。R面取り1 は穴1 を、
 * 穴1 は押し出し1 を使っているので、この 3 つの順序は入れ替えられない。
 * 押し出し2 は独立なのでどこへでも動く。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  buildTimeline,
  createEmptyPartDocument,
  type ExtrudeFeature,
  type FilletFeature,
  type HoleFeature,
  type PartDocument,
  type ReferenceFeature,
  type SolidFeature,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  beginTimelineDrag,
  dropMarkerFor,
  parseDropIndex,
  placeNewFeatures,
  timelineDropCheck,
  timelineMoveOffer,
  withDropTarget,
} from './timelineMove.js';

const ev = expressionValueFromNumber;

/** 立体の上面(穴の対象)。中身は依存の材料としてしか使わないので最小限にする。 */
function faceRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 穴の口の丸い辺(R 面取りの対象)。 */
function edgeRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'edge',
      curveKind: 'circle',
      length: 2 * Math.PI * 3,
      position: [10, 10, 10],
      axis: [0, 0, 1],
      radius: 3,
    },
  };
}

function extrude(id: string, name: string): ExtrudeFeature {
  return {
    id,
    name,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: ev(10),
    reversed: false,
    symmetric: false,
  };
}

function hole(id: string, name: string, targetFeatureId: string): HoleFeature {
  return {
    id,
    name,
    suppressed: false,
    kind: 'hole',
    targetFeatureId,
    face: faceRef(targetFeatureId),
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
    diameter: ev(6),
    depth: { kind: 'through' },
    tiltAngle: ev(0),
    tiltAzimuth: ev(0),
  };
}

function fillet(id: string, name: string, targetFeatureId: string): FilletFeature {
  return {
    id,
    name,
    suppressed: false,
    kind: 'fillet',
    targetFeatureId,
    targets: [edgeRef(targetFeatureId)],
    radius: ev(1),
  };
}

function workPlane(id: string, name: string): ReferenceFeature {
  return {
    id,
    kind: 'referencePlane',
    name,
    visible: true,
    plane: { kind: 'workPlane', planeId: 'xy', offset: ev(0) },
  };
}

/** 計画書 タスク20 の検証表の文書: 押し出し1 → 穴1 → R面取り1(帯 3 件、作業平面なし)。 */
function createPart(): PartDocument {
  return {
    ...createEmptyPartDocument(),
    solids: [
      extrude('extrude-1', '押し出し1'),
      hole('hole-1', '穴1', 'extrude-1'),
      fillet('fillet-1', 'R面取り1', 'hole-1'),
    ],
  };
}

/** 立体を末尾へ積む(`appendSolid` と同じ作り方。ここでは配列を直に組む)。 */
function withSolid(document: PartDocument, feature: SolidFeature): PartDocument {
  return { ...document, solids: [...document.solids, feature] };
}

function names(document: PartDocument): readonly string[] {
  return buildTimeline(document).map((entry) => entry.name);
}

describe('つまみの位置への差し込み(FR-507、タスク20)', () => {
  it('つまみを 押し出し1(通し 0)に置いたまま作ると、その次へ入りつまみが 1 つ進む', () => {
    const before = createPart();
    const appended = withSolid(before, extrude('extrude-2', '押し出し2'));

    const placed = placeNewFeatures(before, appended, 0);

    // 期待値の導出: insertPositionAt(document, 0, 'solid') は「通し 0 までを残す」ので
    // solids の添字 1。押し出し2 はそこへ入り、穴1・R面取り1 は後ろへずれる。
    expect(names(placed.document)).toEqual(['押し出し1', '押し出し2', '穴1', 'R面取り1']);
    // つまみは差し込んだ段(通し 1)へ進む。作ったものが見える位置になる。
    expect(placed.timelineIndex).toBe(1);
    expect(placed.inserted).toBe(true);
  });

  it('差し込んでも、前後のフィーチャーそのものは複製しない(形の作り直しを増やさない)', () => {
    const before = createPart();
    const appended = withSolid(before, extrude('extrude-2', '押し出し2'));

    const placed = placeNewFeatures(before, appended, 0);

    expect(placed.document.solids[0]).toBe(before.solids[0]);
    expect(placed.document.solids[2]).toBe(before.solids[1]);
    expect(placed.document.solids[3]).toBe(before.solids[2]);
    expect(placed.document.sketches).toBe(before.sketches);
  });

  it('つまみが末尾(null)なら、これまでどおり末尾へ積んだまま何も動かさない', () => {
    const before = createPart();
    const appended = withSolid(before, extrude('extrude-2', '押し出し2'));

    const placed = placeNewFeatures(before, appended, null);

    expect(placed.document).toBe(appended);
    expect(placed.timelineIndex).toBeNull();
    expect(placed.inserted).toBe(false);
  });

  it('つまみが実質いちばん下(最後の段)なら、並びは変えずつまみを末尾(null)へそろえる', () => {
    const before = createPart();
    const appended = withSolid(before, extrude('extrude-2', '押し出し2'));

    const placed = placeNewFeatures(before, appended, 2);

    expect(placed.document).toBe(appended);
    expect(placed.timelineIndex).toBeNull();
    expect(placed.inserted).toBe(false);
  });

  it('履歴が伸びない差し替え(名前を変える・消す)ではつまみを動かさない', () => {
    const before = createPart();
    const renamed: PartDocument = {
      ...before,
      solids: [{ ...before.solids[0], name: '土台' }, before.solids[1], before.solids[2]],
    };

    const placed = placeNewFeatures(before, renamed, 0);

    expect(placed.document).toBe(renamed);
    expect(placed.timelineIndex).toBe(0);
    expect(placed.inserted).toBe(false);
  });

  it('末尾へ積んだのではない差し替え(前半が入れ替わっている)には触らない', () => {
    const before = createPart();
    const shuffled: PartDocument = {
      ...before,
      solids: [before.solids[1], before.solids[0], before.solids[2], extrude('extrude-2', '押し出し2')],
    };

    const placed = placeNewFeatures(before, shuffled, 0);

    expect(placed.document).toBe(shuffled);
    expect(placed.timelineIndex).toBe(0);
    expect(placed.inserted).toBe(false);
  });

  it('基準ジオメトリも同じ規則で差し込む(帯は基準 → 立体の 1 本の通し、§0.a-0.20)', () => {
    const before: PartDocument = {
      ...createPart(),
      references: [workPlane('referencePlane-1', '作業平面1'), workPlane('referencePlane-2', '作業平面2')],
    };
    // 帯は 作業平面1(0)→ 作業平面2(1)→ 押し出し1(2)→ 穴1(3)→ R面取り1(4)。
    const appended: PartDocument = {
      ...before,
      references: [...before.references, workPlane('referencePlane-3', '作業平面3')],
    };

    const placed = placeNewFeatures(before, appended, 0);

    expect(names(placed.document)).toEqual([
      '作業平面1',
      '作業平面3',
      '作業平面2',
      '押し出し1',
      '穴1',
      'R面取り1',
    ]);
    expect(placed.timelineIndex).toBe(1);
  });

  it('つまみが基準の段にあるときに立体を作ると、立体の並びの先頭へ入る(配列を取り違えない)', () => {
    const before: PartDocument = {
      ...createPart(),
      references: [workPlane('referencePlane-1', '作業平面1'), workPlane('referencePlane-2', '作業平面2')],
    };
    const appended = withSolid(before, extrude('extrude-2', '押し出し2'));

    // つまみは 作業平面1(通し 0)。立体はまだ 1 つも「作られていない」ので、
    // 新しい立体は立体の並びのいちばん前(通し 2)へ入る。
    const placed = placeNewFeatures(before, appended, 0);

    expect(names(placed.document)).toEqual([
      '作業平面1',
      '作業平面2',
      '押し出し2',
      '押し出し1',
      '穴1',
      'R面取り1',
    ]);
    expect(placed.timelineIndex).toBe(2);
  });
});

describe('順序の入れ替えの予告と断り(FR-507、FR-504、NFR-UX-5)', () => {
  it('穴1 を R面取り1 の後ろへ動かすと断られ、壊れる側(R面取り1)を指す', () => {
    const refusal = timelineDropCheck(createPart(), 'hole-1', 2);

    expect(refusal).not.toBeNull();
    expect(refusal?.blockingFeatureId).toBe('fillet-1');
    expect(refusal?.message).toContain('R面取り1');
    expect(refusal?.message).toContain('穴1');
  });

  it('独立した立体どうしは入れ替えられる(断りは無い)', () => {
    const document = withSolid(createPart(), extrude('extrude-2', '押し出し2'));

    expect(timelineDropCheck(document, 'extrude-2', 0)).toBeNull();
  });

  it('ドラッグは掴んだ段から始まり、落とし先を移すたびに可否を引き直す', () => {
    const document = createPart();
    const started = beginTimelineDrag(document, 'hole-1');

    expect(started).not.toBeNull();
    expect(started?.fromIndex).toBe(1);
    expect(started?.moved).toBe(false);

    const onto = withDropTarget(document, started as NonNullable<typeof started>, 2);
    expect(onto.toIndex).toBe(2);
    expect(onto.moved).toBe(true);
    expect(onto.refusal?.blockingFeatureId).toBe('fillet-1');

    // 元の位置へ戻せば断りは消える(動かさないのは断りではない)。
    const back = withDropTarget(document, onto, 1);
    expect(back.refusal).toBeNull();
  });

  it('帯に無い行(スケッチの要素)は掴めない', () => {
    expect(beginTimelineDrag(createPart(), 'point-1')).toBeNull();
  });

  it('予告の線は、上へ動かすなら行の上・下へ動かすなら行の下に引く', () => {
    const document = withSolid(createPart(), extrude('extrude-2', '押し出し2'));
    const drag = beginTimelineDrag(document, 'extrude-2') as NonNullable<
      ReturnType<typeof beginTimelineDrag>
    >;

    const up = withDropTarget(document, drag, 0);
    expect(dropMarkerFor(up, 0)).toBe('above');
    expect(dropMarkerFor(up, 1)).toBeNull();

    const stay = withDropTarget(document, drag, 3);
    expect(dropMarkerFor(stay, 3)).toBeNull();
  });

  it('掴んだだけ(まだ動かしていない)ときは予告の線を描かない', () => {
    const document = createPart();
    const drag = beginTimelineDrag(document, 'fillet-1');

    expect(dropMarkerFor(drag, 2)).toBeNull();
    expect(dropMarkerFor(null, 0)).toBeNull();
  });

  it('行に付けた通し番号は、履歴の中の数だけを受け取る', () => {
    expect(parseDropIndex('2', 3)).toBe(2);
    expect(parseDropIndex('0', 3)).toBe(0);
    expect(parseDropIndex('3', 3)).toBeNull();
    expect(parseDropIndex('-1', 3)).toBeNull();
    expect(parseDropIndex('1.5', 3)).toBeNull();
    expect(parseDropIndex('', 3)).toBeNull();
    expect(parseDropIndex(null, 3)).toBeNull();
    expect(parseDropIndex(undefined, 3)).toBeNull();
  });
});

describe('「⋮」の 1 つ上へ・1 つ下へ(FR-507、NFR-UX-3)', () => {
  it('独立した立体は上へも下へも動かせる', () => {
    const document = withSolid(createPart(), extrude('extrude-2', '押し出し2'));

    expect(timelineMoveOffer(document, 'extrude-2', -1)).toEqual({ kind: 'ready', toIndex: 2 });
  });

  it('いちばん上・いちばん下では、その向きへは動かせない', () => {
    const document = createPart();

    expect(timelineMoveOffer(document, 'extrude-1', -1)).toEqual({ kind: 'edge' });
    expect(timelineMoveOffer(document, 'fillet-1', 1)).toEqual({ kind: 'edge' });
  });

  it('依存を壊す向きは理由つきで断る(押してから失敗させない)', () => {
    const offer = timelineMoveOffer(createPart(), 'hole-1', 1);

    expect(offer.kind).toBe('refused');
    if (offer.kind === 'refused') {
      expect(offer.refusal.blockingFeatureId).toBe('fillet-1');
      expect(offer.refusal.message).toContain('R面取り1');
    }
  });

  it('抑制された段も通し番号どおりに数える(FR-503。抑制は削除ではない)', () => {
    const base = createPart();
    const document: PartDocument = {
      ...base,
      solids: [
        base.solids[0],
        { ...base.solids[1], suppressed: true },
        base.solids[2],
        extrude('extrude-2', '押し出し2'),
      ],
    };

    // 抑制された 穴1 も帯の 1 段として数えるので、押し出し2(通し 3)の 1 つ上は通し 2。
    expect(timelineMoveOffer(document, 'extrude-2', -1)).toEqual({ kind: 'ready', toIndex: 2 });
  });

  it('帯に無い行には項目を出さない(端として扱う)', () => {
    expect(timelineMoveOffer(createPart(), 'point-1', -1)).toEqual({ kind: 'edge' });
  });
});
