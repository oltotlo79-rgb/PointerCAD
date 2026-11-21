/** 接線方向の重みは長さ。作成時も性質欄も同じ単位と範囲で編集する。 */
const weight = {
  unit: 'mm', defaultSource: '1',
  range: { min: 0, minInclusive: false, max: null, maxInclusive: false },
} as const;

export const BLEND_WEIGHT_FIELDS = {
  weightA: { ...weight, key: 'weightA', labelKey: 'surfaceBlend.weightA', tooltipKey: 'surfaceBlend.weightATooltip' },
  weightB: { ...weight, key: 'weightB', labelKey: 'surfaceBlend.weightB', tooltipKey: 'surfaceBlend.weightBTooltip' },
} as const;
