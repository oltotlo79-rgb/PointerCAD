/**
 * 欄の見出し・説明・単位。その場数値入力(numericInput.ts)と同じ言葉を使う。
 *
 * ピッチ・下穴径・傾き・傾ける向きはその場入力を持たない(「その場入力には出さず
 * プロパティでだけ編集」、下穴径はねじの呼びから自動で決まる)ので専用の tooltip キーが
 * 無い。ラベルと同じキーを tooltip にも使う(ja.json を増やさない)。
 */
export const BASIC_FIELD_DEFINITIONS = {
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
  // 面をつなぐ・ロフトのねじれ。その場入力の欄とまったく同じ文言キーを使う
  // (同じ数を 2 通りの名前で呼ばない)。単位は個(頂点の数)。
  ruledTwist: {
    labelKey: 'numericInput.field.ruledTwist',
    tooltipKey: 'numericInput.tooltip.ruledTwist',
    unit: 'count',
  },
} as const;
