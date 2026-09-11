/** Material strength is condition-specific. Never infer it from a body's display material. */
export interface StrengthSource {
  readonly url: string;
  readonly publisher: string;
  readonly locator: string;
  readonly checkedDate: string;
  readonly standard: string | null;
  readonly standardEdition: string | null;
  readonly evidence: 'supplier-excerpt' | 'manufacturer-reference' | 'measured-reference';
  readonly sha256: string;
}
export interface StrengthMaterialProperty {
  readonly mpa: string;
  readonly sourceId: string;
  readonly basis: 'minimum' | 'reference';
}
export interface StrengthMaterialPreset {
  readonly id: string;
  readonly densityMaterialId: 'steel' | 'stainless' | 'aluminum';
  readonly grade: string;
  readonly condition: string;
  readonly product: 'plate' | 'cold-rolled-sheet' | 'general';
  readonly thicknessMm: { readonly greaterThan: number; readonly atMost: number; readonly lowerInclusive?: boolean } | null;
  readonly temperature: 'room' | 'not-specified';
  readonly yieldStress: StrengthMaterialProperty;
  readonly tensileStrength: StrengthMaterialProperty;
  readonly youngModulus: StrengthMaterialProperty | null;
  readonly shearModulus: StrengthMaterialProperty | null;
}

export function checkStrengthMaterialCondition(preset: StrengthMaterialPreset, productThicknessMm: number | null):
  { readonly ok: true } | { readonly ok: false; readonly reason: 'thickness-required' | 'thickness-outside' } {
  if (preset.thicknessMm === null) return { ok: true };
  if (productThicknessMm === null || !Number.isFinite(productThicknessMm)) return { ok: false, reason: 'thickness-required' };
  const above = preset.thicknessMm.lowerInclusive === true ? productThicknessMm >= preset.thicknessMm.greaterThan : productThicknessMm > preset.thicknessMm.greaterThan;
  return above && productThicknessMm <= preset.thicknessMm.atMost
    ? { ok: true } : { ok: false, reason: 'thickness-outside' };
}

/** Separate material inputs from section geometry. Missing source-backed constants stay empty. */
export function strengthMaterialSources(preset: StrengthMaterialPreset): ReadonlyMap<string, string> {
  const fields = new Map<string, string>([['yieldStress', preset.yieldStress.mpa]]);
  if (preset.youngModulus) fields.set('youngModulus', preset.youngModulus.mpa);
  if (preset.shearModulus) fields.set('shearModulus', preset.shearModulus.mpa);
  return fields;
}
