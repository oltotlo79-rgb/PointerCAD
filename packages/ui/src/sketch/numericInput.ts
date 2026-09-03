/**
 * その場数値入力ポップアップの状態機械(計画書 docs/plans/P1-式とスケッチ.md タスク16、§2.9)。
 * P2 でソリッドの3道具(押し出し・回転・縫合)を足した(P2 タスク19、§0.a-0.7 / 0.8 / 0.9)。
 *
 * DOM にも React にも触れない純関数と不変な状態だけで作る。理由は2つ。
 * ① jsdom / testing-library を入れない方針(§0.a-0.8)の下でも、欄の巡回・確定・取消・
 *    エラー表示のすべてを Node の単体検査で固定できるようにするため。
 * ② 表示はタスク18 の React 部品が薄く包むだけにして、状態をストア1本へ寄せるため
 *    (rules/04-設計の規律.md「フロントの状態はZustandストア1本に一元化する」)。
 *
 * 表示する文言はここに持たず、必ず ja.json のキー(MessageKey)で返す(NFR-MA-5)。
 * 例外は範囲外の理由文だけで、限界値を差し込んだ文になるためキー1つでは組み立てられない
 * (packages/expression/src/errors.ts と同じ事情。describeRange の注釈を参照)。
 */

import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionError,
  type ExpressionValue,
} from '@pointercad/expression';
import type {
  CoordinateInput,
  PointReference,
  RevolveAxis,
  SketchLineRef,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

/** ツールバーで選べるスケッチの道具(FR-301〜309)。ストアの activeTool の型でもある。 */
export type SketchToolId = 'select' | 'point' | 'line' | 'arc' | 'pointArray' | 'face';

/**
 * 数値を聞くソリッドの道具(FR-401〜403)。
 * ブーリアン(和・差・積)は選んで押すだけで数値を聞かないので含めない(§2.11 の表)。
 */
export type SolidToolId = 'extrude' | 'revolve' | 'sew';

/** ポップアップを開ける道具。スケッチの道具より広い。 */
export type NumericInputToolId = SketchToolId | SolidToolId;

/** 座標の指定方法(FR-301〜303)。 */
export type CoordinateMode = 'absolute' | 'relative' | 'polar';

/** 座標を1点聞く段階。線分は始点→終点、円弧は中心→形の2段階になる(FR-304、FR-307)。 */
export type CoordinateNumericInputStep =
  | 'point'
  | 'lineStart'
  | 'lineEnd'
  | 'arcCenter'
  | 'pointArrayBase';

/** 座標ではなく形の値を聞く段階(FR-305、FR-308)。 */
export type ShapeNumericInputStep = 'arcShape' | 'pointArrayShape';

/** スケッチの段階。確定結果 NumericInputCommit の step はここに限る。 */
export type SketchNumericInputStep = CoordinateNumericInputStep | ShapeNumericInputStep;

/** ソリッドの段階(P2 タスク19)。いずれも1段で終わる。 */
export type SolidNumericInputStep = 'extrudeDistance' | 'revolveAngle' | 'sewTolerance';

/** ポップアップの段階。 */
export type NumericInputStep = SketchNumericInputStep | SolidNumericInputStep;

export type FieldUnit = 'mm' | 'degree' | 'count';

/**
 * 欄が受け付ける値の範囲(NFR-UX-5)。
 * 範囲を持たない欄(P1 の座標・円弧・点列)は range を持たない。
 */
export interface NumericFieldRange {
  readonly min: number;
  /** min そのものを許すか。false なら min より大きい値だけを許す。 */
  readonly minInclusive: boolean;
  /** 上限。上限が無ければ null。 */
  readonly max: number | null;
  /** max そのものを許すか。 */
  readonly maxInclusive: boolean;
}

export interface NumericFieldDefinition {
  readonly key: string;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  /** 空欄のまま Enter を押したときに使う値(NFR-UX-4)。 */
  readonly defaultSource: string;
  /** 値の範囲(NFR-UX-5)。無ければどんな数でも受け付ける。 */
  readonly range?: NumericFieldRange;
}

export interface NumericField extends NumericFieldDefinition {
  readonly source: string;
}

/** 入切だけのつまみ(押し出しの向き・両側、回転の向き)。式ではないので値は真偽。 */
export type NumericToggleKey = 'reversed' | 'symmetric';

export interface NumericToggle {
  readonly key: NumericToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/** 回転軸の選び方(§0.a-0.9)。line はスケッチの線分が選ばれているときだけ現れる。 */
export type RevolveAxisChoice = 'x' | 'y' | 'z' | 'line';

/** 選択肢1つ。確定でそのまま使える RevolveAxis を持たせ、後から組み立て直さない。 */
export interface NumericAxisOption {
  readonly value: RevolveAxisChoice;
  readonly labelKey: MessageKey;
  readonly axis: RevolveAxis;
}

/** いくつかから1つを選ぶつまみ(いまは回転軸だけ)。 */
export interface NumericChoice {
  readonly key: 'axis';
  readonly value: RevolveAxisChoice;
  readonly options: readonly NumericAxisOption[];
}

export interface NumericInputState {
  readonly toolId: NumericInputToolId;
  readonly step: NumericInputStep;
  readonly mode: CoordinateMode;
  readonly fields: readonly NumericField[];
  /**
   * 焦点の位置。欄・選択肢・つまみを並べた輪(numericFocusTargets)の添字で、
   * P1 の段は欄しか無いので「何番目の欄か」と一致する。
   */
  readonly focusedIndex: number;
  /** 入切のつまみ。持たない段は空配列。 */
  readonly toggles: readonly NumericToggle[];
  /** 1つを選ぶつまみ。持たない段は null。 */
  readonly choice: NumericChoice | null;
}

export type NumericInputEvent =
  | { readonly type: 'edit'; readonly index: number; readonly source: string }
  | { readonly type: 'focus'; readonly index: number }
  | { readonly type: 'tab'; readonly backwards: boolean }
  | { readonly type: 'setMode'; readonly mode: CoordinateMode }
  /** ビューポートをクリックしたときに、その座標を欄へ入れる(FR-107)。 */
  | { readonly type: 'setValues'; readonly values: readonly number[] }
  /** つまみの入切(Space、クリック)。 */
  | { readonly type: 'toggle'; readonly key: NumericToggleKey }
  /** 選択肢を直に選ぶ(クリック)。 */
  | { readonly type: 'choose'; readonly value: RevolveAxisChoice }
  /** 選択肢を1つ隣へ動かす(← →)。端では回り込む。 */
  | { readonly type: 'moveChoice'; readonly backwards: boolean };

const COORDINATE_FIELDS: Readonly<Record<CoordinateMode, readonly NumericFieldDefinition[]>> = {
  absolute: [
    { key: 'x', labelKey: 'numericInput.field.x', tooltipKey: 'numericInput.tooltip.x', unit: 'mm', defaultSource: '0' },
    { key: 'y', labelKey: 'numericInput.field.y', tooltipKey: 'numericInput.tooltip.y', unit: 'mm', defaultSource: '0' },
    { key: 'z', labelKey: 'numericInput.field.z', tooltipKey: 'numericInput.tooltip.z', unit: 'mm', defaultSource: '0' },
  ],
  relative: [
    { key: 'dx', labelKey: 'numericInput.field.dx', tooltipKey: 'numericInput.tooltip.dx', unit: 'mm', defaultSource: '0' },
    { key: 'dy', labelKey: 'numericInput.field.dy', tooltipKey: 'numericInput.tooltip.dy', unit: 'mm', defaultSource: '0' },
    { key: 'dz', labelKey: 'numericInput.field.dz', tooltipKey: 'numericInput.tooltip.dz', unit: 'mm', defaultSource: '0' },
  ],
  polar: [
    { key: 'distance', labelKey: 'numericInput.field.distance', tooltipKey: 'numericInput.tooltip.distance', unit: 'mm', defaultSource: '10' },
    { key: 'azimuth', labelKey: 'numericInput.field.azimuth', tooltipKey: 'numericInput.tooltip.azimuth', unit: 'degree', defaultSource: '0' },
    { key: 'elevation', labelKey: 'numericInput.field.elevation', tooltipKey: 'numericInput.tooltip.elevation', unit: 'degree', defaultSource: '0' },
  ],
};

const SHAPE_FIELDS: Readonly<Record<ShapeNumericInputStep, readonly NumericFieldDefinition[]>> = {
  arcShape: [
    { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.radius', unit: 'mm', defaultSource: '10' },
    { key: 'startAngle', labelKey: 'numericInput.field.startAngle', tooltipKey: 'numericInput.tooltip.startAngle', unit: 'degree', defaultSource: '0' },
    { key: 'endAngle', labelKey: 'numericInput.field.endAngle', tooltipKey: 'numericInput.tooltip.endAngle', unit: 'degree', defaultSource: '90' },
  ],
  pointArrayShape: [
    { key: 'azimuth', labelKey: 'numericInput.field.azimuth', tooltipKey: 'numericInput.tooltip.azimuth', unit: 'degree', defaultSource: '0' },
    { key: 'spacing', labelKey: 'numericInput.field.spacing', tooltipKey: 'numericInput.tooltip.spacing', unit: 'mm', defaultSource: '10' },
    { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.count', unit: 'count', defaultSource: '5' },
  ],
};

/** 0 より大きい長さ(押し出しの距離・縫合の許容量)。 */
const POSITIVE: NumericFieldRange = { min: 0, minInclusive: false, max: null, maxInclusive: false };

const SOLID_FIELDS: Readonly<Record<SolidNumericInputStep, readonly NumericFieldDefinition[]>> = {
  extrudeDistance: [
    { key: 'distance', labelKey: 'numericInput.field.distance', tooltipKey: 'numericInput.tooltip.extrudeDistance', unit: 'mm', defaultSource: '10', range: POSITIVE },
  ],
  revolveAngle: [
    // 0 より大きく 360 以下(§2.1 の RevolveFeature.angle)。
    { key: 'angle', labelKey: 'numericInput.field.angle', tooltipKey: 'numericInput.tooltip.angle', unit: 'degree', defaultSource: '360', range: { min: 0, minInclusive: false, max: 360, maxInclusive: true } },
  ],
  sewTolerance: [
    // 既定は model の DEFAULT_SEW_TOLERANCE_MM と同じ 0.01(§0.a-0.7)。
    { key: 'tolerance', labelKey: 'numericInput.field.tolerance', tooltipKey: 'numericInput.tooltip.tolerance', unit: 'mm', defaultSource: '0.01', range: POSITIVE },
  ],
};

/** 段階ごとの見出し。 */
export const STEP_TITLE_KEYS: Readonly<Record<NumericInputStep, MessageKey>> = {
  point: 'numericInput.title.point',
  lineStart: 'numericInput.title.lineStart',
  lineEnd: 'numericInput.title.lineEnd',
  arcCenter: 'numericInput.title.arcCenter',
  arcShape: 'numericInput.title.arc',
  pointArrayBase: 'numericInput.title.pointArrayBase',
  pointArrayShape: 'numericInput.title.pointArray',
  extrudeDistance: 'numericInput.title.extrude',
  revolveAngle: 'numericInput.title.revolve',
  sewTolerance: 'numericInput.title.sew',
};

/** 段階の一覧。タスク18 の部品と、キーの網羅検査が舐めるために公開する。 */
export const NUMERIC_INPUT_STEPS: readonly NumericInputStep[] = [
  'point',
  'lineStart',
  'lineEnd',
  'arcCenter',
  'arcShape',
  'pointArrayBase',
  'pointArrayShape',
  'extrudeDistance',
  'revolveAngle',
  'sewTolerance',
];

/** ソリッドの道具が最初に(そして最後に)聞く段階。ツールバーがここから開く。 */
export const SOLID_TOOL_STEPS: Readonly<Record<SolidToolId, SolidNumericInputStep>> = {
  extrude: 'extrudeDistance',
  revolve: 'revolveAngle',
  sew: 'sewTolerance',
};

/** 段階から道具を引く。確定結果へ入れる道具名の正本。 */
const SOLID_STEP_TOOLS: Readonly<Record<SolidNumericInputStep, SolidToolId>> = {
  extrudeDistance: 'extrude',
  revolveAngle: 'revolve',
  sewTolerance: 'sew',
};

/** 段階ごとのつまみ。縫合は向きも両側も持たない(§2.11 の表)。 */
const STEP_TOGGLE_KEYS: Readonly<Record<SolidNumericInputStep, readonly NumericToggleKey[]>> = {
  extrudeDistance: ['reversed', 'symmetric'],
  revolveAngle: ['reversed'],
  sewTolerance: [],
};

/** つまみの見出し。 */
export const TOGGLE_LABEL_KEYS: Readonly<Record<NumericToggleKey, MessageKey>> = {
  reversed: 'numericInput.toggle.reversed',
  symmetric: 'numericInput.toggle.symmetric',
};

/** ワールドの X / Y / Z 軸。既定は Z(§0.a-0.9)。 */
const WORLD_AXIS_OPTIONS: readonly NumericAxisOption[] = [
  { value: 'x', labelKey: 'numericInput.axis.x', axis: { kind: 'world', axis: 'x' } },
  { value: 'y', labelKey: 'numericInput.axis.y', axis: { kind: 'world', axis: 'y' } },
  { value: 'z', labelKey: 'numericInput.axis.z', axis: { kind: 'world', axis: 'z' } },
];

/** 回転軸の既定(§0.a-0.9)。XY 面にかいた断面を Z 軸まわりに回すのが最も多い。 */
export const DEFAULT_REVOLVE_AXIS: RevolveAxisChoice = 'z';

/** 選んだ線分を軸にする選択肢の見出し(P2 タスク21 で専用のキーを追加した)。 */
const AXIS_LINE_LABEL_KEY: MessageKey = 'numericInput.axis.line';

/** 座標モードのタブの並び(§2.9)。Alt+1 / Alt+2 / Alt+3 の順でもある。 */
export const COORDINATE_MODES: readonly CoordinateMode[] = ['absolute', 'relative', 'polar'];

/** タブの見出し。 */
export const MODE_LABEL_KEYS: Readonly<Record<CoordinateMode, MessageKey>> = {
  absolute: 'numericInput.mode.absolute',
  relative: 'numericInput.mode.relative',
  polar: 'numericInput.mode.polar',
};

/** タブのホバー説明(FR-904、NFR-UX-7)。 */
export const MODE_TOOLTIP_KEYS: Readonly<Record<CoordinateMode, MessageKey>> = {
  absolute: 'numericInput.mode.absoluteTooltip',
  relative: 'numericInput.mode.relativeTooltip',
  polar: 'numericInput.mode.polarTooltip',
};

/** 欄の中に置く単位札(NFR-RE-3)。 */
export const UNIT_KEYS: Readonly<Record<FieldUnit, MessageKey>> = {
  mm: 'numericInput.unit.mm',
  degree: 'numericInput.unit.degree',
  count: 'numericInput.unit.count',
};

/** ポップアップ共通の文字列キー。文言そのものは持たない(NFR-MA-5)。 */
export const NUMERIC_INPUT_KEYS: Readonly<
  Record<'commit' | 'commitTooltip' | 'cancel' | 'cancelTooltip', MessageKey>
> = {
  commit: 'numericInput.commit',
  commitTooltip: 'numericInput.commitTooltip',
  cancel: 'numericInput.cancel',
  cancelTooltip: 'numericInput.cancelTooltip',
};

/** 相対・極の基準点の既定。直前に作った点からの続きが自然(FR-302、FR-307)。 */
export const DEFAULT_COORDINATE_BASE: PointReference = { kind: 'previous' };

/** 段階が座標を聞くものかどうか。円弧の半径・角度やソリッドの距離は座標モードを持たない。 */
export function isCoordinateStep(step: NumericInputStep): step is CoordinateNumericInputStep {
  return (
    step === 'point' ||
    step === 'lineStart' ||
    step === 'lineEnd' ||
    step === 'arcCenter' ||
    step === 'pointArrayBase'
  );
}

/** 段階がソリッドのものかどうか(P2 タスク19)。 */
export function isSolidStep(step: NumericInputStep): step is SolidNumericInputStep {
  return step === 'extrudeDistance' || step === 'revolveAngle' || step === 'sewTolerance';
}

/** 段階ごとの既定の座標モード。線分の終点だけは相対が自然(FR-307)。 */
export function defaultModeForStep(step: NumericInputStep): CoordinateMode {
  return step === 'lineEnd' ? 'relative' : 'absolute';
}

function definitionsFor(
  step: NumericInputStep,
  mode: CoordinateMode,
): readonly NumericFieldDefinition[] {
  if (isSolidStep(step)) {
    return SOLID_FIELDS[step];
  }
  if (step === 'arcShape') {
    return SHAPE_FIELDS.arcShape;
  }
  if (step === 'pointArrayShape') {
    return SHAPE_FIELDS.pointArrayShape;
  }
  return COORDINATE_FIELDS[mode];
}

function toFields(definitions: readonly NumericFieldDefinition[]): NumericField[] {
  return definitions.map((definition) => ({ ...definition, source: definition.defaultSource }));
}

function togglesFor(step: NumericInputStep): readonly NumericToggle[] {
  if (!isSolidStep(step)) {
    return [];
  }
  return STEP_TOGGLE_KEYS[step].map((key) => ({
    key,
    labelKey: TOGGLE_LABEL_KEYS[key],
    value: false,
  }));
}

function choiceFor(step: NumericInputStep, options: NumericInputOptions): NumericChoice | null {
  if (step !== 'revolveAngle') {
    return null;
  }
  const { axisLine } = options;
  const axes: readonly NumericAxisOption[] =
    axisLine === undefined
      ? WORLD_AXIS_OPTIONS
      : [
          ...WORLD_AXIS_OPTIONS,
          {
            value: 'line',
            labelKey: AXIS_LINE_LABEL_KEY,
            axis: { kind: 'line', line: axisLine },
          },
        ];
  return { key: 'axis', value: DEFAULT_REVOLVE_AXIS, options: axes };
}

/** ポップアップを開くときに外から渡せるもの。無くても既定で成り立つ(NFR-UX-4)。 */
export interface NumericInputOptions {
  /**
   * 回転軸に選べるスケッチの線分(§0.a-0.9)。
   * 線分が選ばれているときだけタスク21 が渡し、渡されなければ軸は X / Y / Z だけになる。
   */
  readonly axisLine?: SketchLineRef;
}

export function createNumericInput(
  toolId: NumericInputToolId,
  step: NumericInputStep,
  mode: CoordinateMode = defaultModeForStep(step),
  options: NumericInputOptions = {},
): NumericInputState {
  return {
    toolId,
    step,
    mode,
    fields: toFields(definitionsFor(step, mode)),
    focusedIndex: 0,
    toggles: togglesFor(step),
    choice: choiceFor(step, options),
  };
}

/** 焦点が当たれる場所。並びは「欄 → 選択肢 → つまみ」で、画面の並びと同じにする。 */
export type NumericFocusTarget =
  | { readonly kind: 'field'; readonly index: number }
  | { readonly kind: 'choice' }
  | { readonly kind: 'toggle'; readonly index: number };

/** Tab で巡る輪。P1 の段は欄しか無いので、輪の添字は欄の添字と一致する。 */
export function numericFocusTargets(state: NumericInputState): readonly NumericFocusTarget[] {
  const targets: NumericFocusTarget[] = state.fields.map((_field, index) => ({
    kind: 'field',
    index,
  }));
  if (state.choice !== null) {
    targets.push({ kind: 'choice' });
  }
  state.toggles.forEach((_toggle, index) => {
    targets.push({ kind: 'toggle', index });
  });
  return targets;
}

/** いま焦点が当たっている場所。輪の外を指していれば null。 */
export function focusedTarget(state: NumericInputState): NumericFocusTarget | null {
  return numericFocusTargets(state)[state.focusedIndex] ?? null;
}

function moveChoiceValue(choice: NumericChoice, backwards: boolean): RevolveAxisChoice {
  const count = choice.options.length;
  const current = choice.options.findIndex((option) => option.value === choice.value);
  const next = ((backwards ? current - 1 : current + 1) + count) % count;
  return choice.options[next].value;
}

/** 欄の操作を 1 つ受けて次の状態を返す。副作用を持たないのでそのまま検査できる。 */
export function reduceNumericInput(
  state: NumericInputState,
  event: NumericInputEvent,
): NumericInputState {
  switch (event.type) {
    case 'edit': {
      if (event.index < 0 || event.index >= state.fields.length) {
        return state;
      }
      const fields = state.fields.map((field, index) =>
        index === event.index ? { ...field, source: event.source } : field,
      );
      return { ...state, fields, focusedIndex: event.index };
    }
    case 'focus': {
      if (event.index < 0 || event.index >= numericFocusTargets(state).length) {
        return state;
      }
      return { ...state, focusedIndex: event.index };
    }
    case 'tab': {
      const count = numericFocusTargets(state).length;
      // 最後の欄で Tab を押しても外へ出さず、先頭へ戻す(NFR-UX-2)。
      const next = event.backwards
        ? (state.focusedIndex - 1 + count) % count
        : (state.focusedIndex + 1) % count;
      return { ...state, focusedIndex: next };
    }
    case 'setMode': {
      if (!isCoordinateStep(state.step) || state.mode === event.mode) {
        return state;
      }
      // モードが変わると欄の意味が変わるので、入力は引き継がず既定値へ戻す(§2.9)。
      return {
        ...state,
        mode: event.mode,
        fields: toFields(definitionsFor(state.step, event.mode)),
        focusedIndex: 0,
      };
    }
    case 'setValues': {
      const fields = state.fields.map((field, index) => {
        const value = event.values[index];
        return value === undefined
          ? field
          : { ...field, source: expressionValueFromNumber(value).source };
      });
      return { ...state, fields };
    }
    case 'toggle': {
      if (!state.toggles.some((toggle) => toggle.key === event.key)) {
        return state;
      }
      return {
        ...state,
        toggles: state.toggles.map((toggle) =>
          toggle.key === event.key ? { ...toggle, value: !toggle.value } : toggle,
        ),
      };
    }
    case 'choose': {
      const { choice } = state;
      if (
        choice === null ||
        choice.value === event.value ||
        !choice.options.some((option) => option.value === event.value)
      ) {
        return state;
      }
      return { ...state, choice: { ...choice, value: event.value } };
    }
    case 'moveChoice': {
      const { choice } = state;
      if (choice === null || choice.options.length < 2) {
        return state;
      }
      return { ...state, choice: { ...choice, value: moveChoiceValue(choice, event.backwards) } };
    }
  }
}

/** つまみを入切する(§0.a-0.8)。持っていないつまみを指したときは何も起きない。 */
export function toggleNumericInput(
  state: NumericInputState,
  key: NumericToggleKey,
): NumericInputState {
  return reduceNumericInput(state, { type: 'toggle', key });
}

/** 選択肢を選ぶ(§0.a-0.9)。選択肢に無い値は無視する。 */
export function chooseNumericInput(
  state: NumericInputState,
  value: RevolveAxisChoice,
): NumericInputState {
  return reduceNumericInput(state, { type: 'choose', value });
}

export interface NumericFieldResult {
  readonly key: string;
  readonly value: ExpressionValue | null;
  readonly error: ExpressionError | null;
}

export interface NumericInputEvaluation {
  readonly results: readonly NumericFieldResult[];
  /** すべての欄が妥当なら true。false のときは決定させない(NFR-UX-5)。 */
  readonly canCommit: boolean;
  /** 最初にエラーになった欄。無ければ -1。 */
  readonly firstErrorIndex: number;
}

/** 範囲外を表す識別子(packages/expression の ExpressionErrorCode、P3 §0.a-0.23 ①)。 */
const RANGE_ERROR_CODE = 'outOfRange';

/**
 * 範囲外の理由文を組み立てる。
 * 限界値を差し込んだ文になるので ja.json のキー1つでは組み立てられない
 * (packages/expression/src/errors.ts が日本語を持っているのと同じ事情)。
 * 見出しの語だけは ja.json から引く(NFR-MA-5)。
 */
function describeRange(label: string, range: NumericFieldRange): string {
  const min = String(range.min);
  if (range.max === null) {
    const lower = range.minInclusive ? `${min} 以上の` : `${min} より大きい`;
    return `${label}は ${lower}値を入れてください。`;
  }
  const lower = range.minInclusive ? `${min} 以上` : `${min} より大きく`;
  const upper = `${String(range.max)} ${range.maxInclusive ? '以下' : '未満'}`;
  return `${label}は ${lower} ${upper}の値を入れてください。`;
}

/** 欄の範囲を確かめる。範囲内なら null(NFR-UX-5)。 */
export function rangeErrorFor(field: NumericField, value: ExpressionValue): ExpressionError | null {
  const { range } = field;
  if (range === undefined) {
    return null;
  }
  const belowMin = range.minInclusive ? value.value < range.min : value.value <= range.min;
  const aboveMax =
    range.max !== null && (range.maxInclusive ? value.value > range.max : value.value >= range.max);
  if (!belowMin && !aboveMax) {
    return null;
  }
  return {
    code: RANGE_ERROR_CODE,
    message: describeRange(t(field.labelKey), range),
    position: -1,
  };
}

/** 空欄は既定値として扱う。Enter を連打するだけで意味のある形になる(NFR-UX-4)。 */
export function effectiveSource(field: NumericField): string {
  return field.source.trim() === '' ? field.defaultSource : field.source;
}

/**
 * 空欄を既定値の文字列で埋めた状態を返す(NFR-UX-4)。
 * 決定のときに一度だけ通し、利用者が実際に使われた値を目で確かめられるようにする。
 * 埋めるものが無ければ同じ状態をそのまま返す。
 */
export function fillDefaults(state: NumericInputState): NumericInputState {
  if (state.fields.every((field) => field.source === effectiveSource(field))) {
    return state;
  }
  return {
    ...state,
    fields: state.fields.map((field) => ({ ...field, source: effectiveSource(field) })),
  };
}

/** すべての欄を評価する。1 文字打つごとに呼んでよい軽さにする。 */
export function evaluateNumericInput(
  state: NumericInputState,
  variables: ReadonlyMap<string, number> = new Map(),
): NumericInputEvaluation {
  const results: NumericFieldResult[] = state.fields.map((field) => {
    const result = evaluateExpression(effectiveSource(field), { variables });
    if (!result.ok) {
      return { key: field.key, value: null, error: result.error };
    }
    // 式としては読めても、その道具が使えない値は決定させない(NFR-UX-5)。
    const rangeError = rangeErrorFor(field, result.value);
    return rangeError === null
      ? { key: field.key, value: result.value, error: null }
      : { key: field.key, value: null, error: rangeError };
  });
  const firstErrorIndex = results.findIndex((result) => result.error !== null);
  return { results, canCommit: firstErrorIndex === -1, firstErrorIndex };
}

/** 評価できた値だけを順に取り出す。決定のときに使う。 */
export function commitValues(evaluation: NumericInputEvaluation): ExpressionValue[] | null {
  if (!evaluation.canCommit) {
    return null;
  }
  const values: ExpressionValue[] = [];
  for (const result of evaluation.results) {
    if (result.value === null) {
      return null;
    }
    values.push(result.value);
  }
  return values;
}

/**
 * 決定した値を欄の名前で引く(円弧の `radius` など)。
 * 並び順の取り違えを防ぐため、タスク17 が履歴へ積むときはこちらを使う。
 */
export function valueByFieldKey(
  state: NumericInputState,
  values: readonly ExpressionValue[],
  key: string,
): ExpressionValue | undefined {
  const index = state.fields.findIndex((field) => field.key === key);
  return index === -1 ? undefined : values[index];
}

/**
 * 3 つの評価値から 1 点の指定を組み立てる(FR-301〜303)。
 * 式は文字列のまま、評価値と対で持つ(FR-202)。欄が足りなければ null を返す。
 */
export function buildCoordinateInput(
  mode: CoordinateMode,
  values: readonly ExpressionValue[],
  base: PointReference,
): CoordinateInput | null {
  const first = values[0];
  const second = values[1];
  const third = values[2];
  if (first === undefined || second === undefined || third === undefined) {
    return null;
  }
  switch (mode) {
    case 'absolute':
      return { mode: 'absolute', x: first, y: second, z: third };
    case 'relative':
      return { mode: 'relative', base, dx: first, dy: second, dz: third };
    case 'polar':
      return { mode: 'polar', base, distance: first, azimuth: second, elevation: third };
  }
}

/**
 * 決定したときに外へ渡すもの(スケッチ)。座標を聞く段階かどうかで中身が変わる。
 * ソリッドの確定は形が違うので SolidInputCommit で別に返す。
 */
export type NumericInputCommit =
  | {
      readonly kind: 'coordinate';
      readonly step: CoordinateNumericInputStep;
      readonly mode: CoordinateMode;
      readonly coordinate: CoordinateInput;
      /** 欄の並び順の評価値。`valueByFieldKey` で名前から引ける。 */
      readonly values: readonly ExpressionValue[];
    }
  | {
      readonly kind: 'shape';
      readonly step: ShapeNumericInputStep;
      readonly values: readonly ExpressionValue[];
    };

/** ソリッドの数値。道具ごとに1つだけ入る(§2.11 の表)。 */
export interface SolidCommitValues {
  /** 押し出しの長さ(mm)。 */
  readonly distance?: ExpressionValue;
  /** 回転の角度(度)。 */
  readonly angle?: ExpressionValue;
  /** 縫合の許容量(mm)。 */
  readonly tolerance?: ExpressionValue;
}

/** ソリッドのつまみ。持たない道具では欄ごと現れない。 */
export interface SolidCommitFlags {
  /** 向きを反転するか(押し出し・回転)。 */
  readonly reversed?: boolean;
  /** 両側へ出すか(押し出しだけ)。 */
  readonly symmetric?: boolean;
}

/**
 * ソリッドを決めたときに外へ渡すもの(§0.a-0.7 / 0.8 / 0.9)。
 * タスク21 がこれを packages/ui/src/solid/solidCommands.ts へ渡す。
 */
export interface SolidInputCommit {
  readonly kind: 'solid';
  readonly tool: SolidToolId;
  readonly step: SolidNumericInputStep;
  readonly values: SolidCommitValues;
  readonly flags: SolidCommitFlags;
  /** 回転のときだけ入る。 */
  readonly axis?: RevolveAxis;
}

/** ポップアップが返しうる確定結果のすべて。 */
export type AnyNumericInputCommit = NumericInputCommit | SolidInputCommit;

/**
 * ポップアップの次の姿。`open` は開いたまま、`committed` / `solidCommitted` は
 * 履歴へ積んでよい、`blocked` は不正な欄が残っているので決定させない(NFR-UX-5)、
 * `cancelled` は取消。
 */
export type NumericInputTransition =
  | { readonly kind: 'open'; readonly state: NumericInputState }
  | {
      readonly kind: 'committed';
      readonly state: NumericInputState;
      readonly commit: NumericInputCommit;
    }
  | {
      readonly kind: 'solidCommitted';
      readonly state: NumericInputState;
      readonly commit: SolidInputCommit;
    }
  | {
      readonly kind: 'blocked';
      readonly state: NumericInputState;
      readonly evaluation: NumericInputEvaluation;
    }
  | { readonly kind: 'cancelled' };

export interface NumericInputContext {
  /** 相対・極の基準点(FR-302、FR-303)。省略すると直前に作った点を指す。 */
  readonly base?: PointReference;
  /** 変数表(FR-206、§0.a-0.6)。P1 の UI は渡さない。 */
  readonly variables?: ReadonlyMap<string, number>;
}

function solidValuesFor(
  step: SolidNumericInputStep,
  values: readonly ExpressionValue[],
): SolidCommitValues {
  const first = values[0];
  switch (step) {
    case 'extrudeDistance':
      return { distance: first };
    case 'revolveAngle':
      return { angle: first };
    case 'sewTolerance':
      return { tolerance: first };
  }
}

function solidFlagsFor(toggles: readonly NumericToggle[]): SolidCommitFlags {
  const flags: { reversed?: boolean; symmetric?: boolean } = {};
  for (const toggle of toggles) {
    flags[toggle.key] = toggle.value;
  }
  return flags;
}

/** 選ばれている選択肢の軸。選択肢を持たない段では undefined。 */
function axisOf(choice: NumericChoice | null): RevolveAxis | undefined {
  if (choice === null) {
    return undefined;
  }
  return choice.options.find((option) => option.value === choice.value)?.axis;
}

/**
 * 「決定」を押したとき、または Enter を打ったときの処理。
 * 空欄を既定値で埋めてから評価し(NFR-UX-4)、1 つでも不正なら決定させずに
 * 最初の誤りへ焦点を移す(NFR-UX-5、FR-204)。
 */
export function commitNumericInput(
  state: NumericInputState,
  context: NumericInputContext = {},
): NumericInputTransition {
  const filled = fillDefaults(state);
  const evaluation = evaluateNumericInput(filled, context.variables);
  const values = commitValues(evaluation);
  if (values === null) {
    return {
      kind: 'blocked',
      state: { ...filled, focusedIndex: Math.max(evaluation.firstErrorIndex, 0) },
      evaluation,
    };
  }
  const { step } = filled;
  if (isSolidStep(step)) {
    return {
      kind: 'solidCommitted',
      state: filled,
      commit: {
        kind: 'solid',
        tool: SOLID_STEP_TOOLS[step],
        step,
        values: solidValuesFor(step, values),
        flags: solidFlagsFor(filled.toggles),
        axis: axisOf(filled.choice),
      },
    };
  }
  if (!isCoordinateStep(step)) {
    return {
      kind: 'committed',
      state: filled,
      commit: { kind: 'shape', step, values },
    };
  }
  const coordinate = buildCoordinateInput(
    filled.mode,
    values,
    context.base ?? DEFAULT_COORDINATE_BASE,
  );
  if (coordinate === null) {
    // 欄が 3 つ揃わない段階は今のところ無いが、揃わないまま履歴へ積むよりは止める。
    return { kind: 'blocked', state: filled, evaluation };
  }
  return {
    kind: 'committed',
    state: filled,
    commit: { kind: 'coordinate', step, mode: filled.mode, coordinate, values },
  };
}

/**
 * 決めた後に続けて聞くこと(§2.9 の「確定した後」)。閉じるなら null。
 *
 * 線分・円弧・点列は 2 段階でひと組なので、前半を決めたら連続描画の入切に関わらず後半へ進む。
 * 後半まで終わったときは、連続描画が入なら次の 1 本を同じ手順で聞き直し(FR-307)、切なら閉じる。
 * 相対・極の基準点は `DEFAULT_COORDINATE_BASE`(直前に作った点)なので、開き直すだけで
 * 直前の端点からの続きになる。
 *
 * ソリッドの段は連続描画の対象外なので、いつでも閉じる(面を選び直さないと次を作れない)。
 */
export function nextNumericInput(
  state: NumericInputState,
  chaining: boolean,
): NumericInputState | null {
  switch (state.step) {
    case 'lineStart':
      return createNumericInput(state.toolId, 'lineEnd');
    case 'arcCenter':
      return createNumericInput(state.toolId, 'arcShape');
    case 'pointArrayBase':
      return createNumericInput(state.toolId, 'pointArrayShape');
    case 'point':
      // 点は 1 段階で終わるので、同じ指定方法のまま次の点を聞く。
      return chaining ? createNumericInput(state.toolId, 'point', state.mode) : null;
    case 'lineEnd':
      return chaining ? createNumericInput(state.toolId, 'lineEnd') : null;
    case 'arcShape':
      return chaining ? createNumericInput(state.toolId, 'arcCenter') : null;
    case 'pointArrayShape':
      return chaining ? createNumericInput(state.toolId, 'pointArrayBase') : null;
    case 'extrudeDistance':
    case 'revolveAngle':
    case 'sewTolerance':
      return null;
  }
}

/**
 * ポップアップの中で意味を持つキー操作(§2.9)。
 * DOM の KeyboardEvent をこれへ詰め替えるのはタスク18 の React 部品の役目で、
 * この層はキーの名前だけを知る。
 */
export type NumericInputKey =
  | 'Tab'
  | 'ShiftTab'
  | 'Enter'
  | 'Escape'
  | 'Alt1'
  | 'Alt2'
  | 'Alt3'
  /** 焦点があるつまみの入切。 */
  | 'Space'
  /** 焦点がある選択肢を1つ隣へ。 */
  | 'ArrowLeft'
  | 'ArrowRight';

function modeForKey(key: 'Alt1' | 'Alt2' | 'Alt3'): CoordinateMode {
  if (key === 'Alt1') {
    return 'absolute';
  }
  return key === 'Alt2' ? 'relative' : 'polar';
}

/**
 * キー操作を 1 つ受けて次の姿を返す。焦点はポップアップの外へ出さない(NFR-UX-2)。
 *
 * Space と ← → は、焦点がつまみ・選択肢にあるときだけ効く。欄に焦点があるときは
 * 空白の入力とカーソル移動を邪魔しないため、状態を変えずにそのまま返す。
 */
export function applyNumericInputKey(
  state: NumericInputState,
  key: NumericInputKey,
  context: NumericInputContext = {},
): NumericInputTransition {
  switch (key) {
    case 'Tab':
      return { kind: 'open', state: reduceNumericInput(state, { type: 'tab', backwards: false }) };
    case 'ShiftTab':
      return { kind: 'open', state: reduceNumericInput(state, { type: 'tab', backwards: true }) };
    case 'Alt1':
    case 'Alt2':
    case 'Alt3':
      return {
        kind: 'open',
        state: reduceNumericInput(state, { type: 'setMode', mode: modeForKey(key) }),
      };
    case 'Space': {
      const target = focusedTarget(state);
      if (target === null || target.kind !== 'toggle') {
        return { kind: 'open', state };
      }
      const toggle = state.toggles[target.index];
      return { kind: 'open', state: toggleNumericInput(state, toggle.key) };
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const target = focusedTarget(state);
      if (target === null || target.kind !== 'choice') {
        return { kind: 'open', state };
      }
      return {
        kind: 'open',
        state: reduceNumericInput(state, {
          type: 'moveChoice',
          backwards: key === 'ArrowLeft',
        }),
      };
    }
    case 'Enter':
      return commitNumericInput(state, context);
    case 'Escape':
      // 作りかけの要素は履歴に積まない。ツールは選ばれたまま残す(NFR-UX-3)。
      return { kind: 'cancelled' };
  }
}
