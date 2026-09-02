/**
 * その場数値入力ポップアップの状態機械(計画書 docs/plans/P1-式とスケッチ.md タスク16、§2.9)。
 *
 * DOM にも React にも触れない純関数と不変な状態だけで作る。理由は2つ。
 * ① jsdom / testing-library を入れない方針(§0.a-0.8)の下でも、欄の巡回・確定・取消・
 *    エラー表示のすべてを Node の単体検査で固定できるようにするため。
 * ② 表示はタスク18 の React 部品が薄く包むだけにして、状態をストア1本へ寄せるため
 *    (rules/04-設計の規律.md「フロントの状態はZustandストア1本に一元化する」)。
 *
 * 表示する文言はここに持たず、必ず ja.json のキー(MessageKey)で返す(NFR-MA-5)。
 */

import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionError,
  type ExpressionValue,
} from '@pointercad/expression';
import type { CoordinateInput, PointReference } from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';

/** ツールバーで選べる道具(FR-301〜309)。 */
export type SketchToolId = 'select' | 'point' | 'line' | 'arc' | 'pointArray' | 'face';

/** 座標の指定方法(FR-301〜303)。 */
export type CoordinateMode = 'absolute' | 'relative' | 'polar';

/**
 * ポップアップの段階。線分は始点→終点、円弧は中心→形、点列は基準点→並べ方の
 * 2 段階になる(FR-304、FR-305、FR-307、FR-308)。
 */
export type NumericInputStep =
  | 'point'
  | 'lineStart'
  | 'lineEnd'
  | 'arcCenter'
  | 'arcShape'
  | 'pointArrayBase'
  | 'pointArrayShape';

export type FieldUnit = 'mm' | 'degree' | 'count';

export interface NumericFieldDefinition {
  readonly key: string;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  /** 空欄のまま Enter を押したときに使う値(NFR-UX-4)。 */
  readonly defaultSource: string;
}

export interface NumericField extends NumericFieldDefinition {
  readonly source: string;
}

export interface NumericInputState {
  readonly toolId: SketchToolId;
  readonly step: NumericInputStep;
  readonly mode: CoordinateMode;
  readonly fields: readonly NumericField[];
  readonly focusedIndex: number;
}

export type NumericInputEvent =
  | { readonly type: 'edit'; readonly index: number; readonly source: string }
  | { readonly type: 'focus'; readonly index: number }
  | { readonly type: 'tab'; readonly backwards: boolean }
  | { readonly type: 'setMode'; readonly mode: CoordinateMode }
  /** ビューポートをクリックしたときに、その座標を欄へ入れる(FR-107)。 */
  | { readonly type: 'setValues'; readonly values: readonly number[] };

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

const SHAPE_FIELDS: Readonly<Record<'arcShape' | 'pointArrayShape', readonly NumericFieldDefinition[]>> = {
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

/** 段階ごとの見出し。 */
export const STEP_TITLE_KEYS: Readonly<Record<NumericInputStep, MessageKey>> = {
  point: 'numericInput.title.point',
  lineStart: 'numericInput.title.lineStart',
  lineEnd: 'numericInput.title.lineEnd',
  arcCenter: 'numericInput.title.arcCenter',
  arcShape: 'numericInput.title.arc',
  pointArrayBase: 'numericInput.title.pointArrayBase',
  pointArrayShape: 'numericInput.title.pointArray',
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
];

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

/** 段階が座標を聞くものかどうか。円弧の半径・角度などは座標モードを持たない。 */
export function isCoordinateStep(step: NumericInputStep): boolean {
  return step !== 'arcShape' && step !== 'pointArrayShape';
}

/** 段階ごとの既定の座標モード。線分の終点だけは相対が自然(FR-307)。 */
export function defaultModeForStep(step: NumericInputStep): CoordinateMode {
  return step === 'lineEnd' ? 'relative' : 'absolute';
}

function definitionsFor(step: NumericInputStep, mode: CoordinateMode): readonly NumericFieldDefinition[] {
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

export function createNumericInput(
  toolId: SketchToolId,
  step: NumericInputStep,
  mode: CoordinateMode = defaultModeForStep(step),
): NumericInputState {
  return { toolId, step, mode, fields: toFields(definitionsFor(step, mode)), focusedIndex: 0 };
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
      if (event.index < 0 || event.index >= state.fields.length) {
        return state;
      }
      return { ...state, focusedIndex: event.index };
    }
    case 'tab': {
      const count = state.fields.length;
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
  }
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
    return result.ok
      ? { key: field.key, value: result.value, error: null }
      : { key: field.key, value: null, error: result.error };
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

/** 決定したときに外へ渡すもの。座標を聞く段階かどうかで中身が変わる。 */
export type NumericInputCommit =
  | {
      readonly kind: 'coordinate';
      readonly step: NumericInputStep;
      readonly mode: CoordinateMode;
      readonly coordinate: CoordinateInput;
      /** 欄の並び順の評価値。`valueByFieldKey` で名前から引ける。 */
      readonly values: readonly ExpressionValue[];
    }
  | {
      readonly kind: 'shape';
      readonly step: NumericInputStep;
      readonly values: readonly ExpressionValue[];
    };

/**
 * ポップアップの次の姿。`open` は開いたまま、`committed` は履歴へ積んでよい、
 * `blocked` は不正な欄が残っているので決定させない(NFR-UX-5)、`cancelled` は取消。
 */
export type NumericInputTransition =
  | { readonly kind: 'open'; readonly state: NumericInputState }
  | {
      readonly kind: 'committed';
      readonly state: NumericInputState;
      readonly commit: NumericInputCommit;
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
  if (!isCoordinateStep(filled.step)) {
    return {
      kind: 'committed',
      state: filled,
      commit: { kind: 'shape', step: filled.step, values },
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
    commit: { kind: 'coordinate', step: filled.step, mode: filled.mode, coordinate, values },
  };
}

/**
 * ポップアップの中で意味を持つキー操作(§2.9)。
 * DOM の KeyboardEvent をこれへ詰め替えるのはタスク18 の役目で、
 * この層はキーの名前だけを知る。
 */
export type NumericInputKey =
  | 'Tab'
  | 'ShiftTab'
  | 'Enter'
  | 'Escape'
  | 'Alt1'
  | 'Alt2'
  | 'Alt3';

function modeForKey(key: 'Alt1' | 'Alt2' | 'Alt3'): CoordinateMode {
  if (key === 'Alt1') {
    return 'absolute';
  }
  return key === 'Alt2' ? 'relative' : 'polar';
}

/** キー操作を 1 つ受けて次の姿を返す。焦点はポップアップの外へ出さない(NFR-UX-2)。 */
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
    case 'Enter':
      return commitNumericInput(state, context);
    case 'Escape':
      // 作りかけの要素は履歴に積まない。ツールは選ばれたまま残す(NFR-UX-3)。
      return { kind: 'cancelled' };
  }
}
