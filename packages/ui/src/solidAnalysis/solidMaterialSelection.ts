import { checkStrengthMaterialCondition, findStrengthMaterial, STRENGTH_SOURCES } from '@pointercad/model';
import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import type { StrengthMaterialPreset, StrengthSource } from '@pointercad/model';
import { evaluateExpression } from '@pointercad/expression';

export interface SolidMaterialDraft {
  readonly materialConditionId: string;
  readonly thickness: string;
}
export type SolidMaterialIssue = 'material' | 'thickness' | 'outside' | 'source';
 type SolidMaterialSelection = { readonly ok: false; readonly issue: SolidMaterialIssue }
  | { readonly ok: true; readonly capacity: AnalysisMaterialCapacity | null; readonly preset: StrengthMaterialPreset | null; readonly source: StrengthSource | null };

/** Yield evidence only. Never fills the independent elastic-analysis inputs. */
export function selectSolidMaterial(draft: SolidMaterialDraft): SolidMaterialSelection {
  if (draft.materialConditionId === '') return { ok: true, capacity: null, preset: null, source: null };
  const preset = findStrengthMaterial(draft.materialConditionId);
  if (preset === undefined) return { ok: false, issue: 'material' };
  const evaluated = evaluateExpression(draft.thickness);
  const thickness = draft.thickness.trim() === '' ? null : evaluated.ok ? evaluated.value.value : NaN;
  if (thickness === null ? preset.thicknessMm !== null : !Number.isFinite(thickness) || thickness <= 0) {
    return { ok: false, issue: 'thickness' };
  }
  if (!checkStrengthMaterialCondition(preset, thickness).ok) return { ok: false, issue: 'outside' };
  const property = preset.yieldStress, source = STRENGTH_SOURCES[property.sourceId];
  const yieldMPa = Number(property.mpa);
  if (source === undefined || solidMaterialSourceUrl(source) === null || !/^[0-9a-f]{64}$/u.test(source.sha256) || !Number.isFinite(yieldMPa) || yieldMPa <= 0) {
    return { ok: false, issue: 'source' };
  }
  return { ok: true, preset, source, capacity: { materialConditionId: preset.id, condition: preset.condition,
    thicknessMm: thickness, yieldMPa, sourceId: property.sourceId, sourceSnapshot: { ...source }, evidence: source.evidence, basis: property.basis } };
}

export function solidMaterialDraftOf(value: AnalysisMaterialCapacity | null): SolidMaterialDraft {
  return { materialConditionId: value?.materialConditionId ?? '', thickness: value?.thicknessMm == null ? '' : String(value.thicknessMm) };
}

/** Saved values cannot borrow current catalogue evidence after changing a yield/source/condition. */
export function solidMaterialCapacityMatches(value: AnalysisMaterialCapacity | null): boolean {
  if (value === null) return false;
  const selection = selectSolidMaterial(solidMaterialDraftOf(value));
  if (!selection.ok || selection.capacity === null || selection.source === null || value.sourceSnapshot === undefined) return false;
  const source = value.sourceSnapshot, current = selection.source;
  const keys: readonly (keyof StrengthSource)[] = ['url', 'publisher', 'locator', 'checkedDate', 'standard', 'standardEdition', 'evidence', 'sha256'];
  return value.condition === selection.capacity.condition && value.yieldMPa === selection.capacity.yieldMPa
    && value.sourceId === selection.capacity.sourceId && value.evidence === selection.capacity.evidence
    && value.basis === selection.capacity.basis && Reflect.ownKeys(source).length === keys.length
    && keys.every(key => source[key] === current[key]);
}

export function solidMaterialSourceUrl(source: Pick<StrengthSource, 'url'>): string | null {
  try {
    const url = new URL(source.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? source.url : null;
  } catch { return null; }
}
