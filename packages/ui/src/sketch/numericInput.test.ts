import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t, type MessageKey } from '../i18n/t.js';
import {
  applyNumericInputKey,
  buildCoordinateInput,
  chooseNumericInput,
  commitNumericInput,
  commitValues,
  COORDINATE_MODES,
  createNumericInput,
  defaultModeForStep,
  evaluateNumericInput,
  fillDefaults,
  focusedTarget,
  isCoordinateStep,
  isSolidStep,
  MODE_LABEL_KEYS,
  MODE_TOOLTIP_KEYS,
  nextNumericInput,
  NUMERIC_INPUT_KEYS,
  NUMERIC_INPUT_STEPS,
  numericFocusTargets,
  reduceNumericInput,
  SOLID_TOOL_STEPS,
  STEP_TITLE_KEYS,
  toggleNumericInput,
  UNIT_KEYS,
  valueByFieldKey,
  type NumericInputState,
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

function expectSolidCommitted(
  transition: NumericInputTransition,
): Extract<NumericInputTransition, { kind: 'solidCommitted' }> {
  if (transition.kind !== 'solidCommitted') {
    throw new Error(`expected solidCommitted transition, got ${transition.kind}`);
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
        const state = createNumericInput('point', step, mode, {
          axisLine: { sketchId: 'sketch-1', lineFeatureId: 'line-1' },
        });
        for (const field of state.fields) {
          keys.push(field.labelKey, field.tooltipKey);
        }
        for (const toggle of state.toggles) {
          keys.push(toggle.labelKey);
        }
        for (const option of state.choice?.options ?? []) {
          keys.push(option.labelKey);
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

describe('決めた後に続けて聞くこと(§2.9「確定した後」、FR-307)', () => {
  it('2 段階の道具は、前半を決めたら「続けてかく」の入切に関わらず後半へ進む', () => {
    const pairs = [
      ['line', 'lineStart', 'lineEnd'],
      ['arc', 'arcCenter', 'arcShape'],
      ['pointArray', 'pointArrayBase', 'pointArrayShape'],
    ] as const;
    for (const [toolId, step, expected] of pairs) {
      for (const chaining of [false, true]) {
        const next = nextNumericInput(createNumericInput(toolId, step), chaining);
        expect(next?.step, `${step} → ${expected}`).toBe(expected);
        expect(next?.toolId).toBe(toolId);
      }
    }
  });

  it('「続けてかく」が切なら、ひと組を終えたところで閉じる', () => {
    const endings = ['point', 'lineEnd', 'arcShape', 'pointArrayShape'] as const;
    for (const step of endings) {
      expect(nextNumericInput(createNumericInput('point', step), false), step).toBeNull();
    }
  });

  it('「続けてかく」が入なら、次のひと組の最初の段階へ戻る(FR-307)', () => {
    expect(nextNumericInput(createNumericInput('line', 'lineEnd'), true)?.step).toBe('lineEnd');
    expect(nextNumericInput(createNumericInput('arc', 'arcShape'), true)?.step).toBe('arcCenter');
    expect(nextNumericInput(createNumericInput('pointArray', 'pointArrayShape'), true)?.step).toBe(
      'pointArrayBase',
    );
  });

  it('点は同じ座標モードのまま次の点を聞く(打ち直しの手間を増やさない)', () => {
    const polar = createNumericInput('point', 'point', 'polar');
    const next = nextNumericInput(polar, true);
    expect(next?.step).toBe('point');
    expect(next?.mode).toBe('polar');
    // 欄は既定値へ戻る。前の点の値をそのまま足し続けないため。
    expect(next?.fields.map((field) => field.source)).toEqual(['10', '0', '0']);
  });

  it('線分の終点は続けても相対のまま(直前の端からの続きが自然、FR-307)', () => {
    const next = nextNumericInput(createNumericInput('line', 'lineEnd'), true);
    expect(next?.mode).toBe('relative');
    expect(next?.focusedIndex).toBe(0);
  });
});

/** 欄へ式を打つ。ポップアップと同じ道筋を通す。 */
function edited(state: NumericInputState, source: string, index = 0): NumericInputState {
  return reduceNumericInput(state, { type: 'edit', index, source });
}

describe('ソリッドの段の欄と既定値(§0.a-0.8 / 0.9 / 0.7、NFR-UX-4)', () => {
  it('道具から段が引ける。ソリッドの段は座標を聞かない', () => {
    expect(SOLID_TOOL_STEPS).toEqual({
      extrude: 'extrudeDistance',
      revolve: 'revolveAngle',
      sew: 'sewTolerance',
    });
    for (const step of Object.values(SOLID_TOOL_STEPS)) {
      expect(isSolidStep(step), step).toBe(true);
      expect(isCoordinateStep(step), step).toBe(false);
    }
    expect(isSolidStep('point')).toBe(false);
  });

  it('押し出しは長さ 1 欄(既定 10)と、反転・両側の 2 つのつまみ(§0.a-0.8)', () => {
    const state = createNumericInput('extrude', 'extrudeDistance');
    expect(state.toolId).toBe('extrude');
    expect(state.fields.map((field) => field.key)).toEqual(['distance']);
    expect(state.fields.map((field) => field.source)).toEqual(['10']);
    expect(state.fields[0].unit).toBe('mm');
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['reversed', 'symmetric']);
    expect(state.toggles.map((toggle) => toggle.value)).toEqual([false, false]);
    expect(state.choice).toBeNull();
    expect(STEP_TITLE_KEYS.extrudeDistance).toBe('numericInput.title.extrude');
  });

  it('回転は角度 1 欄(既定 360)と反転のつまみ、軸は X / Y / Z で既定 Z(§0.a-0.9)', () => {
    const state = createNumericInput('revolve', 'revolveAngle');
    expect(state.fields.map((field) => field.key)).toEqual(['angle']);
    expect(state.fields.map((field) => field.source)).toEqual(['360']);
    expect(state.fields[0].unit).toBe('degree');
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['reversed']);
    expect(state.choice?.key).toBe('axis');
    expect(state.choice?.value).toBe('z');
    expect(state.choice?.options.map((option) => option.value)).toEqual(['x', 'y', 'z']);
    expect(state.choice?.options.map((option) => option.axis)).toEqual([
      { kind: 'world', axis: 'x' },
      { kind: 'world', axis: 'y' },
      { kind: 'world', axis: 'z' },
    ]);
    expect(STEP_TITLE_KEYS.revolveAngle).toBe('numericInput.title.revolve');
  });

  it('縫合は許容量 1 欄(既定 0.01)だけで、つまみも選択肢も無い(§0.a-0.7)', () => {
    const state = createNumericInput('sew', 'sewTolerance');
    expect(state.fields.map((field) => field.key)).toEqual(['tolerance']);
    expect(state.fields.map((field) => field.source)).toEqual(['0.01']);
    expect(state.toggles).toEqual([]);
    expect(state.choice).toBeNull();
    expect(STEP_TITLE_KEYS.sewTolerance).toBe('numericInput.title.sew');
  });

  it('線分が選ばれているときだけ、軸の選択肢に線分が増える(§0.a-0.9)', () => {
    const line = { sketchId: 'sketch-1', lineFeatureId: 'line-1' };
    const state = createNumericInput('revolve', 'revolveAngle', 'absolute', { axisLine: line });
    expect(state.choice?.options.map((option) => option.value)).toEqual(['x', 'y', 'z', 'line']);
    expect(state.choice?.options[3].axis).toEqual({ kind: 'line', line });
    // 線分を渡さない押し出し・縫合には選択肢が生えない。
    expect(createNumericInput('extrude', 'extrudeDistance', 'absolute', { axisLine: line }).choice)
      .toBeNull();
  });

  it('ソリッドの段は座標モードを持たず、モード切替でも欄が変わらない', () => {
    const state = createNumericInput('extrude', 'extrudeDistance');
    expect(state.mode).toBe('absolute');
    expect(reduceNumericInput(state, { type: 'setMode', mode: 'polar' })).toBe(state);
  });

  it('P1 の段はつまみも選択肢も持たない(P1 の振る舞いを変えない)', () => {
    for (const step of ['point', 'lineEnd', 'arcShape', 'pointArrayShape'] as const) {
      const state = createNumericInput('point', step);
      expect(state.toggles, step).toEqual([]);
      expect(state.choice, step).toBeNull();
    }
  });
});

describe('つまみと選択肢の操作(NFR-UX-2)', () => {
  it('つまみは 2 回切り替えると元へ戻り、元の状態は書き換わらない', () => {
    const state = createNumericInput('extrude', 'extrudeDistance');
    const once = toggleNumericInput(state, 'reversed');
    expect(once.toggles.map((toggle) => toggle.value)).toEqual([true, false]);
    // 元の状態はそのまま(不変)。
    expect(state.toggles.map((toggle) => toggle.value)).toEqual([false, false]);
    const twice = toggleNumericInput(once, 'reversed');
    expect(twice.toggles).toEqual(state.toggles);
    // 持っていないつまみを指しても何も起きない。
    expect(toggleNumericInput(state, 'symmetric').toggles[1].value).toBe(true);
    expect(toggleNumericInput(createNumericInput('sew', 'sewTolerance'), 'reversed').toggles)
      .toEqual([]);
  });

  it('選択肢を選んでも欄の値は変わらない。知らない値は無視する', () => {
    const state = edited(createNumericInput('revolve', 'revolveAngle'), '90');
    const chosen = chooseNumericInput(state, 'x');
    expect(chosen.choice?.value).toBe('x');
    expect(chosen.fields.map((field) => field.source)).toEqual(['90']);
    expect(state.choice?.value).toBe('z');
    // 選択肢に無い値(線分が選ばれていない)は無視する。
    expect(chooseNumericInput(state, 'line')).toBe(state);
    // 選択肢を持たない段では何も起きない。
    expect(chooseNumericInput(createNumericInput('sew', 'sewTolerance'), 'x').choice).toBeNull();
  });

  it('Tab の巡回に欄・選択肢・つまみが並ぶ(NFR-UX-2)', () => {
    const extrude = createNumericInput('extrude', 'extrudeDistance');
    expect(numericFocusTargets(extrude)).toEqual([
      { kind: 'field', index: 0 },
      { kind: 'toggle', index: 0 },
      { kind: 'toggle', index: 1 },
    ]);
    const revolve = createNumericInput('revolve', 'revolveAngle');
    expect(numericFocusTargets(revolve)).toEqual([
      { kind: 'field', index: 0 },
      { kind: 'choice' },
      { kind: 'toggle', index: 0 },
    ]);
    expect(numericFocusTargets(createNumericInput('sew', 'sewTolerance'))).toEqual([
      { kind: 'field', index: 0 },
    ]);
    // 3 回 Tab を押すと先頭へ戻る。焦点はポップアップの外へ出ない。
    let state = extrude;
    for (const expected of [1, 2, 0]) {
      state = expectOpen(applyNumericInputKey(state, 'Tab')).state;
      expect(state.focusedIndex).toBe(expected);
    }
    expect(expectOpen(applyNumericInputKey(extrude, 'ShiftTab')).state.focusedIndex).toBe(2);
  });

  it('P1 の段の巡回は欄だけのまま(既存の振る舞いを変えない)', () => {
    expect(numericFocusTargets(createNumericInput('point', 'point'))).toEqual([
      { kind: 'field', index: 0 },
      { kind: 'field', index: 1 },
      { kind: 'field', index: 2 },
    ]);
  });

  it('Space は焦点のつまみを切り替える。欄に焦点があるときは何も起きない', () => {
    const state = createNumericInput('extrude', 'extrudeDistance');
    // 焦点は欄なので Space は素通し(欄には空白がそのまま入る)。
    expect(expectOpen(applyNumericInputKey(state, 'Space')).state).toBe(state);
    const onReversed = reduceNumericInput(state, { type: 'focus', index: 1 });
    expect(focusedTarget(onReversed)).toEqual({ kind: 'toggle', index: 0 });
    const flipped = expectOpen(applyNumericInputKey(onReversed, 'Space')).state;
    expect(flipped.toggles.map((toggle) => toggle.value)).toEqual([true, false]);
    const onSymmetric = reduceNumericInput(flipped, { type: 'focus', index: 2 });
    expect(
      expectOpen(applyNumericInputKey(onSymmetric, 'Space')).state.toggles.map((t2) => t2.value),
    ).toEqual([true, true]);
  });

  it('← → は焦点の選択肢を動かし、端では回り込む', () => {
    const state = createNumericInput('revolve', 'revolveAngle');
    const onChoice = reduceNumericInput(state, { type: 'focus', index: 1 });
    expect(focusedTarget(onChoice)).toEqual({ kind: 'choice' });
    // 既定は z(3 つ目)。→ で先頭の x へ回り込む。
    expect(expectOpen(applyNumericInputKey(onChoice, 'ArrowRight')).state.choice?.value).toBe('x');
    expect(expectOpen(applyNumericInputKey(onChoice, 'ArrowLeft')).state.choice?.value).toBe('y');
    // 焦点が欄のときは欄の中のカーソル移動を邪魔しない。
    expect(expectOpen(applyNumericInputKey(state, 'ArrowLeft')).state).toBe(state);
  });

  it('焦点はつまみ・選択肢まで含めて数え、範囲外は無視する', () => {
    const revolve = createNumericInput('revolve', 'revolveAngle');
    expect(reduceNumericInput(revolve, { type: 'focus', index: 2 }).focusedIndex).toBe(2);
    expect(reduceNumericInput(revolve, { type: 'focus', index: 3 })).toBe(revolve);
    expect(focusedTarget(reduceNumericInput(revolve, { type: 'focus', index: 2 }))).toEqual({
      kind: 'toggle',
      index: 0,
    });
  });
});

describe('ソリッドの確定結果(FR-201、FR-202、§0.a-0.8 / 0.9 / 0.7)', () => {
  it('押し出しは長さと 2 つのつまみを返す。式は文字列のまま持つ(FR-202)', () => {
    const state = toggleNumericInput(
      edited(createNumericInput('extrude', 'extrudeDistance'), '5*2'),
      'symmetric',
    );
    const { commit } = expectSolidCommitted(commitNumericInput(state));
    expect(commit.kind).toBe('solid');
    expect(commit.tool).toBe('extrude');
    expect(commit.step).toBe('extrudeDistance');
    expect(commit.values.distance?.source).toBe('5*2');
    expect(commit.values.distance?.value).toBe(10);
    expect(commit.values.angle).toBeUndefined();
    expect(commit.flags).toEqual({ reversed: false, symmetric: true });
    expect(commit.axis).toBeUndefined();
  });

  it('回転は角度・反転・軸を返す。軸を選び直すと結果も変わる', () => {
    const state = edited(createNumericInput('revolve', 'revolveAngle'), '90');
    const base = expectSolidCommitted(commitNumericInput(state)).commit;
    expect(base.tool).toBe('revolve');
    expect(base.values.angle?.value).toBe(90);
    expect(base.flags).toEqual({ reversed: false });
    expect(base.axis).toEqual({ kind: 'world', axis: 'z' });

    const turned = toggleNumericInput(chooseNumericInput(state, 'x'), 'reversed');
    const commit = expectSolidCommitted(commitNumericInput(turned)).commit;
    expect(commit.flags).toEqual({ reversed: true });
    expect(commit.axis).toEqual({ kind: 'world', axis: 'x' });
  });

  it('選んだ線分を軸にできる(§0.a-0.9)', () => {
    const line = { sketchId: 'sketch-1', lineFeatureId: 'line-1' };
    const state = chooseNumericInput(
      createNumericInput('revolve', 'revolveAngle', 'absolute', { axisLine: line }),
      'line',
    );
    expect(expectSolidCommitted(commitNumericInput(state)).commit.axis).toEqual({
      kind: 'line',
      line,
    });
  });

  it('縫合は許容量だけを返し、つまみは空になる', () => {
    const { commit } = expectSolidCommitted(
      commitNumericInput(createNumericInput('sew', 'sewTolerance')),
    );
    expect(commit.tool).toBe('sew');
    expect(commit.values.tolerance?.value).toBe(0.01);
    expect(commit.values.distance).toBeUndefined();
    expect(commit.flags).toEqual({});
  });

  it('空欄のまま Enter を押すと既定値で確定する(NFR-UX-4)', () => {
    const cases = [
      ['extrude', 'extrudeDistance', 10],
      ['revolve', 'revolveAngle', 360],
      ['sew', 'sewTolerance', 0.01],
    ] as const;
    for (const [tool, step, expected] of cases) {
      const cleared = edited(createNumericInput(tool, step), '   ');
      const { commit, state } = expectSolidCommitted(applyNumericInputKey(cleared, 'Enter'));
      expect(state.fields[0].source, step).toBe(String(expected));
      const values = commit.values;
      const value = values.distance ?? values.angle ?? values.tolerance;
      expect(value?.value, step).toBe(expected);
    }
  });

  it('ソリッドは 1 段で終わるので、「続けてかく」が入でも閉じる', () => {
    for (const step of Object.values(SOLID_TOOL_STEPS)) {
      for (const chaining of [false, true]) {
        expect(nextNumericInput(createNumericInput('extrude', step), chaining), step).toBeNull();
      }
    }
  });

  it('取消はソリッドでも作りかけを返さない(NFR-UX-3)', () => {
    const state = edited(createNumericInput('extrude', 'extrudeDistance'), '99');
    expect(applyNumericInputKey(state, 'Escape')).toEqual({ kind: 'cancelled' });
  });
});

describe('ソリッドの不正値は確定させない(NFR-UX-5、FR-204)', () => {
  it('押し出しの長さは 0 以下を受け付けない', () => {
    for (const source of ['0', '-5']) {
      const state = edited(createNumericInput('extrude', 'extrudeDistance'), source);
      const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
      expect(blocked.evaluation.canCommit, source).toBe(false);
      expect(blocked.evaluation.firstErrorIndex).toBe(0);
      expect(blocked.evaluation.results[0].value).toBeNull();
      expect(blocked.evaluation.results[0].error?.message).toBe(
        '距離は 0 より大きい値を入れてください。',
      );
      expect(blocked.state.focusedIndex).toBe(0);
    }
  });

  it('回転の角度は 0 以下と 360 超を受け付けない(0 < 角度 ≤ 360)', () => {
    for (const source of ['0', '-1', '361', '360.5']) {
      const state = edited(createNumericInput('revolve', 'revolveAngle'), source);
      const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
      expect(blocked.evaluation.canCommit, source).toBe(false);
      expect(blocked.evaluation.results[0].error?.message).toBe(
        '角度は 0 より大きく 360 以下の値を入れてください。',
      );
    }
    // 境界の 360 と、ぎりぎり内側の値は通る。
    for (const source of ['360', '0.001', '180*2']) {
      const state = edited(createNumericInput('revolve', 'revolveAngle'), source);
      expect(evaluateNumericInput(state).canCommit, source).toBe(true);
    }
  });

  it('縫合の許容量は 0 以下を受け付けない', () => {
    const state = edited(createNumericInput('sew', 'sewTolerance'), '0');
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.results[0].error?.message).toBe(
      'つなぎ目の許容量は 0 より大きい値を入れてください。',
    );
    expect(evaluateNumericInput(edited(state, '0.000001')).canCommit).toBe(true);
  });

  it('式そのものの誤りは今までどおり理由が出る(FR-204)', () => {
    const state = edited(createNumericInput('extrude', 'extrudeDistance'), '1/0');
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.results[0].error?.code).toBe('divisionByZero');
    expect(blocked.evaluation.results[0].error?.message).toBe('0 で割ることはできません。');
  });

  it('P1 の欄には範囲の縛りを足していない(既存の振る舞いを変えない)', () => {
    const state = edited(createNumericInput('point', 'point'), '-1000');
    expect(evaluateNumericInput(state).canCommit).toBe(true);
    expect(
      evaluateNumericInput(edited(createNumericInput('arc', 'arcShape'), '0')).canCommit,
    ).toBe(true);
  });
});
