/**
 * 画面の状態(計画書 docs/plans/P1-式とスケッチ.md タスク17 手順5、
 * docs/plans/P2-ソリッド基礎.md タスク17 手順6)。
 *
 * 状態は Zustand のストア1本へ寄せる(rules/04-設計の規律.md)。P2 からは
 * **部品文書 `document` が唯一の正本**で、`sketch` / `resolvedSketch` / `sketchMesh` /
 * `sketchErrors` はそこから作り直す派生の控え(§0.a-0.4)。ここでは初期値・文書の差し替え・
 * 控えの同期・Undo / Redo・再計算の予約・進捗と中止・作図面・スナップ・選択・ホバーを検査する。
 * 再計算そのものは幾何カーネル(Worker)を伴うので、偽の再計算を注入して待ち合わせる。
 */

import {
  absoluteCoordinate,
  appearanceFromPreset,
  appearanceOf,
  appendFeature,
  appendSolid,
  assignBodyAppearance,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  findSketch,
  FREE_WORK_PLANE_ID,
  removeSolid,
  replaceSketch,
  sketchConstraints,
  resolveSketch,
  WORK_PLANES,
  type AppearanceMatchEntry,
  type ExtrudeFeature,
  type HoleFeature,
  type PartDocument,
  type PartRecomputeOptions,
  type PartRecomputeResult,
  type SketchDocument,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SketchPointFeature,
  type SketchRecomputeResult,
  type SolidBody,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { AutoSaver } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DISPLAY_SETTINGS } from '../settings/settings.js';
import { setFeatureField } from '../sketch/featureSummary.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { commitConstraintFromSelection } from '../sketch/constraintCommands.js';
import { EMPTY_SHAPE_DRAFT } from '../sketch/shapeCommands.js';
import { HOME_ORBIT, type OrbitState } from '../viewport/cameraMath.js';
import type { PartMeasurer } from '../solid/measureCommands.js';
import type { MeasurementState } from '../viewport/createMeasureLayer.js';
import {
  attachPartMeasure,
  attachPartRecompute,
  createInitialDocumentState,
  useAppStore,
  workPlaneForOrbit,
  workPlaneOfSketch,
  type PartRecomputer,
} from './useAppStore.js';

interface PendingRecompute {
  readonly document: PartDocument;
  readonly options: PartRecomputeOptions;
  readonly settle: (result: PartRecomputeResult) => void;
}

/** 呼ばれた文書を覚え、こちらの好きな時点で結果を返す偽の再計算。 */
function createFakeRecompute(): {
  readonly calls: PendingRecompute[];
  readonly recompute: PartRecomputer;
} {
  const calls: PendingRecompute[] = [];
  const recompute: PartRecomputer = (document, options) =>
    new Promise<PartRecomputeResult>((resolve) => {
      calls.push({ document, options, settle: resolve });
    });
  return { calls, recompute };
}

/** スケッチだけを解決した、失敗もボディも無い結果。 */
function resultFor(document: PartDocument): PartRecomputeResult {
  return {
    sketches: document.sketches.map((sketch) => ({
      sketchId: sketch.id,
      resolved: resolveSketch(sketch),
      mesh: null,
      // 拘束の診断(model の P4b タスク8)。この検査の文書は拘束を持たない。
      diagnosis: null,
    })),
    bodies: [],
    errors: [],
    cacheHits: 0,
    cancelled: false,
    generation: 0,
  };
}

/** P1 の applySketch(スケッチ 1 本ぶんの結果)を作る。 */
function sketchResultFor(sketch: SketchDocument): SketchRecomputeResult {
  return { resolved: resolveSketch(sketch), mesh: null, errors: [], diagnosis: null };
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

/** いま編集しているスケッチを差し替えた部品文書。 */
function partWithPoint(): PartDocument {
  return replaceSketch(createEmptyPartDocument(), documentWithPoint());
}

/** 押し出し 1 段だけの部品文書。ボディの id はフィーチャーの id と同じ(§0.a-0.5)。 */
function extrudeFeature(id: string): ExtrudeFeature {
  return {
    id,
    kind: 'extrude',
    name: `押し出し${id}`,
    suppressed: false,
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: expressionValueFromNumber(10),
    reversed: false,
    symmetric: false,
  };
}

/**
 * 穴 1 つ(P4b タスク20 の並べ替えの検査用)。対象の立体を指すので、対象より前へは
 * 動かせない(`timelineOrder.ts` の依存)。中身は依存の材料としてしか使わない。
 */
function holeFeature(id: string, targetFeatureId: string): HoleFeature {
  return {
    id,
    kind: 'hole',
    name: `穴${id}`,
    suppressed: false,
    targetFeatureId,
    face: {
      bodyFeatureId: targetFeatureId,
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    },
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
    diameter: expressionValueFromNumber(6),
    depth: { kind: 'through' },
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
}

/** 表示用のボディ 1 つ。中身は使わないので最小限の並びにする。 */
function bodyFor(featureId: string): SolidBody {
  return {
    featureId,
    mesh: {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array(6),
      triangleCount: 1,
    },
    volume: 6000,
    isValid: true,
    // P3 タスク17 で SolidBody に必須で足された欄。この検査では中身を使わない。
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/**
 * 点・線・面(境界に使える/使えない)と立体が 1 つずつ入った部品文書(§0.a-0.23 ⑨)。
 * `setActiveTool('face')` の選択掃除を検査するのに使う。
 */
function partWithMixedFeatures(): PartDocument {
  const point: SketchPointFeature = {
    id: 'point-1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(1, 2, 3),
  };
  const line: SketchLineFeature = {
    id: 'line-1',
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(10, 0, 0),
    construction: false,
  };
  const face: SketchFaceFeature = {
    id: 'face-1',
    name: '面1',
    planeId: 'xy',
    kind: 'face',
    boundary: [{ featureId: 'point-1' }],
    color: '#7aa2f7',
  };
  let sketch = createEmptySketchDocument();
  for (const feature of [point, line, face]) {
    sketch = appendFeature(sketch, feature);
  }
  return appendSolid(replaceSketch(createEmptyPartDocument(), sketch), extrudeFeature('extrude-1'));
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
    ...createInitialDocumentState(),
    matchWorkPlaneRequestCount: 0,
    focusViewportRequestCount: 0,
    viewportSize: [0, 0],
    // createInitialDocumentState の外にある(文書を作り直しても戻らない)ので、
    // ここで明示的に初期化しないと前の検査の値が漏れる(§0.a-0.23 ⑨)。
    kernelLoaded: false,
    // displaySettings も同じ理由(タスク1)。他の検査が setDisplaySettings を呼んでも
    // 次の検査へ持ち越さない。
    displaySettings: DEFAULT_DISPLAY_SETTINGS,
  });
});

describe('画面の状態(rules/04: ストア1本)', () => {
  it('起動時は空のスケッチで、道具は選択、作図面は XY(§0.a-0.2、§0.a-0.3)', () => {
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
    expect(state.pendingStart).toBeNull();
    expect(state.snapIndicator).toBeNull();
  });

  it('スナップは既定で入、種別は 9 つとも有効(§0.a-0.10、§0.12)', () => {
    const state = useAppStore.getState();
    expect(state.snapEnabled).toBe(true);
    // P4b タスク16(FR-110)で向きの吸着の 4 種が同じ一覧へ加わった(§0.13)。
    expect([...state.snapKinds].sort()).toEqual([
      'center',
      'endpoint',
      'extension',
      'grid',
      'intersection',
      'midpoint',
      'parallel',
      'perpendicular',
      'polar',
    ]);
    expect(state.chaining).toBe(true);
  });

  it('向きの吸着の案内線を出す・消せる(FR-110、タスク16)', () => {
    expect(useAppStore.getState().trackIndicator).toBeNull();
    const lines = [
      {
        kind: 'polar',
        origin: [0, 0, 0],
        direction: [1, 0, 0],
        sourceFeatureId: null,
        angleDegrees: 0,
      },
    ] as const;
    useAppStore.getState().setTrackIndicator(lines);
    expect(useAppStore.getState().trackIndicator).toEqual(lines);

    // 道具を変えたら案内線は持ち越さない(向きを合わせる相手が変わるため)。
    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().trackIndicator).toBeNull();
  });

  it('履歴を差し替えると計算中になる', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(useAppStore.getState().sketch.features).toHaveLength(1);
  });

  it('再計算の結果を反映すると計算中が下りて名前が並ぶ(FR-501、FR-504)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));

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

  it('道具を変えるとポップアップを閉じ、取りかけの始点と吸着の印も落とす', () => {
    useAppStore.getState().openNumericInput(createNumericInput('point', 'point'), [10, 20]);
    useAppStore.getState().setPendingStart(absoluteCoordinate(1, 2, 3));
    useAppStore
      .getState()
      .setSnapIndicator({ screen: [30, 40], kind: 'endpoint', elementId: 'point-1' });
    expect(useAppStore.getState().numericInput).not.toBeNull();
    expect(useAppStore.getState().numericInputAnchor).toEqual([10, 20]);

    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().activeTool).toBe('line');
    expect(useAppStore.getState().numericInput).toBeNull();
    expect(useAppStore.getState().numericInputAnchor).toBeNull();
    expect(useAppStore.getState().pendingStart).toBeNull();
    expect(useAppStore.getState().snapIndicator).toBeNull();
  });

  it('立体の道具も選べる(P2 タスク21。押し出し・回転・縫合)', () => {
    useAppStore.getState().setActiveTool('extrude');
    expect(useAppStore.getState().activeTool).toBe('extrude');
    useAppStore.getState().setActiveTool('revolve');
    expect(useAppStore.getState().activeTool).toBe('revolve');
    useAppStore.getState().setActiveTool('sew');
    expect(useAppStore.getState().activeTool).toBe('sew');
    useAppStore.getState().setActiveTool('select');
    expect(useAppStore.getState().activeTool).toBe('select');
  });

  it('幾何カーネルを読み込み終えたかどうかを持つ(§0.a-0.23 ⑨)', () => {
    expect(useAppStore.getState().kernelLoaded).toBe(false);
    useAppStore.getState().markKernelLoaded();
    expect(useAppStore.getState().kernelLoaded).toBe(true);
  });

  it('面の道具を選ぶと、境界に使えない要素(面フィーチャー・立体)を選択から外す(§0.a-0.23 ⑨)', () => {
    useAppStore.getState().applyDocument(partWithMixedFeatures(), { undoable: false });
    useAppStore.getState().setSelection(['point-1', 'line-1', 'face-1', 'extrude-1']);

    useAppStore.getState().setActiveTool('face');
    expect(useAppStore.getState().selection).toEqual(['point-1', 'line-1']);
  });

  it('面以外の道具に切り替えても選択は掃除しない(既存の振る舞いのまま)', () => {
    useAppStore.getState().applyDocument(partWithMixedFeatures(), { undoable: false });
    useAppStore.getState().setSelection(['face-1', 'extrude-1']);

    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().selection).toEqual(['face-1', 'extrude-1']);
  });

  it('立体を作れなかった理由を出し入れでき、選び直すと消える(NFR-UX-5)', () => {
    expect(useAppStore.getState().solidErrorKey).toBeNull();
    useAppStore.getState().setSolidError('solidError.needTwoBodies');
    expect(useAppStore.getState().solidErrorKey).toBe('solidError.needTwoBodies');

    // 選び直しは「やり直す気になった」合図なので、断った理由は消す。
    useAppStore.getState().setSelection(['extrude-1']);
    expect(useAppStore.getState().solidErrorKey).toBeNull();

    useAppStore.getState().setSolidError('solidError.noFace');
    useAppStore.getState().toggleSelection('extrude-2');
    expect(useAppStore.getState().solidErrorKey).toBeNull();

    // 道具を変えたときも持ち越さない。
    useAppStore.getState().setSolidError('solidError.noFace');
    useAppStore.getState().setActiveTool('select');
    expect(useAppStore.getState().solidErrorKey).toBeNull();
  });

  it('ビューポートで選んだ場所を覚える(立体のその場入力を出す位置)', () => {
    expect(useAppStore.getState().pickAnchor).toBeNull();
    useAppStore.getState().setPickAnchor([120, 80]);
    expect(useAppStore.getState().pickAnchor).toEqual([120, 80]);
    useAppStore.getState().setPickAnchor(null);
    expect(useAppStore.getState().pickAnchor).toBeNull();
  });

  it('取りかけの始点を出し入れできる(線分の始点・円弧の中心・点列の基準)', () => {
    const start = absoluteCoordinate(1, 2, 3);
    useAppStore.getState().setPendingStart(start);
    expect(useAppStore.getState().pendingStart).toBe(start);
    useAppStore.getState().setPendingStart(null);
    expect(useAppStore.getState().pendingStart).toBeNull();
  });

  it('新しい図形の取りかけを出し入れでき、道具を変えると空へ戻る(P4 タスク12)', () => {
    const draft = {
      ...EMPTY_SHAPE_DRAFT,
      points: [absoluteCoordinate(1, 2, 3)],
    };
    useAppStore.getState().setShapeDraft(draft);
    expect(useAppStore.getState().shapeDraft.points).toHaveLength(1);

    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().shapeDraft).toEqual(EMPTY_SHAPE_DRAFT);

    // ポップアップを閉じたときも取りかけを持ち越さない(NFR-UX-3)。
    useAppStore.getState().setShapeDraft(draft);
    useAppStore.getState().closeNumericInput();
    expect(useAppStore.getState().shapeDraft).toEqual(EMPTY_SHAPE_DRAFT);
  });

  it('図形を作れなかった理由を出し入れできる(NFR-UX-5)', () => {
    useAppStore.getState().setShapeError('スプラインには点が 2 個以上必要です。');
    expect(useAppStore.getState().shapeErrorMessage).toBe(
      'スプラインには点が 2 個以上必要です。',
    );
    useAppStore.getState().setShapeError(null);
    expect(useAppStore.getState().shapeErrorMessage).toBeNull();
  });

  it('吸着の印を出し入れできる(FR-107)', () => {
    const indicator = { screen: [12, 34], kind: 'grid', elementId: null } as const;
    useAppStore.getState().setSnapIndicator(indicator);
    expect(useAppStore.getState().snapIndicator).toEqual(indicator);
    useAppStore.getState().setSnapIndicator(null);
    expect(useAppStore.getState().snapIndicator).toBeNull();
  });

  it('ビューポートの大きさを持つ(ポップアップの折り返しに使う)', () => {
    useAppStore.getState().setViewportSize([800, 600]);
    expect(useAppStore.getState().viewportSize).toEqual([800, 600]);
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

describe('履歴の差し替えと取り除き(FR-311、FR-504)', () => {
  it('式を直すと履歴が入れ替わる(打つたびの点滅を避けるため計算中の印は立てない)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));

    const target = sketch.features[0];
    useAppStore
      .getState()
      .replaceSketchFeature(
        target.id,
        setFeatureField(target, 'at.x', expressionValueFromNumber(7)),
      );

    const state = useAppStore.getState();
    expect(state.isComputing).toBe(false);
    expect(state.sketch.features).toHaveLength(1);
    const changed = state.sketch.features[0];
    if (changed.kind !== 'point' || changed.at.mode !== 'absolute') {
      throw new Error('絶対座標の点が残るはず');
    }
    expect(changed.at.x.value).toBe(7);
    expect(changed.at.y.value).toBe(2);
  });

  it('取り除くと選択とホバーからも外れる(点列の 1 点を指していても外れる)', () => {
    const sketch = documentWithPoint();
    const id = sketch.features[0].id;
    useAppStore.getState().setSketch(sketch);
    useAppStore.getState().setSelection([`${id}#0`]);
    useAppStore.getState().setHovered(`${id}#0`);

    useAppStore.getState().removeSketchFeature(id);

    const state = useAppStore.getState();
    expect(state.sketch.features).toEqual([]);
    expect(state.selection).toEqual([]);
    expect(state.hoveredElementId).toBeNull();
    expect(state.isComputing).toBe(true);
  });

  it('面を張れなかった理由を持ち、選び直すと消える(NFR-UX-5)', () => {
    useAppStore.getState().setFaceError('face.error.tooFewPoints');
    expect(useAppStore.getState().faceErrorKey).toBe('face.error.tooFewPoints');

    useAppStore.getState().setSelection(['point-1']);
    expect(useAppStore.getState().faceErrorKey).toBeNull();

    useAppStore.getState().setFaceError('face.error.mixedBoundary');
    useAppStore.getState().toggleSelection('line-1');
    expect(useAppStore.getState().faceErrorKey).toBeNull();
  });

  it('ビューポートへ焦点を戻す要求を数える(道具を選んだ直後の Enter に使う)', () => {
    expect(useAppStore.getState().focusViewportRequestCount).toBe(0);
    useAppStore.getState().requestViewportFocus();
    useAppStore.getState().requestViewportFocus();
    expect(useAppStore.getState().focusViewportRequestCount).toBe(2);
  });
});

describe('部品文書が唯一の正本(§0.a-0.4)', () => {
  it('起動時は空のスケッチ 1 本とソリッド 0 段、控えは文書の中身そのもの', () => {
    const state = useAppStore.getState();
    expect(state.document.sketches).toHaveLength(1);
    expect(state.document.solids).toEqual([]);
    expect(state.bodies).toEqual([]);
    expect(state.partErrors).toEqual([]);
    expect(state.cacheHits).toBe(0);
    expect(state.recomputeProgress).toBeNull();
    // 控えは複製ではなく、文書の中の同じものを指す。
    expect(state.sketch).toBe(findSketch(state.document, state.document.activeSketchId));
    expect(state.undoStack.present).toBe(state.document);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it('applyDocument で控えが同期され、Undo に 1 段積まれる', () => {
    const next = partWithPoint();
    useAppStore.getState().applyDocument(next);

    const state = useAppStore.getState();
    expect(state.document).toBe(next);
    expect(state.sketch).toBe(next.sketches[0]);
    expect(state.documentName).toBe('スケッチ1');
    expect(state.featureNames).toEqual(['点1']);
    expect(state.isComputing).toBe(true);
    expect(state.undoStack.past).toHaveLength(1);
    expect(state.undoStack.present).toBe(next);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('applySketch を通しても同じ控えが同期される(呼び出し側は P1 のまま)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));

    const state = useAppStore.getState();
    expect(state.sketch).toBe(sketch);
    expect(state.document.sketches[0]).toBe(sketch);
    expect(state.sketch).toBe(findSketch(state.document, state.document.activeSketchId));
    expect(state.resolvedSketch.points).toHaveLength(1);
    // 計算結果の反映は利用者の操作ではないので Undo の段を作らない。
    expect(state.undoStack.past).toEqual([]);
    expect(state.undoStack.present).toBe(state.document);
  });

  it('setSketch は文書のスケッチを差し替える(正本は document のまま)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);

    const state = useAppStore.getState();
    expect(state.document.sketches).toHaveLength(1);
    expect(state.document.sketches[0]).toBe(sketch);
    expect(state.sketch).toBe(sketch);
  });

  it('同じ文書を入れ直しても何も変えない(Undo に空の段を作らない)', () => {
    const before = useAppStore.getState().document;
    useAppStore.getState().applyDocument(before);
    expect(useAppStore.getState().undoStack.past).toEqual([]);
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('文書から消えたフィーチャーは選択とホバーから外れる(ソリッドも同じ)', () => {
    const withSolid = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(withSolid);
    useAppStore.getState().setSelection(['point-1#0', 'extrude-1']);
    useAppStore.getState().setHovered('extrude-1');

    // ソリッドだけを消した文書へ差し替える。
    useAppStore.getState().applyDocument(partWithPoint());

    const state = useAppStore.getState();
    expect(state.selection).toEqual(['point-1#0']);
    expect(state.hoveredElementId).toBeNull();
  });

  it('編集中のスケッチを切り替えると控えも移る(Undo の段は作らない)', () => {
    const state = useAppStore.getState();
    // 起動直後の 1 本しか無いので、同じ id を指し直しても文書は変わらない。
    state.setActiveSketch(state.document.activeSketchId);
    expect(useAppStore.getState().document).toBe(state.document);
    expect(useAppStore.getState().undoStack.past).toEqual([]);

    state.setActiveSketch('sketch-99');
    expect(useAppStore.getState().document).toBe(state.document);
  });

  it('文書の複製をストアの他の欄へ置かない(正本は document の 1 つだけ)', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    const state = useAppStore.getState();

    const holders = Object.entries(state).filter(([key, value]) => {
      if (key === 'document' || key === 'undoStack') {
        // undoStack は履歴そのもの(過去の版)なので複製ではない。
        return false;
      }
      return (
        typeof value === 'object' &&
        value !== null &&
        'sketches' in value &&
        'solids' in value &&
        'activeSketchId' in value
      );
    });
    expect(holders.map(([key]) => key)).toEqual([]);
  });
});

describe('Undo / Redo(FR-505、§0.a-0.13)', () => {
  it('元に戻すと文書も控えも前の版へ戻り、やり直すと元へ進む', () => {
    const first = useAppStore.getState().document;
    const second = partWithPoint();
    useAppStore.getState().applyDocument(second);

    useAppStore.getState().undo();
    let state = useAppStore.getState();
    expect(state.document).toBe(first);
    expect(state.sketch).toBe(first.sketches[0]);
    expect(state.sketch.features).toEqual([]);
    expect(state.featureNames).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);

    useAppStore.getState().redo();
    state = useAppStore.getState();
    expect(state.document).toBe(second);
    expect(state.sketch).toBe(second.sketches[0]);
    expect(state.featureNames).toEqual(['点1']);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('戻せる版が無ければ何も起きない(例外にしない)', () => {
    const before = useAppStore.getState().document;
    useAppStore.getState().undo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().canRedo).toBe(false);
  });

  it('同じ欄への連続した変更は 1 段にまとめる(プロパティ欄の 1 文字ごと)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    expect(useAppStore.getState().undoStack.past).toHaveLength(1);

    const target = sketch.features[0];
    for (const value of [4, 5, 6]) {
      const current = useAppStore.getState().sketch.features[0];
      useAppStore
        .getState()
        .replaceSketchFeature(
          target.id,
          setFeatureField(current, 'at.x', expressionValueFromNumber(value)),
        );
    }

    // 3 回打っても段は 1 つしか増えない(束ねる、§0.a-0.13)。
    expect(useAppStore.getState().undoStack.past).toHaveLength(2);

    useAppStore.getState().undo();
    const undone = useAppStore.getState().sketch.features[0];
    if (undone.kind !== 'point' || undone.at.mode !== 'absolute') {
      throw new Error('絶対座標の点が残るはず');
    }
    // 束ねた 3 回ぶんがまとめて戻り、打ち始める前の値に戻る。
    expect(undone.at.x.value).toBe(1);
  });

  it('鍵の無い変更は必ず別の段になる', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    useAppStore.getState().setSketch(createEmptySketchDocument());
    expect(useAppStore.getState().undoStack.past).toHaveLength(2);
  });
});

describe('documentVersion(プロパティ欄の下書きを捨てる判定、docs/報告記録.md 2026-09-04 14:05 の 9b)', () => {
  it('起動直後は 0', () => {
    expect(useAppStore.getState().documentVersion).toBe(0);
  });

  it('プロパティ欄の 1 文字ずつの反映(coalesceKey あり)では進まない', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    const before = useAppStore.getState().documentVersion;

    const target = useAppStore.getState().sketch.features[0];
    for (const value of [4, 5, 6]) {
      const current = useAppStore.getState().sketch.features[0];
      useAppStore
        .getState()
        .replaceSketchFeature(
          target.id,
          setFeatureField(current, 'at.x', expressionValueFromNumber(value)),
        );
    }
    expect(useAppStore.getState().documentVersion).toBe(before);
  });

  it('普通の applyDocument(新しい要素の追加など)では進まない', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().documentVersion).toBe(before);
  });

  it('replacesDocument: true を渡すと進む(開くファイルの読み込みと同じ扱い)', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDocument(partWithPoint(), { replacesDocument: true });
    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });

  it('undo / redo で進む(時をまたぐ差し替えなので下書きを信用しない)', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    const afterApply = useAppStore.getState().documentVersion;

    useAppStore.getState().undo();
    expect(useAppStore.getState().documentVersion).toBe(afterApply + 1);

    useAppStore.getState().redo();
    expect(useAppStore.getState().documentVersion).toBe(afterApply + 2);
  });

  it('戻せる段が無い undo / redo は何も起きないので進まない', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().undo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().documentVersion).toBe(before);
  });

  it('resetDocument(新規・復元)で進む', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });

  it('同じ文書を入れ直しても(何も変わらないとき)進まない', () => {
    const before = useAppStore.getState().document;
    const beforeVersion = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDocument(before, { replacesDocument: true });
    expect(useAppStore.getState().documentVersion).toBe(beforeVersion);
  });
});

describe('作図面(§0.a-0.3)', () => {
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

  it('「視点に合わせる」の要求は数で伝える(視点の正本はビューポートにある)', () => {
    // ストアは視点を持たないので、押されたことだけを数えてビューポートに渡し返させる。
    expect(useAppStore.getState().matchWorkPlaneRequestCount).toBe(0);
    useAppStore.getState().requestMatchWorkPlaneToView();
    useAppStore.getState().requestMatchWorkPlaneToView();
    expect(useAppStore.getState().matchWorkPlaneRequestCount).toBe(2);
    // 数えるだけで作図面は変わらない。
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });
});

describe('文書の変化に応じた再計算の予約(要件§6.3)', () => {
  it('つないだ直後に今の文書を1回計算し、結果を反映する', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].document).toBe(useAppStore.getState().document);
    expect(fake.calls[0].options.generation).toBe(1);

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().documentName).toBe('スケッチ1');
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('計算を1回終えると、幾何カーネルを読み込み終えたと記録する(§0.a-0.23 ⑨)', async () => {
    expect(useAppStore.getState().kernelLoaded).toBe(false);
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().kernelLoaded).toBe(true);
    detach();
  });

  it('文書が変わるたびに計算し、結果をストアへ入れる', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].document).toBe(useAppStore.getState().document);
    // 世代番号は依頼のたびに 1 つ増える(古い応答を捨てる目印、NFR-PF-4)。
    expect(fake.calls[1].options.generation).toBe(2);

    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toEqual(['点1']);
    expect(useAppStore.getState().resolvedSketch.points).toHaveLength(1);
    detach();
  });

  it('計算中に続けて変えても重ねず、最後の文書だけを次に回す(連続入力)', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const first = documentWithPoint();
    const second = appendFeature(first, createPointFeature(first, absoluteCoordinate(4, 5, 6)));
    const third = appendFeature(second, createPointFeature(second, absoluteCoordinate(7, 8, 9)));

    useAppStore.getState().setSketch(first);
    const started = useAppStore.getState().document;
    useAppStore.getState().setSketch(second);
    useAppStore.getState().setSketch(third);
    // 1 本目が終わるまでは次を始めない。
    expect(fake.calls).toHaveLength(2);

    fake.calls[1].settle(resultFor(started));
    await tick();

    // 間に挟まった second は捨て、最新の third だけを計算する。
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(useAppStore.getState().document);
    expect(fake.calls[2].document.sketches[0]).toBe(third);
    // 途中の結果では計算中の札を下ろさない。
    expect(useAppStore.getState().isComputing).toBe(true);

    fake.calls[2].settle(resultFor(fake.calls[2].document));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toHaveLength(3);
    detach();
  });

  it('外した後は文書が変わっても計算しない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    detach();

    useAppStore.getState().setSketch(documentWithPoint());
    await tick();
    expect(fake.calls).toHaveLength(1);
  });

  it('計算が投げたら理由を出して計算中を下ろす(FR-504)', async () => {
    const detach = attachPartRecompute(() => Promise.reject(new Error('計算できません')));
    await tick();
    expect(useAppStore.getState().errorMessage).toBe('計算できません');
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('ボディと失敗と命中数を反映し、進捗は下ろす(FR-504、NFR-PF-3)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setRecomputeProgress({
      featureId: 'extrude-1',
      index: 0,
      total: 1,
      label: '押し出しextrude-1',
    });
    expect(useAppStore.getState().recomputeProgress).not.toBeNull();

    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [bodyFor('extrude-1')],
      errors: [{ featureId: 'extrude-1', code: 'kernelFailed', message: '立体を作れませんでした' }],
      cacheHits: 3,
    });

    const state = useAppStore.getState();
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0].featureId).toBe('extrude-1');
    expect(state.partErrors).toHaveLength(1);
    expect(state.cacheHits).toBe(3);
    expect(state.isComputing).toBe(false);
    expect(state.recomputeProgress).toBeNull();
    // ソリッドの失敗はスケッチの控えへ混ぜない(要素 id が違う)。
    expect(state.sketchErrors).toEqual([]);
  });

  it('スケッチの失敗はいま編集しているスケッチの控えへ写す(FR-504)', () => {
    const document = partWithPoint();
    const featureId = document.sketches[0].features[0].id;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      errors: [{ featureId, code: 'kernelFailed', message: '面を作れませんでした: 失敗' }],
    });

    const state = useAppStore.getState();
    expect(state.sketchErrors).toHaveLength(1);
    expect(state.sketchErrors[0].featureId).toBe(featureId);
    expect(state.sketchErrors[0].code).toBe('kernelFailed');
    expect(state.partErrors).toHaveLength(1);
  });
});

describe('進捗と中止(NFR-PF-4、§0.a-0.22)', () => {
  it('計算中の進み具合を受け取って持つ', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    fake.calls[0].options.onProgress?.({
      featureId: 'extrude-1',
      index: 2,
      total: 5,
      label: '押し出し1',
    });
    expect(useAppStore.getState().recomputeProgress).toEqual({
      featureId: 'extrude-1',
      index: 2,
      total: 5,
      label: '押し出し1',
    });

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    expect(useAppStore.getState().recomputeProgress).toBeNull();
    detach();
  });

  it('中止を頼むと、いま走っている計算の shouldCancel が立つ', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    const shouldCancel = fake.calls[0].options.shouldCancel;
    expect(shouldCancel?.()).toBe(false);
    useAppStore.getState().cancelRecompute();
    expect(shouldCancel?.()).toBe(true);
    detach();
  });

  it('次に始まる計算は前の中止を引きずらない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    useAppStore.getState().cancelRecompute();
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);

    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
    await tick();
    useAppStore.getState().setSketch(documentWithPoint());

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.shouldCancel?.()).toBe(false);
    detach();
  });

  it('中止された結果では前のボディを消さない(半分だけの形を出さない)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [bodyFor('extrude-1')],
    });
    expect(useAppStore.getState().bodies).toHaveLength(1);

    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [],
      cancelled: true,
    });

    const state = useAppStore.getState();
    expect(state.bodies).toHaveLength(1);
    expect(state.isComputing).toBe(false);
    expect(state.recomputeProgress).toBeNull();
  });

  it('中止を頼んでいないときは何も起きない(例外にならない)', () => {
    useAppStore.getState().cancelRecompute();
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('起動直後は中止の知らせを持たない(タスク25)', () => {
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('中止で終わると知らせが立ち、進捗は下りる(NFR-PF-4、タスク25)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setRecomputeProgress({
      featureId: 'extrude-1',
      index: 0,
      total: 3,
      label: '押し出し1',
    });

    useAppStore
      .getState()
      .applyRecompute(document, { ...resultFor(document), cancelled: true });

    const state = useAppStore.getState();
    expect(state.recomputeCancelled).toBe(true);
    expect(state.recomputeProgress).toBeNull();
    // 中止は失敗ではないので、赤い帯になる errorMessage は立てない。
    expect(state.errorMessage).toBeNull();
  });

  it('最後まで走った計算が終わると中止の知らせは下りる', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().applyRecompute(document, resultFor(document));
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('文書が変わると中止の知らせは消える(時間では消さない)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().setSketch(documentWithPoint());
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('元に戻す・やり直す・新しくやり直すでも中止の知らせは消える', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    const document = useAppStore.getState().document;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().undo();
    expect(useAppStore.getState().recomputeCancelled).toBe(false);

    useAppStore.getState().applyRecompute(useAppStore.getState().document, {
      ...resultFor(useAppStore.getState().document),
      cancelled: true,
    });
    useAppStore.getState().redo();
    expect(useAppStore.getState().recomputeCancelled).toBe(false);

    useAppStore.getState().applyRecompute(useAppStore.getState().document, {
      ...resultFor(useAppStore.getState().document),
      cancelled: true,
    });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });
});

describe('ファイルまわりの状態(FR-806、計画書 タスク23)', () => {
  it('起動直後は名前も保存済みの文書も無く、口だけが用意されている', () => {
    const state = useAppStore.getState();
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    expect(state.captureThumbnail).toBeNull();
    expect(state.fileMessage).toBeNull();
    expect(state.fileGateway.hasSaveTarget()).toBe(false);
  });

  it('読み書きの口を差し替えられる(デスクトップ版が使う)', () => {
    const gateway = {
      openPcad: () => Promise.resolve(null),
      savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => true,
    };
    useAppStore.getState().setFileGateway(gateway);
    expect(useAppStore.getState().fileGateway).toBe(gateway);
  });

  it('ファイル名と保存済みの文書を入れられる', () => {
    const document = createEmptyPartDocument();
    useAppStore.getState().setFileState('部品1.pcad', document);

    const state = useAppStore.getState();
    expect(state.fileName).toBe('部品1.pcad');
    expect(state.savedDocument).toBe(document);
  });

  it('サムネイルの作り手を差し出し、取り下げられる(ビューポートが使う)', () => {
    const png = new Uint8Array([1, 2, 3]);
    useAppStore.getState().setCaptureThumbnail(() => png);
    expect(useAppStore.getState().captureThumbnail?.()).toBe(png);

    useAppStore.getState().setCaptureThumbnail(null);
    expect(useAppStore.getState().captureThumbnail).toBeNull();
  });

  it('文書が変わるとファイル操作の知らせは消える(古い返事を残さない)', () => {
    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });
    expect(useAppStore.getState().fileMessage).not.toBeNull();

    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('保存・開くなどが成功すると、古い断り(面・立体)は消える(§0.a-0.23 ⑦)', () => {
    useAppStore.getState().setFaceError('face.error.emptySelection');
    useAppStore.getState().setSolidError('solidError.noFace');

    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });

    const state = useAppStore.getState();
    expect(state.faceErrorKey).toBeNull();
    expect(state.solidErrorKey).toBeNull();
  });

  it('保存などが失敗したときは古い断りを残す(まだ解消していない、§0.a-0.23 ⑦)', () => {
    useAppStore.getState().setSolidError('solidError.noFace');
    useAppStore.getState().setFileMessage({ key: 'file.saveFailed', failed: true });
    expect(useAppStore.getState().solidErrorKey).toBe('solidError.noFace');
  });

  it('文書が変わったときも古い断りは消える(§0.a-0.23 ⑦)', () => {
    useAppStore.getState().setFaceError('face.error.emptySelection');
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().faceErrorKey).toBeNull();
  });

  it('元に戻す・やり直すでも知らせは消える', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });

    useAppStore.getState().undo();
    expect(useAppStore.getState().fileMessage).toBeNull();

    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });
    useAppStore.getState().redo();
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('新しくやり直すと履歴のスタックごと作り直され、取りかけも残らない', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    useAppStore.getState().setSelection(['point-1']);
    useAppStore.getState().setActiveTool('line');
    useAppStore.getState().setPendingStart(absoluteCoordinate(0, 0, 0));
    expect(useAppStore.getState().canUndo).toBe(true);

    const next = createEmptyPartDocument();
    useAppStore.getState().resetDocument(next);

    const state = useAppStore.getState();
    expect(state.document).toBe(next);
    expect(state.undoStack.past).toEqual([]);
    expect(state.undoStack.future).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.selection).toEqual([]);
    expect(state.activeTool).toBe('select');
    expect(state.pendingStart).toBeNull();
    expect(state.errorMessage).toBeNull();
  });
});

describe('自動保存まわりの状態(FR-805、計画書 タスク24)', () => {
  /** 何も書かない偽の控え係。ここで確かめるのは「差し出せて取り下げられる」ことだけ。 */
  function createFakeAutoSaver(): AutoSaver {
    return {
      markDirty: () => undefined,
      saveNow: () => Promise.resolve(),
      stop: () => undefined,
      readLatest: () => Promise.resolve(null),
      discard: () => Promise.resolve(),
    };
  }

  it('起動直後は控え係も復元の案内も無い', () => {
    const state = useAppStore.getState();
    expect(state.autoSaver).toBeNull();
    expect(state.restorePrompt).toBeNull();
  });

  it('控え係を差し出し、取り下げられる', () => {
    const saver = createFakeAutoSaver();
    useAppStore.getState().setAutoSaver(saver);
    expect(useAppStore.getState().autoSaver).toBe(saver);

    useAppStore.getState().setAutoSaver(null);
    expect(useAppStore.getState().autoSaver).toBeNull();
  });

  it('復元の案内を出し、閉じられる', () => {
    const prompt = { savedAt: '2026-09-03T09:30:00.000Z', documentName: '部品1' };
    useAppStore.getState().setRestorePrompt(prompt);
    expect(useAppStore.getState().restorePrompt).toEqual(prompt);

    useAppStore.getState().setRestorePrompt(null);
    expect(useAppStore.getState().restorePrompt).toBeNull();
  });
});

describe('選択の種類(FR-106、NFR-UX-1、計画書 P3 タスク21、§0.a-0.6)', () => {
  it('起動時の選択の種類は立体(body)', () => {
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it('setSelectionKind で手動切替でき、種類が変わると選択は空になる', () => {
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().setSelectionKind('face');
    expect(useAppStore.getState().selectionKind).toBe('face');
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('setSelectionKind を同じ種類で 2 回呼んでも、2 回目は選択が残る(変わっていないので)', () => {
    useAppStore.getState().setSelectionKind('body'); // 1 回目: 起動時から変わらない
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().setSelectionKind('body'); // 2 回目もやはり変わらない
    expect(useAppStore.getState().selectionKind).toBe('body');
    expect(useAppStore.getState().selection).toEqual(['extrude-1']);
  });

  it('setActiveTool(select) は選択の種類を立体へ戻す', () => {
    useAppStore.getState().setSelectionKind('edge');
    useAppStore.getState().setActiveTool('select');
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it('加工の道具を選ぶと必要な種類へ自動で切り替わる(§0.a-0.6: 穴・ねじ穴→面、面取り→辺、パターン→立体)', () => {
    useAppStore.getState().setActiveTool('hole');
    expect(useAppStore.getState().selectionKind).toBe('face');
    useAppStore.getState().setActiveTool('threadHole');
    expect(useAppStore.getState().selectionKind).toBe('face');
    useAppStore.getState().setActiveTool('fillet');
    expect(useAppStore.getState().selectionKind).toBe('edge');
    useAppStore.getState().setActiveTool('chamfer');
    expect(useAppStore.getState().selectionKind).toBe('edge');
    useAppStore.getState().setActiveTool('linearPattern');
    expect(useAppStore.getState().selectionKind).toBe('body');
    useAppStore.getState().setActiveTool('circularPattern');
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it('道具の変更で選択の種類が変わると選択が空になり、変わらなければ選択は残る', () => {
    useAppStore.getState().setActiveTool('select');
    useAppStore.getState().setSelection(['extrude-1']);

    // body → body(押し出しも立体を選ぶ道具なので種類は変わらない)。
    useAppStore.getState().setActiveTool('extrude');
    expect(useAppStore.getState().selection).toEqual(['extrude-1']);

    // body → edge(R 面取りは辺を選ぶ)。合わない選択は外れる。
    useAppStore.getState().setActiveTool('fillet');
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('フィーチャーを消すと部分形状の選択(extrude-1#face:0)も外れる(§0.a-0.8)', () => {
    const withSolid = appendSolid(createEmptyPartDocument(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(withSolid, { undoable: false });
    useAppStore.getState().setSelectionKind('face');
    useAppStore.getState().setSelection(['extrude-1#face:0']);
    expect(useAppStore.getState().selection).toEqual(['extrude-1#face:0']);

    useAppStore.getState().applyDocument(removeSolid(withSolid, 'extrude-1'));
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('立体の選択と部分形状の選択が混ざった状態で setSelectionKind すると選択が空になる', () => {
    useAppStore.getState().setSelectionKind('body');
    useAppStore.getState().setSelection(['extrude-1', 'extrude-2#face:0']);
    useAppStore.getState().setSelectionKind('face');
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('resetDocument で選択の種類も立体へ戻る(NFR-UX-3、前の部品の状態を持ち越さない)', () => {
    useAppStore.getState().setSelectionKind('edge');
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it(
    '加工の確定後、道具を選択へ戻してから作った立体を選ぶと選択が残る' +
      '(タスク30 不具合(a): AppShell.onSolidCommit が setActiveTool(\'select\') → setSelection の' +
      '順で呼ぶ。逆順だと setActiveTool が種類の変化(面/辺 → 立体)を見て選択を空にする)',
    () => {
      // 穴・ねじ穴・R/C面取りのように選ぶ種類が body 以外になる道具で確定した状況を再現する。
      useAppStore.getState().setActiveTool('hole');
      useAppStore.getState().setSelection(['extrude-1#face:0']);
      expect(useAppStore.getState().selectionKind).toBe('face');

      // 修正後の順(道具を選択へ戻してから、作った立体を選ぶ)。
      useAppStore.getState().setActiveTool('select');
      useAppStore.getState().setSelection(['hole-1']);

      const state = useAppStore.getState();
      expect(state.selectionKind).toBe('body');
      expect(state.selection).toEqual(['hole-1']);
    },
  );

  it('(参考)逆順だと setActiveTool が選択を空にする(タスク30 不具合(a) の再現)', () => {
    useAppStore.getState().setActiveTool('hole');
    useAppStore.getState().setSelection(['extrude-1#face:0']);

    // 修正前の順(作った立体を選んでから、道具を選択へ戻す)だと選択が空になる。
    useAppStore.getState().setSelection(['hole-1']);
    useAppStore.getState().setActiveTool('select');

    expect(useAppStore.getState().selection).toEqual([]);
  });
});

describe('表示設定(FR-908、FR-909、計画書 P4 タスク1、§0.a-0.1〜0.3)', () => {
  it('起動時の表示設定は既定(ダーク・100%)', () => {
    expect(useAppStore.getState().displaySettings).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('setDisplaySettings で表示設定を丸ごと差し替えられる', () => {
    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', uiScale: 120 });
    expect(useAppStore.getState().displaySettings).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', uiScale: 120 });

    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 90 });
    expect(useAppStore.getState().displaySettings).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 90 });
  });

  it('localStorage が無い実行環境(このテスト環境)でも例外を投げずに保存を試みる', () => {
    // Vitest は environment: 'node' で動く(localStorage が無い)。saveSettings が黙って
    // 諦めることを settings.test.ts で確かめているので、ここでは setDisplaySettings 経由でも
    // 例外が外へ漏れないことだけを確かめる(NFR-RE-1)。
    expect(() => {
      useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'darkModern', uiScale: 140 });
    }).not.toThrow();
  });

  it('resetDocument(新規)では表示設定を戻さない(部品ではなく端末の好みのため)', () => {
    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 150 });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().displaySettings).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 150 });
  });
});

describe('3D スケッチで押した場所の面(FR-330、タスク14)', () => {
  /** 画面に正対する面の代わり。向きだけが要るので基準の XY をそのまま使う。 */
  const plane = { ...WORK_PLANES.xy, id: FREE_WORK_PLANE_ID };

  it('初期値は null(まだ一度も押していない)', () => {
    expect(useAppStore.getState().freeSketchPlane).toBeNull();
  });

  it('道具を変えたら捨てる(取りかけを持ち越さない、NFR-UX-3)', () => {
    useAppStore.getState().setFreeSketchPlane(plane);
    expect(useAppStore.getState().freeSketchPlane).toEqual(plane);
    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().freeSketchPlane).toBeNull();
  });

  it('作図面を変えたら捨てる(前の作図面の面を持ち越さない)', () => {
    useAppStore.getState().setFreeSketchPlane(plane);
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().freeSketchPlane).toBeNull();
    // 3D スケッチを選んだこと自体は残る。
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);
  });
});

describe('複数のスケッチ(P4 仕上げ (g)、FR-501、FR-328)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  /** 指定した作図面に置いた点を 1 つだけ持つスケッチ。 */
  function sketchOnPlane(id: string, name: string, planeId: 'xy' | 'xz' | 'yz'): SketchDocument {
    const point: SketchPointFeature = {
      id: 'point-1',
      name: '点1',
      planeId,
      kind: 'point',
      at: absoluteCoordinate(1, 2, 3),
    };
    return appendFeature({ id, name, features: [] }, point);
  }

  it('スケッチの作図面は最後に置いた要素の作図面(要素が無ければ決まらない)', () => {
    expect(workPlaneOfSketch(undefined)).toBeNull();
    expect(workPlaneOfSketch(createEmptySketchDocument())).toBeNull();
    expect(workPlaneOfSketch(sketchOnPlane('sketch-2', 'スケッチ2', 'xz'))).toBe('xz');
  });

  it('スケッチを切り替えると作図面が追従する', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = {
      ...base,
      sketches: [sketchOnPlane('sketch-1', 'スケッチ1', 'xy'), sketchOnPlane('sketch-2', 'スケッチ2', 'xz')],
      activeSketchId: 'sketch-1',
    };
    useAppStore.getState().applyDocument(document);
    expect(useAppStore.getState().workPlaneId).toBe('xy');

    useAppStore.getState().setActiveSketch('sketch-2');
    expect(useAppStore.getState().document.activeSketchId).toBe('sketch-2');
    expect(useAppStore.getState().workPlaneId).toBe('xz');
    // 控えの sketch も切り替わり、作図面を解いた面(workPlane)も追いつく。
    expect(useAppStore.getState().sketch.id).toBe('sketch-2');
    expect(useAppStore.getState().workPlane).toEqual(WORK_PLANES.xz);

    useAppStore.getState().setActiveSketch('sketch-1');
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('要素が 1 つも無いスケッチへ切り替えても作図面は今のまま', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = {
      ...base,
      sketches: [sketchOnPlane('sketch-1', 'スケッチ1', 'yz'), createEmptySketchDocument2('sketch-2')],
      activeSketchId: 'sketch-1',
    };
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setWorkPlane('yz');
    useAppStore.getState().setActiveSketch('sketch-2');
    expect(useAppStore.getState().document.activeSketchId).toBe('sketch-2');
    expect(useAppStore.getState().workPlaneId).toBe('yz');
  });

  it('切り替えでは Undo の段を作らない(形は変わらないため)', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = {
      ...base,
      sketches: [sketchOnPlane('sketch-1', 'スケッチ1', 'xy'), sketchOnPlane('sketch-2', 'スケッチ2', 'xz')],
      activeSketchId: 'sketch-1',
    };
    useAppStore.getState().applyDocument(document);
    const before = useAppStore.getState().undoStack.past.length;
    useAppStore.getState().setActiveSketch('sketch-2');
    expect(useAppStore.getState().undoStack.past).toHaveLength(before);
  });
});

/** 名前だけ差し替えた空のスケッチ(検査の読みやすさのための小さな補助)。 */
function createEmptySketchDocument2(id: string): SketchDocument {
  return { ...createEmptySketchDocument(), id, name: id };
}

/** 押し出しを 3 段積んだ部品文書(タイムラインの帯が 3 件になる)。 */
function partWithThreeSolids(): PartDocument {
  let document = createEmptyPartDocument();
  for (const id of ['1', '2', '3']) {
    document = appendSolid(document, extrudeFeature(id));
  }
  return document;
}

describe('タイムラインのつまみ(FR-507、FR-506、P4b タスク19)', () => {
  it('起動直後のつまみは末尾(null)で、知らせも出ていない(§0.a-0.19)', () => {
    expect(useAppStore.getState().timelineIndex).toBeNull();
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('つまみを動かしても文書は 1 バイトも変わらず、Undo の段も増えない', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const before = useAppStore.getState().document;
    const undoBefore = useAppStore.getState().undoStack.past.length;

    useAppStore.getState().setTimelineIndex(0);

    expect(useAppStore.getState().timelineIndex).toBe(0);
    // 形の正本は全体のまま。保存されるのはこれ(`savePart` は document を書く)。
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().document.solids).toHaveLength(3);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoBefore);
  });

  it('文書をまるごと差し替えたら(開く)つまみは末尾へ戻る', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(1);
    expect(useAppStore.getState().timelineIndex).toBe(1);

    useAppStore.getState().applyDocument(partWithPoint(), { replacesDocument: true });

    expect(useAppStore.getState().timelineIndex).toBeNull();
    // 開いただけで「最後まで戻しました」とは言わない(言っても意味が無い)。
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('新規・復元(resetDocument)でもつまみは末尾へ戻る', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().timelineIndex).toBeNull();
  });

  it('元に戻す・やり直すでもつまみは末尾へ戻る(履歴の件数が変わりうるため)', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().timelineIndex).toBeNull();

    useAppStore.getState().setTimelineIndex(0);
    useAppStore.getState().redo();
    expect(useAppStore.getState().timelineIndex).toBeNull();
  });

  /*
   * タスク19 では、戻したまま作ったものは末尾へ積まれるので、つまみを末尾へ戻して
   * 「最後まで戻しました」と知らせていた。タスク20 で**つまみの位置へ差し込む**ように
   * 変えたので、期待値もそれに合わせて書き替えてある(緩めたのではなく、決めた振る舞いが
   * 変わった。計画書 タスク20「実装内容」)。
   */
  it('途中まで戻したまま履歴が伸びたら、つまみのところへ差し込んでつまみを 1 つ進める', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);

    const grown = appendSolid(useAppStore.getState().document, extrudeFeature('4'));
    useAppStore.getState().applyDocument(grown);

    // 押し出し4 は末尾ではなく、つまみ(押し出し1)の次へ入る。
    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual([
      '1',
      '4',
      '2',
      '3',
    ]);
    // つまみは差し込んだ段へ進むので、作ったものがそのまま画面に出る。
    expect(useAppStore.getState().timelineIndex).toBe(1);
    expect(useAppStore.getState().timelineNoticeKey).toBe('timeline.inserted');
  });

  it('差し込みは Undo 1 回で元へ戻り、つまみも末尾へ戻る', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    useAppStore
      .getState()
      .applyDocument(appendSolid(useAppStore.getState().document, extrudeFeature('4')));

    useAppStore.getState().undo();

    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['1', '2', '3']);
    expect(useAppStore.getState().timelineIndex).toBeNull();
  });

  it('保存される文書には差し込んだ並びがそのまま入る(つまみで切った文書は保存しない)', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    useAppStore
      .getState()
      .applyDocument(appendSolid(useAppStore.getState().document, extrudeFeature('4')));

    expect(useAppStore.getState().document.solids).toHaveLength(4);
    expect(useAppStore.getState().undoStack.present).toBe(useAppStore.getState().document);
  });

  it('つまみが末尾のまま履歴が伸びても、知らせは出ない(これまでどおり)', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const grown = appendSolid(useAppStore.getState().document, extrudeFeature('4'));
    useAppStore.getState().applyDocument(grown);

    expect(useAppStore.getState().timelineIndex).toBeNull();
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('戻したまま名前を変える・消すなど履歴が伸びない差し替えでは、つまみは動かない', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);

    useAppStore.getState().applyDocument(removeSolid(useAppStore.getState().document, '3'));

    expect(useAppStore.getState().timelineIndex).toBe(0);
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('順序の入れ替えは Undo 1 段で、断られたら文書を 1 バイトも変えない(FR-507、FR-504)', () => {
    // 押し出し1 → 穴1(押し出し1 が対象)→ 押し出し2(独立)。
    const base = appendSolid(
      appendSolid(appendSolid(createEmptyPartDocument(), extrudeFeature('1')), holeFeature('h', '1')),
      extrudeFeature('2'),
    );
    useAppStore.getState().applyDocument(base);
    const undoBefore = useAppStore.getState().undoStack.past.length;

    // 独立した押し出し2 を先頭へ。1 回積むので取り消し 1 回で戻る(NFR-UX-3)。
    useAppStore.getState().moveTimelineItem('2', 0);
    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['2', '1', 'h']);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoBefore + 1);
    expect(useAppStore.getState().timelineRefusal).toBeNull();
    // 動かしたのは並びだけで、フィーチャーそのものは同じ物のまま(NFR-PF-3。
    // 中身を作り直すと、変わっていない段まで形の計算をやり直すことになる)。
    expect(useAppStore.getState().document.solids[1]).toBe(base.solids[0]);
    expect(useAppStore.getState().document.solids[2]).toBe(base.solids[1]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['1', 'h', '2']);

    // 押し出し1 を穴1 の後ろへは動かせない。断りは「壊れる側」の穴1 を指す。
    const before = useAppStore.getState().document;
    useAppStore.getState().moveTimelineItem('1', 1);
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().timelineRefusal?.blockingFeatureId).toBe('h');
    expect(useAppStore.getState().timelineRefusal?.message).toContain('穴h');

    // 次に形が変われば断りは用済み(FR-504)。
    useAppStore.getState().moveTimelineItem('2', 0);
    expect(useAppStore.getState().timelineRefusal).toBeNull();
  });

  it('つまみを動かすと、切った文書で計算し直す(保存する文書は全体のまま)', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    // つないだ直後は末尾なので、渡るのは文書そのもの(=== を保つ、NFR-PF-3)。
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].document).toBe(useAppStore.getState().document);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    useAppStore.getState().setTimelineIndex(0);
    expect(fake.calls).toHaveLength(2);
    // 渡るのは 1 段目までに切った文書。
    expect(fake.calls[1].document.solids).toHaveLength(1);
    expect(fake.calls[1].document).not.toBe(useAppStore.getState().document);
    // 切っても中のフィーチャーは複製しないので、形の作り直しが起きない(§2.7)。
    expect(fake.calls[1].document.solids[0]).toBe(useAppStore.getState().document.solids[0]);
    // ストアの正本(保存されるもの)は全体のまま。
    expect(useAppStore.getState().document.solids).toHaveLength(3);
    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await tick();

    // 末尾へ戻すと、また文書そのものが渡る。
    useAppStore.getState().setTimelineIndex(null);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(useAppStore.getState().document);
    fake.calls[2].settle(resultFor(fake.calls[2].document));
    await tick();
    detach();
  });

  it('同じ位置へ置き直しても計算し直さない', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    useAppStore.getState().setTimelineIndex(null);
    expect(fake.calls).toHaveLength(1);
    detach();
  });
});

describe('拘束の控えと後始末(FR-313、P4b タスク13)', () => {
  /** 線分 2 本を持つスケッチと、その 2 本に付けた直角の拘束。 */
  function partWithPerpendicular(): PartDocument {
    let sketch = appendFeature(createEmptySketchDocument(), {
      id: 'line-1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(10, 0, 0),
      construction: false,
    });
    sketch = appendFeature(sketch, {
      id: 'line-2',
      name: '線分2',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(3, 9, 0),
      construction: false,
    });
    const outcome = commitConstraintFromSelection(sketch, 'perpendicular', ['line-1', 'line-2']);
    if (!outcome.ok) {
      throw new Error(`拘束を足せなかった: ${outcome.reason}`);
    }
    return replaceSketch(createEmptyPartDocument(), outcome.document);
  }

  it('拘束が無ければ一覧も診断も空のまま(要らない計算をしない)', () => {
    const store = useAppStore.getState();
    store.applySketch(documentWithPoint(), sketchResultFor(documentWithPoint()));
    expect(useAppStore.getState().constraintSummaries).toEqual([]);
    expect(useAppStore.getState().constraintDiagnosis).toBeNull();
  });

  it('再計算の結果から拘束の一覧と診断を控える', () => {
    const part = partWithPerpendicular();
    useAppStore.getState().applyDocument(part);
    const sketch = part.sketches[0];
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));
    const summaries = useAppStore.getState().constraintSummaries;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].label).toBe('直角1');
    // 印は 2 本の線の中点に 1 つずつ(`constraintSummary.ts` の `anchors`)。
    expect(summaries[0].anchors).toHaveLength(2);
  });

  it('要素を消すと、それを指していた拘束も一緒に消える(取り消し 1 回で戻る)', () => {
    const part = partWithPerpendicular();
    useAppStore.getState().applyDocument(part);
    expect(sketchConstraints(useAppStore.getState().sketch)).toHaveLength(1);

    useAppStore.getState().removeSketchFeature('line-2');
    expect(useAppStore.getState().sketch.features.map((feature) => feature.id)).toEqual(['line-1']);
    expect(sketchConstraints(useAppStore.getState().sketch)).toHaveLength(0);

    useAppStore.getState().undo();
    expect(sketchConstraints(useAppStore.getState().sketch)).toHaveLength(1);
    expect(useAppStore.getState().sketch.features).toHaveLength(2);
  });

  it('拘束の道具を選ぶと、下地の道具は選択に戻り、選択と押した相手は空になる', () => {
    useAppStore.getState().setActiveTool('line');
    useAppStore.getState().setSelection(['line-1']);
    useAppStore.getState().setConstraintTool('perpendicular');
    const state = useAppStore.getState();
    expect(state.activeConstraintKind).toBe('perpendicular');
    expect(state.activeTool).toBe('select');
    expect(state.selection).toEqual([]);
    expect(state.constraintTargets).toEqual([]);
  });

  it('別の道具を選ぶと拘束の道具はやめる(取りかけを持ち越さない)', () => {
    useAppStore.getState().setConstraintTool('parallel');
    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().activeConstraintKind).toBeNull();
  });

  it('文書が変われば拘束の断りは用済み(FR-504)', () => {
    useAppStore.getState().setConstraintError('線を 2 本選んでください。');
    expect(useAppStore.getState().constraintErrorMessage).not.toBeNull();
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().constraintErrorMessage).toBeNull();
  });
});

describe('引っぱりの一時状態(FR-313、P4b タスク14)', () => {
  /** 引っぱっている点の見立て。中身は `dragSketch.ts` の検査が押さえている。 */
  const drag = {
    pointKey: 'line-1:end',
    featureId: 'line-1',
    field: 'to',
    index: null,
    startUv: [10, 0],
    grabUv: [10, 0],
  } as const;

  it('掴んだだけでは形を変えない(押しただけで動かない)', () => {
    useAppStore.getState().beginSketchDrag(drag);
    expect(useAppStore.getState().sketchDrag).toEqual(drag);
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('掴んだら前の断りは消える(押し直したら理由も出し直す)', () => {
    useAppStore.getState().setDragRefusal('drag.error.fixed');
    useAppStore.getState().beginSketchDrag(drag);
    expect(useAppStore.getState().dragRefusalKey).toBeNull();
  });

  it('Esc(取り消し)は仮の形ごと捨てる', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().beginSketchDrag(drag);
    useAppStore.getState().setDragResolved(resolveSketch(sketch));
    useAppStore.getState().endSketchDrag(false);
    expect(useAppStore.getState().sketchDrag).toBeNull();
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('離したときの形は次の計算まで残す(元の形へ戻ってちらつかない)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().beginSketchDrag(drag);
    useAppStore.getState().setDragResolved(resolveSketch(sketch));
    useAppStore.getState().endSketchDrag(true);
    expect(useAppStore.getState().sketchDrag).toBeNull();
    expect(useAppStore.getState().dragResolved).not.toBeNull();
  });

  it('計算した形が届いたら仮の形は用済み(applySketch)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setDragResolved(resolveSketch(sketch));
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('部品まるごとの計算が届いても仮の形は用済み(applyRecompute)', () => {
    const part = partWithPoint();
    useAppStore.getState().setDragResolved(resolveSketch(documentWithPoint()));
    useAppStore.getState().applyRecompute(part, resultFor(part));
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('文書が変われば引っぱれなかった理由は用済み(FR-504)', () => {
    useAppStore.getState().setDragRefusal('drag.error.derived');
    expect(useAppStore.getState().dragRefusalKey).not.toBeNull();
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().dragRefusalKey).toBeNull();
  });
});

/**
 * 作図面が消えた文書に留まらない(統括の指示、2026-09-05。P4b タスク22a-(5))。
 *
 * 再現した不具合: 3 点の作業平面を作って作図面をその参照面に切り替えた後「新規」を
 * 押すと、空の新文書は `references` が空なのに `workPlaneId` が古い参照面の id の
 * まま残り、以後の矩形・線分が存在しない作図面を指して作られる(面が張れず
 * 「作図面が見つかりません」)。`documentPatch`(`resetDocument` / `applyDocument` の
 * 開く・復元の枝 / `undo` / `redo` が共通で通る)で、`workPlaneId` がその文書の
 * `references` に無ければ既定の XY へ戻すことで直した。
 */
describe('作図面が消えた文書に留まらない(P4b タスク22a-(5))', () => {
  /** 基準の3面のオフセット 0(= XY そのもの)を作業平面にした、いちばん単純な参照面。 */
  function documentWithReferencePlane(): PartDocument {
    return {
      ...createEmptyPartDocument(),
      references: [
        {
          id: 'referencePlane-1',
          name: '作業平面1',
          visible: true,
          kind: 'referencePlane',
          plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0) },
        },
      ],
    };
  }

  it('作業平面へ切り替え → 新規 → workPlaneId が xy へ戻る(修正前は referencePlane-1 のまま残った)', () => {
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    useAppStore.getState().setWorkPlane('referencePlane-1');
    expect(useAppStore.getState().workPlaneId).toBe('referencePlane-1');

    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('作業平面を持つ文書を開く → その id を保つ', () => {
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    useAppStore.getState().setWorkPlane('referencePlane-1');

    // 開き直した先の文書にも同じ id の作業平面があれば、そのまま使う。
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    expect(useAppStore.getState().workPlaneId).toBe('referencePlane-1');
  });

  it('作業平面を持たない文書を開く → xy へ戻る', () => {
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    useAppStore.getState().setWorkPlane('referencePlane-1');

    useAppStore.getState().applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });
});

/*
 * 外観だけの変更で再計算を起こさない経路(P5 タスク10、要件§4.12、FR-1106〜1110)。
 * 「色を変えるとカーネルが 100 フィーチャーぶん走り直す」ことを防ぐ、P5 で最も効く配線。
 */
describe('外観の変更(FR-1106、要件§4.12)', () => {
  const steel = appearanceFromPreset('steel');

  it('外観だけを変えても再計算を投げず、計算中の札も立てない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    expect(fake.calls).toHaveLength(1);

    const painted = assignBodyAppearance(useAppStore.getState().document, 'extrude-1', steel);
    useAppStore.getState().applyDocument(painted);

    // 文書は変わっている(割り当てが 1 つ増えた)が、形は変わっていない。
    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('形が変わる変更では、これまでどおり 1 回だけ投げる', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    useAppStore.getState().setSketch(documentWithPoint());
    expect(fake.calls).toHaveLength(2);
    expect(useAppStore.getState().isComputing).toBe(true);
    detach();
  });

  it('外観だけの取り消し(FR-505、FR-1110)でも計算中の札を立てない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    useAppStore
      .getState()
      .applyDocument(assignBodyAppearance(useAppStore.getState().document, 'extrude-1', steel));
    useAppStore.getState().undo();

    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('再計算の結果の面の照合(appearanceMatches)をストアへ入れる', async () => {
    const matches: AppearanceMatchEntry[] = [
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 4 },
      { id: 'appearance-2', bodyFeatureId: 'extrude-1', faceIndex: null },
    ];
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), appearanceMatches: matches });
    await tick();

    expect(useAppStore.getState().appearanceMatches).toEqual(matches);
    detach();
  });

  it('打ち切られた結果では面の照合を差し替えない(ボディと同じ扱い)', async () => {
    const matches: AppearanceMatchEntry[] = [
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 4 },
    ];
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), appearanceMatches: matches });
    await tick();

    useAppStore.getState().setSketch(documentWithPoint());
    fake.calls[1].settle({
      ...resultFor(fake.calls[1].document),
      cancelled: true,
      appearanceMatches: [],
    });
    await tick();

    expect(useAppStore.getState().appearanceMatches).toEqual(matches);
    detach();
  });
});

/*
 * 外観の口(P5 タスク11、FR-1106〜1110、FR-505)。断りの判断そのものは純関数
 * `appearance/appearanceCommands.ts` の検査で固定してあるので、ここでは
 * 「ストアが確定を `applyDocument` に通しているか」「断りを帯へ置くか」だけを見る。
 */
describe('外観の口(FR-1106〜1110、P5 タスク11)', () => {
  const steel = appearanceFromPreset('steel');
  const glass = appearanceFromPreset('glass');

  /** 押し出し 1 段とそのボディが画面に出ている状態にする。 */
  function withSolidBody(): void {
    useAppStore.setState({
      ...createInitialDocumentState(),
      document: appendSolid(partWithPoint(), extrudeFeature('extrude-1')),
      bodies: [bodyFor('extrude-1')],
    });
  }

  it('立体を選んで割り当てると、割り当てが 1 件できる', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);

    const entries = appearanceOf(useAppStore.getState().document).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].target).toEqual({ kind: 'body', bodyFeatureId: 'extrude-1' });
    expect(useAppStore.getState().appearanceErrorKey).toBeNull();
  });

  it('外観の割り当ては再計算も計算中の札も起こさない(§2.3 の要)', async () => {
    withSolidBody();
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    expect(fake.calls).toHaveLength(1);

    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);

    expect(fake.calls).toHaveLength(1);
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('取り消し 1 回で外観が消える(FR-505)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);
    useAppStore.getState().undo();

    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('何も選ばずに割り当てると断り、文書は 1 バイトも変わらない(NFR-UX-5)', () => {
    withSolidBody();
    const before = useAppStore.getState().document;
    useAppStore.getState().assignAppearance(steel);

    expect(useAppStore.getState().appearanceErrorKey).toBe('appearanceError.noTarget');
    expect(useAppStore.getState().document).toBe(before);
  });

  it('選び直すと外観の断りは消える', () => {
    withSolidBody();
    useAppStore.getState().assignAppearance(steel);
    expect(useAppStore.getState().appearanceErrorKey).not.toBeNull();

    useAppStore.getState().setSelection(['extrude-1']);
    expect(useAppStore.getState().appearanceErrorKey).toBeNull();
  });

  it('割り当てを 1 つ外す(FR-1110)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);
    const id = appearanceOf(useAppStore.getState().document).entries[0].id;

    useAppStore.getState().removeAppearance(id);
    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('すべて既定に戻す(FR-1110)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);
    useAppStore.getState().setSelection([]);
    useAppStore.getState().clearAppearance();

    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('上流のフィーチャーを消すと、その立体を指す割り当ても消える', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(glass);
    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);

    useAppStore
      .getState()
      .applyDocument(removeSolid(useAppStore.getState().document, 'extrude-1'));

    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('抑制(一時的に外す)では割り当てを消さない(戻したときに色が失われないため)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(glass);

    const document = useAppStore.getState().document;
    const suppressed = {
      ...document,
      solids: document.solids.map((solid) =>
        solid.id === 'extrude-1' ? { ...solid, suppressed: true } : solid,
      ),
    };
    useAppStore.getState().applyDocument(suppressed);

    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);
  });
});

describe('3D スケッチのまま文書を差し替えたときの作図面(P4b タスク22b-(i))', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('3D スケッチのまま「新規」すると作図面は XY へ戻る', () => {
    /*
      Electron 台本の項目 10〜13 が落ちた不具合(統括の指示 2026-09-05)。3D スケッチのまま
      新規にすると作図面が「3D」のまま残り、次に描く矩形が
      「3D スケッチではこの形をかけません。」で必ず失敗していた。
    */
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);

    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('3D スケッチのまま取り消しても作図面は 3D のまま(同じ部品の中の移動なので降ろさない)', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);

    useAppStore.getState().undo();
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);
  });
});

describe('つまみの初回の案内(FR-507、利用者の決定①、P4b タスク22b-(a))', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    // 既読を「まだ見せていない」に戻す(端末に覚える欄なので検査ごとに初期化する)。
    useAppStore.setState({
      displaySettings: { ...useAppStore.getState().displaySettings, timelineHintSeen: false },
    });
  });

  it('ソリッドが初めて 2 段になったとき 1 回だけ帯に案内を出し、既読を覚える', () => {
    const one = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    const two = appendSolid(one, extrudeFeature('extrude-2'));

    // 1 段目では出さない(戻す先が無い)。
    useAppStore.getState().applyDocument(one);
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
    expect(useAppStore.getState().displaySettings.timelineHintSeen).toBe(false);

    // 2 段目で出る。
    useAppStore.getState().applyDocument(two);
    expect(useAppStore.getState().timelineNoticeKey).toBe('timeline.hint');
    expect(useAppStore.getState().displaySettings.timelineHintSeen).toBe(true);

    // 3 段目では出さない(既読になっている)。
    useAppStore.getState().applyDocument(appendSolid(two, extrudeFeature('extrude-3')));
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('既読なら二度と出さない', () => {
    useAppStore.setState({
      displaySettings: { ...useAppStore.getState().displaySettings, timelineHintSeen: true },
    });
    const one = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(one);
    useAppStore.getState().applyDocument(appendSolid(one, extrudeFeature('extrude-2')));
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });
});

/*
 * 測定の欄(FR-1102、P5 タスク31)。**測る・消すの操作はタスク32** で、ここが決めるのは
 * 「結果を持つ欄」と「いつ消えるか」だけ。要件の「モデルを変更するまで残る」を、
 * `affectsShape` の真偽そのままで固定する(§0.a-0.29)。
 */
describe('測定の結果の消え方(FR-1102、P5 タスク31)', () => {
  /** 40×30×10 の板の向かい合う面の距離(タスク30 の計算そのまま)。 */
  const MEASUREMENT: MeasurementState = {
    result: {
      kind: 'faceDistance',
      value: 10,
      unit: 'mm',
      segment: [
        [20, 15, 0],
        [20, 15, 10],
      ],
    },
    text: '10.000 mm',
    angle: null,
    anchor: null,
  };

  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('起動直後は何も測っていない', () => {
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('形が変わると消える', () => {
    useAppStore.setState({ measurement: MEASUREMENT });
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('外観だけを変えても残る(形は 1 ミリも動いていない)', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore.setState({ measurement: MEASUREMENT });

    const painted = assignBodyAppearance(
      useAppStore.getState().document,
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    useAppStore.getState().applyDocument(painted);

    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);
  });

  it('取り消しで形が戻ると消える', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore.setState({ measurement: MEASUREMENT });

    useAppStore.getState().undo();
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('外観だけの取り消し・やり直しでは残る(FR-505、FR-1110)', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore
      .getState()
      .applyDocument(
        assignBodyAppearance(
          useAppStore.getState().document,
          'extrude-1',
          appearanceFromPreset('steel'),
        ),
      );
    useAppStore.setState({ measurement: MEASUREMENT });

    useAppStore.getState().undo();
    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(0);
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);

    useAppStore.getState().redo();
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);
  });

  it('新しい部品にすると消える(前の部品の値は当てはまらない)', () => {
    useAppStore.setState({ measurement: MEASUREMENT });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().measurement).toBeNull();
  });
});

/*
 * 測る・消すの操作(FR-1101、FR-1102。P5 タスク32)。判断と組み立ては
 * `solid/measureCommands.ts` にあるので、ここが固定するのは**ストアの口の振る舞い**だけ
 * (置く・消す・断りを出す・形を測る手立てを差し出す)。
 */
describe('測る・消すの操作(FR-1101、FR-1102、P5 タスク32)', () => {
  const MEASUREMENT: MeasurementState = {
    result: { kind: 'bodyVolume', value: 12000, unit: 'mm3', segment: null },
    text: '12000.000 mm³',
    angle: null,
    anchor: [20, 15, 5],
  };

  const MASS = {
    bodyFeatureId: 'extrude-1',
    volume: 12000,
    area: 3400,
    centreOfMass: [20, 15, 5] as const,
    principalMoments: [1, 2, 3] as const,
  };

  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('測った値を置くと、前の断りは消える(押したら必ず何かが起きる)', () => {
    useAppStore.getState().setMeasureError('measureError.nothingSelected');
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);
    expect(useAppStore.getState().massProperties).toBe(MASS);
    expect(useAppStore.getState().measureErrorKey).toBeNull();
  });

  it('質量特性を渡さない置き方では、前の質量特性を持ち越さない', () => {
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore.getState().setMeasurement(MEASUREMENT);
    expect(useAppStore.getState().massProperties).toBeNull();
  });

  it('Esc で消す口は、測定と質量特性の両方を落とす(§0.a-0.68)', () => {
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore.getState().clearMeasurement();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(useAppStore.getState().massProperties).toBeNull();
  });

  it('何も測っていなければ消す口は何もしない(Esc の他の働きへ譲るため)', () => {
    const before = useAppStore.getState();
    useAppStore.getState().clearMeasurement();
    // 状態そのものが差し替わっていない(set を呼んでいない)ことまで見る。
    expect(useAppStore.getState()).toBe(before);
  });

  it('質量特性も形が変わると消える(体積・重心は形そのものの値)', () => {
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    expect(useAppStore.getState().massProperties).toBeNull();
  });

  it('外観だけを変えても質量特性は残る(材料を変えても形は動かない)', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore
      .getState()
      .applyDocument(
        assignBodyAppearance(
          useAppStore.getState().document,
          'extrude-1',
          appearanceFromPreset('aluminum'),
        ),
      );
    expect(useAppStore.getState().massProperties).toBe(MASS);
  });

  it('測れなかった理由は文書が変われば用済み(FR-504)', () => {
    useAppStore.getState().setMeasureError('measureError.tooMany');
    expect(useAppStore.getState().measureErrorKey).toBe('measureError.tooMany');
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    expect(useAppStore.getState().measureErrorKey).toBeNull();
  });

  it('形を測る手立てを差し出す・取り下げる(attachPartMeasure)', () => {
    const measurer: PartMeasurer = () =>
      Promise.resolve({ kind: 'failed', message: '測れませんでした。' });
    const detach = attachPartMeasure(measurer);
    expect(useAppStore.getState().partMeasurer).toBe(measurer);
    detach();
    expect(useAppStore.getState().partMeasurer).toBeNull();
  });

  it('別の手立てに差し替わった後の片付けは、新しい手立てを消さない', () => {
    const first: PartMeasurer = () => Promise.resolve({ kind: 'failed', message: '1' });
    const second: PartMeasurer = () => Promise.resolve({ kind: 'failed', message: '2' });
    const detachFirst = attachPartMeasure(first);
    attachPartMeasure(second);
    detachFirst();
    expect(useAppStore.getState().partMeasurer).toBe(second);
  });

  it('選んでいるものが測れなければ、理由を置いて何も出さない(NFR-UX-5)', async () => {
    useAppStore.getState().measureSelection();
    // 一覧から出せる判定なので、次のマイクロタスクで結果が入る。
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(useAppStore.getState().measureErrorKey).toBe('measureError.nothingSelected');
  });
});

describe('ビューの断面表示(FR-111、P6 タスク35)', () => {
  it('起動直後は切ってある(平面を 1 枚も持たない)', () => {
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('入れると今の作図面で切り、オフセット 0・表向きから始まる(§0.42)', () => {
    useAppStore.getState().setWorkPlane('xz');
    useAppStore.getState().toggleSectionView();
    const section = useAppStore.getState().sectionView;
    expect(section).not.toBeNull();
    expect(section?.plane).toEqual({
      kind: 'workPlane',
      planeId: 'xz',
      offset: expressionValueFromNumber(0),
    });
    expect(section?.offsetMm).toBe(0);
    expect(section?.flipped).toBe(false);
  });

  it('基準の 3 面でない作図面のときは XY から始める(解けない面で切らない)', () => {
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    useAppStore.getState().toggleSectionView();
    expect(useAppStore.getState().sectionView?.plane).toEqual({
      kind: 'workPlane',
      planeId: 'xy',
      offset: expressionValueFromNumber(0),
    });
  });

  it('もう一度押すと切れる(元の見た目に戻る)', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().toggleSectionView();
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('つまみ(オフセット)を動かしても文書は 1 バイトも変わらず、再計算も走らない', () => {
    const before = useAppStore.getState().document;
    const version = useAppStore.getState().documentVersion;
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().setSectionOffset(12.5);
    useAppStore.getState().flipSectionView();
    const state = useAppStore.getState();
    expect(state.sectionView?.offsetMm).toBe(12.5);
    expect(state.sectionView?.flipped).toBe(true);
    // 文書(形の正本)も、そこから導く控えも触っていない → 再計算は起きない。
    expect(state.document).toBe(before);
    expect(state.documentVersion).toBe(version);
    expect(state.isComputing).toBe(false);
  });

  it('数にならないオフセットは据え置く(0 除算や NaN を描画へ持ち込まない)', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().setSectionOffset(5);
    useAppStore.getState().setSectionOffset(Number.NaN);
    useAppStore.getState().setSectionOffset(Number.POSITIVE_INFINITY);
    expect(useAppStore.getState().sectionView?.offsetMm).toBe(5);
  });

  it('同じ値を入れ直しても札を作り直さない(描き直しを呼ばない、NFR-PF-1)', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().setSectionOffset(3);
    const first = useAppStore.getState().sectionView;
    useAppStore.getState().setSectionOffset(3);
    expect(useAppStore.getState().sectionView).toBe(first);
  });

  it('切ってあるあいだはオフセットも裏返しも効かない(null のまま)', () => {
    useAppStore.getState().setSectionOffset(9);
    useAppStore.getState().flipSectionView();
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('丸ごと差し替えられる(面を選び直す道はここを通る)', () => {
    useAppStore.getState().setSectionView({
      plane: { kind: 'workPlane', planeId: 'yz', offset: expressionValueFromNumber(0) },
      offsetMm: -4,
      flipped: true,
    });
    expect(useAppStore.getState().sectionView?.offsetMm).toBe(-4);
    useAppStore.getState().setSectionView(null);
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('新規(文書の作り直し)では持ち越さない', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().sectionView).toBeNull();
  });
});
