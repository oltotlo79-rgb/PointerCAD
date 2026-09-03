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
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  findSketch,
  replaceSketch,
  resolveSketch,
  type ExtrudeFeature,
  type PartDocument,
  type PartRecomputeOptions,
  type PartRecomputeResult,
  type SketchDocument,
  type SketchRecomputeResult,
  type SolidBody,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeEach, describe, expect, it } from 'vitest';

import { setFeatureField } from '../sketch/featureSummary.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { HOME_ORBIT, type OrbitState } from '../viewport/cameraMath.js';
import {
  attachPartRecompute,
  createInitialDocumentState,
  useAppStore,
  workPlaneForOrbit,
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
  return { resolved: resolveSketch(sketch), mesh: null, errors: [] };
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
  };
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
