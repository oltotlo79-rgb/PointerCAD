/** 立体の数値欄の名前・単位・範囲と、原式を持つ表示値を組み立てる。 */
import type { ExpressionValue } from '@pointercad/expression';
import { MAX_DRAFT_ANGLE_DEGREES, MAX_SCALE, MAX_TAPER_ANGLE_DEGREES, MIN_SCALE } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { SHEET_FIELD_DEFINITIONS } from '../sheetMetal/sheetFields.js';
import type { FieldUnit, NumericFieldRange } from '../sketch/numericInput.js';
import type { SolidFieldKey, SolidFieldSummary } from './solidPropertyContracts.js';

/**
 * 欄の見出し・説明・単位。その場数値入力(numericInput.ts)と同じ言葉を使う。
 *
 * ピッチ・下穴径・傾き・傾ける向きはその場入力を持たない(§0.a-0.10「その場入力には出さず
 * プロパティでだけ編集」、下穴径はねじの呼びから自動で決まる)ので専用の tooltip キーが
 * 無い。ラベルと同じキーを tooltip にも使う(ja.json を増やさない、計画書 §4)。
 */
/** 0 より大きい数だけ(厚み・半径・長さ)。その場入力の `POSITIVE` と同じ形。 */
const POSITIVE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: null,
  maxInclusive: false,
};

/** 0 以上(押し出しの側面の傾きは 0 = まっすぐ)。上限は model の定数が正本。 */
const TAPER_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: MAX_TAPER_ANGLE_DEGREES,
  maxInclusive: true,
};

/** 抜き勾配は 0 度では意味が無いので 0 を含めない(model の `MAX_DRAFT_ANGLE_DEGREES` まで)。 */
const DRAFT_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: MAX_DRAFT_ANGLE_DEGREES,
  maxInclusive: true,
};

/** 皿もみの開き角(度)。0 度と 180 度は円錐にならない。 */
const COUNTERSINK_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 180,
  maxInclusive: false,
};

/** 拡大縮小の倍率。上下限は model の `MIN_SCALE` / `MAX_SCALE` が正本。 */
const SCALE_RANGE: NumericFieldRange = {
  min: MIN_SCALE,
  minInclusive: true,
  max: MAX_SCALE,
  maxInclusive: true,
};

/** 曲面を回す角度(度)。0 度では面にならず、360 度で全周。 */
const SURFACE_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 360,
  maxInclusive: true,
};

/** 切る面の傾き(度)。§2.9b の断りと同じ 0 以上 180 度未満。 */
export const PLANE_TILT_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: 180,
  maxInclusive: false,
};

const FIELD_DEFINITIONS: Readonly<
  Record<
    SolidFieldKey,
    {
      readonly labelKey: MessageKey;
      readonly tooltipKey: MessageKey;
      readonly unit: FieldUnit;
      readonly range?: NumericFieldRange;
    }
  >
> = {
  ...SHEET_FIELD_DEFINITIONS,
  distance: {
    labelKey: 'numericInput.field.distance',
    tooltipKey: 'numericInput.tooltip.extrudeDistance',
    unit: 'mm',
  },
  angle: {
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.angle',
    unit: 'degree',
  },
  tolerance: {
    labelKey: 'numericInput.field.tolerance',
    tooltipKey: 'numericInput.tooltip.tolerance',
    unit: 'mm',
  },
  diameter: {
    labelKey: 'numericInput.field.diameter',
    tooltipKey: 'numericInput.tooltip.diameter',
    unit: 'mm',
  },
  depth: {
    labelKey: 'numericInput.field.depth',
    tooltipKey: 'numericInput.tooltip.depth',
    unit: 'mm',
  },
  radius: {
    labelKey: 'numericInput.field.radius',
    tooltipKey: 'numericInput.tooltip.filletRadius',
    unit: 'mm',
  },
  chamferDistance: {
    labelKey: 'numericInput.field.chamferDistance',
    tooltipKey: 'numericInput.tooltip.chamferDistance',
    unit: 'mm',
  },
  chamferDistance2: {
    labelKey: 'numericInput.field.chamferDistance2',
    tooltipKey: 'numericInput.tooltip.chamferDistance2',
    unit: 'mm',
  },
  chamferAngle: {
    labelKey: 'numericInput.field.chamferAngle',
    tooltipKey: 'numericInput.tooltip.chamferAngle',
    unit: 'degree',
  },
  pitch: { labelKey: 'propertyPanel.pitch', tooltipKey: 'propertyPanel.pitch', unit: 'mm' },
  drillDiameter: {
    labelKey: 'propertyPanel.drillDiameter',
    tooltipKey: 'propertyPanel.drillDiameter',
    unit: 'mm',
  },
  threadLength: {
    labelKey: 'numericInput.field.threadLength',
    tooltipKey: 'numericInput.tooltip.threadLength',
    unit: 'mm',
  },
  tiltAngle: {
    labelKey: 'propertyPanel.tiltAngle',
    tooltipKey: 'propertyPanel.tiltAngle',
    unit: 'degree',
  },
  tiltAzimuth: {
    labelKey: 'propertyPanel.tiltAzimuth',
    tooltipKey: 'propertyPanel.tiltAzimuth',
    unit: 'degree',
  },
  spacing: {
    labelKey: 'numericInput.field.spacing',
    tooltipKey: 'numericInput.tooltip.patternSpacing',
    unit: 'mm',
  },
  count: {
    labelKey: 'numericInput.field.count',
    tooltipKey: 'numericInput.tooltip.patternCount',
    unit: 'count',
  },
  patternAngle: {
    labelKey: 'numericInput.field.patternAngle',
    tooltipKey: 'numericInput.tooltip.patternAngle',
    unit: 'degree',
  },
  coilDiameter: {
    labelKey: 'numericInput.field.coilDiameter',
    tooltipKey: 'numericInput.tooltip.coilDiameter',
    unit: 'mm',
  },
  wireDiameter: {
    labelKey: 'numericInput.field.wireDiameter',
    tooltipKey: 'numericInput.tooltip.wireDiameter',
    unit: 'mm',
  },
  springPitch: {
    labelKey: 'numericInput.field.springPitch',
    tooltipKey: 'numericInput.tooltip.springPitch',
    unit: 'mm',
  },
  springTurns: {
    labelKey: 'numericInput.field.springTurns',
    tooltipKey: 'numericInput.tooltip.springTurns',
    unit: 'count',
  },
  springLength: {
    labelKey: 'numericInput.field.springLength',
    tooltipKey: 'numericInput.tooltip.springLength',
    unit: 'mm',
  },
  // 面をつなぐ・ロフトのねじれ(タスク27)。その場入力の欄とまったく同じ文言キーを使う
  // (同じ数を 2 通りの名前で呼ばない)。単位は個(頂点の数)。
  ruledTwist: {
    labelKey: 'numericInput.field.ruledTwist',
    tooltipKey: 'numericInput.tooltip.ruledTwist',
    unit: 'count',
  },
  /*
    P5 の Should / Could 群と切断(タスク52・27f・55)。見出し・説明・単位・範囲は
    **その場入力(numericInput.ts、タスク49・50・27e)とまったく同じ文言キー**にする。
    同じ数を 2 通りの名前で呼ばないための決めで、ばね・面をつなぐと同じ流儀。
  */
  taperAngle: {
    labelKey: 'propertyPanel.taperAngle',
    tooltipKey: 'numericInput.tooltip.taperAngle',
    unit: 'degree',
    range: TAPER_ANGLE_RANGE,
  },
  extrudeThickness: {
    labelKey: 'propertyPanel.extrudeThickness',
    tooltipKey: 'numericInput.tooltip.extrudeThickness',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  counterboreDiameter: {
    labelKey: 'numericInput.field.counterboreDiameter',
    tooltipKey: 'numericInput.tooltip.counterboreDiameter',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  counterboreDepth: {
    labelKey: 'numericInput.field.counterboreDepth',
    tooltipKey: 'numericInput.tooltip.counterboreDepth',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  countersinkDiameter: {
    labelKey: 'numericInput.field.countersinkDiameter',
    tooltipKey: 'numericInput.tooltip.countersinkDiameter',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  countersinkAngle: {
    labelKey: 'numericInput.field.countersinkAngle',
    tooltipKey: 'numericInput.tooltip.countersinkAngle',
    unit: 'degree',
    range: COUNTERSINK_ANGLE_RANGE,
  },
  radiusEnd: {
    labelKey: 'propertyPanel.filletRadiusEnd',
    tooltipKey: 'numericInput.tooltip.filletRadiusEnd',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  draftAngle: {
    labelKey: 'propertyPanel.draftAngle',
    tooltipKey: 'numericInput.tooltip.draftAngle',
    unit: 'degree',
    range: DRAFT_ANGLE_RANGE,
  },
  translationX: {
    labelKey: 'numericInput.field.x',
    tooltipKey: 'numericInput.tooltip.translationX',
    unit: 'mm',
  },
  translationY: {
    labelKey: 'numericInput.field.y',
    tooltipKey: 'numericInput.tooltip.translationY',
    unit: 'mm',
  },
  translationZ: {
    labelKey: 'numericInput.field.z',
    tooltipKey: 'numericInput.tooltip.translationZ',
    unit: 'mm',
  },
  rotationAngle: {
    labelKey: 'propertyPanel.transformRotationAngle',
    tooltipKey: 'numericInput.tooltip.transformRotation',
    unit: 'degree',
  },
  scaleFactor: {
    labelKey: 'numericInput.field.scaleFactor',
    tooltipKey: 'numericInput.tooltip.scaleFactor',
    unit: 'count',
    range: SCALE_RANGE,
  },
  scaleX: {
    labelKey: 'numericInput.field.scaleX',
    tooltipKey: 'numericInput.tooltip.scaleX',
    unit: 'count',
    range: SCALE_RANGE,
  },
  scaleY: {
    labelKey: 'numericInput.field.scaleY',
    tooltipKey: 'numericInput.tooltip.scaleY',
    unit: 'count',
    range: SCALE_RANGE,
  },
  scaleZ: {
    labelKey: 'numericInput.field.scaleZ',
    tooltipKey: 'numericInput.tooltip.scaleZ',
    unit: 'count',
    range: SCALE_RANGE,
  },
  ribThickness: {
    labelKey: 'numericInput.field.wallThickness',
    tooltipKey: 'numericInput.tooltip.ribThickness',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  embossHeight: {
    labelKey: 'numericInput.field.height',
    tooltipKey: 'numericInput.tooltip.embossHeight',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  surfaceDistance: {
    labelKey: 'numericInput.field.distance',
    tooltipKey: 'numericInput.tooltip.surfaceDistance',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  surfaceAngle: {
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.surfaceAngle',
    unit: 'degree',
    range: SURFACE_ANGLE_RANGE,
  },
  surfaceOffset: {
    labelKey: 'numericInput.field.surfaceOffset',
    tooltipKey: 'numericInput.tooltip.surfaceOffset',
    unit: 'mm',
  },
  shellThickness: {
    labelKey: 'numericInput.field.wallThickness',
    tooltipKey: 'numericInput.tooltip.wallThickness',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  planeOffset: {
    labelKey: 'numericInput.field.planeOffset',
    tooltipKey: 'numericInput.tooltip.planeOffset',
    unit: 'mm',
  },
  planeAngle: {
    labelKey: 'numericInput.field.planeAngle',
    tooltipKey: 'numericInput.tooltip.planeAngle',
    unit: 'degree',
  },
};

/**
 * readOnly は既定 false。既存の呼び出し(加工6種・パターン)は1つも変えない(タスク29b)。
 *
 * `range` は**持っている欄にだけ**足す(持たない欄の要約に `range: undefined` の欄を
 * 生やさない)。P1〜P4 からある欄は範囲を持たないので、要約の形もそのまま変わらない。
 */
export function fieldSummary(
  key: SolidFieldKey,
  value: ExpressionValue,
  readOnly = false,
): SolidFieldSummary {
  const definition = FIELD_DEFINITIONS[key];
  const base = {
    key,
    labelKey: definition.labelKey,
    tooltipKey: definition.tooltipKey,
    unit: definition.unit,
    value,
    readOnly,
  };
  return definition.range === undefined ? base : { ...base, range: definition.range };
}
