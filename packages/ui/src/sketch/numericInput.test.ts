import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t, type MessageKey } from '../i18n/t.js';
import {
  applyNumericInputKey,
  buildCoordinateInput,
  commitNumericInput,
  commitValues,
  COORDINATE_MODES,
  createNumericInput,
  defaultModeForStep,
  evaluateNumericInput,
  fillDefaults,
  isCoordinateStep,
  MODE_LABEL_KEYS,
  MODE_TOOLTIP_KEYS,
  NUMERIC_INPUT_KEYS,
  NUMERIC_INPUT_STEPS,
  reduceNumericInput,
  STEP_TITLE_KEYS,
  UNIT_KEYS,
  valueByFieldKey,
  type NumericInputTransition,
} from './numericInput.js';

/** 判別共用体を検査で絞り込む。強制変換(as)を使わずに中身へ触るための小道具。 */
function expectCommitted(
  transition: NumericInputTransition,
): Extract<NumericInputTransition, { kind: 'committed' }> {
  if (transition.kind !== 'committed') {
    throw new Error(`expected committed transition, got ${transition.kind}`);
  }
  return transition;
}

function expectBlocked(
  transition: NumericInputTransition,
): Extract<NumericInputTransition, { kind: 'blocked' }> {
  if (transition.kind !== 'blocked') {
    throw new Error(`expected blocked transition, got ${transition.kind}`);
  }
  return transition;
}

function expectOpen(
  transition: NumericInputTransition,
): Extract<NumericInputTransition, { kind: 'open' }> {
  if (transition.kind !== 'open') {
    throw new Error(`expected open transition, got ${transition.kind}`);
  }
  return transition;
}

describe('その場数値入力の状態(NFR-UX-1〜5)', () => {
  it('点の既定は絶対座標の X・Y・Z、いずれも既定値 0(§2.9 の表)', () => {
    const state = createNumericInput('point', 'point');
    expect(state.mode).toBe('absolute');
    expect(state.fields.map((field) => field.key)).toEqual(['x', 'y', 'z']);
    expect(state.fields.map((field) => field.source)).toEqual(['0', '0', '0']);
    expect(state.focusedIndex).toBe(0);
  });

  it('線分の終点の既定は相対座標(FR-307)', () => {
    expect(defaultModeForStep('lineEnd')).toBe('relative');
    const state = createNumericInput('line', 'lineEnd');
    expect(state.fields.map((field) => field.key)).toEqual(['dx', 'dy', 'dz']);
  });

  it('円弧と点列は座標モードを持たず、専用の欄になる(§2.9 の表)', () => {
    expect(isCoordinateStep('arcShape')).toBe(false);
    const arc = createNumericInput('arc', 'arcShape');
    expect(arc.fields.map((field) => field.key)).toEqual(['radius', 'startAngle', 'endAngle']);
    expect(arc.fields.map((field) => field.source)).toEqual(['10', '0', '90']);
    const array = createNumericInput('pointArray', 'pointArrayShape');
    expect(array.fields.map((field) => field.key)).toEqual(['azimuth', 'spacing', 'count']);
    expect(array.fields.map((field) => field.source)).toEqual(['0', '10', '5']);
    // モードを変えようとしても何も起きない。
    expect(reduceNumericInput(arc, { type: 'setMode', mode: 'polar' })).toBe(arc);
  });

  it('Tab は欄を巡り、最後で先頭へ戻る(NFR-UX-2)', () => {
    let state = createNumericInput('point', 'point');
    state = reduceNumericInput(state, { type: 'tab', backwards: false });
    expect(state.focusedIndex).toBe(1);
    state = reduceNumericInput(state, { type: 'tab', backwards: false });
    state = reduceNumericInput(state, { type: 'tab', backwards: false });
    expect(state.focusedIndex).toBe(0);
    state = reduceNumericInput(state, { type: 'tab', backwards: true });
    expect(state.focusedIndex).toBe(2);
  });

  it('Tab / Shift+Tab はキー操作からも欄を巡る(NFR-UX-2)', () => {
    const state = createNumericInput('point', 'point');
    const forward = expectOpen(applyNumericInputKey(state, 'Tab')).state;
    expect(forward.focusedIndex).toBe(1);
    const backwards = expectOpen(applyNumericInputKey(state, 'ShiftTab')).state;
    // 先頭で Shift+Tab を押すと末尾へ回り、焦点はポップアップの外へ出ない。
    expect(backwards.focusedIndex).toBe(2);
  });

  it('焦点は欄を選んで移せる。範囲外の指定は無視する(NFR-UX-4)', () => {
    const state = createNumericInput('point', 'point');
    expect(reduceNumericInput(state, { type: 'focus', index: 2 }).focusedIndex).toBe(2);
    expect(reduceNumericInput(state, { type: 'focus', index: 3 })).toBe(state);
    expect(reduceNumericInput(state, { type: 'focus', index: -1 })).toBe(state);
    expect(reduceNumericInput(state, { type: 'edit', index: 5, source: '1' })).toBe(state);
  });

  it('モードを変えると欄の構成と既定値が変わる(FR-301〜303)', () => {
    let state = createNumericInput('point', 'point');
    state = reduceNumericInput(state, { type: 'edit', index: 0, source: '5' });
    state = reduceNumericInput(state, { type: 'setMode', mode: 'polar' });
    expect(state.fields.map((field) => field.key)).toEqual(['distance', 'azimuth', 'elevation']);
    expect(state.fields.map((field) => field.source)).toEqual(['10', '0', '0']);
    expect(state.focusedIndex).toBe(0);
  });

  it('Alt+1 / Alt+2 / Alt+3 でも座標モードを切り替えられる(§2.9)', () => {
    const state = createNumericInput('point', 'point');
    expect(COORDINATE_MODES).toEqual(['absolute', 'relative', 'polar']);
    expect(expectOpen(applyNumericInputKey(state, 'Alt2')).state.mode).toBe('relative');
    expect(expectOpen(applyNumericInputKey(state, 'Alt3')).state.mode).toBe('polar');
    // 同じモードを選び直しても入力は消えない。
    const edited = reduceNumericInput(state, { type: 'edit', index: 0, source: '5' });
    expect(expectOpen(applyNumericInputKey(edited, 'Alt1')).state).toBe(edited);
  });

  it('空欄は既定値として扱う。Enter 連打で意味のある結果になる(NFR-UX-4)', () => {
    let state = createNumericInput('arc', 'arcShape');
    state = reduceNumericInput(state, { type: 'edit', index: 0, source: '   ' });
    const evaluation = evaluateNumericInput(state);
    expect(evaluation.canCommit).toBe(true);
    expect(commitValues(evaluation)?.map((value) => value.value)).toEqual([10, 0, 90]);
  });

  it('空欄は確定のときに既定値の文字列で埋まる(NFR-UX-4)', () => {
    const state = createNumericInput('point', 'point');
    // 既定値のままなら埋める必要がないので、同じ状態をそのまま返す。
    expect(fillDefaults(state)).toBe(state);
    const cleared = reduceNumericInput(state, { type: 'edit', index: 1, source: '' });
    expect(fillDefaults(cleared).fields.map((field) => field.source)).toEqual(['0', '0', '0']);
    const committed = expectCommitted(applyNumericInputKey(cleared, 'Enter'));
    expect(committed.state.fields.map((field) => field.source)).toEqual(['0', '0', '0']);
    expect(committed.commit.values.map((value) => value.source)).toEqual(['0', '0', '0']);
  });

  it('式が使え、間違いは欄ごとに理由が付く(FR-201、FR-204、NFR-UX-5)', () => {
    let state = createNumericInput('point', 'point');
    state = reduceNumericInput(state, { type: 'edit', index: 0, source: '10*√2' });
    state = reduceNumericInput(state, { type: 'edit', index: 1, source: '1/0' });
    const evaluation = evaluateNumericInput(state);
    // 10・√2 = 14.142135623730951
    expect(evaluation.results[0].value?.value).toBeCloseTo(14.142135623730951, 9);
    expect(evaluation.results[1].error?.code).toBe('divisionByZero');
    expect(evaluation.results[1].error?.message).toBe('0 で割ることはできません。');
    expect(evaluation.canCommit).toBe(false);
    expect(evaluation.firstErrorIndex).toBe(1);
    expect(commitValues(evaluation)).toBeNull();
  });

  it('不正な欄が残っていると Enter で確定しない(NFR-UX-5)', () => {
    let state = createNumericInput('point', 'point');
    state = reduceNumericInput(state, { type: 'edit', index: 2, source: '1+' });
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.canCommit).toBe(false);
    expect(blocked.evaluation.firstErrorIndex).toBe(2);
    expect(blocked.evaluation.results[2].error?.code).toBe('unexpectedEnd');
    // 直せるように、最初に間違っている欄へ焦点を移す。
    expect(blocked.state.focusedIndex).toBe(2);
  });

  it('Esc は取消。作りかけの値は返さない(NFR-UX-3)', () => {
    const state = createNumericInput('point', 'point');
    const edited = reduceNumericInput(state, { type: 'edit', index: 0, source: '99' });
    expect(applyNumericInputKey(edited, 'Escape')).toEqual({ kind: 'cancelled' });
  });

  it('確定すると絶対座標の CoordinateInput になる(FR-301、FR-202)', () => {
    let state = createNumericInput('point', 'point');
    state = reduceNumericInput(state, { type: 'edit', index: 0, source: '10*√2' });
    state = reduceNumericInput(state, { type: 'edit', index: 1, source: '3/4' });
    const committed = expectCommitted(commitNumericInput(state));
    const { commit } = committed;
    expect(commit.kind).toBe('coordinate');
    if (commit.kind !== 'coordinate') {
      throw new Error(`expected coordinate commit, got ${commit.kind}`);
    }
    expect(commit.step).toBe('point');
    const { coordinate } = commit;
    expect(coordinate.mode).toBe('absolute');
    if (coordinate.mode !== 'absolute') {
      throw new Error(`expected absolute coordinate, got ${coordinate.mode}`);
    }
    // 式は文字列のまま持ち、評価値と対で保存する(FR-202)。
    expect(coordinate.x.source).toBe('10*√2');
    expect(coordinate.x.value).toBeCloseTo(14.142135623730951, 9);
    expect(coordinate.y.source).toBe('3/4');
    expect(coordinate.y.value).toBe(0.75);
    expect(coordinate.z.value).toBe(0);
  });

  it('相対・極の確定には基準点が入る(FR-302、FR-303)', () => {
    const relative = expectCommitted(
      commitNumericInput(createNumericInput('line', 'lineEnd'), {
        base: { kind: 'point', pointId: 'point-1' },
      }),
    ).commit;
    if (relative.kind !== 'coordinate' || relative.coordinate.mode !== 'relative') {
      throw new Error('expected relative coordinate commit');
    }
    expect(relative.coordinate.base).toEqual({ kind: 'point', pointId: 'point-1' });
    expect(relative.coordinate.dx.value).toBe(0);

    const polarState = reduceNumericInput(createNumericInput('point', 'point'), {
      type: 'setMode',
      mode: 'polar',
    });
    const polar = expectCommitted(commitNumericInput(polarState)).commit;
    if (polar.kind !== 'coordinate' || polar.coordinate.mode !== 'polar') {
      throw new Error('expected polar coordinate commit');
    }
    // 基準点を渡さなければ直前の点を使う(FR-307)。
    expect(polar.coordinate.base).toEqual({ kind: 'previous' });
    expect(polar.coordinate.distance.value).toBe(10);
    expect(polar.coordinate.azimuth.value).toBe(0);
    expect(polar.coordinate.elevation.value).toBe(0);
  });

  it('円弧・点列の確定は座標ではなく欄の値を返す(FR-305、FR-308)', () => {
    const arc = createNumericInput('arc', 'arcShape');
    const committed = expectCommitted(commitNumericInput(arc));
    const { commit } = committed;
    expect(commit.kind).toBe('shape');
    expect(commit.values.map((value) => value.value)).toEqual([10, 0, 90]);
    // 順序の取り違えを防ぐため、欄の名前でも引ける。
    expect(valueByFieldKey(committed.state, commit.values, 'radius')?.value).toBe(10);
    expect(valueByFieldKey(committed.state, commit.values, 'endAngle')?.value).toBe(90);
    expect(valueByFieldKey(committed.state, commit.values, 'spacing')).toBeUndefined();
  });

  it('欄が 3 つ揃わない指定では座標を組み立てない', () => {
    const value = { source: '1', value: 1, display: '1' };
    expect(buildCoordinateInput('absolute', [value, value], { kind: 'origin' })).toBeNull();
    expect(buildCoordinateInput('absolute', [value, value, value], { kind: 'origin' })).not.toBeNull();
  });

  it('ビューポートで拾った座標を欄へ入れられる(FR-107)、見出しは資源から引く', () => {
    let state = createNumericInput('point', 'point');
    state = reduceNumericInput(state, { type: 'setValues', values: [12.5, -3, 0] });
    expect(state.fields.map((field) => field.source)).toEqual(['12.5', '-3', '0']);
    expect(evaluateNumericInput(state).results[0].value?.value).toBe(12.5);
    expect(STEP_TITLE_KEYS.point).toBe('numericInput.title.point');
  });

  it('渡された数より欄が多いときは残りの欄をそのままにする(FR-107)', () => {
    const state = createNumericInput('point', 'point');
    const edited = reduceNumericInput(state, { type: 'edit', index: 2, source: '7' });
    const next = reduceNumericInput(edited, { type: 'setValues', values: [1, 2] });
    expect(next.fields.map((field) => field.source)).toEqual(['1', '2', '7']);
  });

  it('見出し・説明・単位・ボタンの文字列はすべて ja.json のキーで返す(NFR-MA-5)', () => {
    const keys: MessageKey[] = [
      ...Object.values(STEP_TITLE_KEYS),
      ...Object.values(MODE_LABEL_KEYS),
      ...Object.values(MODE_TOOLTIP_KEYS),
      ...Object.values(UNIT_KEYS),
      ...Object.values(NUMERIC_INPUT_KEYS),
    ];
    for (const step of NUMERIC_INPUT_STEPS) {
      const modes = isCoordinateStep(step) ? COORDINATE_MODES : [defaultModeForStep(step)];
      for (const mode of modes) {
        for (const field of createNumericInput('point', step, mode).fields) {
          keys.push(field.labelKey, field.tooltipKey);
        }
      }
    }
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(MESSAGE_KEYS).toContain(key);
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });
});
