import { describe, expect, it } from 'vitest';

import { expressionValueFromNumber } from '@pointercad/expression';
import { MAX_PATTERN_COUNT, MAX_SPRING_TURNS, METRIC_THREAD_DESIGNATIONS } from '@pointercad/model';

import { MESSAGE_KEYS, t, type MessageKey } from '../i18n/t.js';
import {
  applyNumericInputKey,
  buildCoordinateInput,
  choiceValueOf,
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
  numericChoiceOptionLabel,
  numericFocusTargets,
  rangeErrorFor,
  reduceNumericInput,
  SOLID_TOOL_STEPS,
  STEP_TITLE_KEYS,
  toggleNumericInput,
  TOGGLE_LABEL_KEYS,
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
        for (const choice of state.choices) {
          keys.push(choice.labelKey);
          for (const option of choice.options) {
            // 呼び径(28個)は labelKey を持たず label をそのまま出すので、ここでは飛ばす
            // (§2.11、numericChoiceOptionLabel の注釈)。
            if (option.labelKey !== undefined) {
              keys.push(option.labelKey);
            }
          }
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
      hole: 'holeSize',
      threadHole: 'threadSize',
      fillet: 'filletRadius',
      chamfer: 'chamferSize',
      linearPattern: 'linearPattern',
      circularPattern: 'circularPattern',
      spring: 'springShape',
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
    expect(state.choices).toEqual([]);
    expect(STEP_TITLE_KEYS.extrudeDistance).toBe('numericInput.title.extrude');
  });

  it('回転は角度 1 欄(既定 360)と反転のつまみ、軸は X / Y / Z で既定 Z(§0.a-0.9)', () => {
    const state = createNumericInput('revolve', 'revolveAngle');
    expect(state.fields.map((field) => field.key)).toEqual(['angle']);
    expect(state.fields.map((field) => field.source)).toEqual(['360']);
    expect(state.fields[0].unit).toBe('degree');
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['reversed']);
    expect(state.choices.length).toBe(1);
    expect(state.choices[0].key).toBe('axis');
    expect(state.choices[0].value).toBe('z');
    expect(state.choices[0].options.map((option) => option.value)).toEqual(['x', 'y', 'z']);
    // P3 で選択肢は value(文字列)だけを持つようになり、RevolveAxis は確定時に組み立て直す
    // (§2.11「確定側で value から引き直す」)。実際の組み立ては下の「ソリッドの確定結果」で検証する。
    expect(STEP_TITLE_KEYS.revolveAngle).toBe('numericInput.title.revolve');
  });

  it('縫合は許容量 1 欄(既定 0.01)だけで、つまみも選択肢も無い(§0.a-0.7)', () => {
    const state = createNumericInput('sew', 'sewTolerance');
    expect(state.fields.map((field) => field.key)).toEqual(['tolerance']);
    expect(state.fields.map((field) => field.source)).toEqual(['0.01']);
    expect(state.toggles).toEqual([]);
    expect(state.choices).toEqual([]);
    expect(STEP_TITLE_KEYS.sewTolerance).toBe('numericInput.title.sew');
  });

  it('線分が選ばれているときだけ、軸の選択肢に線分が増える(§0.a-0.9)', () => {
    const line = { sketchId: 'sketch-1', lineFeatureId: 'line-1' };
    const state = createNumericInput('revolve', 'revolveAngle', 'absolute', { axisLine: line });
    expect(state.choices[0].options.map((option) => option.value)).toEqual(['x', 'y', 'z', 'line']);
    // axis の組み立ては確定時に行う(下の「選んだ線分を軸にできる」で検証)。
    // 線分を渡さない押し出し・縫合には選択肢が生えない。
    expect(createNumericInput('extrude', 'extrudeDistance', 'absolute', { axisLine: line }).choices)
      .toEqual([]);
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
      expect(state.choices, step).toEqual([]);
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
    const chosen = chooseNumericInput(state, 'axis', 'x');
    expect(chosen.choices[0].value).toBe('x');
    expect(chosen.fields.map((field) => field.source)).toEqual(['90']);
    expect(state.choices[0].value).toBe('z');
    // 選択肢に無い値(線分が選ばれていない)は無視する。
    expect(chooseNumericInput(state, 'axis', 'line')).toBe(state);
    // 持っていないつまみの key を指しても無視する。
    expect(chooseNumericInput(state, 'chamferMode', 'equal')).toBe(state);
    // 選択肢を持たない段では何も起きない。
    expect(chooseNumericInput(createNumericInput('sew', 'sewTolerance'), 'axis', 'x').choices)
      .toEqual([]);
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
      { kind: 'choice', index: 0 },
      { kind: 'toggle', index: 0 },
    ]);
    expect(numericFocusTargets(createNumericInput('sew', 'sewTolerance'))).toEqual([
      { kind: 'field', index: 0 },
    ]);
    // 選択肢が2つある段(ねじ穴)では、選択肢が順に並ぶ(計画書タスク24 検証表)。
    const threadHole = createNumericInput('threadHole', 'threadSize');
    expect(numericFocusTargets(threadHole)).toEqual([
      { kind: 'field', index: 0 },
      { kind: 'field', index: 1 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 1 },
      { kind: 'toggle', index: 0 },
      { kind: 'toggle', index: 1 },
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
    expect(focusedTarget(onChoice)).toEqual({ kind: 'choice', index: 0 });
    // 既定は z(3 つ目)。→ で先頭の x へ回り込む。
    expect(expectOpen(applyNumericInputKey(onChoice, 'ArrowRight')).state.choices[0].value).toBe('x');
    expect(expectOpen(applyNumericInputKey(onChoice, 'ArrowLeft')).state.choices[0].value).toBe('y');
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

    const turned = toggleNumericInput(chooseNumericInput(state, 'axis', 'x'), 'reversed');
    const commit = expectSolidCommitted(commitNumericInput(turned)).commit;
    expect(commit.flags).toEqual({ reversed: true });
    expect(commit.axis).toEqual({ kind: 'world', axis: 'x' });
  });

  it('選んだ線分を軸にできる(§0.a-0.9)', () => {
    const line = { sketchId: 'sketch-1', lineFeatureId: 'line-1' };
    const state = chooseNumericInput(
      createNumericInput('revolve', 'revolveAngle', 'absolute', { axisLine: line }),
      'axis',
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

  it('ソリッドは 1 段で終わるので、「続けてかく」が入でも閉じる(例外: ばねの1段目は2段目へ進む)', () => {
    for (const step of Object.values(SOLID_TOOL_STEPS)) {
      // ばねの1段目(springShape)だけは2段構えの前半なので、続けてかくに関わらず
      // springLength へ進む(§2.11)。これは下の「ばねの2段」でまとめて検証する。
      if (step === 'springShape') {
        continue;
      }
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
      expect(blocked.evaluation.results[0].error?.code, source).toBe('outOfRange');
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
      expect(blocked.evaluation.results[0].error?.code, source).toBe('outOfRange');
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
    expect(blocked.evaluation.results[0].error?.code).toBe('outOfRange');
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

  it('数として表せない値(NaN/Infinity)は notFinite のまま、範囲外(outOfRange)と混ぜない', () => {
    // 0^-1 は Infinity になり、rangeErrorFor に届く前に evaluateExpression が断る
    // (packages/expression/src/evaluate.test.ts の notFinite@1 と同じ式)。
    const state = edited(createNumericInput('extrude', 'extrudeDistance'), '0^-1');
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.results[0].error?.code).toBe('notFinite');
  });

  it('rangeErrorFor は範囲内で null、範囲外で outOfRange を返す(文言は変えない)', () => {
    const field = createNumericInput('extrude', 'extrudeDistance').fields[0];
    const below = rangeErrorFor(field, expressionValueFromNumber(-5));
    expect(below?.code).toBe('outOfRange');
    expect(below?.message).toBe('距離は 0 より大きい値を入れてください。');
    expect(rangeErrorFor(field, expressionValueFromNumber(10))).toBeNull();

    const angleField = createNumericInput('revolve', 'revolveAngle').fields[0];
    const above = rangeErrorFor(angleField, expressionValueFromNumber(361));
    expect(above?.code).toBe('outOfRange');
    expect(above?.message).toBe('角度は 0 より大きく 360 以下の値を入れてください。');
    expect(rangeErrorFor(angleField, expressionValueFromNumber(360))).toBeNull();
  });

  it('P1 の欄には範囲の縛りを足していない(既存の振る舞いを変えない)', () => {
    const state = edited(createNumericInput('point', 'point'), '-1000');
    expect(evaluateNumericInput(state).canCommit).toBe(true);
    expect(
      evaluateNumericInput(edited(createNumericInput('arc', 'arcShape'), '0')).canCommit,
    ).toBe(true);
  });
});

describe('P3 加工の段(計画書 docs/plans/P3-加工フィーチャー.md タスク24 §2.11、検証表)', () => {
  it('穴: 欄2つ(直径6・深さ10)、貫通のつまみ(既定 false)、選択肢なし', () => {
    const state = createNumericInput('hole', 'holeSize');
    expect(state.fields.map((field) => field.key)).toEqual(['diameter', 'depth']);
    expect(state.fields.map((field) => field.source)).toEqual(['6', '10']);
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['through']);
    expect(state.toggles[0].value).toBe(false);
    expect(state.choices).toEqual([]);
    expect(STEP_TITLE_KEYS.holeSize).toBe('numericInput.title.hole');
  });

  it('ねじ穴: 欄2つ(深さ10・ねじ部の長さ10)、つまみ2つ、選択肢2つ(呼びM6・系列coarse)', () => {
    const state = createNumericInput('threadHole', 'threadSize');
    expect(state.fields.map((field) => field.key)).toEqual(['depth', 'threadLength']);
    expect(state.fields.map((field) => field.source)).toEqual(['10', '10']);
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['through', 'modeledThread']);
    expect(state.toggles.map((toggle) => toggle.value)).toEqual([false, false]);
    expect(state.choices.map((choice) => choice.key)).toEqual(['threadDesignation', 'threadSeries']);
    expect(state.choices[0].value).toBe('M6');
    expect(state.choices[1].value).toBe('coarse');
    expect(STEP_TITLE_KEYS.threadSize).toBe('numericInput.title.threadHole');
  });

  it('R面取り: 欄1つ(半径2)、つまみ・選択肢なし', () => {
    const state = createNumericInput('fillet', 'filletRadius');
    expect(state.fields.map((field) => field.key)).toEqual(['radius']);
    expect(state.fields.map((field) => field.source)).toEqual(['2']);
    expect(state.toggles).toEqual([]);
    expect(state.choices).toEqual([]);
    expect(STEP_TITLE_KEYS.filletRadius).toBe('numericInput.title.fillet');
  });

  it('直線パターン: 欄2つ(間隔20・個数3)、両側への既定false、選択肢1つ(向き、既定 x)', () => {
    const state = createNumericInput('linearPattern', 'linearPattern');
    expect(state.fields.map((field) => field.key)).toEqual(['spacing', 'count']);
    expect(state.fields.map((field) => field.source)).toEqual(['20', '3']);
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['patternSymmetric']);
    expect(state.toggles[0].value).toBe(false);
    expect(state.choices[0].key).toBe('patternDirection');
    expect(state.choices[0].value).toBe('x');
    expect(STEP_TITLE_KEYS.linearPattern).toBe('numericInput.title.linearPattern');
  });

  it('円形パターン: 欄2つ(角度360・個数4)、全周の既定true、選択肢1つ(軸、既定 z)', () => {
    const state = createNumericInput('circularPattern', 'circularPattern');
    expect(state.fields.map((field) => field.key)).toEqual(['angle', 'count']);
    expect(state.fields.map((field) => field.source)).toEqual(['360', '4']);
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['fullCircle']);
    expect(state.toggles[0].value).toBe(true);
    expect(state.choices[0].key).toBe('axis');
    expect(state.choices[0].value).toBe('z');
    expect(STEP_TITLE_KEYS.circularPattern).toBe('numericInput.title.circularPattern');
  });

  it('choiceValueOf で選択肢の現在値を読める。元の state は変わらない', () => {
    const state = createNumericInput('threadHole', 'threadSize');
    const chosen = chooseNumericInput(state, 'threadDesignation', 'M8');
    expect(choiceValueOf(chosen, 'threadDesignation')).toBe('M8');
    expect(choiceValueOf(state, 'threadDesignation')).toBe('M6');
    // 持たない段・持たないつまみは null。
    expect(choiceValueOf(state, 'springDerived')).toBeNull();
  });

  it('呼び径の選択肢は label をそのまま持ち、labelKey は持たない(28個、§2.11)', () => {
    const state = createNumericInput('threadHole', 'threadSize');
    const designation = state.choices.find((choice) => choice.key === 'threadDesignation');
    expect(designation?.options.length).toBe(METRIC_THREAD_DESIGNATIONS.length);
    expect(designation?.options[0]).toEqual({ value: 'M2', label: 'M2' });
    expect(designation?.options.every((option) => option.labelKey === undefined)).toBe(true);
  });

  it('パターンの個数は 2 未満・MAX_PATTERN_COUNT 超を受け付けない。境界は通る', () => {
    const low = edited(createNumericInput('linearPattern', 'linearPattern'), '1', 1);
    const blocked = expectBlocked(applyNumericInputKey(low, 'Enter'));
    expect(blocked.evaluation.results[1].error?.code).toBe('outOfRange');

    const high = edited(
      createNumericInput('circularPattern', 'circularPattern'),
      String(MAX_PATTERN_COUNT + 1),
      1,
    );
    expect(evaluateNumericInput(high).canCommit).toBe(false);

    const atMin = edited(createNumericInput('linearPattern', 'linearPattern'), '2', 1);
    expect(evaluateNumericInput(atMin).canCommit).toBe(true);
    const atMax = edited(
      createNumericInput('circularPattern', 'circularPattern'),
      String(MAX_PATTERN_COUNT),
      1,
    );
    expect(evaluateNumericInput(atMax).canCommit).toBe(true);
  });

  it('個数が整数かどうかはこの層(numericInput.ts)では確かめない(判断: 検証表の注記への回答)', () => {
    // 2.5 は範囲(2以上 MAX_PATTERN_COUNT 以下)には収まるため、ここでは確定できる形の
    // まま通す。整数チェックは加工コマンド側(タスク25 machiningCommands.ts)へ委ねる
    // 決定を、evaluateNumericInput の中のコメントと合わせてここでも固定する。
    const state = edited(createNumericInput('linearPattern', 'linearPattern'), '2.5', 1);
    expect(evaluateNumericInput(state).canCommit).toBe(true);
  });

  it('直径に式が使え(3*2)、空欄は既定値 6 で確定する(FR-202、NFR-UX-4)', () => {
    const state = edited(createNumericInput('hole', 'holeSize'), '3*2', 0);
    const evaluation = evaluateNumericInput(state);
    expect(evaluation.results[0].value?.source).toBe('3*2');
    expect(evaluation.results[0].value?.value).toBe(6);

    const cleared = edited(createNumericInput('hole', 'holeSize'), '', 0);
    const { commit } = expectSolidCommitted(applyNumericInputKey(cleared, 'Enter'));
    expect(commit.values.diameter?.value).toBe(6);
  });

  it('C面取り: 決め方で欄が変わり、距離の値は引き継ぐ(検証表)', () => {
    let state = createNumericInput('chamfer', 'chamferSize');
    // 等距離(既定)は距離1つだけの欄。「等距離」なのに距離2 を聞くのは分かりにくいため
    // (NFR-UX-2)、統括の判断で距離2 の欄は出さない(numericInput.ts の
    // chamferFieldDefinitions 注釈)。
    expect(state.fields.map((field) => field.key)).toEqual(['chamferDistance']);
    expect(state.fields.map((field) => field.source)).toEqual(['1']);
    expect(state.choices.length).toBe(1);
    expect(state.choices[0].key).toBe('chamferMode');
    expect(state.choices[0].value).toBe('equal');
    expect(STEP_TITLE_KEYS.chamferSize).toBe('numericInput.title.chamfer');

    state = edited(state, '3', 0);
    // 等距離のまま確定すると、距離2・角度はどちらも values に入らない。
    const equalCommitted = expectSolidCommitted(commitNumericInput(state)).commit;
    expect(equalCommitted.chamferMode).toBe('equal');
    expect(equalCommitted.values.chamferDistance?.value).toBe(3);
    expect(equalCommitted.values.chamferDistance2).toBeUndefined();
    expect(equalCommitted.values.chamferAngle).toBeUndefined();

    // 2距離に切り替えると欄が2つになり、距離の値は引き継ぐ。
    const twoDistances = chooseNumericInput(state, 'chamferMode', 'twoDistances');
    expect(twoDistances.fields.map((field) => field.key)).toEqual([
      'chamferDistance',
      'chamferDistance2',
    ]);
    expect(twoDistances.fields.map((field) => field.source)).toEqual(['3', '1']);

    const switched = chooseNumericInput(twoDistances, 'chamferMode', 'distanceAngle');
    expect(switched.fields.map((field) => field.key)).toEqual(['chamferDistance', 'chamferAngle']);
    // 1つ目(距離)の値は引き継ぎ、2つ目は角度の既定(45)になる。
    expect(switched.fields.map((field) => field.source)).toEqual(['3', '45']);

    const committed = expectSolidCommitted(commitNumericInput(switched)).commit;
    expect(committed.chamferMode).toBe('distanceAngle');
    expect(committed.values.chamferDistance?.value).toBe(3);
    expect(committed.values.chamferAngle?.value).toBe(45);
    expect(committed.values.chamferDistance2).toBeUndefined();

    // 角度は 0 より大きく 90 より小さい。
    const outOfRange = edited(switched, '90', 1);
    expect(evaluateNumericInput(outOfRange).canCommit).toBe(false);
  });

  it('穴・ねじ穴・パターンの確定は SolidInputCommit の該当欄・つまみ・軸だけへ入る', () => {
    const hole = expectSolidCommitted(
      commitNumericInput(toggleNumericInput(createNumericInput('hole', 'holeSize'), 'through')),
    ).commit;
    expect(hole.tool).toBe('hole');
    expect(hole.values.diameter?.value).toBe(6);
    expect(hole.values.depth?.value).toBe(10);
    expect(hole.flags.through).toBe(true);
    expect(hole.axis).toBeUndefined();

    const threadHole = expectSolidCommitted(
      commitNumericInput(createNumericInput('threadHole', 'threadSize')),
    ).commit;
    expect(threadHole.threadDesignation).toBe('M6');
    expect(threadHole.threadSeries).toBe('coarse');
    expect(threadHole.flags).toEqual({ through: false, modeledThread: false });

    const linear = expectSolidCommitted(
      commitNumericInput(createNumericInput('linearPattern', 'linearPattern')),
    ).commit;
    expect(linear.axis).toEqual({ kind: 'world', axis: 'x' });
    expect(linear.values.spacing?.value).toBe(20);
    expect(linear.values.count?.value).toBe(3);
    expect(linear.flags).toEqual({ patternSymmetric: false });

    const circular = expectSolidCommitted(
      commitNumericInput(createNumericInput('circularPattern', 'circularPattern')),
    ).commit;
    expect(circular.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(circular.flags).toEqual({ fullCircle: true });
  });

  it('直線パターン・円形パターンも選んだ線分を向き・軸にできる(§0.a-0.9 の作りを流用)', () => {
    const line = { sketchId: 'sketch-1', lineFeatureId: 'line-1' };
    const linear = chooseNumericInput(
      createNumericInput('linearPattern', 'linearPattern', 'absolute', { axisLine: line }),
      'patternDirection',
      'line',
    );
    expect(expectSolidCommitted(commitNumericInput(linear)).commit.axis).toEqual({
      kind: 'line',
      line,
    });

    const circular = chooseNumericInput(
      createNumericInput('circularPattern', 'circularPattern', 'absolute', { axisLine: line }),
      'axis',
      'line',
    );
    expect(expectSolidCommitted(commitNumericInput(circular)).commit.axis).toEqual({
      kind: 'line',
      line,
    });
  });
});

describe('P3 ばねの2段(計画書タスク24 §2.11、FR-414)', () => {
  it('ばね1段目: 欄2つ(コイル径20・線径2)、選択肢2つ(軸z・巻き方向right)、つまみなし', () => {
    const state = createNumericInput('spring', 'springShape');
    expect(state.fields.map((field) => field.key)).toEqual(['coilDiameter', 'wireDiameter']);
    expect(state.fields.map((field) => field.source)).toEqual(['20', '2']);
    expect(state.toggles).toEqual([]);
    expect(state.choices.map((choice) => choice.key)).toEqual(['axis', 'springHandedness']);
    expect(state.choices[0].value).toBe('z');
    expect(state.choices[1].value).toBe('right');
    expect(STEP_TITLE_KEYS.springShape).toBe('numericInput.title.springShape');
  });

  it('ばね2段目: 欄2つ(ピッチ5・巻数4)、選択肢1つ(求める値、既定 length)', () => {
    const state = createNumericInput('spring', 'springLength');
    expect(state.fields.map((field) => field.key)).toEqual(['springPitch', 'springTurns']);
    expect(state.fields.map((field) => field.source)).toEqual(['5', '4']);
    expect(state.choices.map((choice) => choice.key)).toEqual(['springDerived']);
    expect(state.choices[0].value).toBe('length');
    expect(STEP_TITLE_KEYS.springLength).toBe('numericInput.title.springLength');
  });

  it('求める値を pitch/turns に変えると欄が入れ替わり、残る欄の値は引き継ぐ', () => {
    const state = edited(createNumericInput('spring', 'springLength'), '7', 1);

    const toPitch = chooseNumericInput(state, 'springDerived', 'pitch');
    // ピッチの欄が消え、全長の欄(既定20)が出る。巻数の値は引き継ぐ。
    expect(toPitch.fields.map((field) => field.key)).toEqual(['springTurns', 'springLength']);
    expect(toPitch.fields.map((field) => field.source)).toEqual(['7', '20']);

    const toTurns = chooseNumericInput(state, 'springDerived', 'turns');
    // 巻数の欄が消え、全長の欄が出る。
    expect(toTurns.fields.map((field) => field.key)).toEqual(['springPitch', 'springLength']);
    expect(toTurns.fields.map((field) => field.source)).toEqual(['5', '20']);
  });

  it('ばねの1段目を確定すると2段目へ進み、コイル径・線径・軸・巻き方向が持ち越される', () => {
    const line = { sketchId: 'sketch-1', lineFeatureId: 'line-1' };
    let shape = createNumericInput('spring', 'springShape', 'absolute', { axisLine: line });
    shape = edited(shape, '25', 0);
    shape = chooseNumericInput(shape, 'axis', 'line');
    shape = chooseNumericInput(shape, 'springHandedness', 'left');

    // nextNumericInput が springLength を返す(検証表)。
    const viaNext = nextNumericInput(shape, false);
    expect(viaNext?.step).toBe('springLength');
    expect(viaNext?.toolId).toBe('spring');

    // Enter を押しても同じ遷移になる。ばねの1段目だけは閉じない(kind: 'open')。
    const transition = applyNumericInputKey(shape, 'Enter');
    if (transition.kind !== 'open') {
      throw new Error(`expected open transition, got ${transition.kind}`);
    }
    expect(transition.state.step).toBe('springLength');

    const finished = expectSolidCommitted(commitNumericInput(transition.state));
    const { commit } = finished;
    expect(commit.kind).toBe('solid');
    expect(commit.tool).toBe('spring');
    expect(commit.step).toBe('springLength');
    expect(commit.values.coilDiameter?.value).toBe(25);
    expect(commit.values.wireDiameter?.value).toBe(2);
    expect(commit.values.springPitch?.value).toBe(5);
    expect(commit.values.springTurns?.value).toBe(4);
    // 求める値が既定(全長)のときは全長を計算しない(タスク25b が計算する、§0.30)。
    expect(commit.values.springLength).toBeUndefined();
    expect(commit.axis).toEqual({ kind: 'line', line });
    expect(commit.springHandedness).toBe('left');
    expect(commit.springDerived).toBe('length');
  });

  it('ばねの巻数は200を超えると確定できない。コイル径は0を受け付けない', () => {
    const overTurns = edited(createNumericInput('spring', 'springLength'), String(MAX_SPRING_TURNS + 1), 1);
    const blockedTurns = expectBlocked(applyNumericInputKey(overTurns, 'Enter'));
    expect(blockedTurns.evaluation.results[1].error?.code).toBe('outOfRange');
    const atMax = edited(createNumericInput('spring', 'springLength'), String(MAX_SPRING_TURNS), 1);
    expect(evaluateNumericInput(atMax).canCommit).toBe(true);

    const zeroCoil = edited(createNumericInput('spring', 'springShape'), '0', 0);
    const blockedCoil = expectBlocked(applyNumericInputKey(zeroCoil, 'Enter'));
    expect(blockedCoil.evaluation.results[0].error?.code).toBe('outOfRange');
  });

  it('ばねは道具ごとの先頭段(springShape)から開く。取消は1段目でも作りかけを返さない', () => {
    expect(SOLID_TOOL_STEPS.spring).toBe('springShape');
    const state = edited(createNumericInput('spring', 'springShape'), '99', 0);
    expect(applyNumericInputKey(state, 'Escape')).toEqual({ kind: 'cancelled' });
  });
});

describe('P3 の細部(キーボード操作・境界値・不変性)', () => {
  it('穴の貫通つまみは2回押すと元に戻る(P3 でも P2 と同じ振る舞い)', () => {
    const state = createNumericInput('hole', 'holeSize');
    const once = toggleNumericInput(state, 'through');
    expect(once.toggles[0].value).toBe(true);
    const twice = toggleNumericInput(once, 'through');
    expect(twice.toggles[0].value).toBe(false);
  });

  it('円形パターンの全周つまみは既定 true、2回切り替えると元に戻る', () => {
    const state = createNumericInput('circularPattern', 'circularPattern');
    expect(state.toggles[0].value).toBe(true);
    const once = toggleNumericInput(state, 'fullCircle');
    expect(once.toggles[0].value).toBe(false);
    const twice = toggleNumericInput(once, 'fullCircle');
    expect(twice.toggles[0].value).toBe(true);
  });

  it('C面取りの決め方は ← → でも切り替えられ、欄も一緒に変わる(moveChoice 経由)', () => {
    const state = createNumericInput('chamfer', 'chamferSize');
    // 等距離(既定)は欄が1つなので、選択肢の焦点は輪の2番目(添字1)。
    const onChoice = reduceNumericInput(state, { type: 'focus', index: 1 });
    expect(focusedTarget(onChoice)).toEqual({ kind: 'choice', index: 0 });
    const moved = expectOpen(applyNumericInputKey(onChoice, 'ArrowRight')).state;
    expect(moved.choices[0].value).toBe('twoDistances');
    expect(moved.fields.map((field) => field.key)).toEqual(['chamferDistance', 'chamferDistance2']);
    // 欄が1つから2つに増えても、焦点は選択肢を指したまま(輪の3番目、添字2、§2.11)。
    expect(focusedTarget(moved)).toEqual({ kind: 'choice', index: 0 });

    const movedAgain = expectOpen(applyNumericInputKey(moved, 'ArrowRight')).state;
    expect(movedAgain.choices[0].value).toBe('distanceAngle');
    expect(movedAgain.fields.map((field) => field.key)).toEqual(['chamferDistance', 'chamferAngle']);
    expect(focusedTarget(movedAgain)).toEqual({ kind: 'choice', index: 0 });

    // 末尾から先頭(等距離)へ回り込むと欄は1つに戻り、焦点も選択肢を指し続ける。
    const wrapped = expectOpen(applyNumericInputKey(movedAgain, 'ArrowRight')).state;
    expect(wrapped.choices[0].value).toBe('equal');
    expect(wrapped.fields.map((field) => field.key)).toEqual(['chamferDistance']);
    expect(focusedTarget(wrapped)).toEqual({ kind: 'choice', index: 0 });
  });

  it('ばねの求める値は ← → でも切り替えられる(moveChoice 経由)', () => {
    const state = createNumericInput('spring', 'springLength');
    const onChoice = reduceNumericInput(state, { type: 'focus', index: 2 });
    expect(focusedTarget(onChoice)).toEqual({ kind: 'choice', index: 0 });
    const moved = expectOpen(applyNumericInputKey(onChoice, 'ArrowRight')).state;
    expect(moved.choices[0].value).toBe('pitch');
    expect(moved.fields.map((field) => field.key)).toEqual(['springTurns', 'springLength']);
  });

  it('円形パターンの軸、直線パターンの向きも ← → で動かせる(端では回り込む)', () => {
    const circular = reduceNumericInput(createNumericInput('circularPattern', 'circularPattern'), {
      type: 'focus',
      index: 2,
    });
    // 既定は z(3つ目)。→ で先頭の x へ回り込む。
    expect(expectOpen(applyNumericInputKey(circular, 'ArrowRight')).state.choices[0].value).toBe('x');

    const linear = reduceNumericInput(createNumericInput('linearPattern', 'linearPattern'), {
      type: 'focus',
      index: 2,
    });
    // 既定は x(先頭)。← で末尾の z へ回り込む。
    expect(expectOpen(applyNumericInputKey(linear, 'ArrowLeft')).state.choices[0].value).toBe('z');
  });

  it('ばね1段目の欄は式が使え、2段目の確定値にそのまま持ち越される(FR-202)', () => {
    const shape = edited(createNumericInput('spring', 'springShape'), '10*2', 0);
    const length = nextNumericInput(shape, false);
    if (length === null) {
      throw new Error('expected springLength state');
    }
    const finished = expectSolidCommitted(commitNumericInput(length));
    expect(finished.commit.values.coilDiameter?.source).toBe('10*2');
    expect(finished.commit.values.coilDiameter?.value).toBe(20);
  });

  it('確定処理・段の遷移は元の state を書き換えない(不変性)', () => {
    const shape = edited(createNumericInput('spring', 'springShape'), '30', 0);
    const snapshotBefore = JSON.stringify(shape);
    commitNumericInput(shape);
    nextNumericInput(shape, false);
    expect(JSON.stringify(shape)).toBe(snapshotBefore);
  });

  it('C面取りの角度は 90 ちょうどを受け付けない(0 < 角度 < 90)', () => {
    const switched = chooseNumericInput(
      createNumericInput('chamfer', 'chamferSize'),
      'chamferMode',
      'distanceAngle',
    );
    const at90 = edited(switched, '90', 1);
    expect(evaluateNumericInput(at90).canCommit).toBe(false);
    const justBelow = edited(switched, '89.999', 1);
    expect(evaluateNumericInput(justBelow).canCommit).toBe(true);
  });

  it('R面取りの半径は 0 を受け付けない', () => {
    const state = edited(createNumericInput('fillet', 'filletRadius'), '0', 0);
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.results[0].error?.code).toBe('outOfRange');
  });

  it('ねじ穴: 系列を fine に変えても呼びは変わらない(2つの選択肢は独立)', () => {
    const state = createNumericInput('threadHole', 'threadSize');
    const changed = chooseNumericInput(state, 'threadSeries', 'fine');
    expect(choiceValueOf(changed, 'threadSeries')).toBe('fine');
    expect(choiceValueOf(changed, 'threadDesignation')).toBe('M6');
  });

  it('呼び径は ← → で送れる。既定 M6 の1つ前は表の並びで1つ小さい M5', () => {
    const state = reduceNumericInput(createNumericInput('threadHole', 'threadSize'), {
      type: 'focus',
      index: 2,
    });
    expect(focusedTarget(state)).toEqual({ kind: 'choice', index: 0 });
    const defaultIndex = METRIC_THREAD_DESIGNATIONS.indexOf('M6');
    const movedLeft = expectOpen(applyNumericInputKey(state, 'ArrowLeft')).state;
    expect(movedLeft.choices[0].value).toBe(METRIC_THREAD_DESIGNATIONS[defaultIndex - 1]);
    const movedRight = expectOpen(applyNumericInputKey(state, 'ArrowRight')).state;
    expect(movedRight.choices[0].value).toBe(METRIC_THREAD_DESIGNATIONS[defaultIndex + 1]);
    // 先頭(M2)から ← へ動かすと末尾(M64)へ回り込む。
    const atFirst = chooseNumericInput(state, 'threadDesignation', 'M2');
    const focusedAtFirst = reduceNumericInput(atFirst, { type: 'focus', index: 2 });
    const wrapped = expectOpen(applyNumericInputKey(focusedAtFirst, 'ArrowLeft')).state;
    expect(wrapped.choices[0].value).toBe(
      METRIC_THREAD_DESIGNATIONS[METRIC_THREAD_DESIGNATIONS.length - 1],
    );
  });

  it('TOGGLE_LABEL_KEYS はすべて ja.json に実在する', () => {
    for (const key of Object.values(TOGGLE_LABEL_KEYS)) {
      expect(MESSAGE_KEYS).toContain(key);
      expect(t(key).length).toBeGreaterThan(0);
    }
  });

  it('円形パターンの角度は 360 を超えると確定できない(直線パターンと共有する範囲)', () => {
    const state = edited(createNumericInput('circularPattern', 'circularPattern'), '361', 0);
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.results[0].error?.code).toBe('outOfRange');
    const atMax = edited(createNumericInput('circularPattern', 'circularPattern'), '360', 0);
    expect(evaluateNumericInput(atMax).canCommit).toBe(true);
  });

  it('numericChoiceOptionLabel: label があればそのまま、無ければ labelKey から引く', () => {
    expect(numericChoiceOptionLabel({ value: 'M6', label: 'M6' })).toBe('M6');
    expect(
      numericChoiceOptionLabel({ value: 'coarse', labelKey: 'numericInput.threadSeries.coarse' }),
    ).toBe(t('numericInput.threadSeries.coarse'));
  });
});
