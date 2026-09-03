/**
 * その場数値入力ポップアップの状態機械(計画書 docs/plans/P1-式とスケッチ.md タスク16、§2.9)。
 * P2 でソリッドの3道具(押し出し・回転・縫合)を足した(P2 タスク19、§0.a-0.7 / 0.8 / 0.9)。
 * P3 で加工6種(穴・ねじ穴・R面取り・C面取り・直線/円形パターン)とばね(2段)を足した
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク24、§2.11)。
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
 *
 * P3 で選択肢(NumericChoice)を「1つだけ」から「配列」へ広げた(§2.11)。
 * ねじ穴は「呼び」と「系列」の2つ、C面取りは「決め方」1つ、パターンは「向き/軸」1つを持つため。
 * P1・P2 の段の振る舞いは1つも変えていない(既存の検査はそのまま緑)。
 */

import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionError,
  type ExpressionValue,
} from '@pointercad/expression';
import {
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DEPTH_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM,
  DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM,
  DEFAULT_SPRING_TURNS,
  DEFAULT_SPRING_WIRE_DIAMETER_MM,
  DEFAULT_THREAD_DESIGNATION,
  MAX_PATTERN_COUNT,
  MAX_SPRING_TURNS,
  METRIC_THREAD_DESIGNATIONS,
  type ChamferSize,
  type CoordinateInput,
  type PointReference,
  type RevolveAxis,
  type SketchLineRef,
  type SpringDerived,
  type SpringHandedness,
  type ThreadSeries,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

/** ツールバーで選べるスケッチの道具(FR-301〜309)。ストアの activeTool の型でもある。 */
export type SketchToolId = 'select' | 'point' | 'line' | 'arc' | 'pointArray' | 'face';

/**
 * 数値を聞くソリッドの道具(FR-401〜403、P3 で加工6種+ばねを追加)。
 * ブーリアン(和・差・積)は選んで押すだけで数値を聞かないので含めない(§2.11 の表)。
 */
export type SolidToolId =
  | 'extrude'
  | 'revolve'
  | 'sew'
  | 'hole'
  | 'threadHole'
  | 'fillet'
  | 'chamfer'
  | 'linearPattern'
  | 'circularPattern'
  /** ばね(FR-414)。2段で聞く(§2.11)。 */
  | 'spring';

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

/** ソリッドの段階(P2 タスク19、P3 タスク24)。ばね以外はいずれも1段で終わる。 */
export type SolidNumericInputStep =
  | 'extrudeDistance'
  | 'revolveAngle'
  | 'sewTolerance'
  | 'holeSize'
  | 'threadSize'
  | 'filletRadius'
  | 'chamferSize'
  | 'linearPattern'
  | 'circularPattern'
  /** ばねの1段目(形)。確定すると springLength へ進む(§2.11)。 */
  | 'springShape'
  /** ばねの2段目(長さ)。確定でようやく閉じる。 */
  | 'springLength';

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

/**
 * 入切だけのつまみ(押し出しの向き・両側、回転の向き、P3 の貫通・実らせん・両側へ・全周)。
 * 式ではないので値は真偽。
 */
export type NumericToggleKey =
  | 'reversed'
  | 'symmetric'
  | 'through'
  | 'modeledThread'
  | 'patternSymmetric'
  | 'fullCircle';

export interface NumericToggle {
  readonly key: NumericToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/** 回転軸の選び方(§0.a-0.9)。line はスケッチの線分が選ばれているときだけ現れる。 */
export type RevolveAxisChoice = 'x' | 'y' | 'z' | 'line';

/**
 * 1つを選ぶつまみの種類(P3 §2.11)。
 * axis は回転・円形パターン・ばねの軸で共用する(いずれも「回転軸」の性質を持つ)。
 * patternDirection は直線パターン専用(向きであって回転軸ではないので別のキーにする)。
 */
export type NumericChoiceKey =
  | 'axis'
  | 'threadDesignation'
  | 'threadSeries'
  | 'chamferMode'
  | 'patternDirection'
  | 'springHandedness'
  | 'springDerived';

export interface NumericChoiceOption {
  readonly value: string;
  /**
   * 選択肢の見出し。ja.json のキーで持つのが原則だが、一覧が長いとき(呼び径28個)は
   * `label` に札の文字をそのまま入れて `labelKey` を持たない(ja.json に28個のキーを
   * 作らないため、§2.11「手順3」)。
   *
   * 計画書タスク24 の型宣言は `labelKey: MessageKey`(必須)のまま `label` を追加していたが、
   * 「labelKey が無い選択肢に使う」という同じ節の注釈と矛盾するため、labelKey を任意にした
   * (判断に迷った点として報告する)。
   */
  readonly labelKey?: MessageKey;
  readonly label?: string;
}

/** いくつかから1つを選ぶつまみ。 */
export interface NumericChoice {
  readonly key: NumericChoiceKey;
  /** つまみの見出し(例:「回転軸」「決め方」「求める値」)。 */
  readonly labelKey: MessageKey;
  readonly value: string;
  readonly options: readonly NumericChoiceOption[];
}

/** 選択肢の表示文字列。label があればそのまま、無ければ labelKey から引く(§2.11)。 */
export function numericChoiceOptionLabel(option: NumericChoiceOption): string {
  if (option.label !== undefined) {
    return option.label;
  }
  return option.labelKey === undefined ? option.value : t(option.labelKey);
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
  /**
   * 1つを選ぶつまみ。持たない段は空配列
   * (P2 の `choice: NumericChoice | null` から変わった、§2.11)。
   */
  readonly choices: readonly NumericChoice[];
  /**
   * 回転軸・パターンの向き・ばねの軸の選択肢に「選んだ線分」を含めるための元データ
   * (§0.a-0.9)。選択肢の 'line' を確定時に組み立て直すのに使う。持たない・
   * 選ばれていないときは undefined。
   */
  readonly axisLine?: SketchLineRef;
  /**
   * ばねの1段目(springShape)で確定した欄・選択肢・線分。2段目(springLength)の確定で
   * まとめて1つの SolidInputCommit にする(§2.11「1段目の値は2段目へ持ち越す」)。
   * ばね以外の道具・段では常に undefined。
   */
  readonly carriedStage1?: {
    readonly fields: readonly NumericField[];
    readonly choices: readonly NumericChoice[];
    readonly axisLine?: SketchLineRef;
  };
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
  /** 選択肢を直に選ぶ(クリック)。どのつまみかを key で指す(§2.11)。 */
  | { readonly type: 'choose'; readonly key: NumericChoiceKey; readonly value: string }
  /** 焦点がある選択肢を1つ隣へ動かす(← →)。端では回り込む。 */
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

/**
 * 0 より大きい値。上限なし。押し出しの距離・縫合の許容量のほか、P3 の直径・半径・距離・
 * 距離2・間隔・ねじ部の長さ・コイル径・線径・ばねのピッチ・全長がすべてこの範囲を使う
 * (計画書タスク24 の範囲表)。
 */
const POSITIVE: NumericFieldRange = { min: 0, minInclusive: false, max: null, maxInclusive: false };

/** 0 より大きく 360 以下(回転角・円形パターンの角度、§2.1、§0.a-0.21)。 */
const ANGLE_UP_TO_360: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 360,
  maxInclusive: true,
};

/** 0 より大きく 90 より小さい(C面取りの距離角度、model の ChamferSize の注釈どおり)。 */
const CHAMFER_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 90,
  maxInclusive: false,
};

/** 2 以上 MAX_PATTERN_COUNT 以下(パターンの個数、計画書タスク24 の範囲表)。 */
const PATTERN_COUNT_RANGE: NumericFieldRange = {
  min: 2,
  minInclusive: true,
  max: MAX_PATTERN_COUNT,
  maxInclusive: true,
};

/** 0 より大きく MAX_SPRING_TURNS 以下(ばねの巻数、§0.a-0.35)。 */
const SPRING_TURNS_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: MAX_SPRING_TURNS,
  maxInclusive: true,
};

const EXTRUDE_DISTANCE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'distance', labelKey: 'numericInput.field.distance', tooltipKey: 'numericInput.tooltip.extrudeDistance', unit: 'mm', defaultSource: '10', range: POSITIVE },
];

const REVOLVE_ANGLE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'angle', labelKey: 'numericInput.field.angle', tooltipKey: 'numericInput.tooltip.angle', unit: 'degree', defaultSource: '360', range: ANGLE_UP_TO_360 },
];

const SEW_TOLERANCE_FIELDS: readonly NumericFieldDefinition[] = [
  // 既定は model の DEFAULT_SEW_TOLERANCE_MM と同じ 0.01(§0.a-0.7)。
  { key: 'tolerance', labelKey: 'numericInput.field.tolerance', tooltipKey: 'numericInput.tooltip.tolerance', unit: 'mm', defaultSource: '0.01', range: POSITIVE },
];

const HOLE_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'diameter', labelKey: 'numericInput.field.diameter', tooltipKey: 'numericInput.tooltip.diameter', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DIAMETER_MM), range: POSITIVE },
  { key: 'depth', labelKey: 'numericInput.field.depth', tooltipKey: 'numericInput.tooltip.depth', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DEPTH_MM), range: POSITIVE },
];

const THREAD_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'depth', labelKey: 'numericInput.field.depth', tooltipKey: 'numericInput.tooltip.depth', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DEPTH_MM), range: POSITIVE },
  // ねじ部の長さの既定値専用の model 定数は無いため、穴の深さの既定(10)と揃える
  // (計画書タスク24 §2.11 の表がどちらも既定 10 としているのに合わせた)。
  { key: 'threadLength', labelKey: 'numericInput.field.threadLength', tooltipKey: 'numericInput.tooltip.threadLength', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DEPTH_MM), range: POSITIVE },
];

const FILLET_RADIUS_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.filletRadius', unit: 'mm', defaultSource: String(DEFAULT_FILLET_RADIUS_MM), range: POSITIVE },
];

const CHAMFER_DISTANCE_FIELD: NumericFieldDefinition = {
  key: 'chamferDistance',
  labelKey: 'numericInput.field.chamferDistance',
  tooltipKey: 'numericInput.tooltip.chamferDistance',
  unit: 'mm',
  defaultSource: String(DEFAULT_CHAMFER_DISTANCE_MM),
  range: POSITIVE,
};
const CHAMFER_DISTANCE2_FIELD: NumericFieldDefinition = {
  key: 'chamferDistance2',
  labelKey: 'numericInput.field.chamferDistance2',
  tooltipKey: 'numericInput.tooltip.chamferDistance2',
  unit: 'mm',
  defaultSource: String(DEFAULT_CHAMFER_DISTANCE_MM),
  range: POSITIVE,
};
const CHAMFER_ANGLE_FIELD: NumericFieldDefinition = {
  key: 'chamferAngle',
  labelKey: 'numericInput.field.chamferAngle',
  tooltipKey: 'numericInput.tooltip.chamferAngle',
  unit: 'degree',
  defaultSource: String(DEFAULT_CHAMFER_ANGLE_DEGREES),
  range: CHAMFER_ANGLE_RANGE,
};

/**
 * C面取りの欄は「決め方」で変わる(計画書タスク24「C面取りは『決め方』で出る欄が変わる」)。
 * 距離(等距離)と2つの距離は同じ2欄(距離・距離2)、距離と角度だけ2つ目が角度になる。
 *
 * 既定(距離=equal)でも欄が2つ(距離・距離2)なのは計画書タスク24 の検証表のとおりで、
 * ChamferSize の 'equal' が本来 distance 1つしか持たないことと食い違う。equal と
 * twoDistances は見た目が同じ2欄のままにし、equal のときの距離2はタスク25
 * (machiningCommands.ts)が ChamferSize を組み立てるときに読み捨てる想定とした
 * (判断に迷った点として報告する)。
 */
function chamferFieldDefinitions(mode: string | undefined): readonly NumericFieldDefinition[] {
  return mode === 'distanceAngle'
    ? [CHAMFER_DISTANCE_FIELD, CHAMFER_ANGLE_FIELD]
    : [CHAMFER_DISTANCE_FIELD, CHAMFER_DISTANCE2_FIELD];
}

const LINEAR_PATTERN_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'spacing', labelKey: 'numericInput.field.spacing', tooltipKey: 'numericInput.tooltip.patternSpacing', unit: 'mm', defaultSource: String(DEFAULT_PATTERN_SPACING_MM), range: POSITIVE },
  { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.patternCount', unit: 'count', defaultSource: String(DEFAULT_PATTERN_COUNT), range: PATTERN_COUNT_RANGE },
];

const CIRCULAR_PATTERN_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'angle', labelKey: 'numericInput.field.patternAngle', tooltipKey: 'numericInput.tooltip.patternAngle', unit: 'degree', defaultSource: '360', range: ANGLE_UP_TO_360 },
  { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.patternCount', unit: 'count', defaultSource: String(DEFAULT_CIRCULAR_PATTERN_COUNT), range: PATTERN_COUNT_RANGE },
];

const SPRING_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'coilDiameter', labelKey: 'numericInput.field.coilDiameter', tooltipKey: 'numericInput.tooltip.coilDiameter', unit: 'mm', defaultSource: String(DEFAULT_SPRING_COIL_DIAMETER_MM), range: POSITIVE },
  { key: 'wireDiameter', labelKey: 'numericInput.field.wireDiameter', tooltipKey: 'numericInput.tooltip.wireDiameter', unit: 'mm', defaultSource: String(DEFAULT_SPRING_WIRE_DIAMETER_MM), range: POSITIVE },
];

const SPRING_PITCH_FIELD: NumericFieldDefinition = {
  key: 'springPitch',
  labelKey: 'numericInput.field.springPitch',
  tooltipKey: 'numericInput.tooltip.springPitch',
  unit: 'mm',
  defaultSource: String(DEFAULT_SPRING_PITCH_MM),
  range: POSITIVE,
};
/**
 * 巻数は 3.5 巻きのように整数でなくてよい(model の SpringFeature.turns の注釈)。
 * 単位札は mm / degree / count の3つしか無く(ja.json を増やせないため、§4「ja.json は
 * 触らない」)、「巻」に当たる単位が無いので count(「個」)を流用する。表示上の妥協点として
 * 報告する。
 */
const SPRING_TURNS_FIELD: NumericFieldDefinition = {
  key: 'springTurns',
  labelKey: 'numericInput.field.springTurns',
  tooltipKey: 'numericInput.tooltip.springTurns',
  unit: 'count',
  defaultSource: String(DEFAULT_SPRING_TURNS),
  range: SPRING_TURNS_RANGE,
};
/** 既定の全長はピッチ×巻数(model の DEFAULT_SPRING_PITCH_MM × DEFAULT_SPRING_TURNS = 20mm)。 */
const SPRING_LENGTH_FIELD: NumericFieldDefinition = {
  key: 'springLength',
  labelKey: 'numericInput.field.springLength',
  tooltipKey: 'numericInput.tooltip.springLength',
  unit: 'mm',
  defaultSource: String(DEFAULT_SPRING_PITCH_MM * DEFAULT_SPRING_TURNS),
  range: POSITIVE,
};

const SPRING_LENGTH_FIELD_DEFS: readonly NumericFieldDefinition[] = [
  SPRING_PITCH_FIELD,
  SPRING_TURNS_FIELD,
  SPRING_LENGTH_FIELD,
];

/**
 * 求める値(derived)が指す欄は出さない(§0.a-0.30。読み取り専用の欄をポップアップに
 * 置かないため、NFR-UX-4)。既定・未知の値は 'length' と同じ扱いにする(安全側)。
 */
function springLengthFieldDefinitions(derived: string | undefined): readonly NumericFieldDefinition[] {
  const excludedKey = derived === 'pitch' ? 'springPitch' : derived === 'turns' ? 'springTurns' : 'springLength';
  return SPRING_LENGTH_FIELD_DEFS.filter((definition) => definition.key !== excludedKey);
}

/** 段ごとの静的な欄の並び。動的な段(chamferSize・springLength)はここを通らない。 */
function solidFieldDefinitionsFor(
  step: SolidNumericInputStep,
  choices: readonly NumericChoice[],
): readonly NumericFieldDefinition[] {
  switch (step) {
    case 'extrudeDistance':
      return EXTRUDE_DISTANCE_FIELDS;
    case 'revolveAngle':
      return REVOLVE_ANGLE_FIELDS;
    case 'sewTolerance':
      return SEW_TOLERANCE_FIELDS;
    case 'holeSize':
      return HOLE_SIZE_FIELDS;
    case 'threadSize':
      return THREAD_SIZE_FIELDS;
    case 'filletRadius':
      return FILLET_RADIUS_FIELDS;
    case 'chamferSize':
      return chamferFieldDefinitions(choiceValueFrom(choices, 'chamferMode'));
    case 'linearPattern':
      return LINEAR_PATTERN_FIELDS;
    case 'circularPattern':
      return CIRCULAR_PATTERN_FIELDS;
    case 'springShape':
      return SPRING_SHAPE_FIELDS;
    case 'springLength':
      return springLengthFieldDefinitions(choiceValueFrom(choices, 'springDerived'));
  }
}

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
  holeSize: 'numericInput.title.hole',
  threadSize: 'numericInput.title.threadHole',
  filletRadius: 'numericInput.title.fillet',
  chamferSize: 'numericInput.title.chamfer',
  linearPattern: 'numericInput.title.linearPattern',
  circularPattern: 'numericInput.title.circularPattern',
  springShape: 'numericInput.title.springShape',
  springLength: 'numericInput.title.springLength',
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
  'holeSize',
  'threadSize',
  'filletRadius',
  'chamferSize',
  'linearPattern',
  'circularPattern',
  'springShape',
  'springLength',
];

/** ソリッドの道具が最初に聞く段階。ツールバーがここから開く。ばねは形(springShape)から。 */
export const SOLID_TOOL_STEPS: Readonly<Record<SolidToolId, SolidNumericInputStep>> = {
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
};

/** 段階から道具を引く。確定結果へ入れる道具名の正本。ばねは springShape / springLength とも spring。 */
const SOLID_STEP_TOOLS: Readonly<Record<SolidNumericInputStep, SolidToolId>> = {
  extrudeDistance: 'extrude',
  revolveAngle: 'revolve',
  sewTolerance: 'sew',
  holeSize: 'hole',
  threadSize: 'threadHole',
  filletRadius: 'fillet',
  chamferSize: 'chamfer',
  linearPattern: 'linearPattern',
  circularPattern: 'circularPattern',
  springShape: 'spring',
  springLength: 'spring',
};

/** 段階ごとのつまみ。縫合・R面取り・C面取り・ばねは向きも両側も持たない(§2.11 の表)。 */
const STEP_TOGGLE_KEYS: Readonly<Record<SolidNumericInputStep, readonly NumericToggleKey[]>> = {
  extrudeDistance: ['reversed', 'symmetric'],
  revolveAngle: ['reversed'],
  sewTolerance: [],
  holeSize: ['through'],
  threadSize: ['through', 'modeledThread'],
  filletRadius: [],
  chamferSize: [],
  linearPattern: ['patternSymmetric'],
  circularPattern: ['fullCircle'],
  springShape: [],
  springLength: [],
};

/** つまみの見出し。 */
export const TOGGLE_LABEL_KEYS: Readonly<Record<NumericToggleKey, MessageKey>> = {
  reversed: 'numericInput.toggle.reversed',
  symmetric: 'numericInput.toggle.symmetric',
  through: 'numericInput.toggle.through',
  modeledThread: 'numericInput.toggle.modeledThread',
  patternSymmetric: 'numericInput.toggle.patternSymmetric',
  fullCircle: 'numericInput.toggle.fullCircle',
};

/**
 * つまみの既定値。円形パターンの「全周」だけ既定で入(§0.a-0.21「円形『Z・全周・4』」)。
 * ほかはすべて既定で切。
 */
const TOGGLE_DEFAULT_VALUES: Readonly<Record<NumericToggleKey, boolean>> = {
  reversed: false,
  symmetric: false,
  through: false,
  modeledThread: false,
  patternSymmetric: false,
  fullCircle: true,
};

/** ワールドの X / Y / Z 軸(+選んだ線分)の選択肢。回転軸・円形パターン・ばねの軸で共用する。 */
const WORLD_AXIS_OPTIONS: readonly NumericChoiceOption[] = [
  { value: 'x', labelKey: 'numericInput.axis.x' },
  { value: 'y', labelKey: 'numericInput.axis.y' },
  { value: 'z', labelKey: 'numericInput.axis.z' },
];

/** 選んだ線分を軸にする選択肢の見出し(P2 タスク21 で専用のキーを追加した)。 */
const AXIS_LINE_LABEL_KEY: MessageKey = 'numericInput.axis.line';

function axisLikeOptions(axisLine: SketchLineRef | undefined): readonly NumericChoiceOption[] {
  return axisLine === undefined
    ? WORLD_AXIS_OPTIONS
    : [...WORLD_AXIS_OPTIONS, { value: 'line', labelKey: AXIS_LINE_LABEL_KEY }];
}

/** 回転軸の既定(§0.a-0.9)。XY 面にかいた断面を Z 軸まわりに回すのが最も多い。 */
export const DEFAULT_REVOLVE_AXIS: RevolveAxisChoice = 'z';

/** 回転・円形パターン・ばねの軸(見出しは「回転軸」で共用、§2.11)。 */
function axisChoice(axisLine: SketchLineRef | undefined, defaultValue: string): NumericChoice {
  return {
    key: 'axis',
    labelKey: 'numericInput.axisGroupLabel',
    value: defaultValue,
    options: axisLikeOptions(axisLine),
  };
}

/** 直線パターンの向き(§0.a-0.21。既定は X)。回転軸とは別のキー・見出しにする。 */
function patternDirectionChoice(axisLine: SketchLineRef | undefined): NumericChoice {
  return {
    key: 'patternDirection',
    labelKey: 'numericInput.choice.patternDirection',
    value: 'x',
    options: axisLikeOptions(axisLine),
  };
}

/** ねじ穴の呼び(M2〜M64)。ラベルは METRIC_THREAD_DESIGNATIONS の文字をそのまま使う(§2.11)。 */
function threadDesignationChoice(): NumericChoice {
  return {
    key: 'threadDesignation',
    labelKey: 'numericInput.choice.threadDesignation',
    value: DEFAULT_THREAD_DESIGNATION,
    options: METRIC_THREAD_DESIGNATIONS.map((designation) => ({ value: designation, label: designation })),
  };
}

/** ねじの系列(並目/細目)。既定は並目。 */
function threadSeriesChoice(): NumericChoice {
  return {
    key: 'threadSeries',
    labelKey: 'numericInput.choice.threadSeries',
    value: 'coarse',
    options: [
      { value: 'coarse', labelKey: 'numericInput.threadSeries.coarse' },
      { value: 'fine', labelKey: 'numericInput.threadSeries.fine' },
    ],
  };
}

/** C面取りの決め方。既定は距離(等距離)。 */
function chamferModeChoice(): NumericChoice {
  return {
    key: 'chamferMode',
    labelKey: 'numericInput.choice.chamferMode',
    value: 'equal',
    options: [
      { value: 'equal', labelKey: 'numericInput.chamferMode.equal' },
      { value: 'twoDistances', labelKey: 'numericInput.chamferMode.twoDistances' },
      { value: 'distanceAngle', labelKey: 'numericInput.chamferMode.distanceAngle' },
    ],
  };
}

/** ばねの巻き方向。既定は右巻き(§0.a-0.33)。 */
function springHandednessChoice(): NumericChoice {
  return {
    key: 'springHandedness',
    labelKey: 'numericInput.choice.springHandedness',
    value: 'right',
    options: [
      { value: 'right', labelKey: 'numericInput.springHandedness.right' },
      { value: 'left', labelKey: 'numericInput.springHandedness.left' },
    ],
  };
}

/** ばねの求める値(全長/ピッチ/巻数)。既定は全長(§0.a-0.30)。 */
function springDerivedChoice(): NumericChoice {
  return {
    key: 'springDerived',
    labelKey: 'numericInput.choice.springDerived',
    value: 'length',
    options: [
      { value: 'length', labelKey: 'numericInput.springDerived.length' },
      { value: 'pitch', labelKey: 'numericInput.springDerived.pitch' },
      { value: 'turns', labelKey: 'numericInput.springDerived.turns' },
    ],
  };
}

/** 段階ごとの選択肢の並び。持たない段は空配列。 */
function choicesFor(step: NumericInputStep, options: NumericInputOptions): readonly NumericChoice[] {
  switch (step) {
    case 'revolveAngle':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS)];
    case 'threadSize':
      return [threadDesignationChoice(), threadSeriesChoice()];
    case 'chamferSize':
      return [chamferModeChoice()];
    case 'linearPattern':
      return [patternDirectionChoice(options.axisLine)];
    case 'circularPattern':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS)];
    case 'springShape':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS), springHandednessChoice()];
    case 'springLength':
      return [springDerivedChoice()];
    default:
      return [];
  }
}

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

/** 段階がソリッドのものかどうか(P2 タスク19、P3 タスク24)。 */
export function isSolidStep(step: NumericInputStep): step is SolidNumericInputStep {
  return (
    step === 'extrudeDistance' ||
    step === 'revolveAngle' ||
    step === 'sewTolerance' ||
    step === 'holeSize' ||
    step === 'threadSize' ||
    step === 'filletRadius' ||
    step === 'chamferSize' ||
    step === 'linearPattern' ||
    step === 'circularPattern' ||
    step === 'springShape' ||
    step === 'springLength'
  );
}

/** 段階ごとの既定の座標モード。線分の終点だけは相対が自然(FR-307)。 */
export function defaultModeForStep(step: NumericInputStep): CoordinateMode {
  return step === 'lineEnd' ? 'relative' : 'absolute';
}

function definitionsFor(
  step: NumericInputStep,
  mode: CoordinateMode,
  choices: readonly NumericChoice[],
): readonly NumericFieldDefinition[] {
  if (isSolidStep(step)) {
    return solidFieldDefinitionsFor(step, choices);
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
    value: TOGGLE_DEFAULT_VALUES[key],
  }));
}

/** ポップアップを開くときに外から渡せるもの。無くても既定で成り立つ(NFR-UX-4)。 */
export interface NumericInputOptions {
  /**
   * 回転軸・パターンの向き・ばねの軸に選べるスケッチの線分(§0.a-0.9)。
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
  const choices = choicesFor(step, options);
  return {
    toolId,
    step,
    mode,
    fields: toFields(definitionsFor(step, mode, choices)),
    focusedIndex: 0,
    toggles: togglesFor(step),
    choices,
    axisLine: options.axisLine,
  };
}

/**
 * ばねの2段目(springLength)の初期状態を、1段目(state)の入力を持ち越して作る
 * (§2.11「1段目の値は2段目へ持ち越す」)。springLength 自体は軸の選択肢を持たないので
 * axisLine は渡さず、carriedStage1 の中だけに残す。
 */
function springLengthStateFrom(state: NumericInputState): NumericInputState {
  const next = createNumericInput(state.toolId, 'springLength');
  return {
    ...next,
    carriedStage1: { fields: state.fields, choices: state.choices, axisLine: state.axisLine },
  };
}

/** 焦点が当たれる場所。並びは「欄 → 選択肢(順に)→ つまみ」で、画面の並びと同じにする。 */
export type NumericFocusTarget =
  | { readonly kind: 'field'; readonly index: number }
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'toggle'; readonly index: number };

/** Tab で巡る輪。P1 の段は欄しか無いので、輪の添字は欄の添字と一致する。 */
export function numericFocusTargets(state: NumericInputState): readonly NumericFocusTarget[] {
  const targets: NumericFocusTarget[] = state.fields.map((_field, index) => ({
    kind: 'field',
    index,
  }));
  state.choices.forEach((_choice, index) => {
    targets.push({ kind: 'choice', index });
  });
  state.toggles.forEach((_toggle, index) => {
    targets.push({ kind: 'toggle', index });
  });
  return targets;
}

/** いま焦点が当たっている場所。輪の外を指していれば null。 */
export function focusedTarget(state: NumericInputState): NumericFocusTarget | null {
  return numericFocusTargets(state)[state.focusedIndex] ?? null;
}

function moveChoiceValue(choice: NumericChoice, backwards: boolean): string {
  const count = choice.options.length;
  const current = choice.options.findIndex((option) => option.value === choice.value);
  const next = ((backwards ? current - 1 : current + 1) + count) % count;
  return choice.options[next].value;
}

/** 欄の並びが変わっても、同じ key の欄は入力値を引き継ぐ。新しい欄は既定値(§2.11)。 */
function mergeFieldValues(
  previous: readonly NumericField[],
  definitions: readonly NumericFieldDefinition[],
): NumericField[] {
  return definitions.map((definition) => {
    const existing = previous.find((field) => field.key === definition.key);
    return existing === undefined
      ? { ...definition, source: definition.defaultSource }
      : { ...definition, source: existing.source };
  });
}

/**
 * 選択肢の値を更新したあと、欄の並びがその選択肢に依存する段(C面取り・ばねの長さ)だけ
 * 欄を組み替える。どちらの段も欄は常に2つのままなので、焦点の位置(focusedIndex)は
 * 動かさなくてよい(輪の並びが変わらないため)。
 */
function applyChoiceToFields(
  state: NumericInputState,
  choices: readonly NumericChoice[],
): NumericInputState {
  if (state.step !== 'chamferSize' && state.step !== 'springLength') {
    return { ...state, choices };
  }
  const definitions = solidFieldDefinitionsFor(state.step, choices);
  const fields = mergeFieldValues(state.fields, definitions);
  return { ...state, choices, fields };
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
        fields: toFields(definitionsFor(state.step, event.mode, state.choices)),
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
      const target = state.choices.find((choice) => choice.key === event.key);
      if (
        target === undefined ||
        target.value === event.value ||
        !target.options.some((option) => option.value === event.value)
      ) {
        return state;
      }
      const choices = state.choices.map((choice) =>
        choice.key === event.key ? { ...choice, value: event.value } : choice,
      );
      return applyChoiceToFields(state, choices);
    }
    case 'moveChoice': {
      const target = focusedTarget(state);
      if (target === null || target.kind !== 'choice') {
        return state;
      }
      const choice = state.choices[target.index];
      if (choice === undefined || choice.options.length < 2) {
        return state;
      }
      const value = moveChoiceValue(choice, event.backwards);
      const choices = state.choices.map((entry, index) =>
        index === target.index ? { ...entry, value } : entry,
      );
      return applyChoiceToFields(state, choices);
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

/** 選択肢を選ぶ(§0.a-0.9、§2.11)。選択肢に無い値、持っていないつまみは無視する。 */
export function chooseNumericInput(
  state: NumericInputState,
  key: NumericChoiceKey,
  value: string,
): NumericInputState {
  return reduceNumericInput(state, { type: 'choose', key, value });
}

function choiceValueFrom(choices: readonly NumericChoice[], key: NumericChoiceKey): string | undefined {
  return choices.find((choice) => choice.key === key)?.value;
}

/** 指定したつまみの現在値。持たない・見つからないときは null。 */
export function choiceValueOf(state: NumericInputState, key: NumericChoiceKey): string | null {
  return choiceValueFrom(state.choices, key) ?? null;
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
    // 個数(パターンの count)が整数かどうかはここでは確かめない。NumericFieldRange は
    // min/max しか表現できず、ここへ整数判定を足すと他の欄(距離等)へ影響しない設計を
    // 保つのが難しいため、整数かどうかの検査は加工コマンド側(タスク25
    // machiningCommands.ts)で行う判断とした(計画書タスク24 検証表の注記への回答)。
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
 * 決めた後に外へ渡すもの(スケッチ)。座標を聞く段階かどうかで中身が変わる。
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

/** ソリッドの数値。道具ごとに使う欄だけが入る(§2.11 の表)。 */
export interface SolidCommitValues {
  /** 押し出しの長さ(mm)。 */
  readonly distance?: ExpressionValue;
  /** 回転の角度(度)。 */
  readonly angle?: ExpressionValue;
  /** 縫合の許容量(mm)。 */
  readonly tolerance?: ExpressionValue;
  /** 穴・ねじ穴の直径(mm)。 */
  readonly diameter?: ExpressionValue;
  /** 穴・ねじ穴の深さ(mm)。 */
  readonly depth?: ExpressionValue;
  /** R面取りの半径(mm)。 */
  readonly radius?: ExpressionValue;
  /** C面取りの距離(mm)。 */
  readonly chamferDistance?: ExpressionValue;
  /** C面取りの距離2(mm)。2距離のときだけ。 */
  readonly chamferDistance2?: ExpressionValue;
  /** C面取りの角度(度)。距離と角度のときだけ。 */
  readonly chamferAngle?: ExpressionValue;
  /** ねじ穴のねじ部の長さ(mm)。 */
  readonly threadLength?: ExpressionValue;
  /** 直線パターンの間隔(mm)。 */
  readonly spacing?: ExpressionValue;
  /** パターンの個数(直線・円形とも)。 */
  readonly count?: ExpressionValue;
  /** ばねのコイル径(mm、FR-414)。 */
  readonly coilDiameter?: ExpressionValue;
  /** ばねの線径(mm)。 */
  readonly wireDiameter?: ExpressionValue;
  /** ばねのピッチ(mm)。求める値が「ピッチ」のときは入らない。 */
  readonly springPitch?: ExpressionValue;
  /** ばねの巻数。求める値が「巻数」のときは入らない。 */
  readonly springTurns?: ExpressionValue;
  /** ばねの全長(mm)。求める値が「全長」のときは入らない。 */
  readonly springLength?: ExpressionValue;
}

/** ソリッドのつまみ。持たない道具では欄ごと現れない。 */
export interface SolidCommitFlags {
  /** 向きを反転するか(押し出し・回転)。 */
  readonly reversed?: boolean;
  /** 両側へ出すか(押し出しだけ)。 */
  readonly symmetric?: boolean;
  /** 貫通させるか(穴・ねじ穴)。 */
  readonly through?: boolean;
  /** 実際のねじ山を作るか(ねじ穴。false なら簡略表示)。 */
  readonly modeledThread?: boolean;
  /** 両側へ並べるか(直線パターン)。 */
  readonly patternSymmetric?: boolean;
  /** 全周へ等間隔で並べるか(円形パターン)。 */
  readonly fullCircle?: boolean;
}

/**
 * ソリッドを決めたときに外へ渡すもの(§0.a-0.7 / 0.8 / 0.9、P3 §2.11)。
 * タスク21・タスク25・タスク25b がこれを受け取る。
 */
export interface SolidInputCommit {
  readonly kind: 'solid';
  readonly tool: SolidToolId;
  readonly step: SolidNumericInputStep;
  readonly values: SolidCommitValues;
  readonly flags: SolidCommitFlags;
  /**
   * 回転・パターン・ばねのときだけ入る(計画書の注釈は「回転・パターンのときだけ」だが、
   * タスク25b の commitSpring が axis を必須で要求するため、ばねにも入れた。
   * 判断に迷った点として報告する)。
   */
  readonly axis?: RevolveAxis;
  /** ねじ穴のときだけ入る。 */
  readonly threadDesignation?: string;
  readonly threadSeries?: ThreadSeries;
  /** C面取りのときだけ入る。 */
  readonly chamferMode?: ChamferSize['kind'];
  /** ばねのときだけ入る(FR-414)。 */
  readonly springHandedness?: SpringHandedness;
  readonly springDerived?: SpringDerived;
}

/** ポップアップが返しうる確定結果のすべて。 */
export type AnyNumericInputCommit = NumericInputCommit | SolidInputCommit;

/**
 * ポップアップの次の姿。`open` は開いたまま(ばねの1段目→2段目の遷移もここを通る、
 * §2.11)、`committed` / `solidCommitted` は履歴へ積んでよい、`blocked` は不正な欄が
 * 残っているので決定させない(NFR-UX-5)、`cancelled` は取消。
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

function fieldValueMap(
  fields: readonly NumericField[],
  values: readonly ExpressionValue[],
): ReadonlyMap<string, ExpressionValue> {
  const map = new Map<string, ExpressionValue>();
  fields.forEach((field, index) => {
    const value = values[index];
    if (value !== undefined) {
      map.set(field.key, value);
    }
  });
  return map;
}

/**
 * ばねの1段目(carriedStage1)の欄を評価し、key から引ける表にする。
 * 1段目は確定済み(すでに canCommit だった)ので、通常は評価に失敗しない。
 */
function evaluateCarried(
  fields: readonly NumericField[] | undefined,
  variables: ReadonlyMap<string, number> | undefined,
): ReadonlyMap<string, ExpressionValue> {
  const map = new Map<string, ExpressionValue>();
  if (fields === undefined) {
    return map;
  }
  for (const field of fields) {
    const result = evaluateExpression(effectiveSource(field), { variables });
    if (result.ok) {
      map.set(field.key, result.value);
    }
  }
  return map;
}

function solidValuesFor(
  step: SolidNumericInputStep,
  fields: readonly NumericField[],
  values: readonly ExpressionValue[],
  carried: ReadonlyMap<string, ExpressionValue>,
): SolidCommitValues {
  const own = fieldValueMap(fields, values);
  const get = (key: string): ExpressionValue | undefined => own.get(key) ?? carried.get(key);
  switch (step) {
    case 'extrudeDistance':
      return { distance: get('distance') };
    case 'revolveAngle':
      return { angle: get('angle') };
    case 'sewTolerance':
      return { tolerance: get('tolerance') };
    case 'holeSize':
      return { diameter: get('diameter'), depth: get('depth') };
    case 'threadSize':
      return { depth: get('depth'), threadLength: get('threadLength') };
    case 'filletRadius':
      return { radius: get('radius') };
    case 'chamferSize':
      return {
        chamferDistance: get('chamferDistance'),
        chamferDistance2: get('chamferDistance2'),
        chamferAngle: get('chamferAngle'),
      };
    case 'linearPattern':
      return { spacing: get('spacing'), count: get('count') };
    case 'circularPattern':
      return { angle: get('angle'), count: get('count') };
    case 'springShape':
      return { coilDiameter: get('coilDiameter'), wireDiameter: get('wireDiameter') };
    case 'springLength':
      return {
        coilDiameter: get('coilDiameter'),
        wireDiameter: get('wireDiameter'),
        springPitch: get('springPitch'),
        springTurns: get('springTurns'),
        springLength: get('springLength'),
      };
  }
}

function solidFlagsFor(toggles: readonly NumericToggle[]): SolidCommitFlags {
  const flags: {
    reversed?: boolean;
    symmetric?: boolean;
    through?: boolean;
    modeledThread?: boolean;
    patternSymmetric?: boolean;
    fullCircle?: boolean;
  } = {};
  for (const toggle of toggles) {
    flags[toggle.key] = toggle.value;
  }
  return flags;
}

/** 選択肢の文字列値から RevolveAxis を組み立て直す(§2.11「確定側で value から引き直す」)。 */
function axisFromChoiceValue(value: string, axisLine: SketchLineRef | undefined): RevolveAxis | undefined {
  switch (value) {
    case 'x':
    case 'y':
    case 'z':
      return { kind: 'world', axis: value };
    case 'line':
      return axisLine === undefined ? undefined : { kind: 'line', line: axisLine };
    default:
      return undefined;
  }
}

function toThreadSeries(value: string | undefined): ThreadSeries | undefined {
  switch (value) {
    case 'coarse':
      return 'coarse';
    case 'fine':
      return 'fine';
    default:
      return undefined;
  }
}

function toChamferMode(value: string | undefined): ChamferSize['kind'] | undefined {
  switch (value) {
    case 'equal':
      return 'equal';
    case 'twoDistances':
      return 'twoDistances';
    case 'distanceAngle':
      return 'distanceAngle';
    default:
      return undefined;
  }
}

function toSpringHandedness(value: string | undefined): SpringHandedness | undefined {
  switch (value) {
    case 'right':
      return 'right';
    case 'left':
      return 'left';
    default:
      return undefined;
  }
}

function toSpringDerived(value: string | undefined): SpringDerived | undefined {
  switch (value) {
    case 'length':
      return 'length';
    case 'pitch':
      return 'pitch';
    case 'turns':
      return 'turns';
    default:
      return undefined;
  }
}

/**
 * ソリッドの確定を組み立てる。ばねの2段目(springLength)では1段目(carriedStage1)の
 * 欄・選択肢も合わせて読む(§2.11「1段目の値は2段目へ持ち越す」)。
 * 呼び出し元(commitNumericInput)がソリッドの段でだけ呼ぶので、step はここで
 * SolidNumericInputStep へ絞り込み済みのものを受け取る。
 */
function buildSolidCommit(
  step: SolidNumericInputStep,
  filled: NumericInputState,
  values: readonly ExpressionValue[],
  variables: ReadonlyMap<string, number> | undefined,
): SolidInputCommit {
  const carried = evaluateCarried(filled.carriedStage1?.fields, variables);
  const combinedChoices = [...filled.choices, ...(filled.carriedStage1?.choices ?? [])];
  const axisValue =
    choiceValueFrom(combinedChoices, 'axis') ?? choiceValueFrom(combinedChoices, 'patternDirection');
  const axisLine = filled.axisLine ?? filled.carriedStage1?.axisLine;
  return {
    kind: 'solid',
    tool: SOLID_STEP_TOOLS[step],
    step,
    values: solidValuesFor(step, filled.fields, values, carried),
    flags: solidFlagsFor(filled.toggles),
    axis: axisValue === undefined ? undefined : axisFromChoiceValue(axisValue, axisLine),
    threadDesignation: choiceValueFrom(combinedChoices, 'threadDesignation'),
    threadSeries: toThreadSeries(choiceValueFrom(combinedChoices, 'threadSeries')),
    chamferMode: toChamferMode(choiceValueFrom(combinedChoices, 'chamferMode')),
    springHandedness: toSpringHandedness(choiceValueFrom(combinedChoices, 'springHandedness')),
    springDerived: toSpringDerived(choiceValueFrom(combinedChoices, 'springDerived')),
  };
}

/**
 * 「決定」を押したとき、または Enter を打ったときの処理。
 * 空欄を既定値で埋めてから評価し(NFR-UX-4)、1 つでも不正なら決定させずに
 * 最初の誤りへ焦点を移す(NFR-UX-5、FR-204)。
 *
 * ばねの1段目(springShape)だけは特別で、確定しても閉じずに2段目(springLength)を
 * 開く(`kind: 'open'`)。まだ利用者へ渡す完成した加工ではないため、`solidCommitted`
 * にはしない(§2.11「P1 の線分の始点→終点と同じ作り」)。
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
    if (step === 'springShape') {
      return { kind: 'open', state: springLengthStateFrom(filled) };
    }
    return {
      kind: 'solidCommitted',
      state: filled,
      commit: buildSolidCommit(step, filled, values, context.variables),
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
 * 例外はばねの springShape で、これだけは chaining に関わらず springLength へ進む
 * (§2.11。commitNumericInput が springShape を `kind: 'open'` で返すのと同じ理由)。
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
    case 'springShape':
      return springLengthStateFrom(state);
    case 'extrudeDistance':
    case 'revolveAngle':
    case 'sewTolerance':
    case 'holeSize':
    case 'threadSize':
    case 'filletRadius':
    case 'chamferSize':
    case 'linearPattern':
    case 'circularPattern':
    case 'springLength':
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
