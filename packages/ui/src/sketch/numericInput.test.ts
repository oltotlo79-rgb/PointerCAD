import { describe, expect, it } from 'vitest';

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  MAX_PATTERN_COUNT,
  MAX_POINT_ARRAY_COUNT,
  MAX_SPLINE_POINTS,
  MAX_SPRING_TURNS,
  METRIC_THREAD_DESIGNATIONS,
  type CoordinateInput,
} from '@pointercad/model';

import { MESSAGE_KEYS, t, type MessageKey } from '../i18n/t.js';
import {
  appendSplinePoint,
  applyNumericInputKey,
  asksCoordinate,
  applySplineShapeCommit,
  buildCoordinateInput,
  checkSplineDraft,
  choiceValueOf,
  chooseNumericInput,
  commitNumericInput,
  commitValues,
  COORDINATE_MODES,
  createNumericInput,
  DEFAULT_GRID_COLUMN_AZIMUTH_DEGREES,
  DEFAULT_GRID_ROW_AZIMUTH_DEGREES,
  DEFAULT_POLYGON_SIDES,
  DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
  DEFAULT_SKETCH_FILLET_RADIUS_MM,
  defaultModeForStep,
  EDIT_TOOL_STEPS,
  EMPTY_SPLINE_DRAFT,
  evaluateNumericInput,
  fillDefaults,
  focusedTarget,
  isCoordinateStep,
  isCornerEditTool,
  isEditStep,
  isEditTool,
  isReferenceCoordinateStep,
  isReferenceStep,
  isReferenceTool,
  isShapeTool,
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
  REFERENCE_TOOL_STEPS,
  removeLastSplinePoint,
  SHAPE_TOOL_STEPS,
  SOLID_TOOL_STEPS,
  splineFinishStateFrom,
  STEP_TITLE_KEYS,
  toggleNumericInput,
  TOGGLE_LABEL_KEYS,
  toggleValueOf,
  twoPointArcCenterOffset,
  twoPointArcRadiusRejection,
  UNIT_KEYS,
  valueByFieldKey,
  type NumericInputCommit,
  type NumericInputState,
  type NumericInputTransition,
  type SplineDraft,
  type SplineDraftOutcome,
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
      // 基本形状5種(FR-429、P5 タスク18)。どれも寸法の 1 段だけ。
      sphere: 'sphereSize',
      box: 'boxSize',
      cylinder: 'cylinderSize',
      cone: 'coneSize',
      torus: 'torusSize',
      // 面をつなぐ・ロフト(FR-430、FR-410、P5 タスク27)。どちらもねじれの 1 段だけ。
      ruled: 'ruledTwist',
      loft: 'loftTwist',
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

  /**
   * P4 タスク11 で、P1 の段のうち**要素が履歴へ積まれる最後の段**にだけ、つまみ・選択肢が
   * 付いた(`lineEnd` / `arcShape` に構築線(FR-320)、`pointArrayShape` に並べ方(FR-327))。
   * 座標を聞く前半の段は P1 のまま何も持たないので、その 4 つをここで固定し続ける。
   * 足した側の振る舞いは「P4 の新しい図形の段」の describe で別に固定する。
   */
  it('P1 の座標の段はつまみも選択肢も持たない(P1 の振る舞いを変えない)', () => {
    for (const step of ['point', 'lineStart', 'arcCenter', 'pointArrayBase'] as const) {
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

/** 判別共用体の中身へ強制変換なしで触るための小道具(既存の expectCommitted と同じ流儀)。 */
function expectCoordinateCommit(
  state: NumericInputState,
): Extract<NumericInputCommit, { readonly kind: 'coordinate' }> {
  const { commit } = expectCommitted(commitNumericInput(state));
  if (commit.kind !== 'coordinate') {
    throw new Error(`expected coordinate commit, got ${commit.kind}`);
  }
  return commit;
}

function coordinateOf(state: NumericInputState): CoordinateInput {
  const commit = expectCoordinateCommit(state);
  return commit.coordinate;
}

function expectDraft(outcome: SplineDraftOutcome): SplineDraft {
  if (!outcome.ok) {
    throw new Error(`expected an appended draft, got a rejection: ${outcome.reason}`);
  }
  return outcome.draft;
}

/** スプラインの下書きへ入れる 1 点。ポップアップと同じ道筋(段の確定)で作る。 */
function splinePoint(x: string): CoordinateInput {
  return coordinateOf(edited(createNumericInput('spline', 'splinePoint'), x));
}

describe('P4 新しい図形の道具と段(計画書 docs/plans/P4-スケッチ拡張.md タスク11)', () => {
  it('道具から最初の段が引ける。8 つとも座標を聞く段から始まる(FR-314〜318、FR-326、FR-330)', () => {
    expect(SHAPE_TOOL_STEPS).toEqual({
      circle: 'circleCenter',
      twoPointArc: 'twoPointArcStart',
      threePointArc: 'threePointArcStart',
      rectangle: 'rectangleCorner1',
      polygon: 'polygonCenter',
      slot: 'slotCenter1',
      ellipse: 'ellipseCenter',
      spline: 'splinePoint',
    });
    for (const step of Object.values(SHAPE_TOOL_STEPS)) {
      expect(isCoordinateStep(step), step).toBe(true);
      expect(isSolidStep(step), step).toBe(false);
    }
  });

  it('新しい図形の道具かどうかを一覧の二重管理なしで見分けられる', () => {
    const shapeTools = [
      'circle',
      'twoPointArc',
      'threePointArc',
      'rectangle',
      'polygon',
      'slot',
      'ellipse',
      'spline',
    ] as const;
    expect(Object.keys(SHAPE_TOOL_STEPS).sort()).toEqual([...shapeTools].sort());
    for (const tool of shapeTools) {
      expect(isShapeTool(tool), tool).toBe(true);
    }
    expect(isShapeTool('line')).toBe(false);
    expect(isShapeTool('extrude')).toBe(false);
    expect(isShapeTool('select')).toBe(false);
  });

  it('2 点目を聞く段の既定は相対(直前の点からの続きで入れられる、FR-307)', () => {
    for (const step of ['twoPointArcEnd', 'rectangleCorner2', 'slotCenter2'] as const) {
      expect(defaultModeForStep(step), step).toBe('relative');
      expect(createNumericInput('point', step).fields.map((field) => field.key)).toEqual([
        'dx',
        'dy',
        'dz',
      ]);
    }
    // 1 点目は絶対のまま(基準になる点がまだ無いため)。
    for (const step of ['twoPointArcStart', 'rectangleCorner1', 'slotCenter1'] as const) {
      expect(defaultModeForStep(step), step).toBe('absolute');
    }
  });

  it('構築線のつまみは、要素が履歴へ積まれる最後の段だけに付く(FR-320、既定は切)', () => {
    const finalSteps = [
      'lineEnd',
      'arcShape',
      'circleRadius',
      'twoPointArcRadius',
      'rectangleCorner2',
      'polygonShape',
      'slotShape',
      'ellipseAngles',
      'splineShape',
    ] as const;
    for (const step of finalSteps) {
      const state = createNumericInput('point', step);
      expect(toggleValueOf(state, 'construction'), step).toBe(false);
      expect(
        state.toggles.some((toggle) => toggle.key === 'construction'),
        step,
      ).toBe(true);
    }
    // 前半の段には付けない(段ごとに状態を作り直すので、確定のときに値が残らないため)。
    for (const step of ['lineStart', 'arcCenter', 'circleCenter', 'rectangleCorner1'] as const) {
      expect(
        createNumericInput('point', step).toggles.some((toggle) => toggle.key === 'construction'),
        step,
      ).toBe(false);
    }
  });

  it('構築線を入にして決めると、確定結果のつまみに入って外へ渡る(FR-320)', () => {
    const state = createNumericInput('circle', 'circleRadius');
    expect(expectCommitted(commitNumericInput(state)).commit.flags.construction).toBe(false);
    const on = toggleNumericInput(state, 'construction');
    expect(expectCommitted(commitNumericInput(on)).commit.flags.construction).toBe(true);
    // 座標で終わる道具(矩形)でも同じように渡る。
    const corner = toggleNumericInput(createNumericInput('rectangle', 'rectangleCorner2'), 'construction');
    expect(expectCoordinateCommit(corner).flags.construction).toBe(true);
  });

  it('P1 の線分・円弧の最後の段にも構築線が付いた(FR-320。欄と既定値は変えていない)', () => {
    const lineEnd = createNumericInput('line', 'lineEnd');
    expect(lineEnd.fields.map((field) => field.key)).toEqual(['dx', 'dy', 'dz']);
    expect(lineEnd.toggles.map((toggle) => toggle.key)).toEqual(['construction']);
    const arcShape = createNumericInput('arc', 'arcShape');
    expect(arcShape.fields.map((field) => field.source)).toEqual(['10', '0', '90']);
    expect(arcShape.toggles.map((toggle) => toggle.key)).toEqual(['construction']);
    // 巡回は「欄 → つまみ」の順に伸びる(NFR-UX-2)。
    expect(numericFocusTargets(arcShape)).toEqual([
      { kind: 'field', index: 0 },
      { kind: 'field', index: 1 },
      { kind: 'field', index: 2 },
      { kind: 'toggle', index: 0 },
    ]);
  });
});

describe('P4 円と 2 点+半径の円弧(FR-326、統括の決定 §0.a-0.18)', () => {
  it('円は「中心 → 半径」の 2 段。半径は 1 欄・既定 10・0 より大きい', () => {
    expect(nextNumericInput(createNumericInput('circle', 'circleCenter'), false)?.step).toBe(
      'circleRadius',
    );
    const state = createNumericInput('circle', 'circleRadius');
    expect(state.fields.map((field) => field.key)).toEqual(['radius']);
    expect(state.fields.map((field) => field.source)).toEqual(['10']);
    expect(evaluateNumericInput(edited(state, '0')).canCommit).toBe(false);
    expect(evaluateNumericInput(edited(state, '0.001')).canCommit).toBe(true);
    expect(expectBlocked(applyNumericInputKey(edited(state, '0'), 'Enter')).evaluation.results[0]
      .error?.code).toBe('outOfRange');
  });

  it('円は「続けてかく」が入なら次の円の中心へ戻り、切なら閉じる', () => {
    const state = createNumericInput('circle', 'circleRadius');
    expect(nextNumericInput(state, true)?.step).toBe('circleCenter');
    expect(nextNumericInput(state, false)).toBeNull();
  });

  it('2 点+半径の円弧は「1 点目 → 2 点目 → 半径」の 3 段(FR-326)', () => {
    expect(nextNumericInput(createNumericInput('twoPointArc', 'twoPointArcStart'), false)?.step)
      .toBe('twoPointArcEnd');
    expect(nextNumericInput(createNumericInput('twoPointArc', 'twoPointArcEnd'), false)?.step)
      .toBe('twoPointArcRadius');
    expect(nextNumericInput(createNumericInput('twoPointArc', 'twoPointArcRadius'), true)?.step)
      .toBe('twoPointArcStart');
  });

  it('半径の段は「ふくらむ向き」の選択肢を持ち、既定は左(NFR-UX-4)', () => {
    const state = createNumericInput('twoPointArc', 'twoPointArcRadius');
    expect(state.choices.map((choice) => choice.key)).toEqual(['arcBulge']);
    expect(choiceValueOf(state, 'arcBulge')).toBe('left');
    expect(state.choices[0].options.map((option) => option.value)).toEqual(['left', 'right']);
    const flipped = chooseNumericInput(state, 'arcBulge', 'right');
    expect(expectCommitted(commitNumericInput(flipped)).commit.choices.arcBulge).toBe('right');
    // 選択肢を変えても欄は変わらない(欄の並びが選択肢に依らない段)。
    expect(flipped.fields.map((field) => field.key)).toEqual(['radius']);
  });

  it('2 点 (0,0,0)-(10,0,0) と半径 10 なら、中点から中心まで 8.660254…(√75)', () => {
    // 弦の半分 h = 5、中心までの距離 = √(10² − 5²) = √75 = 5√3 = 8.660254037844386。
    // 中心は (5, ±8.660254…, 0) の 2 つで、どちらを採るかは「ふくらむ向き」が決める。
    expect(twoPointArcCenterOffset(10, 10)).toBeCloseTo(8.660254037844386, 12);
    expect(twoPointArcCenterOffset(10, 10)).toBeCloseTo(Math.sqrt(3) * 5, 12);
    // 半径が弦の半分ちょうどなら中心は中点(半円)。
    expect(twoPointArcCenterOffset(10, 5)).toBe(0);
    // 8 と 5 は 3-4-5 の直角三角形。
    expect(twoPointArcCenterOffset(8, 5)).toBe(3);
  });

  it('半径が 2 点の間の長さの半分より小さいと円弧にならない(日本語で断る、NFR-UX-5)', () => {
    // 2 点間 30、半径 10 なら半弦 15 > 10 で解が無い(計画書タスク12 の検証表)。
    expect(twoPointArcCenterOffset(30, 10)).toBeNull();
    expect(twoPointArcRadiusRejection(30, 10)).toBe(
      '半径は 2 点の間の長さの半分(15mm)以上にしてください。',
    );
    // 引けるときは断らない。
    expect(twoPointArcRadiusRejection(10, 10)).toBeNull();
    expect(twoPointArcRadiusRejection(10, 5)).toBeNull();
  });

  it('2 点が同じ位置なら円弧にならない(長さ 0 の弦)', () => {
    expect(twoPointArcCenterOffset(0, 10)).toBeNull();
    expect(twoPointArcRadiusRejection(0, 10)).toBe('2 点が同じ位置にあるので円弧になりません。');
    expect(twoPointArcCenterOffset(Number.NaN, 10)).toBeNull();
    expect(twoPointArcCenterOffset(10, Number.NaN)).toBeNull();
  });
});

describe('P4 矩形・正多角形・長穴(FR-314、FR-315、FR-316)', () => {
  it('矩形は対角 2 点の 2 段で、2 つ目の角で確定する(FR-314)', () => {
    expect(nextNumericInput(createNumericInput('rectangle', 'rectangleCorner1'), false)?.step)
      .toBe('rectangleCorner2');
    const corner2 = createNumericInput('rectangle', 'rectangleCorner2');
    expect(corner2.mode).toBe('relative');
    expect(corner2.fields.map((field) => field.source)).toEqual(['0', '0', '0']);
    expect(nextNumericInput(corner2, false)).toBeNull();
    expect(nextNumericInput(corner2, true)?.step).toBe('rectangleCorner1');
    // 確定は座標(1 つ目の角と組にするのはタスク12)。
    expect(expectCoordinateCommit(corner2).step).toBe('rectangleCorner2');
  });

  it('正多角形は「中心 → 辺数・半径」で、辺数の既定は 6(FR-315)', () => {
    expect(nextNumericInput(createNumericInput('polygon', 'polygonCenter'), false)?.step)
      .toBe('polygonShape');
    const state = createNumericInput('polygon', 'polygonShape');
    expect(state.fields.map((field) => field.key)).toEqual(['sides', 'radius']);
    expect(state.fields.map((field) => field.source)).toEqual([String(DEFAULT_POLYGON_SIDES), '10']);
    expect(DEFAULT_POLYGON_SIDES).toBe(6);
    expect(state.fields.map((field) => field.unit)).toEqual(['count', 'mm']);
  });

  it('辺数は 3 未満を受け付けない。整数かどうかは model の解決が見る(NFR-UX-5)', () => {
    const state = createNumericInput('polygon', 'polygonShape');
    expect(evaluateNumericInput(edited(state, '2')).canCommit).toBe(false);
    expect(evaluateNumericInput(edited(state, '2')).results[0].error?.message).toBe(
      '辺数は 3 以上の値を入れてください。',
    );
    expect(evaluateNumericInput(edited(state, '3')).canCommit).toBe(true);
    // 3.5 は範囲では止まらない(整数の判定は resolveSketch の「辺の数は 3 以上にしてください。」)。
    expect(evaluateNumericInput(edited(state, '3.5')).canCommit).toBe(true);
  });

  it('半径の測り方は外接(既定)と内接から選べ、確定結果に入る(FR-315)', () => {
    const state = createNumericInput('polygon', 'polygonShape');
    expect(state.choices.map((choice) => choice.key)).toEqual(['polygonRadiusMode']);
    expect(choiceValueOf(state, 'polygonRadiusMode')).toBe('circumscribed');
    expect(expectCommitted(commitNumericInput(state)).commit.choices.polygonRadiusMode).toBe(
      'circumscribed',
    );
    // 内接を選んでも欄は変わらない(半径の意味だけが変わる。
    // 正六角形で内接 10 なら model は外接 10 / cos(π/6) = 11.547005383792515 として頂点を置く)。
    const inscribed = chooseNumericInput(state, 'polygonRadiusMode', 'inscribed');
    expect(inscribed.fields.map((field) => field.key)).toEqual(['sides', 'radius']);
    expect(expectCommitted(commitNumericInput(inscribed)).commit.choices.polygonRadiusMode).toBe(
      'inscribed',
    );
  });

  it('長穴は「中心 1 → 中心 2 → 幅」の 3 段。幅は 1 欄・既定 10(FR-316)', () => {
    expect(nextNumericInput(createNumericInput('slot', 'slotCenter1'), false)?.step)
      .toBe('slotCenter2');
    expect(nextNumericInput(createNumericInput('slot', 'slotCenter2'), false)?.step)
      .toBe('slotShape');
    const state = createNumericInput('slot', 'slotShape');
    expect(state.fields.map((field) => field.key)).toEqual(['width']);
    expect(state.fields.map((field) => field.source)).toEqual(['10']);
    expect(evaluateNumericInput(edited(state, '0')).canCommit).toBe(false);
    expect(nextNumericInput(state, true)?.step).toBe('slotCenter1');
    expect(nextNumericInput(state, false)).toBeNull();
  });

  it('長穴の幅を式で入れても、式の文字列のまま確定へ渡る(FR-202)', () => {
    const state = edited(createNumericInput('slot', 'slotShape'), '4*2.5');
    const commit = expectCommitted(commitNumericInput(state)).commit;
    expect(commit.values[0].source).toBe('4*2.5');
    expect(commit.values[0].value).toBe(10);
  });
});

describe('P4 楕円と楕円弧(FR-318)', () => {
  it('楕円は「中心 → 長半径・短半径 → 傾き」で、Enter 連打なら全周になる', () => {
    expect(nextNumericInput(createNumericInput('ellipse', 'ellipseCenter'), false)?.step)
      .toBe('ellipseShape');
    const shape = createNumericInput('ellipse', 'ellipseShape');
    expect(shape.fields.map((field) => field.key)).toEqual(['majorRadius', 'minorRadius']);
    expect(shape.fields.map((field) => field.source)).toEqual(['20', '10']);
    expect(nextNumericInput(shape, false)?.step).toBe('ellipseAngles');

    const angles = createNumericInput('ellipse', 'ellipseAngles');
    expect(angles.fields.map((field) => field.key)).toEqual(['rotation']);
    expect(angles.fields.map((field) => field.source)).toEqual(['0']);
    // 「一部だけ」が切なので、傾きを決めたところで終わる(全周の楕円)。
    expect(nextNumericInput(angles, false)).toBeNull();
    expect(nextNumericInput(angles, true)?.step).toBe('ellipseCenter');
  });

  it('半径は 0 を受け付けない。傾きは負の角度も受け付ける(向きに意味があるため)', () => {
    const shape = createNumericInput('ellipse', 'ellipseShape');
    expect(evaluateNumericInput(edited(shape, '0')).canCommit).toBe(false);
    expect(evaluateNumericInput(edited(shape, '0', 1)).canCommit).toBe(false);
    const angles = createNumericInput('ellipse', 'ellipseAngles');
    expect(evaluateNumericInput(edited(angles, '-30')).canCommit).toBe(true);
    expect(evaluateNumericInput(edited(angles, '400')).canCommit).toBe(true);
  });

  it('「一部だけ(楕円弧)」を入にすると開始角・終了角の段へ進む(FR-318)', () => {
    const angles = createNumericInput('ellipse', 'ellipseAngles');
    expect(angles.toggles.map((toggle) => toggle.key)).toEqual(['ellipseArc', 'construction']);
    expect(toggleValueOf(angles, 'ellipseArc')).toBe(false);
    const arc = toggleNumericInput(angles, 'ellipseArc');
    expect(nextNumericInput(arc, false)?.step).toBe('ellipseArcAngles');
    // つまみは確定結果にも入る(タスク12 が全周か楕円弧かを見分ける手掛かり)。
    expect(expectCommitted(commitNumericInput(arc)).commit.flags.ellipseArc).toBe(true);
  });

  it('楕円弧の角度の既定は 0 と 360。そのまま決めれば全周と同じ形になる(NFR-UX-4)', () => {
    const state = createNumericInput('ellipse', 'ellipseArcAngles');
    expect(state.fields.map((field) => field.key)).toEqual(['startAngle', 'endAngle']);
    expect(state.fields.map((field) => field.source)).toEqual(['0', '360']);
    const commit = expectCommitted(commitNumericInput(state)).commit;
    expect(commit.values.map((value) => value.value)).toEqual([0, 360]);
    expect(nextNumericInput(state, false)).toBeNull();
    expect(nextNumericInput(state, true)?.step).toBe('ellipseCenter');
  });

  it('楕円の欄は 1 段あたり 2 個まで(統括の指示、NFR-UX-2)', () => {
    for (const step of ['ellipseShape', 'ellipseAngles', 'ellipseArcAngles'] as const) {
      expect(createNumericInput('ellipse', step).fields.length, step).toBeLessThanOrEqual(2);
    }
  });
});

describe('P4 スプライン(FR-317、統括の決定 §0.a-0.17)', () => {
  it('点の段は座標を聞き、決めても閉じずに次の点を聞き続ける', () => {
    const state = createNumericInput('spline', 'splinePoint');
    expect(isCoordinateStep('splinePoint')).toBe(true);
    expect(state.fields.map((field) => field.key)).toEqual(['x', 'y', 'z']);
    // 「続けてかく」の入切に関わらず点を積み上げる(終わらせるのは splineFinishStateFrom)。
    expect(nextNumericInput(state, false)?.step).toBe('splinePoint');
    expect(nextNumericInput(state, true)?.step).toBe('splinePoint');
    // 指定方法は引き継ぐ(打ち直しの手間を増やさない)。
    const polar = createNumericInput('spline', 'splinePoint', 'polar');
    expect(nextNumericInput(polar, true)?.mode).toBe('polar');
  });

  it('決め方の段は欄を持たず、選択肢とつまみだけで決める(FR-317)', () => {
    const state = splineFinishStateFrom(createNumericInput('spline', 'splinePoint'));
    expect(state.step).toBe('splineShape');
    expect(state.toolId).toBe('spline');
    expect(state.fields).toEqual([]);
    expect(state.choices.map((choice) => choice.key)).toEqual(['splineMode']);
    expect(choiceValueOf(state, 'splineMode')).toBe('interpolate');
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['splineClosed', 'construction']);
    // 焦点の輪は選択肢から始まる(欄が無いため)。
    expect(numericFocusTargets(state)).toEqual([
      { kind: 'choice', index: 0 },
      { kind: 'toggle', index: 0 },
      { kind: 'toggle', index: 1 },
    ]);
  });

  it('欄が無い段でもそのまま決められ、選択肢とつまみが確定結果に入る', () => {
    const state = splineFinishStateFrom(createNumericInput('spline', 'splinePoint'));
    const commit = expectCommitted(commitNumericInput(state)).commit;
    expect(commit.kind).toBe('shape');
    expect(commit.step).toBe('splineShape');
    expect(commit.values).toEqual([]);
    expect(commit.choices.splineMode).toBe('interpolate');
    expect(commit.flags.splineClosed).toBe(false);
    expect(commit.flags.construction).toBe(false);
  });

  it('制御点・閉じるを選ぶと確定結果に入り、下書きへ写せる', () => {
    const state = toggleNumericInput(
      chooseNumericInput(
        splineFinishStateFrom(createNumericInput('spline', 'splinePoint')),
        'splineMode',
        'control',
      ),
      'splineClosed',
    );
    const commit = expectCommitted(commitNumericInput(state)).commit;
    expect(commit.choices.splineMode).toBe('control');
    expect(commit.flags.splineClosed).toBe(true);
    const draft = applySplineShapeCommit(EMPTY_SPLINE_DRAFT, commit);
    expect(draft.mode).toBe('control');
    expect(draft.closed).toBe(true);
    // 元の下書きは書き換えない(不変)。
    expect(EMPTY_SPLINE_DRAFT.mode).toBe('interpolate');
    expect(EMPTY_SPLINE_DRAFT.closed).toBe(false);
  });

  it('決め方の段以外の確定では下書きを変えない', () => {
    const commit = expectCommitted(
      commitNumericInput(createNumericInput('arc', 'arcShape')),
    ).commit;
    expect(applySplineShapeCommit(EMPTY_SPLINE_DRAFT, commit)).toBe(EMPTY_SPLINE_DRAFT);
  });

  it('下書きは点なし・通過点・開いた曲線から始まる(NFR-UX-4)', () => {
    expect(EMPTY_SPLINE_DRAFT.points).toEqual([]);
    expect(EMPTY_SPLINE_DRAFT.mode).toBe('interpolate');
    expect(EMPTY_SPLINE_DRAFT.closed).toBe(false);
  });

  it('点を置くと下書きが伸び、取り消すと 1 つ戻る(元の下書きは書き換えない)', () => {
    const one = expectDraft(appendSplinePoint(EMPTY_SPLINE_DRAFT, splinePoint('1')));
    const two = expectDraft(appendSplinePoint(one, splinePoint('2')));
    expect(one.points).toHaveLength(1);
    expect(two.points).toHaveLength(2);
    expect(EMPTY_SPLINE_DRAFT.points).toHaveLength(0);
    expect(removeLastSplinePoint(two).points).toHaveLength(1);
    // 点が無ければ同じ下書きをそのまま返す。
    expect(removeLastSplinePoint(EMPTY_SPLINE_DRAFT)).toBe(EMPTY_SPLINE_DRAFT);
  });

  it('点は 100 個まで。超える 1 個は断って下書きを変えない(§0.a-0.17)', () => {
    let draft: SplineDraft = EMPTY_SPLINE_DRAFT;
    for (let index = 0; index < MAX_SPLINE_POINTS; index += 1) {
      draft = expectDraft(appendSplinePoint(draft, splinePoint(String(index))));
    }
    expect(draft.points).toHaveLength(MAX_SPLINE_POINTS);
    expect(checkSplineDraft(draft).ok).toBe(true);
    const overflow = appendSplinePoint(draft, splinePoint('101'));
    expect(overflow.ok).toBe(false);
    if (overflow.ok) {
      throw new Error('expected the 101st point to be rejected');
    }
    expect(overflow.reason).toBe('スプラインの点は 100 個までです。');
  });

  it('開いた曲線は 2 点以上、閉じた曲線は 3 点以上ないと曲線にできない(日本語で断る)', () => {
    const one = expectDraft(appendSplinePoint(EMPTY_SPLINE_DRAFT, splinePoint('1')));
    const two = expectDraft(appendSplinePoint(one, splinePoint('2')));
    const three = expectDraft(appendSplinePoint(two, splinePoint('3')));

    const empty = checkSplineDraft(EMPTY_SPLINE_DRAFT);
    expect(empty.ok).toBe(false);
    if (empty.ok) {
      throw new Error('expected an empty draft to be rejected');
    }
    expect(empty.reason).toBe('スプラインには点が 2 個以上必要です。');
    expect(checkSplineDraft(one).ok).toBe(false);
    expect(checkSplineDraft(two).ok).toBe(true);

    const closedTwo = checkSplineDraft({ ...two, closed: true });
    expect(closedTwo.ok).toBe(false);
    if (closedTwo.ok) {
      throw new Error('expected a closed 2-point draft to be rejected');
    }
    expect(closedTwo.reason).toBe('閉じたスプラインには点が 3 個以上必要です。');
    expect(checkSplineDraft({ ...three, closed: true }).ok).toBe(true);
  });
});

describe('P4 点列の拡張(FR-327)', () => {
  it('並べ方の選択肢が付き、既定は直線。直線の欄は P1 のまま', () => {
    const state = createNumericInput('pointArray', 'pointArrayShape');
    expect(state.choices.map((choice) => choice.key)).toEqual(['pointArrayLayout']);
    expect(choiceValueOf(state, 'pointArrayLayout')).toBe('linear');
    expect(state.choices[0].options.map((option) => option.value)).toEqual([
      'linear',
      'circular',
      'grid',
    ]);
    expect(state.fields.map((field) => field.key)).toEqual(['azimuth', 'spacing', 'count']);
    expect(state.fields.map((field) => field.source)).toEqual(['0', '10', '5']);
    // 直線の欄には範囲を足していない(P1 の振る舞いを変えない)。
    expect(evaluateNumericInput(edited(state, '0', 2)).canCommit).toBe(true);
  });

  it('円周を選ぶと欄が「半径」「個数」の 2 つに変わる(中心 → 半径+個数)', () => {
    const state = chooseNumericInput(
      createNumericInput('pointArray', 'pointArrayShape'),
      'pointArrayLayout',
      'circular',
    );
    // 個数の欄の名前は直線の count と分けてある(直線の値を引き継いで既定値が
    // 画面に出なくなるのを避けるため。numericInput.ts の POINT_ARRAY_CIRCULAR_FIELDS の注釈)。
    expect(state.fields.map((field) => field.key)).toEqual(['radius', 'circularCount']);
    expect(state.fields.map((field) => field.labelKey)).toEqual([
      'numericInput.field.radius',
      'numericInput.field.count',
    ]);
    expect(state.fields.map((field) => field.source)).toEqual(['10', '6']);
    expect(expectCommitted(commitNumericInput(state)).commit.choices.pointArrayLayout).toBe(
      'circular',
    );
    // 円周は 1 段で終わる(「続けてかく」が切なら閉じる)。
    expect(nextNumericInput(state, false)).toBeNull();
    expect(nextNumericInput(state, true)?.step).toBe('pointArrayBase');
  });

  it('円周の半径と個数は範囲で守る(半径 > 0、個数 1〜1000。NFR-UX-5)', () => {
    const state = chooseNumericInput(
      createNumericInput('pointArray', 'pointArrayShape'),
      'pointArrayLayout',
      'circular',
    );
    expect(evaluateNumericInput(edited(state, '0')).canCommit).toBe(false);
    expect(evaluateNumericInput(edited(state, '0', 1)).canCommit).toBe(false);
    expect(evaluateNumericInput(edited(state, '1', 1)).canCommit).toBe(true);
    expect(evaluateNumericInput(edited(state, String(MAX_POINT_ARRAY_COUNT), 1)).canCommit).toBe(
      true,
    );
    expect(
      evaluateNumericInput(edited(state, String(MAX_POINT_ARRAY_COUNT + 1), 1)).canCommit,
    ).toBe(false);
  });

  it('格子は「行の間隔・行数」→「列の間隔・列数」の 2 段(1 段あたり 2 欄まで)', () => {
    const rows = chooseNumericInput(
      createNumericInput('pointArray', 'pointArrayShape'),
      'pointArrayLayout',
      'grid',
    );
    expect(rows.fields.map((field) => field.key)).toEqual(['rowSpacing', 'rowCount']);
    expect(rows.fields.map((field) => field.source)).toEqual(['10', '3']);
    expect(nextNumericInput(rows, false)?.step).toBe('pointArrayGridColumns');

    const columns = createNumericInput('pointArray', 'pointArrayGridColumns');
    expect(columns.fields.map((field) => field.key)).toEqual(['colSpacing', 'colCount']);
    expect(columns.fields.map((field) => field.source)).toEqual(['10', '3']);
    expect(nextNumericInput(columns, false)).toBeNull();
    expect(nextNumericInput(columns, true)?.step).toBe('pointArrayBase');
  });

  it('格子の行・列の向きは作図面の第1軸と第2軸に固定する(欄を 2 個までに収めるため)', () => {
    expect(DEFAULT_GRID_ROW_AZIMUTH_DEGREES).toBe(0);
    expect(DEFAULT_GRID_COLUMN_AZIMUTH_DEGREES).toBe(90);
    // 角度の欄はどちらの段にも出さない(傾けるのはプロパティ側の受け持ち)。
    for (const step of ['pointArrayShape', 'pointArrayGridColumns'] as const) {
      const state = chooseNumericInput(
        createNumericInput('pointArray', step),
        'pointArrayLayout',
        'grid',
      );
      expect(state.fields.some((field) => field.key.endsWith('Azimuth')), step).toBe(false);
    }
  });

  it('並べ方を ← → で送っても欄が入れ替わり、焦点は選択肢を指したまま(NFR-UX-2)', () => {
    const state = createNumericInput('pointArray', 'pointArrayShape');
    // 直線は欄が 3 つなので、選択肢の焦点は輪の 4 番目(添字 3)。
    const onChoice = reduceNumericInput(state, { type: 'focus', index: 3 });
    expect(focusedTarget(onChoice)).toEqual({ kind: 'choice', index: 0 });
    const circular = expectOpen(applyNumericInputKey(onChoice, 'ArrowRight')).state;
    expect(choiceValueOf(circular, 'pointArrayLayout')).toBe('circular');
    expect(circular.fields.map((field) => field.key)).toEqual(['radius', 'circularCount']);
    expect(focusedTarget(circular)).toEqual({ kind: 'choice', index: 0 });

    const grid = expectOpen(applyNumericInputKey(circular, 'ArrowRight')).state;
    expect(choiceValueOf(grid, 'pointArrayLayout')).toBe('grid');
    expect(grid.fields.map((field) => field.key)).toEqual(['rowSpacing', 'rowCount']);
    // 末尾から先頭(直線)へ回り込むと欄も 3 つへ戻る。
    const wrapped = expectOpen(applyNumericInputKey(grid, 'ArrowRight')).state;
    expect(choiceValueOf(wrapped, 'pointArrayLayout')).toBe('linear');
    expect(wrapped.fields.map((field) => field.key)).toEqual(['azimuth', 'spacing', 'count']);
    expect(focusedTarget(wrapped)).toEqual({ kind: 'choice', index: 0 });
  });

  it('並べ方ごとに欄の名前を分けてあるので、切り替えるとその並べ方の既定値から始まる', () => {
    const circular = chooseNumericInput(
      createNumericInput('pointArray', 'pointArrayShape'),
      'pointArrayLayout',
      'circular',
    );
    // 直線の「個数 5」を引き継がず、円周の既定 6 が出る(既定値が画面に出ないのを避けるため)。
    expect(circular.fields.map((field) => field.source)).toEqual(['10', '6']);
    const edited8 = reduceNumericInput(circular, { type: 'edit', index: 1, source: '8' });
    const grid = chooseNumericInput(edited8, 'pointArrayLayout', 'grid');
    expect(grid.fields.map((field) => field.source)).toEqual(['10', '3']);
    // 戻すと既定値から。並べ方ごとの打ち込みを覚えておく仕組みは持たない。
    const backToCircular = chooseNumericInput(grid, 'pointArrayLayout', 'circular');
    expect(backToCircular.fields.map((field) => field.source)).toEqual(['10', '6']);
    // 半径の欄は名前が同じなので、円周 ⇄ 格子でも「間隔」とは混ざらない。
    expect(backToCircular.fields[0].key).toBe('radius');
  });
});

describe('3 点の円弧(FR-330、P4 タスク36、2026-09-04 追加要件)', () => {
  it('3 段とも座標(x/y/z)の 3 欄だけで、半径や角度の欄は無い(始点・終点・通過点をクリックするだけ)', () => {
    for (const step of ['threePointArcStart', 'threePointArcEnd', 'threePointArcVia'] as const) {
      expect(isCoordinateStep(step), step).toBe(true);
      expect(createNumericInput('threePointArc', step).fields, step).toHaveLength(3);
    }
  });

  it('2・3 点目の既定は相対(直前の点からの続きで入れられる、FR-307)', () => {
    for (const step of ['threePointArcEnd', 'threePointArcVia'] as const) {
      expect(defaultModeForStep(step)).toBe('relative');
    }
    expect(defaultModeForStep('threePointArcStart')).toBe('absolute');
  });

  it('構築線のつまみは 3 点目(通過点)の段だけに付く(FR-320)', () => {
    expect(
      createNumericInput('threePointArc', 'threePointArcVia').toggles.some(
        (toggle) => toggle.key === 'construction',
      ),
    ).toBe(true);
    for (const step of ['threePointArcStart', 'threePointArcEnd'] as const) {
      expect(
        createNumericInput('threePointArc', step).toggles.some(
          (toggle) => toggle.key === 'construction',
        ),
        step,
      ).toBe(false);
    }
  });

  it('段の遷移は始点 → 終点 → 通過点 → (続けてかくなら)始点', () => {
    expect(nextNumericInput(createNumericInput('threePointArc', 'threePointArcStart'), false)?.step)
      .toBe('threePointArcEnd');
    expect(nextNumericInput(createNumericInput('threePointArc', 'threePointArcEnd'), false)?.step)
      .toBe('threePointArcVia');
    expect(nextNumericInput(createNumericInput('threePointArc', 'threePointArcVia'), true)?.step)
      .toBe('threePointArcStart');
    expect(nextNumericInput(createNumericInput('threePointArc', 'threePointArcVia'), false)).toBeNull();
  });

  it('見出しがすべて ja.json のキーとして実在する', () => {
    for (const step of ['threePointArcStart', 'threePointArcEnd', 'threePointArcVia'] as const) {
      expect(NUMERIC_INPUT_STEPS, step).toContain(step);
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
    }
  });
});

describe('P4 段の網羅と、既存の段を壊していないこと', () => {
  it('新しい段はすべて段の一覧に載っている(見出しの網羅検査が舐めるため)', () => {
    const added = [
      'pointArrayGridColumns',
      'circleCenter',
      'circleRadius',
      'twoPointArcStart',
      'twoPointArcEnd',
      'twoPointArcRadius',
      'rectangleCorner1',
      'rectangleCorner2',
      'polygonCenter',
      'polygonShape',
      'slotCenter1',
      'slotCenter2',
      'slotShape',
      'ellipseCenter',
      'ellipseShape',
      'ellipseAngles',
      'ellipseArcAngles',
      'splinePoint',
      'splineShape',
    ] as const;
    for (const step of added) {
      expect(NUMERIC_INPUT_STEPS, step).toContain(step);
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
      expect(isSolidStep(step), step).toBe(false);
    }
  });

  it('形を聞く新しい段は欄が 1 段あたり 2 個まで(統括の指示)', () => {
    const shapeSteps = [
      'pointArrayGridColumns',
      'circleRadius',
      'twoPointArcRadius',
      'polygonShape',
      'slotShape',
      'ellipseShape',
      'ellipseAngles',
      'ellipseArcAngles',
      'splineShape',
    ] as const;
    for (const step of shapeSteps) {
      expect(createNumericInput('point', step).fields.length, step).toBeLessThanOrEqual(2);
    }
  });

  it('新しい段でもモードの切替は座標の段だけに効く(P1 と同じ規則)', () => {
    const radius = createNumericInput('circle', 'circleRadius');
    expect(reduceNumericInput(radius, { type: 'setMode', mode: 'polar' })).toBe(radius);
    const center = createNumericInput('circle', 'circleCenter');
    expect(reduceNumericInput(center, { type: 'setMode', mode: 'polar' }).fields.map((f) => f.key))
      .toEqual(['distance', 'azimuth', 'elevation']);
  });

  it('新しい段でも Esc は取消、不正な欄があれば決めさせない(NFR-UX-3、NFR-UX-5)', () => {
    const state = edited(createNumericInput('polygon', 'polygonShape'), '1+');
    expect(applyNumericInputKey(state, 'Escape')).toEqual({ kind: 'cancelled' });
    const blocked = expectBlocked(applyNumericInputKey(state, 'Enter'));
    expect(blocked.evaluation.canCommit).toBe(false);
    expect(blocked.state.focusedIndex).toBe(0);
  });

  it('確定処理・段の遷移は元の state を書き換えない(不変性)', () => {
    const state = toggleNumericInput(createNumericInput('ellipse', 'ellipseAngles'), 'ellipseArc');
    const before = JSON.stringify(state);
    commitNumericInput(state);
    nextNumericInput(state, true);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('P1・P2・P3 の段の遷移は 1 つも変わっていない(回帰)', () => {
    expect(nextNumericInput(createNumericInput('line', 'lineStart'), false)?.step).toBe('lineEnd');
    expect(nextNumericInput(createNumericInput('arc', 'arcCenter'), false)?.step).toBe('arcShape');
    expect(nextNumericInput(createNumericInput('pointArray', 'pointArrayBase'), false)?.step)
      .toBe('pointArrayShape');
    expect(nextNumericInput(createNumericInput('pointArray', 'pointArrayShape'), true)?.step)
      .toBe('pointArrayBase');
    expect(nextNumericInput(createNumericInput('pointArray', 'pointArrayShape'), false)).toBeNull();
    expect(nextNumericInput(createNumericInput('spring', 'springShape'), false)?.step)
      .toBe('springLength');
    expect(nextNumericInput(createNumericInput('extrude', 'extrudeDistance'), true)).toBeNull();
  });

  it('つまみの見出しは新しい 3 つも ja.json に実在する(NFR-MA-5)', () => {
    for (const key of ['construction', 'ellipseArc', 'splineClosed'] as const) {
      expect(MESSAGE_KEYS).toContain(TOGGLE_LABEL_KEYS[key]);
      expect(t(TOGGLE_LABEL_KEYS[key]).length).toBeGreaterThan(0);
    }
  });
});

/* ---- P4 タスク13: 基準ジオメトリの段(FR-328、FR-329) ---- */

function expectReferenceCommitted(
  transition: NumericInputTransition,
): Extract<NumericInputTransition, { kind: 'referenceCommitted' }> {
  if (transition.kind !== 'referenceCommitted') {
    throw new Error(`expected referenceCommitted transition, got ${transition.kind}`);
  }
  return transition;
}

function expectEditCommitted(
  transition: NumericInputTransition,
): Extract<NumericInputTransition, { kind: 'editCommitted' }> {
  if (transition.kind !== 'editCommitted') {
    throw new Error(`expected editCommitted transition, got ${transition.kind}`);
  }
  return transition;
}

describe('基準ジオメトリの段(FR-328、FR-329)', () => {
  it('道具から最初の段が引ける。7 つとも基準ジオメトリの段になる', () => {
    expect(REFERENCE_TOOL_STEPS).toEqual({
      referencePlaneThreePoints: 'referencePlanePoint1',
      referencePlaneOffset: 'referencePlaneOffset',
      referencePlaneTilted: 'referencePlaneTilt',
      referencePlaneThroughPoint: 'referencePlaneBasePoint',
      referenceAxis: 'referenceAxisKind',
      referencePoint: 'referencePointKind',
      referenceCoordinateSystem: 'referenceCsOrigin',
    });
    for (const step of Object.values(REFERENCE_TOOL_STEPS)) {
      expect(isReferenceStep(step)).toBe(true);
      expect(isSolidStep(step)).toBe(false);
    }
  });

  it('道具の見分けは表 1 つだけを見る', () => {
    expect(isReferenceTool('referenceAxis')).toBe(true);
    expect(isReferenceTool('circle')).toBe(false);
    expect(isReferenceTool('extrude')).toBe(false);
  });

  it('すべての段が一覧と見出しの表に載っている(NFR-MA-5)', () => {
    const steps = NUMERIC_INPUT_STEPS.filter((step) => isReferenceStep(step));
    expect(steps).toHaveLength(14);
    for (const step of steps) {
      expect(MESSAGE_KEYS).toContain(STEP_TITLE_KEYS[step]);
      expect(t(STEP_TITLE_KEYS[step]).length).toBeGreaterThan(0);
    }
  });

  it('点を聞く段は位置の決め方のタブを出し、値を聞く段は出さない', () => {
    expect(asksCoordinate('referencePlanePoint1')).toBe(true);
    expect(isReferenceCoordinateStep('referencePlanePoint1')).toBe(true);
    expect(asksCoordinate('referencePlaneOffset')).toBe(false);
    // P1 の段の判定は変わっていない(回帰)。
    expect(asksCoordinate('lineStart')).toBe(true);
    expect(isCoordinateStep('referencePlanePoint1')).toBe(false);
  });

  it('2 点目・3 点目は相対が既定になる(1 つ前の点からの続きで入れる)', () => {
    expect(defaultModeForStep('referencePlanePoint1')).toBe('absolute');
    expect(defaultModeForStep('referencePlanePoint2')).toBe('relative');
    expect(defaultModeForStep('referencePlanePoint3')).toBe('relative');
    expect(defaultModeForStep('referenceAxisEnd')).toBe('relative');
  });

  it('どの段も入切のつまみを持たない', () => {
    for (const step of NUMERIC_INPUT_STEPS.filter((candidate) => isReferenceStep(candidate))) {
      expect(createNumericInput('referenceAxis', step).toggles).toEqual([]);
    }
  });

  it('面から離す段は距離 1 欄と「もとにする面」の選択肢を持つ', () => {
    const state = createNumericInput('referencePlaneOffset', 'referencePlaneOffset');
    expect(state.fields.map((field) => field.key)).toEqual(['planeOffset']);
    expect(state.fields[0].source).toBe('10');
    // 距離は負の値も向きの意味を持つので範囲を付けない。
    expect(state.fields[0].range).toBeUndefined();
    expect(choiceValueOf(state, 'referencePlaneBase')).toBe('current');
    expect(state.choices[0].options.map((option) => option.value)).toEqual([
      'current',
      'xy',
      'xz',
      'yz',
      'face',
    ]);
  });

  it('傾ける段は角度 1 欄と軸の選択肢を持ち、文書の基準軸も並ぶ', () => {
    const state = createNumericInput('referencePlaneTilted', 'referencePlaneTilt', undefined, {
      referenceAxes: [{ id: 'referenceAxis-1', name: '基準軸1' }],
    });
    expect(state.fields.map((field) => field.key)).toEqual(['planeAngle']);
    expect(state.fields[0].source).toBe('45');
    expect(state.choices[0].options.map((option) => option.value)).toEqual([
      'x',
      'y',
      'z',
      'reference:referenceAxis-1',
    ]);
    expect(state.choices[0].options[3].label).toBe('基準軸1');
  });

  it('点を通る段は「軸に垂直」を選んだときだけ傾き・向きの欄が出る(NFR-UX-2)', () => {
    const state = createNumericInput('referencePlaneThroughPoint', 'referencePlaneThrough');
    expect(state.fields).toEqual([]);
    const withAxis = chooseNumericInput(state, 'referencePlaneThroughMode', 'axis');
    expect(withAxis.fields.map((field) => field.key)).toEqual(['planeTilt', 'planeAzimuth']);
    const back = chooseNumericInput(withAxis, 'referencePlaneThroughMode', 'containingEdge');
    expect(back.fields).toEqual([]);
  });

  it('傾き角は 0 度以上 180 度未満だけを受け付ける(model の断りと同じ範囲)', () => {
    const state = chooseNumericInput(
      createNumericInput('referencePlaneThroughPoint', 'referencePlaneThrough'),
      'referencePlaneThroughMode',
      'axis',
    );
    expect(evaluateNumericInput(edited(state, '180')).canCommit).toBe(false);
    expect(evaluateNumericInput(edited(state, '179')).canCommit).toBe(true);
    expect(evaluateNumericInput(edited(state, '-1')).canCommit).toBe(false);
  });

  it('決め方だけを聞く段は欄を持たず、選択肢だけで決まる', () => {
    const axis = createNumericInput('referenceAxis', 'referenceAxisKind');
    expect(axis.fields).toEqual([]);
    expect(choiceValueOf(axis, 'referenceAxisKind')).toBe('twoPoints');
    const point = createNumericInput('referencePoint', 'referencePointKind');
    expect(point.fields).toEqual([]);
    expect(choiceValueOf(point, 'referencePointKind')).toBe('coordinate');
  });

  it('座標系の段は 2 つの軸の選択肢を持つ', () => {
    const state = createNumericInput('referenceCoordinateSystem', 'referenceCsAxes');
    expect(state.choices.map((choice) => choice.key)).toEqual([
      'referenceCsXAxis',
      'referenceCsYAxis',
    ]);
    expect(choiceValueOf(state, 'referenceCsXAxis')).toBe('x');
    expect(choiceValueOf(state, 'referenceCsYAxis')).toBe('y');
  });

  it('段の遷移: 3 点は 3 段、決め方で分かれる段は選んだ値で行き先が変わる', () => {
    const first = createNumericInput('referencePlaneThreePoints', 'referencePlanePoint1');
    expect(nextNumericInput(first, false)?.step).toBe('referencePlanePoint2');
    expect(
      nextNumericInput(
        createNumericInput('referencePlaneThreePoints', 'referencePlanePoint2'),
        true,
      )?.step,
    ).toBe('referencePlanePoint3');
    // 「続けてかく」が入でも、基準ジオメトリは 1 つ作ったら閉じる。
    expect(
      nextNumericInput(
        createNumericInput('referencePlaneThreePoints', 'referencePlanePoint3'),
        true,
      ),
    ).toBeNull();
    expect(
      nextNumericInput(createNumericInput('referencePlaneOffset', 'referencePlaneOffset'), true),
    ).toBeNull();
    const axisKind = createNumericInput('referenceAxis', 'referenceAxisKind');
    expect(nextNumericInput(axisKind, false)?.step).toBe('referenceAxisStart');
    expect(
      nextNumericInput(chooseNumericInput(axisKind, 'referenceAxisKind', 'edge'), false),
    ).toBeNull();
    const pointKind = createNumericInput('referencePoint', 'referencePointKind');
    expect(nextNumericInput(pointKind, false)?.step).toBe('referencePointAt');
    expect(
      nextNumericInput(chooseNumericInput(pointKind, 'referencePointKind', 'vertex'), false),
    ).toBeNull();
  });

  it('軸の一覧は次の段へ持ち越す(原点の次の段でも基準軸が選べる)', () => {
    const origin = createNumericInput('referenceCoordinateSystem', 'referenceCsOrigin', undefined, {
      referenceAxes: [{ id: 'referenceAxis-1', name: '基準軸1' }],
    });
    const axes = nextNumericInput(origin, false);
    expect(axes?.step).toBe('referenceCsAxes');
    expect(axes?.choices[0].options.map((option) => option.value)).toEqual([
      'x',
      'y',
      'z',
      'reference:referenceAxis-1',
    ]);
  });

  it('点を聞く段の確定は座標つきの基準ジオメトリの結果になる', () => {
    const state = createNumericInput('referencePlaneThreePoints', 'referencePlanePoint1');
    const committed = expectReferenceCommitted(commitNumericInput(state));
    expect(committed.commit.kind).toBe('reference');
    expect(committed.commit.tool).toBe('referencePlaneThreePoints');
    expect(committed.commit.coordinate).toEqual({
      mode: 'absolute',
      x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0),
      z: expressionValueFromNumber(0),
    });
    expect(committed.commit.mode).toBe('absolute');
  });

  it('値を聞く段の確定は欄と選択肢だけを渡す', () => {
    const state = chooseNumericInput(
      createNumericInput('referencePlaneOffset', 'referencePlaneOffset'),
      'referencePlaneBase',
      'face',
    );
    const committed = expectReferenceCommitted(commitNumericInput(state));
    expect(committed.commit.coordinate).toBeNull();
    expect(committed.commit.values.offset?.value).toBe(10);
    expect(committed.commit.choices.planeBase).toBe('face');
  });

  it('選択肢の見出しと札はすべて ja.json に実在する(NFR-MA-5)', () => {
    for (const step of NUMERIC_INPUT_STEPS.filter((candidate) => isReferenceStep(candidate))) {
      const state = createNumericInput('referenceAxis', step);
      for (const choice of state.choices) {
        expect(MESSAGE_KEYS).toContain(choice.labelKey);
        for (const option of choice.options) {
          expect(numericChoiceOptionLabel(option).length).toBeGreaterThan(0);
        }
      }
      for (const field of state.fields) {
        expect(MESSAGE_KEYS).toContain(field.labelKey);
        expect(MESSAGE_KEYS).toContain(field.tooltipKey);
      }
    }
  });
});

describe('整形系(オフセット、FR-321、計画書 docs/plans/P4-スケッチ拡張.md タスク21)', () => {
  it('道具から最初の段が引ける。offset は offsetDistance の 1 段だけ', () => {
    // タスク24 で複製系の 4 道具が同じ表へ入った(この表が道具の一覧の正本なので、
    // 道具を足すと期待値も増える。緩めたのではなく、増えたぶんを書き足してある)。
    expect(EDIT_TOOL_STEPS.offset).toBe('offsetDistance');
    expect(isEditStep('offsetDistance')).toBe(true);
    expect(isSolidStep('offsetDistance')).toBe(false);
    expect(isReferenceStep('offsetDistance')).toBe(false);
  });

  it('道具の見分けは表 1 つだけを見る', () => {
    expect(isEditTool('offset')).toBe(true);
    expect(isEditTool('circle')).toBe(false);
    expect(isEditTool('extrude')).toBe(false);
  });

  it('段が一覧と見出しの表に載っている(NFR-MA-5)', () => {
    expect(NUMERIC_INPUT_STEPS).toContain('offsetDistance');
    expect(MESSAGE_KEYS).toContain(STEP_TITLE_KEYS.offsetDistance);
    expect(t(STEP_TITLE_KEYS.offsetDistance).length).toBeGreaterThan(0);
  });

  it('座標を聞く段ではない(選択はすでに済んでいる、§2.5)', () => {
    expect(asksCoordinate('offsetDistance')).toBe(false);
    expect(isCoordinateStep('offsetDistance')).toBe(false);
  });

  it('距離の欄は既定 5mm、0 より大きい値だけを許す', () => {
    const state = createNumericInput('offset', 'offsetDistance');
    expect(state.fields.map((field) => field.key)).toEqual(['distance']);
    expect(state.fields[0].source).toBe('5');
    expect(state.fields[0].range).toEqual({
      min: 0,
      minInclusive: false,
      max: null,
      maxInclusive: false,
    });
    expect(state.toggles).toEqual([]);
  });

  it('閉じた輪郭(既定)では側の見出しが外/内になる', () => {
    const state = createNumericInput('offset', 'offsetDistance');
    const side = state.choices.find((choice) => choice.key === 'offsetSide');
    expect(side?.value).toBe('outside');
    expect(side?.options.map((option) => option.labelKey)).toEqual([
      'numericInput.offsetSide.outside',
      'numericInput.offsetSide.inside',
    ]);
  });

  it('開いた曲線(offsetOpenContour)では側の見出しが左/右になる。値は変わらない', () => {
    const state = createNumericInput('offset', 'offsetDistance', undefined, {
      offsetOpenContour: true,
    });
    const side = state.choices.find((choice) => choice.key === 'offsetSide');
    expect(side?.value).toBe('outside');
    expect(side?.options.map((option) => option.value)).toEqual(['outside', 'inside']);
    expect(side?.options.map((option) => option.labelKey)).toEqual([
      'numericInput.offsetSide.left',
      'numericInput.offsetSide.right',
    ]);
  });

  it('角の選択肢は丸める/尖らせるの 2 択で、既定は丸める', () => {
    const state = createNumericInput('offset', 'offsetDistance');
    const corner = state.choices.find((choice) => choice.key === 'offsetCorner');
    expect(corner?.value).toBe('round');
    expect(corner?.options.map((option) => option.value)).toEqual(['round', 'sharp']);
  });

  it('確定すると editCommitted になり、道具・段・欄・選択肢が写る', () => {
    const state = chooseNumericInput(
      chooseNumericInput(createNumericInput('offset', 'offsetDistance'), 'offsetSide', 'inside'),
      'offsetCorner',
      'sharp',
    );
    const filled = reduceNumericInput(state, { type: 'edit', index: 0, source: '8' });
    const committed = expectEditCommitted(commitNumericInput(filled));
    expect(committed.commit.kind).toBe('edit');
    expect(committed.commit.tool).toBe('offset');
    expect(committed.commit.step).toBe('offsetDistance');
    expect(committed.commit.values.distance?.value).toBe(8);
    expect(committed.commit.choices).toEqual({ side: 'inside', corner: 'sharp' });
  });

  it('確定すると必ず閉じる(対象を選び直さないと続けられない、§2.5)', () => {
    const state = createNumericInput('offset', 'offsetDistance');
    const committed = expectEditCommitted(commitNumericInput(state));
    expect(nextNumericInput(committed.state, true)).toBeNull();
    expect(nextNumericInput(committed.state, false)).toBeNull();
  });

  it('欄が 0 以下では確定させない(NFR-UX-5)', () => {
    const state = reduceNumericInput(createNumericInput('offset', 'offsetDistance'), {
      type: 'edit',
      index: 0,
      source: '0',
    });
    expectBlocked(commitNumericInput(state));
  });

  it('選択肢の見出しと札はすべて ja.json に実在する(NFR-MA-5)', () => {
    const state = createNumericInput('offset', 'offsetDistance');
    for (const choice of state.choices) {
      expect(MESSAGE_KEYS).toContain(choice.labelKey);
      for (const option of choice.options) {
        expect(numericChoiceOptionLabel(option).length).toBeGreaterThan(0);
      }
    }
    for (const field of state.fields) {
      expect(MESSAGE_KEYS).toContain(field.labelKey);
      expect(MESSAGE_KEYS).toContain(field.tooltipKey);
    }
  });
});

describe('複製系(ミラー・複写・配列複写、FR-324、計画書 タスク24)', () => {
  const COPY_TOOLS = ['mirror', 'copy', 'linearArray', 'circularArray'] as const;
  const COPY_STEPS = [
    'mirrorBasis',
    'copyDelta',
    'linearArrayDirection',
    'linearArrayCount',
    'circularArrayCenter',
    'circularArrayShape',
  ] as const;

  it('4 つの道具が最初に開く段は表 1 つだけで決まる', () => {
    expect(EDIT_TOOL_STEPS.mirror).toBe('mirrorBasis');
    expect(EDIT_TOOL_STEPS.copy).toBe('copyDelta');
    expect(EDIT_TOOL_STEPS.linearArray).toBe('linearArrayDirection');
    expect(EDIT_TOOL_STEPS.circularArray).toBe('circularArrayCenter');
    for (const tool of COPY_TOOLS) {
      expect(isEditTool(tool), tool).toBe(true);
    }
  });

  it('6 つの段が一覧と見出しの表に載っている(NFR-MA-5)', () => {
    for (const step of COPY_STEPS) {
      expect(NUMERIC_INPUT_STEPS, step).toContain(step);
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
      expect(isEditStep(step), step).toBe(true);
      expect(isSolidStep(step), step).toBe(false);
      expect(isReferenceStep(step), step).toBe(false);
    }
  });

  it('欄は 1 段あたり 2 個まで(統括の指示)', () => {
    for (const step of COPY_STEPS) {
      const state = createNumericInput('mirror', step);
      expect(state.fields.length, step).toBeLessThanOrEqual(
        // 円形配列の中心だけは座標の 3 欄(P1 からある座標の段と同じ形)。
        step === 'circularArrayCenter' ? 3 : 2,
      );
    }
  });

  it('ミラーは欄を持たず、鏡にするものだけを選ばせる', () => {
    const state = createNumericInput('mirror', 'mirrorBasis');
    expect(state.fields).toEqual([]);
    const basis = state.choices.find((choice) => choice.key === 'mirrorBasis');
    expect(basis?.value).toBe('axisU');
    expect(basis?.options.map((option) => option.value)).toEqual(['axisU', 'axisV']);
    expect(state.toggles.map((toggle) => toggle.key)).toEqual(['construction']);
  });

  it('選んだ線があるときだけ「選んだ線」が選択肢に並ぶ(NFR-UX-5)', () => {
    const state = createNumericInput('mirror', 'mirrorBasis', undefined, {
      mirrorAxes: { planeAxes: true, selectedLine: true },
    });
    const basis = state.choices.find((choice) => choice.key === 'mirrorBasis');
    expect(basis?.options.map((option) => option.value)).toEqual(['axisU', 'axisV', 'line']);
  });

  it('任意の作業平面では作図面の軸が並ばず、既定が「選んだ線」になる', () => {
    const state = createNumericInput('mirror', 'mirrorBasis', undefined, {
      mirrorAxes: { planeAxes: false, selectedLine: true },
    });
    const basis = state.choices.find((choice) => choice.key === 'mirrorBasis');
    expect(basis?.options.map((option) => option.value)).toEqual(['line']);
    expect(basis?.value).toBe('line');
  });

  it('複写は作図面の 2 軸ぶんの欄。3D スケッチでは 3 つ目が増える', () => {
    expect(createNumericInput('copy', 'copyDelta').fields.map((field) => field.key)).toEqual([
      'dx',
      'dy',
    ]);
    const free = createNumericInput('copy', 'copyDelta', undefined, { freeSketch: true });
    expect(free.fields.map((field) => field.key)).toEqual(['dx', 'dy', 'dz']);
  });

  it('複写の既定は「横へ 20mm」(Enter 連打で隣に 1 つ増える、NFR-UX-4)', () => {
    const state = createNumericInput('copy', 'copyDelta');
    expect(state.fields.map((field) => field.source)).toEqual(['20', '0']);
  });

  it('直線配列は 2 段。1 段目を決めると閉じずに 2 段目が開く', () => {
    const first = createNumericInput('linearArray', 'linearArrayDirection');
    expect(first.fields.map((field) => field.key)).toEqual(['angle', 'spacing']);
    const transition = commitNumericInput(first);
    expect(transition.kind).toBe('open');
    if (transition.kind !== 'open') {
      return;
    }
    expect(transition.state.step).toBe('linearArrayCount');
    expect(transition.state.fields.map((field) => field.key)).toEqual(['count']);
    expect(transition.state.fields[0].source).toBe('3');
  });

  it('直線配列の 2 段目の確定に、1 段目の向き・間隔が持ち越される', () => {
    const first = reduceNumericInput(
      reduceNumericInput(createNumericInput('linearArray', 'linearArrayDirection'), {
        type: 'edit',
        index: 0,
        source: '90',
      }),
      { type: 'edit', index: 1, source: '12' },
    );
    const opened = commitNumericInput(first);
    if (opened.kind !== 'open') {
      throw new Error('2 段目が開いていません');
    }
    const committed = expectEditCommitted(commitNumericInput(opened.state));
    expect(committed.commit.tool).toBe('linearArray');
    expect(committed.commit.step).toBe('linearArrayCount');
    expect(committed.commit.values.angle?.value).toBe(90);
    expect(committed.commit.values.spacing?.value).toBe(12);
    expect(committed.commit.values.count?.value).toBe(3);
  });

  it('個数は 2 以上 100 以下しか受け付けない(NFR-UX-5)', () => {
    const opened = commitNumericInput(createNumericInput('linearArray', 'linearArrayDirection'));
    if (opened.kind !== 'open') {
      throw new Error('2 段目が開いていません');
    }
    for (const source of ['1', '101']) {
      expectBlocked(
        commitNumericInput(reduceNumericInput(opened.state, { type: 'edit', index: 0, source })),
      );
    }
    expect(opened.state.fields[0].range).toEqual({
      min: 2,
      minInclusive: true,
      max: 100,
      maxInclusive: true,
    });
  });

  it('円形配列の 1 段目は座標を聞き、位置の決め方のタブが出る', () => {
    expect(asksCoordinate('circularArrayCenter')).toBe(true);
    // スケッチの座標の段(点・線分など)とは別の型なので、そちらの判定は偽のまま。
    expect(isCoordinateStep('circularArrayCenter')).toBe(false);
    const state = createNumericInput('circularArray', 'circularArrayCenter');
    expect(state.fields.map((field) => field.key)).toEqual(['x', 'y', 'z']);
  });

  it('円形配列の 2 段目は角度・個数と「全周」。既定は全周・4 個', () => {
    const opened = commitNumericInput(createNumericInput('circularArray', 'circularArrayCenter'));
    if (opened.kind !== 'open') {
      throw new Error('2 段目が開いていません');
    }
    expect(opened.state.step).toBe('circularArrayShape');
    expect(opened.state.fields.map((field) => field.key)).toEqual(['angle', 'count']);
    expect(opened.state.fields[1].source).toBe('4');
    expect(opened.state.toggles.map((toggle) => toggle.key)).toEqual([
      'fullCircle',
      'construction',
    ]);
    expect(toggleValueOf(opened.state, 'fullCircle')).toBe(true);
  });

  it('円形配列の確定に、1 段目で入れた中心が写る', () => {
    const center = reduceNumericInput(
      createNumericInput('circularArray', 'circularArrayCenter'),
      { type: 'setValues', values: [20, 30, 0] },
    );
    const opened = commitNumericInput(center);
    if (opened.kind !== 'open') {
      throw new Error('2 段目が開いていません');
    }
    const committed = expectEditCommitted(commitNumericInput(opened.state));
    expect(committed.commit.tool).toBe('circularArray');
    expect(committed.commit.flags.fullCircle).toBe(true);
    const coordinate = committed.commit.coordinate;
    if (coordinate?.mode !== 'absolute') {
      throw new Error('中心が絶対座標として写っていません');
    }
    expect([coordinate.x.value, coordinate.y.value, coordinate.z.value]).toEqual([20, 30, 0]);
  });

  it('ミラー・複写は 1 段で終わり、確定したら必ず閉じる(§2.5)', () => {
    for (const step of ['mirrorBasis', 'copyDelta'] as const) {
      const committed = expectEditCommitted(commitNumericInput(createNumericInput('mirror', step)));
      expect(nextNumericInput(committed.state, true), step).toBeNull();
      expect(nextNumericInput(committed.state, false), step).toBeNull();
    }
  });

  it('ミラーの確定に、鏡にするものの選択肢が写る', () => {
    const state = chooseNumericInput(
      createNumericInput('mirror', 'mirrorBasis', undefined, {
        mirrorAxes: { planeAxes: true, selectedLine: true },
      }),
      'mirrorBasis',
      'line',
    );
    const committed = expectEditCommitted(commitNumericInput(state));
    expect(committed.commit.tool).toBe('mirror');
    expect(committed.commit.choices.mirrorBasis).toBe('line');
    expect(committed.commit.flags.construction).toBe(false);
  });

  it('見出し・説明・札はすべて ja.json のキーで返す(NFR-MA-5)', () => {
    for (const step of COPY_STEPS) {
      const state = createNumericInput('mirror', step, undefined, {
        mirrorAxes: { planeAxes: true, selectedLine: true },
      });
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
      for (const field of state.fields) {
        expect(MESSAGE_KEYS, field.key).toContain(field.labelKey);
        expect(MESSAGE_KEYS, field.key).toContain(field.tooltipKey);
      }
      for (const toggle of state.toggles) {
        expect(MESSAGE_KEYS, toggle.key).toContain(toggle.labelKey);
      }
      for (const choice of state.choices) {
        expect(MESSAGE_KEYS, choice.key).toContain(choice.labelKey);
        for (const option of choice.options) {
          expect(numericChoiceOptionLabel(option).length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('スケッチの角の丸め・面取りの段(FR-323、計画書 タスク23)', () => {
  const CORNER_STEPS = ['sketchFilletRadius', 'sketchChamferSize'] as const;

  it('道具から最初の段が引ける。どちらも整形系の段になる', () => {
    expect(EDIT_TOOL_STEPS.sketchFillet).toBe('sketchFilletRadius');
    expect(EDIT_TOOL_STEPS.sketchChamfer).toBe('sketchChamferSize');
    for (const step of CORNER_STEPS) {
      expect(isEditStep(step), step).toBe(true);
      expect(isSolidStep(step), step).toBe(false);
      expect(NUMERIC_INPUT_STEPS, step).toContain(step);
    }
    expect(isEditTool('sketchFillet')).toBe(true);
    expect(isEditTool('sketchChamfer')).toBe(true);
  });

  it('角を指して使う道具として見分けられる(トリム・延長とは別の扱い)', () => {
    expect(isCornerEditTool('sketchFillet')).toBe(true);
    expect(isCornerEditTool('sketchChamfer')).toBe(true);
    expect(isCornerEditTool('trim')).toBe(false);
    expect(isCornerEditTool('offset')).toBe(false);
  });

  it('丸めは半径の 1 欄だけ。既定は 5mm(NFR-UX-4)', () => {
    const state = createNumericInput('sketchFillet', 'sketchFilletRadius');
    expect(state.fields.map((field) => field.key)).toEqual(['cornerRadius']);
    expect(state.fields[0].source).toBe(String(DEFAULT_SKETCH_FILLET_RADIUS_MM));
    expect(state.choices).toEqual([]);
    expect(state.toggles).toEqual([]);
  });

  it('面取りは既定が等距離の 1 欄で、「2つの距離」を選ぶと 2 欄になる', () => {
    const equal = createNumericInput('sketchChamfer', 'sketchChamferSize');
    expect(equal.fields.map((field) => field.key)).toEqual(['cornerDistance1']);
    expect(equal.fields[0].source).toBe(String(DEFAULT_SKETCH_CHAMFER_DISTANCE_MM));
    expect(choiceValueOf(equal, 'chamferMode')).toBe('equal');
    const two = chooseNumericInput(equal, 'chamferMode', 'twoDistances');
    expect(two.fields.map((field) => field.key)).toEqual(['cornerDistance1', 'cornerDistance2']);
    // 距離と角度(立体の C 面取りにはある決め方)は、スケッチの角では出さない。
    expect(equal.choices[0].options.map((option) => option.value)).toEqual([
      'equal',
      'twoDistances',
    ]);
  });

  it('Enter だけで既定値の丸めが決まる(NFR-UX-4)', () => {
    const committed = expectEditCommitted(
      commitNumericInput(createNumericInput('sketchFillet', 'sketchFilletRadius')),
    );
    expect(committed.commit.tool).toBe('sketchFillet');
    expect(committed.commit.step).toBe('sketchFilletRadius');
    expect(committed.commit.values.cornerRadius?.value).toBe(DEFAULT_SKETCH_FILLET_RADIUS_MM);
  });

  it('2 距離の面取りは、決め方と 2 つの値が確定へ写る', () => {
    const two = chooseNumericInput(
      createNumericInput('sketchChamfer', 'sketchChamferSize'),
      'chamferMode',
      'twoDistances',
    );
    const filled = reduceNumericInput(
      reduceNumericInput(two, { type: 'edit', index: 0, source: '3' }),
      { type: 'edit', index: 1, source: '4' },
    );
    const committed = expectEditCommitted(commitNumericInput(filled));
    expect(committed.commit.tool).toBe('sketchChamfer');
    expect(committed.commit.values.cornerDistance1?.value).toBe(3);
    expect(committed.commit.values.cornerDistance2?.value).toBe(4);
    expect(committed.commit.choices.chamferMode).toBe('twoDistances');
  });

  it('半径・距離が 0 以下では確定させない(NFR-UX-5)', () => {
    for (const tool of ['sketchFillet', 'sketchChamfer'] as const) {
      const state = reduceNumericInput(createNumericInput(tool, EDIT_TOOL_STEPS[tool]), {
        type: 'edit',
        index: 0,
        source: '0',
      });
      expectBlocked(commitNumericInput(state));
    }
  });

  it('確定したら閉じる(次の角はビューポートで指し直す)', () => {
    for (const step of CORNER_STEPS) {
      const committed = expectEditCommitted(
        commitNumericInput(createNumericInput('sketchFillet', step)),
      );
      expect(nextNumericInput(committed.state, true), step).toBeNull();
      expect(nextNumericInput(committed.state, false), step).toBeNull();
    }
  });

  it('見出し・説明・札はすべて ja.json のキーで返す(NFR-MA-5)', () => {
    for (const step of CORNER_STEPS) {
      const state = createNumericInput('sketchFillet', step);
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
      for (const field of state.fields) {
        expect(MESSAGE_KEYS, field.key).toContain(field.labelKey);
        expect(MESSAGE_KEYS, field.key).toContain(field.tooltipKey);
      }
      for (const choice of state.choices) {
        expect(MESSAGE_KEYS, choice.key).toContain(choice.labelKey);
        for (const option of choice.options) {
          expect(numericChoiceOptionLabel(option).length).toBeGreaterThan(0);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 基本形状 5 種の段(FR-429、P5 タスク18、§2.7.1・§2.15)
 * ------------------------------------------------------------------ */

/** 基本形状の道具と段の対(§2.15 の段の表)。 */
const PRIMITIVE_STEPS = [
  { tool: 'sphere', step: 'sphereSize' },
  { tool: 'box', step: 'boxSize' },
  { tool: 'cylinder', step: 'cylinderSize' },
  { tool: 'cone', step: 'coneSize' },
  { tool: 'torus', step: 'torusSize' },
] as const;

describe('基本形状 5 種の段(FR-429、§2.15 の段の表)', () => {
  it('道具から段が引け、5 つともソリッドの段で座標を聞かない', () => {
    for (const { tool, step } of PRIMITIVE_STEPS) {
      expect(SOLID_TOOL_STEPS[tool], tool).toBe(step);
      expect(isSolidStep(step), step).toBe(true);
      expect(asksCoordinate(step), step).toBe(false);
      expect(NUMERIC_INPUT_STEPS, step).toContain(step);
    }
  });

  it('欄の名前と既定値が §2.7.1 の表のとおり(球 1 欄)', () => {
    const state = createNumericInput('sphere', 'sphereSize');
    expect(state.fields.map((field) => field.key)).toEqual(['sphereRadius']);
    expect(state.fields.map((field) => field.source)).toEqual(['10']);
  });

  it('箱は X / Y / Z の 3 欄で既定は 20 / 20 / 20(欄 3 つの段、§2.15)', () => {
    const state = createNumericInput('box', 'boxSize');
    expect(state.fields.map((field) => field.key)).toEqual(['boxSizeX', 'boxSizeY', 'boxSizeZ']);
    expect(state.fields.map((field) => field.source)).toEqual(['20', '20', '20']);
  });

  it('円柱は半径・高さの 2 欄で既定は 10 / 20', () => {
    const state = createNumericInput('cylinder', 'cylinderSize');
    expect(state.fields.map((field) => field.key)).toEqual(['cylinderRadius', 'cylinderHeight']);
    expect(state.fields.map((field) => field.source)).toEqual(['10', '20']);
  });

  it('円錐は下半径・上半径・高さの 3 欄で既定は 10 / 0 / 20(欄 3 つの段)', () => {
    const state = createNumericInput('cone', 'coneSize');
    expect(state.fields.map((field) => field.key)).toEqual([
      'coneBottomRadius',
      'coneTopRadius',
      'coneHeight',
    ]);
    expect(state.fields.map((field) => field.source)).toEqual(['10', '0', '20']);
  });

  it('トーラスは主半径・管の半径の 2 欄で既定は 20 / 5', () => {
    const state = createNumericInput('torus', 'torusSize');
    expect(state.fields.map((field) => field.key)).toEqual([
      'torusMajorRadius',
      'torusMinorRadius',
    ]);
    expect(state.fields.map((field) => field.source)).toEqual(['20', '5']);
  });

  it('5 種とも「軸」の選択肢を 1 つだけ持ち、既定は Z(§0.a-0.16)。つまみは持たない', () => {
    for (const { tool, step } of PRIMITIVE_STEPS) {
      const state = createNumericInput(tool, step);
      expect(state.choices.map((choice) => choice.key), tool).toEqual(['axis']);
      expect(state.choices[0].value, tool).toBe('z');
      expect(state.choices[0].options.map((option) => option.value), tool).toEqual(['x', 'y', 'z']);
      expect(state.toggles, tool).toEqual([]);
    }
  });

  it('欄 3 つの段でも Tab は欄 → 選択肢 の輪を回り、外へ出ない(NFR-UX-2)', () => {
    const state = createNumericInput('box', 'boxSize');
    // 欄 3 つ + 選択肢 1 つ = 4 か所。
    expect(numericFocusTargets(state)).toHaveLength(4);
    let moved = state;
    for (let index = 0; index < 4; index += 1) {
      moved = reduceNumericInput(moved, { type: 'tab', backwards: false });
    }
    expect(moved.focusedIndex).toBe(0);
  });

  it('Enter を打つだけで既定の形が確定し、そこで閉じる(NFR-UX-4)', () => {
    for (const { tool, step } of PRIMITIVE_STEPS) {
      const committed = expectSolidCommitted(
        commitNumericInput(createNumericInput(tool, step)),
      );
      expect(committed.commit.tool, tool).toBe(tool);
      expect(committed.commit.step, tool).toBe(step);
      expect(committed.commit.axis, tool).toEqual({ kind: 'world', axis: 'z' });
      // 1 段で終わるので、続けてかくの入切に関わらず次の段は無い。
      expect(nextNumericInput(committed.state, true), tool).toBeNull();
      expect(nextNumericInput(committed.state, false), tool).toBeNull();
    }
  });

  it('欄 3 つの段(箱)の Enter は 3 つの値をまとめて渡す', () => {
    const committed = expectSolidCommitted(
      commitNumericInput(createNumericInput('box', 'boxSize')),
    );
    expect(committed.commit.values.boxSizeX?.value).toBe(20);
    expect(committed.commit.values.boxSizeY?.value).toBe(20);
    expect(committed.commit.values.boxSizeZ?.value).toBe(20);
  });

  it('円錐の上半径 0 はそのまま通る(尖った円錐、§0.a-0.16)', () => {
    const committed = expectSolidCommitted(
      commitNumericInput(createNumericInput('cone', 'coneSize')),
    );
    expect(committed.commit.values.coneTopRadius?.value).toBe(0);
    expect(committed.commit.values.coneBottomRadius?.value).toBe(10);
    expect(committed.commit.values.coneHeight?.value).toBe(20);
  });

  it('半径に式を書くと、式そのものと評価値の両方が渡る(FR-202)', () => {
    const edited = reduceNumericInput(createNumericInput('sphere', 'sphereSize'), {
      type: 'edit',
      index: 0,
      source: '5*2',
    });
    const committed = expectSolidCommitted(commitNumericInput(edited));
    expect(committed.commit.values.sphereRadius?.source).toBe('5*2');
    expect(committed.commit.values.sphereRadius?.value).toBe(10);
  });

  it('半径 -1 は決めさせず、最初の誤りへ焦点を戻す(NFR-UX-5、FR-204)', () => {
    const edited = reduceNumericInput(createNumericInput('sphere', 'sphereSize'), {
      type: 'edit',
      index: 0,
      source: '-1',
    });
    const blocked = expectBlocked(commitNumericInput(edited));
    expect(blocked.state.focusedIndex).toBe(0);
    expect(blocked.evaluation.results[0].error).not.toBeNull();
  });

  it('箱の Y の長さ 0 も決めさせない(欄 3 つの段でも誤りの欄へ戻る)', () => {
    const edited = reduceNumericInput(createNumericInput('box', 'boxSize'), {
      type: 'edit',
      index: 1,
      source: '0',
    });
    const blocked = expectBlocked(commitNumericInput(edited));
    expect(blocked.state.focusedIndex).toBe(1);
  });

  it('円錐の上半径だけは 0 を受け付ける(他の欄の範囲は狭めていない)', () => {
    const state = createNumericInput('cone', 'coneSize');
    const topRadius = state.fields[1];
    expect(topRadius.key).toBe('coneTopRadius');
    expect(topRadius.range).toEqual({
      min: 0,
      minInclusive: true,
      max: null,
      maxInclusive: false,
    });
    expect(rangeErrorFor(topRadius, expressionValueFromNumber(0))).toBeNull();
    // 高さと球の半径は従来どおり「0 より大きい」のまま(既存の段の不変条件を狭めない)。
    expect(state.fields[2].range?.minInclusive).toBe(false);
    expect(createNumericInput('sphere', 'sphereSize').fields[0].range?.minInclusive).toBe(false);
  });

  it('見出し・欄の名前・説明はすべて ja.json のキーで返す(NFR-MA-5)', () => {
    for (const { tool, step } of PRIMITIVE_STEPS) {
      const state = createNumericInput(tool, step);
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
      for (const field of state.fields) {
        expect(MESSAGE_KEYS, field.key).toContain(field.labelKey);
        expect(MESSAGE_KEYS, field.key).toContain(field.tooltipKey);
        expect(t(field.labelKey).length, field.key).toBeGreaterThan(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 面をつなぐ・ロフトの段(FR-430、FR-410、P5 タスク27、§2.15 の段の表)
 * ------------------------------------------------------------------ */

describe('面をつなぐ・ロフトの段(FR-430、FR-410、§2.15 の段の表)', () => {
  const RULED_STEPS = [
    { tool: 'ruled', step: 'ruledTwist' },
    { tool: 'loft', step: 'loftTwist' },
  ] as const;

  it('道具から段が引け、2 つともソリッドの段で座標を聞かない', () => {
    for (const { tool, step } of RULED_STEPS) {
      expect(SOLID_TOOL_STEPS[tool], tool).toBe(step);
      expect(isSolidStep(step), step).toBe(true);
      expect(asksCoordinate(step), step).toBe(false);
      expect(NUMERIC_INPUT_STEPS, step).toContain(step);
    }
  });

  it('どちらもねじれ 1 欄(既定 0、単位は個)で、つまみは持たない', () => {
    for (const { tool, step } of RULED_STEPS) {
      const state = createNumericInput(tool, step);
      expect(state.fields.map((field) => field.key), tool).toEqual(['ruledTwist']);
      expect(state.fields.map((field) => field.source), tool).toEqual(['0']);
      expect(state.fields[0].unit, tool).toBe('count');
      expect(state.toggles, tool).toEqual([]);
    }
  });

  it('ねじれの欄は範囲を持たない(負も大きい数も打てる。整数の判定は確定側)', () => {
    // 「1.5 は整数でない」は上下限では言えないので `NumericFieldRange` を置かない
    // (正多角形の辺数・パターンの個数と同じ切り分け)。断るのは `ruledTwistRejection`。
    expect(createNumericInput('ruled', 'ruledTwist').fields[0].range).toBeUndefined();
    expect(
      rangeErrorFor(
        createNumericInput('ruled', 'ruledTwist').fields[0],
        expressionValueFromNumber(-3),
      ),
    ).toBeNull();
  });

  it('なめらかさの 3 択は、球を含む断面のときだけ出る(§0.a-0.87)', () => {
    const withSphere = createNumericInput('ruled', 'ruledTwist', undefined, {
      ruledHasSphere: true,
    });
    expect(withSphere.choices.map((choice) => choice.key)).toEqual(['ruledSphereSegments']);
    expect(withSphere.choices[0].value).toBe('24');
    expect(withSphere.choices[0].options.map((option) => option.value)).toEqual(['24', '48', '72']);
    // 球を含まないとき(渡さないとき)は選択肢ごと伏せる。
    expect(createNumericInput('ruled', 'ruledTwist').choices).toEqual([]);
    expect(
      createNumericInput('ruled', 'ruledTwist', undefined, { ruledHasSphere: false }).choices,
    ).toEqual([]);
    // ロフトには球を置けないので、渡されても選択肢は出ない。
    expect(
      createNumericInput('loft', 'loftTwist', undefined, { ruledHasSphere: true }).choices,
    ).toEqual([]);
  });

  it('Enter を打つだけで既定(ねじれ 0)が確定し、そこで閉じる(NFR-UX-4)', () => {
    for (const { tool, step } of RULED_STEPS) {
      const committed = expectSolidCommitted(commitNumericInput(createNumericInput(tool, step)));
      expect(committed.commit.tool, tool).toBe(tool);
      expect(committed.commit.step, tool).toBe(step);
      expect(committed.commit.values.ruledTwist?.value, tool).toBe(0);
      expect(committed.commit.ruledSphereSegments, tool).toBeUndefined();
      expect(nextNumericInput(committed.state, true), tool).toBeNull();
      expect(nextNumericInput(committed.state, false), tool).toBeNull();
    }
  });

  it('なめらかさを選ぶと、確定結果に点の数が入る(§0.a-0.74)', () => {
    const chosen = reduceNumericInput(
      createNumericInput('ruled', 'ruledTwist', undefined, { ruledHasSphere: true }),
      { type: 'choose', key: 'ruledSphereSegments', value: '72' },
    );
    const committed = expectSolidCommitted(commitNumericInput(chosen));
    expect(committed.commit.ruledSphereSegments).toBe(72);
  });

  it('ねじれに式を書くと、式そのものと評価値の両方が渡る(FR-202)', () => {
    const edited = reduceNumericInput(createNumericInput('ruled', 'ruledTwist'), {
      type: 'edit',
      index: 0,
      source: '1+1',
    });
    const committed = expectSolidCommitted(commitNumericInput(edited));
    expect(committed.commit.values.ruledTwist?.source).toBe('1+1');
    expect(committed.commit.values.ruledTwist?.value).toBe(2);
  });

  it('見出し・欄の名前・説明・選択肢はすべて ja.json のキーで返す(NFR-MA-5)', () => {
    for (const { tool, step } of RULED_STEPS) {
      const state = createNumericInput(tool, step, undefined, { ruledHasSphere: true });
      expect(MESSAGE_KEYS, step).toContain(STEP_TITLE_KEYS[step]);
      for (const field of state.fields) {
        expect(MESSAGE_KEYS, field.key).toContain(field.labelKey);
        expect(MESSAGE_KEYS, field.key).toContain(field.tooltipKey);
      }
      for (const choice of state.choices) {
        expect(MESSAGE_KEYS, choice.key).toContain(choice.labelKey);
        for (const option of choice.options) {
          expect(numericChoiceOptionLabel(option).length, option.value).toBeGreaterThan(0);
        }
      }
    }
  });
});
