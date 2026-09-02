/**
 * 画面の状態(計画書 docs/plans/P1-式とスケッチ.md タスク17 手順5)。
 *
 * 状態は Zustand のストア1本へ寄せる(rules/04-設計の規律.md)。ここでは
 * 初期値・履歴の差し替え・再計算の予約・作図面・スナップ・選択・ホバーを検査する。
 * 再計算そのものは幾何カーネル(Worker)を伴うので、偽の再計算を注入して待ち合わせる。
 */

import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  createPointFeature,
  resolveSketch,
  type SketchDocument,
  type SketchRecomputeResult,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createNumericInput } from '../sketch/numericInput.js';
import { HOME_ORBIT, type OrbitState } from '../viewport/cameraMath.js';
import {
  attachSketchRecompute,
  createInitialSketchState,
  useAppStore,
  workPlaneForOrbit,
  type SketchRecomputer,
} from './useAppStore.js';

interface PendingRecompute {
  readonly document: SketchDocument;
  readonly settle: (result: SketchRecomputeResult) => void;
}

/** 呼ばれた文書を覚え、こちらの好きな時点で結果を返す偽の再計算。 */
function createFakeRecompute(): {
  readonly calls: PendingRecompute[];
  readonly recompute: SketchRecomputer;
} {
  const calls: PendingRecompute[] = [];
  const recompute: SketchRecomputer = (document) =>
    new Promise<SketchRecomputeResult>((resolve) => {
      calls.push({ document, settle: resolve });
    });
  return { calls, recompute };
}

function resultFor(document: SketchDocument): SketchRecomputeResult {
  return { resolved: resolveSketch(document), mesh: null, errors: [] };
}

/** 予約 → 実行 → 反映は Promise を跨ぐので、待ち行列を空にしてから確かめる。 */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function documentWithPoint(): SketchDocument {
  const empty = createEmptySketchDocument();
  return appendFeature(empty, createPointFeature(empty, absoluteCoordinate(1, 2, 3)));
}

function orbitFrom(azimuthDegrees: number, elevationDegrees: number): OrbitState {
  return {
    azimuth: (azimuthDegrees * Math.PI) / 180,
    elevation: (elevationDegrees * Math.PI) / 180,
    distance: 200,
    target: [0, 0, 0],
  };
}

beforeEach(() => {
  useAppStore.setState({
    ...createInitialSketchState(),
    documentName: '',
    featureNames: [],
    mesh: null,
    isComputing: false,
    errorMessage: null,
  });
});

describe('画面の状態(rules/04: ストア1本)', () => {
  it('起動時は空のスケッチで、道具は選択、かく面は XY(§0.a-0.2、§0.a-0.3)', () => {
    const state = useAppStore.getState();
    expect(state.sketch.features).toEqual([]);
    expect(state.resolvedSketch.points).toEqual([]);
    expect(state.sketchMesh).toBeNull();
    expect(state.sketchErrors).toEqual([]);
    expect(state.activeTool).toBe('select');
    expect(state.workPlaneId).toBe('xy');
    expect(state.selection).toEqual([]);
    expect(state.hoveredElementId).toBeNull();
    expect(state.numericInput).toBeNull();
    expect(state.numericInputAnchor).toBeNull();
  });

  it('スナップは既定で入、種別は 5 つとも有効(§0.a-0.10)', () => {
    const state = useAppStore.getState();
    expect(state.snapEnabled).toBe(true);
    expect([...state.snapKinds].sort()).toEqual(
      ['center', 'endpoint', 'grid', 'intersection', 'midpoint'],
    );
    expect(state.chaining).toBe(true);
  });

  it('履歴を差し替えると計算中になる', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(useAppStore.getState().sketch.features).toHaveLength(1);
  });

  it('再計算の結果を反映すると計算中が下りて名前が並ぶ(FR-501、FR-504)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    useAppStore.getState().applySketch(sketch, resultFor(sketch));

    const state = useAppStore.getState();
    expect(state.isComputing).toBe(false);
    expect(state.documentName).toBe('スケッチ1');
    expect(state.featureNames).toEqual(['点1']);
    expect(state.resolvedSketch.points).toHaveLength(1);
    expect(state.sketchErrors).toEqual([]);
  });

  it('選択は足し引きできる(FR-106)', () => {
    useAppStore.getState().toggleSelection('p1');
    useAppStore.getState().toggleSelection('p2');
    expect(useAppStore.getState().selection).toEqual(['p1', 'p2']);
    useAppStore.getState().toggleSelection('p1');
    expect(useAppStore.getState().selection).toEqual(['p2']);
    useAppStore.getState().setSelection([]);
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('ホバーを出し入れできる(FR-106)', () => {
    useAppStore.getState().setHovered('line-1');
    expect(useAppStore.getState().hoveredElementId).toBe('line-1');
    useAppStore.getState().setHovered(null);
    expect(useAppStore.getState().hoveredElementId).toBeNull();
  });

  it('スナップの入り切りと種別を切り替えられる(FR-107)', () => {
    useAppStore.getState().setSnapEnabled(false);
    expect(useAppStore.getState().snapEnabled).toBe(false);
    useAppStore.getState().setSnapEnabled(true);

    expect(useAppStore.getState().snapKinds).toContain('grid');
    useAppStore.getState().toggleSnapKind('grid');
    expect(useAppStore.getState().snapKinds).not.toContain('grid');
    expect(useAppStore.getState().snapKinds).toContain('endpoint');
    useAppStore.getState().toggleSnapKind('grid');
    expect(useAppStore.getState().snapKinds).toContain('grid');
  });

  it('道具を変えるとポップアップを閉じる(取りかけの操作を持ち越さない)', () => {
    useAppStore.getState().openNumericInput(createNumericInput('point', 'point'), [10, 20]);
    expect(useAppStore.getState().numericInput).not.toBeNull();
    expect(useAppStore.getState().numericInputAnchor).toEqual([10, 20]);

    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().activeTool).toBe('line');
    expect(useAppStore.getState().numericInput).toBeNull();
    expect(useAppStore.getState().numericInputAnchor).toBeNull();
  });

  it('ポップアップの中身だけを書き換えられる(1 文字ごとの再評価に使う)', () => {
    const opened = createNumericInput('point', 'point');
    useAppStore.getState().openNumericInput(opened, [10, 20]);
    useAppStore.getState().updateNumericInput({ ...opened, focusedIndex: 2 });
    expect(useAppStore.getState().numericInput?.focusedIndex).toBe(2);
    expect(useAppStore.getState().numericInputAnchor).toEqual([10, 20]);

    useAppStore.getState().closeNumericInput();
    expect(useAppStore.getState().numericInput).toBeNull();
    expect(useAppStore.getState().numericInputAnchor).toBeNull();
  });

  it('連続してかくかどうかを切り替えられる(FR-307)', () => {
    useAppStore.getState().setChaining(false);
    expect(useAppStore.getState().chaining).toBe(false);
  });
});

describe('かく面(§0.a-0.3)', () => {
  it('作図面を明示的に切り替えられる', () => {
    useAppStore.getState().setWorkPlane('yz');
    expect(useAppStore.getState().workPlaneId).toBe('yz');
    useAppStore.getState().setWorkPlane('xy');
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('真上から見ていれば XY(法線 (0,0,1) が視線と平行)', () => {
    expect(workPlaneForOrbit(orbitFrom(0, 90))).toBe('xy');
    expect(workPlaneForOrbit(orbitFrom(123, -90))).toBe('xy');
  });

  it('+X 側から見ていれば YZ(法線 (1,0,0) が視線と平行)', () => {
    expect(workPlaneForOrbit(orbitFrom(0, 0))).toBe('yz');
    expect(workPlaneForOrbit(orbitFrom(180, 0))).toBe('yz');
  });

  it('+Y 側から見ていれば XZ(法線 (0,-1,0) が視線と平行)', () => {
    expect(workPlaneForOrbit(orbitFrom(90, 0))).toBe('xz');
    expect(workPlaneForOrbit(orbitFrom(-90, 0))).toBe('xz');
  });

  it('等角のホーム視点は 3 面に等しく傾くので既定の XY にする(FR-108)', () => {
    expect(workPlaneForOrbit(HOME_ORBIT)).toBe('xy');
  });

  it('「視点に合わせる」で今の視点に最も近い面へ移る', () => {
    useAppStore.getState().matchWorkPlaneToView(orbitFrom(90, 10));
    expect(useAppStore.getState().workPlaneId).toBe('xz');
    useAppStore.getState().matchWorkPlaneToView(orbitFrom(0, 80));
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });
});

describe('履歴の変化に応じた再計算の予約(要件§6.3)', () => {
  it('つないだ直後に今の履歴を1回計算し、結果を反映する', async () => {
    const fake = createFakeRecompute();
    const detach = attachSketchRecompute(fake.recompute);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].document.features).toEqual([]);

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().documentName).toBe('スケッチ1');
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('履歴が変わるたびに計算し、結果をストアへ入れる', async () => {
    const fake = createFakeRecompute();
    const detach = attachSketchRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].document).toBe(sketch);

    fake.calls[1].settle(resultFor(sketch));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toEqual(['点1']);
    expect(useAppStore.getState().resolvedSketch.points).toHaveLength(1);
    detach();
  });

  it('計算中に続けて変えても重ねず、最後の履歴だけを次に回す(連続入力)', async () => {
    const fake = createFakeRecompute();
    const detach = attachSketchRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const first = documentWithPoint();
    const second = appendFeature(first, createPointFeature(first, absoluteCoordinate(4, 5, 6)));
    const third = appendFeature(second, createPointFeature(second, absoluteCoordinate(7, 8, 9)));

    useAppStore.getState().setSketch(first);
    useAppStore.getState().setSketch(second);
    useAppStore.getState().setSketch(third);
    // 1 本目が終わるまでは次を始めない。
    expect(fake.calls).toHaveLength(2);

    fake.calls[1].settle(resultFor(first));
    await tick();

    // 間に挟まった second は捨て、最新の third だけを計算する。
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(third);
    // 途中の結果では計算中の札を下ろさない。
    expect(useAppStore.getState().isComputing).toBe(true);

    fake.calls[2].settle(resultFor(third));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toHaveLength(3);
    detach();
  });

  it('外した後は履歴が変わっても計算しない', async () => {
    const fake = createFakeRecompute();
    const detach = attachSketchRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    detach();

    useAppStore.getState().setSketch(documentWithPoint());
    await tick();
    expect(fake.calls).toHaveLength(1);
  });
});
