/**
 * コマンドラインの欄・候補・段への流し込み(計画書 docs/plans/P4b-スケッチの仕上げ.md
 * タスク18、FR-208、NFR-UX-1、NFR-UX-4、NFR-UX-7)。
 *
 * 受け入れ条件の「`L` → `0,0` → `@40,0` → `@30<90`」でマウスに触れずに L 字の 2 本の線が
 * 引けることを、ストアの中身で確かめる(画面は持たないので `.tsx` は使わない。
 * `docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して Node で検査する」)。
 */

import { resolveSketch, type Vec3 } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createNumericInput } from '../sketch/numericInput.js';
import { createInitialDocumentState, useAppStore } from '../store/useAppStore.js';
import {
  acceptedWordOf,
  COMMAND_HISTORY_LIMIT,
  commandSuggestions,
  nextFieldLabels,
  pushCommandHistory,
  stepCommandHistory,
  submitCommandLine,
} from './commandLineActions.js';

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
