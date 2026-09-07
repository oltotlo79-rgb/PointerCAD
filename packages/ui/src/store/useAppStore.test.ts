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
  appendSolid,
  assignBodyAppearance,
  findSketch,
  type AppearanceMatchEntry,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createNumericInput,
} from '../sketch/numericInput.js';
import {
  EMPTY_SHAPE_DRAFT,
} from '../sketch/shapeCommands.js';
import {
  attachPartRecompute,
} from './attachKernel.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  createFakeRecompute,
  resultFor,
  sketchResultFor,
  tick,
  documentWithPoint,
  partWithPoint,
  extrudeFeature,
  partWithMixedFeatures,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

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

  it('推定した拘束の予告を持ち、道具を変えると落とす(FR-333、P6 タスク41)', () => {
    const preview = {
      featureId: 'line-1',
      constraints: [],
      marks: [],
    } as const;
    useAppStore.getState().setInferredConstraints(preview);
    expect(useAppStore.getState().inferredConstraints).toBe(preview);

    useAppStore.getState().setActiveTool('point');
    expect(useAppStore.getState().inferredConstraints).toBeNull();
  });

  it('欄を打ち直すと予告を落とす(打った線に合わない拘束を付けない、FR-333)', () => {
    const opened = createNumericInput('line', 'lineEnd');
    useAppStore.getState().openNumericInput(opened, [10, 20]);
    useAppStore.getState().setInferredConstraints({
      featureId: 'line-1',
      constraints: [],
      marks: [],
    });
    // 押した場所を欄へ入れる道(openNumericInput)では予告は残る。
    useAppStore.getState().openNumericInput({ ...opened, focusedIndex: 1 }, [10, 20]);
    expect(useAppStore.getState().inferredConstraints).not.toBeNull();

    // 打ち直す道(updateNumericInput)では落ちる。
    useAppStore.getState().updateNumericInput({ ...opened, focusedIndex: 2 });
    expect(useAppStore.getState().inferredConstraints).toBeNull();
  });

  it('連続してかくかどうかを切り替えられる(FR-307)', () => {
    useAppStore.getState().setChaining(false);
    expect(useAppStore.getState().chaining).toBe(false);
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
