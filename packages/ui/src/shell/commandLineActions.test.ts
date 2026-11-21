/**
 * コマンドラインの欄・候補・段への流し込み(計画書 docs/plans/P4b-スケッチの仕上げ.md
 * タスク18、FR-208、NFR-UX-1、NFR-UX-4、NFR-UX-7)。
 *
 * 受け入れ条件の「`L` → `0,0` → `@40,0` → `@30<90`」でマウスに触れずに L 字の 2 本の線が
 * 引けることを、ストアの中身で確かめる(画面は持たないので `.tsx` は使わない。
 * `docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して Node で検査する」)。
 */

import { createAssemblyDocument, createDrawingDocument, resolveSketch, type Vec3 } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as toolbarCommands from '../commands/toolbarCommandExecution.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  acceptedWordOf,
  commandSuggestions,
  nextFieldLabels,
  pushCommandHistory,
  stepCommandHistory,
  submitCommandLine,
  submitCommandTable,
} from './commandLineActions.js';

/** Pinned expected values: the same literals as the product constants, kept independent of them. */
const COMMAND_HISTORY_LIMIT = 20;

beforeEach(() => {
  useAppStore.setState({ ...createInitialDocumentState(), viewportSize: [1200, 800] });
});

/** いまのスケッチを解いて、線分の端点だけを取り出す。 */
function segments(): ReadonlyArray<{ from: Vec3; to: Vec3 }> {
  const resolved = resolveSketch(useAppStore.getState().sketch);
  return resolved.segments.map((segment) => ({ from: segment.from, to: segment.to }));
}

function closeTo(actual: Vec3, expected: readonly [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
  expect(actual[2]).toBeCloseTo(expected[2], 9);
}

describe('コマンドラインから道具を選ぶ(FR-208)', () => {
  it('`L` で線分の道具になり、1 段目(始点)が開く', () => {
    const outcome = submitCommandLine('L');
    expect(outcome).toEqual({ kind: 'tool', tool: 'line', openedStep: true });
    const store = useAppStore.getState();
    expect(store.activeTool).toBe('line');
    expect(store.numericInput?.step).toBe('lineStart');
    // 段はビューポートのほぼ中央へ出す(どこもクリックしていないため)。
    expect(store.numericInputAnchor).toEqual([600, 400]);
  });

  it('大文字小文字と日本語のどれで打っても同じ道具になる', () => {
    for (const word of ['line', 'LINE', '線分', 'l']) {
      useAppStore.setState({ ...createInitialDocumentState() });
      expect(submitCommandLine(word)).toMatchObject({ kind: 'tool', tool: 'line' });
    }
  });

  it('選択の道具は段を開かない(クリックで進む道具のため)', () => {
    const outcome = submitCommandLine('s');
    expect(outcome).toEqual({ kind: 'tool', tool: 'select', openedStep: false });
    expect(useAppStore.getState().numericInput).toBeNull();
  });

  it('先に対象を選ぶ道具(オフセット)は道具の切替だけを行う', () => {
    const outcome = submitCommandLine('o');
    expect(outcome).toEqual({ kind: 'tool', tool: 'offset', openedStep: false });
    expect(useAppStore.getState().activeTool).toBe('offset');
    expect(useAppStore.getState().numericInput).toBeNull();
  });

  it('知らない語は断り、前方一致の候補を添える(FR-204 と同じ流儀)', () => {
    const outcome = submitCommandLine('LL');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toBe('そのような道具はありません');
      expect(outcome.suggestions).toContain('l');
    }
    // 断っても道具は変えない。
    expect(useAppStore.getState().activeTool).toBe('select');
  });
});

describe('立体の語をツールバーと同じ入口で実行する', () => {
  beforeEach(() => {
    vi.spyOn(toolbarCommands, 'executeToolbarCommand');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('箱の入力段を開き、空の Enter で部品に箱ができる', () => {
    expect(submitCommandLine('BOX')).toEqual({ kind: 'tool', tool: 'box', openedStep: true });
    expect(toolbarCommands.executeToolbarCommand).toHaveBeenCalledExactlyOnceWith('toolbar.solidCreate.box');
    expect(useAppStore.getState().numericInput?.step).toBe('boxSize');
    expect(submitCommandLine('')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().document.solids).toHaveLength(1);
    expect(useAppStore.getState().document.solids[0]).toMatchObject({ kind: 'primitive', shape: { kind: 'box' } });
  });

  it('箱の寸法を既存の欄名で決め、選んだ箱と円柱の和を作る', () => {
    submitCommandLine('箱');
    expect(submitCommandLine('boxSizeX=37')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().document.solids[0]).toMatchObject({ shape: { kind: 'box', sizeX: { value: 37 } } });
    submitCommandLine('cyl');
    expect(submitCommandLine('')).toEqual({ kind: 'committed' });
    const ids = useAppStore.getState().document.solids.map(solid => solid.id);
    expect(ids).toHaveLength(2);
    useAppStore.getState().setSelection(ids);
    expect(submitCommandLine('uni')).toEqual({ kind: 'tool', tool: 'select', openedStep: false });
    expect(toolbarCommands.executeToolbarCommand).toHaveBeenLastCalledWith('toolbar.solidCombine.union');
    const combined = useAppStore.getState().document.solids.at(-1);
    expect(combined).toMatchObject({ kind: 'boolean', operation: 'union', targetFeatureId: ids[0], toolFeatureId: ids[1] });
    expect(useAppStore.getState().selection).toEqual([combined?.id]);
  });

  it.each([
    ['ext', 'toolbar.solidCreate.extrude', 'extrude', 'solidError.noFace'],
    ['穴', 'toolbar.solidMachining.hole', 'hole', 'machiningError.noFace'],
  ] as const)('%s は対象の選択待ちになり、帯に今回の理由が出る', (word, commandId, tool, reason) => {
    const original = useAppStore.getState().document;
    useAppStore.getState().setFileMessage({ key: 'command.unavailable.action', failed: true });
    expect(submitCommandLine(word)).toEqual({ kind: 'tool', tool, openedStep: false });
    expect(toolbarCommands.executeToolbarCommand).toHaveBeenCalledExactlyOnceWith(commandId);
    const state = useAppStore.getState();
    expect(state.activeTool).toBe(tool);
    expect(state.fileMessage).toBeNull();
    expect(state.solidErrorKey).toBe(reason);
    expect(state.numericInput).toBeNull();
    expect(state.document).toBe(original);
  });

  it('対象の足りない和は元の帯の理由を保ち、開いていた段も文書も変えない', () => {
    submitCommandLine('L');
    const before = useAppStore.getState();
    expect(submitCommandLine('和')).toEqual({ kind: 'error', message: 'ソリッドを 2 つ選んでください。', suggestions: [] });
    expect(toolbarCommands.executeToolbarCommand).toHaveBeenCalledExactlyOnceWith('toolbar.solidCombine.union');
    const state = useAppStore.getState();
    expect(state.solidErrorKey).toBe('solidError.needTwoBodies');
    expect(state.numericInput).toBe(before.numericInput);
    expect(state.document).toBe(before.document);
    expect(state.canUndo).toBe(false);
  });

  it.each(['assembly', 'drawing'] as const)('%s では箱を開かずに文書の種類を理由として返す', kind => {
    const store = useAppStore.getState();
    if (kind === 'assembly') {
      store.openAssembly(createAssemblyDocument('組立'));
    } else {
      store.openDrawing(createDrawingDocument('図面', {
        sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
      }));
    }
    const before = useAppStore.getState();
    expect(submitCommandLine('box')).toEqual({
      kind: 'error', message: '「箱」を開始できません。この画面では使えません。対象の画面へ切り替えてください。', suggestions: [],
    });
    expect(toolbarCommands.executeToolbarCommand).toHaveBeenCalledExactlyOnceWith('toolbar.solidCreate.box');
    expect(useAppStore.getState()).toBe(before);
  });

  it('立体の候補を採ると、Tab で入る語をそのまま実行できる', () => {
    const [first] = commandSuggestions('CyL');
    expect(first.labelKey).toBe('toolbar.solid.cylinder');
    expect(acceptedWordOf(first, 'CyL')).toBe('cylinder');
    expect(submitCommandLine(acceptedWordOf(first, 'CyL'))).toEqual({ kind: 'tool', tool: 'cylinder', openedStep: true });
  });
});

describe('選びの語でマウスを使わずに立体を選ぶ(M06-2)', () => {
  function makeBoxAndCylinder(): readonly string[] {
    submitCommandLine('box');
    submitCommandLine('');
    submitCommandLine('cyl');
    submitCommandLine('');
    return useAppStore.getState().document.solids.map(solid => solid.id);
  }

  it('箱 → 円柱 → `sel all` → `uni` で、マウスを使わずに和を作れる', () => {
    const ids = makeBoxAndCylinder();
    expect(ids).toHaveLength(2);
    expect(submitCommandLine('sel all')).toEqual({ kind: 'selected', count: 2 });
    expect(useAppStore.getState().selection).toEqual(ids);
    expect(useAppStore.getState().selectionKind).toBe('body');
    expect(submitCommandLine('uni')).toEqual({ kind: 'tool', tool: 'select', openedStep: false });
    expect(useAppStore.getState().document.solids.at(-1))
      .toMatchObject({ kind: 'boolean', operation: 'union', targetFeatureId: ids[0], toolFeatureId: ids[1] });
  });

  it('「選ぶ 直前」は最後に作った立体を選び、和で使われた立体は直前にも全部にも数えない', () => {
    const ids = makeBoxAndCylinder();
    expect(submitCommandLine('選ぶ　直前')).toEqual({ kind: 'selected', count: 1 });
    expect(useAppStore.getState().selection).toEqual([ids[1]]);
    useAppStore.getState().setSelection(ids);
    submitCommandLine('uni');
    const combined = useAppStore.getState().document.solids.at(-1);
    useAppStore.getState().setSelection([]);
    expect(submitCommandLine('SEL LAST')).toEqual({ kind: 'selected', count: 1 });
    expect(useAppStore.getState().selection).toEqual([combined?.id]);
    expect(submitCommandLine('sel all')).toEqual({ kind: 'selected', count: 1 });
    expect(useAppStore.getState().selection).toEqual([combined?.id]);
  });

  it('「sel none」は選択を空にする(立体が無くても通る)', () => {
    useAppStore.getState().setSelection(['face-1']);
    expect(submitCommandLine('sel none')).toEqual({ kind: 'selected', count: 0 });
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('選べる立体が無い時と組立の画面では断り、選択を変えない', () => {
    const before = useAppStore.getState().selection;
    expect(submitCommandLine('選ぶ 全部')).toEqual({ kind: 'error', message: '選べる立体がありません。先に立体を作ってください。', suggestions: [] });
    expect(useAppStore.getState().selection).toBe(before);
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
    const assembly = useAppStore.getState().selection;
    expect(submitCommandLine('sel last')).toEqual({ kind: 'error', message: '選べる立体がありません。先に立体を作ってください。', suggestions: [] });
    expect(useAppStore.getState().selection).toBe(assembly);
  });
});

describe('受け入れ条件: マウスに触れずに L 字の 2 本の線を引く(FR-208、FR-307)', () => {
  it('`L` → `0,0` → `@40,0` → `@30<90` で 2 本の線分ができる', () => {
    expect(submitCommandLine('L')).toMatchObject({ kind: 'tool' });

    // 始点。まだ履歴は増えず、次の段(終点)が開く。
    expect(submitCommandLine('0,0')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().sketch.features).toHaveLength(0);
    expect(useAppStore.getState().numericInput?.step).toBe('lineEnd');

    // 1 本目の終点(直前の点からのずれ)。
    expect(submitCommandLine('@40,0')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().sketch.features).toHaveLength(1);

    // 2 本目の終点(距離と角度)。続けてかく(FR-307)ので段は開いたまま。
    expect(submitCommandLine('@30<90')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().sketch.features).toHaveLength(2);
    expect(useAppStore.getState().numericInput?.step).toBe('lineEnd');

    const drawn = segments();
    expect(drawn).toHaveLength(2);
    closeTo(drawn[0].from, [0, 0, 0]);
    closeTo(drawn[0].to, [40, 0, 0]);
    closeTo(drawn[1].from, [40, 0, 0]);
    closeTo(drawn[1].to, [40, 30, 0]);
  });

  it('`C` → `0,0` → `r=20` で半径 20 の円ができる', () => {
    expect(submitCommandLine('C')).toMatchObject({ kind: 'tool', tool: 'circle' });
    expect(submitCommandLine('0,0')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().numericInput?.step).toBe('circleRadius');
    expect(submitCommandLine('r=20')).toEqual({ kind: 'committed' });

    // 円は「全周の円弧」として履歴へ積まれる(model の SketchArcFeature)。
    const [feature] = useAppStore.getState().sketch.features;
    expect(feature.kind).toBe('arc');
    const resolved = resolveSketch(useAppStore.getState().sketch);
    expect(resolved.arcs[0].radius).toBeCloseTo(20, 9);
  });

  it('空の Enter は欄の既定値のまま確定する(NFR-UX-4)', () => {
    submitCommandLine('C');
    submitCommandLine('0,0');
    // 半径の既定値のまま決める。
    expect(submitCommandLine('')).toEqual({ kind: 'committed' });
    expect(useAppStore.getState().sketch.features).toHaveLength(1);
  });
});

describe('欄への流し込みの断り(NFR-UX-5)', () => {
  it('段が開いていないのに座標を打ったら断る', () => {
    const outcome = submitCommandLine('10,20');
    expect(outcome).toEqual({
      kind: 'error',
      message: '先に道具を打ってください。',
      suggestions: [],
    });
  });

  it('座標を聞いていない段(円の半径)で座標を打ったら断る', () => {
    submitCommandLine('C');
    submitCommandLine('0,0');
    const outcome = submitCommandLine('10,20');
    expect(outcome).toMatchObject({ kind: 'error', message: 'いまは座標を聞いていません。' });
    // 断っても履歴は増えない。
    expect(useAppStore.getState().sketch.features).toHaveLength(0);
  });

  it('その段に無い名前の欄を打ったら断る', () => {
    submitCommandLine('C');
    submitCommandLine('0,0');
    const outcome = submitCommandLine('n=6');
    expect(outcome).toMatchObject({ kind: 'error', message: 'その名前の欄はありません。' });
  });

  it('範囲の外の値は決めさせず、理由をそのまま返す(NFR-UX-5)', () => {
    submitCommandLine('C');
    submitCommandLine('0,0');
    const outcome = submitCommandLine('r=0');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('半径');
    }
    expect(useAppStore.getState().sketch.features).toHaveLength(0);
    // 打った値は欄に残る(打ち直せる)。
    expect(useAppStore.getState().numericInput?.fields[0].source).toBe('0');
  });

  it('直前の点が無いのに `@` を打ったら断る', () => {
    submitCommandLine('L');
    const outcome = submitCommandLine('@5,0');
    expect(outcome).toMatchObject({ kind: 'error', message: '直前の点がありません' });
  });
});

describe('候補と、次に打つものの案内(§0.a-0.11)', () => {
  it('`c` の候補は円が 1 件目で、最大 5 件', () => {
    const found = commandSuggestions('c');
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(5);
    expect(found[0].tool).toBe('circle');
  });

  it('座標や名前付きの欄を打ち始めたら候補は出さない', () => {
    expect(commandSuggestions('10,20')).toEqual([]);
    expect(commandSuggestions('r=5')).toEqual([]);
    expect(commandSuggestions('  ')).toEqual([]);
  });

  it('候補を採ると、打ちかけと同じ書き方の語が欄へ入る', () => {
    const [first] = commandSuggestions('circ');
    expect(acceptedWordOf(first, 'circ')).toBe('circle');
    // 打ちかけと合う語が無ければ、いちばん短い語(短縮)を採る。
    expect(acceptedWordOf(first)).toBe('円');
  });

  it('次に打つものの案内は、開いている段の欄名をそのまま出す', () => {
    expect(nextFieldLabels(null)).toEqual([]);
    expect(nextFieldLabels(createNumericInput('line', 'lineStart'))).toEqual(['X', 'Y', 'Z']);
    expect(nextFieldLabels(createNumericInput('circle', 'circleRadius'))).toEqual(['半径']);
  });
});

describe('履歴(20 件、保存しない。§0.a-0.11)', () => {
  it('新しいものが先頭で、20 件を超えたら古いものから落ちる', () => {
    let history: readonly string[] = [];
    for (let index = 0; index < 25; index += 1) {
      history = pushCommandHistory(history, `line${String(index)}`);
    }
    expect(history).toHaveLength(COMMAND_HISTORY_LIMIT);
    expect(history[0]).toBe('line24');
    expect(history[COMMAND_HISTORY_LIMIT - 1]).toBe('line5');
  });

  it('空行と、直前とまったく同じ語は積まない', () => {
    const once = pushCommandHistory([], 'L');
    expect(pushCommandHistory(once, '   ')).toBe(once);
    expect(pushCommandHistory(once, 'L')).toBe(once);
    expect(pushCommandHistory(once, '0,0')).toEqual(['0,0', 'L']);
  });

  it('↑ でさかのぼり、↓ で戻る。端では止まる', () => {
    const history = ['@40,0', '0,0', 'L'];
    const first = stepCommandHistory(history, -1, true);
    expect(first).toEqual({ index: 0, text: '@40,0' });
    expect(stepCommandHistory(history, 0, true)).toEqual({ index: 1, text: '0,0' });
    // いちばん古いところで ↑ を押しても、そこから動かない。
    expect(stepCommandHistory(history, 2, true)).toEqual({ index: 2, text: 'L' });
    // いちばん新しいところで ↓ を押すと、いま打っている行(空)へ戻る。
    expect(stepCommandHistory(history, 0, false)).toEqual({ index: -1, text: '' });
  });
});

describe('座標の表をまとめて確定する', () => {
  it.each(['select', 'point'] as const)('%s で 3 点を作り、1 回の Undo で全部戻す', (tool) => {
    submitCommandLine(tool);
    const before = useAppStore.getState();
    expect(submitCommandTable('X,Y\n0,0\n3,4\n7,8')).toEqual({ kind: 'created', count: 3 });
    const after = useAppStore.getState();
    expect(resolveSketch(after.sketch).points.map((entry) => entry.position)).toEqual([
      [0, 0, 0], [3, 4, 0], [7, 8, 0],
    ]);
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    after.undo();
    expect(useAppStore.getState().document).toBe(before.document);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(after.document);
  });

  it('表の先頭から順に 2 本をつなぎ、1 回の Undo で元の文書に戻す', () => {
    submitCommandLine('L');
    submitCommandLine('80,90');
    useAppStore.setState({ chaining: false });
    useAppStore.getState().setInferredConstraints({ featureId: 'line-1', marks: [], constraints: [{
      kind: 'horizontal', relatedId: null, markerAt: [0, 0],
      target: { kind: 'curve', element: { featureId: 'line-1' } },
    }] });
    const before = useAppStore.getState();
    expect(submitCommandTable('1,2\n11,2\n11,7')).toEqual({ kind: 'created', count: 2 });
    expect(segments()).toEqual([
      { from: [1, 2, 0], to: [11, 2, 0] }, { from: [11, 2, 0], to: [11, 7, 0] },
    ]);
    const after = useAppStore.getState();
    expect(after.pendingStart).toBeNull();
    expect(after.numericInput).toBeNull();
    expect(after.inferredConstraints).toBeNull();
    expect(after.sketch.constraints ?? []).toEqual([]);
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    after.undo();
    expect(useAppStore.getState().document).toBe(before.document);
  });

  it('途中の式が壊れていれば元の行を知らせ、1 点も作らない', () => {
    submitCommandLine('po');
    const before = useAppStore.getState();
    const result = submitCommandTable('X,Y\n1,2\n\n未定義,5\n7,8');
    if (result.kind !== 'error') throw new Error('読めない座標を確定しました');
    expect(result.message).toContain('4 行目');
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.numericInput).toBe(before.numericInput);
  });

  it('前半の線を作れても後半の交点が拘束済みなら表全体を断る', () => {
    submitCommandLine('L');
    submitCommandLine('-5,0');
    submitCommandLine('5,0');
    const state = useAppStore.getState();
    const first = state.sketch.features[0];
    state.setSketch({ ...state.sketch, constraints: [{ id: 'c1', name: '水平', kind: 'horizontal',
      target: { kind: 'curve', element: { featureId: first.id } } }] });
    const before = useAppStore.getState();
    const result = submitCommandTable('-2,-2\n0,-2\n0,2');
    if (result.kind !== 'error') throw new Error('拘束の付いた線を分割しました');
    expect(result.message).toContain('3 行目');
    expect(result.message).toContain('交わる線に拘束があります');
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.pendingStart).toBe(before.pendingStart);
    expect(after.numericInput).toBe(before.numericInput);
  });

  it('線分で座標が 1 個だけの表と、別の道具での貼り付けを断る', () => {
    submitCommandLine('L');
    const before = useAppStore.getState();
    expect(submitCommandTable('0,0\n')).toMatchObject({ kind: 'error' });
    submitCommandLine('C');
    expect(submitCommandTable('1,2\n3,4')).toEqual({
      kind: 'error', message: '部品で点・線分・選択の道具を選んでください。', suggestions: [],
    });
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
});
