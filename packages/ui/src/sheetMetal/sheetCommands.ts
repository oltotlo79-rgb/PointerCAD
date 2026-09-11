/** 板金の入力から文書変更への境界。解析失敗時は変更を作らない。 */
import type { EvaluateOptions } from '@pointercad/expression';
import { appendSolid, replaceSolid, resolvePart, type LengthUnit, type PartDocument, type SheetMetalFeature, type SheetBaseFeature, type SheetFlangeFeature, type SheetBendFeature, type SheetReliefFeature } from '@pointercad/model';
import type { SheetFieldKey } from './sheetFields.js';
import { evaluateSheetDraft } from './sheetDraft.js';

export function buildSheetCreation(document: PartDocument, feature: SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature,
  sources: Readonly<Partial<Record<SheetFieldKey, string>>>, lengthUnit: LengthUnit, options: EvaluateOptions, original?: SheetMetalFeature):
  { readonly ok: true; readonly document: PartDocument; readonly feature: SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature }
  | { readonly ok: false; readonly message: string; readonly field?: SheetFieldKey } {
  if (original !== undefined && (document.solids.find((item) => item.id === original.id) !== original || original.id !== feature.id || original.kind !== feature.kind))
    return { ok: false, message: '編集元の板金が変わりました。選び直してから編集してください。' };
  const evaluated = evaluateSheetDraft(feature, sources, lengthUnit, options); if (!evaluated.ok) return evaluated;
  const next = evaluated.feature;
  const candidate = original === undefined ? appendSolid(document, next) : replaceSolid(document, original.id, next);
  const resolved = resolvePart(candidate);
  const problem = resolved.errors.find((error) => error.featureId === next.id);
  if (problem !== undefined) return { ok: false, message: problem.message };
  if (!resolved.steps.some((step) => step.featureId === next.id)) return { ok: false, message: '板金の元になる面または縁を選んでください。' };
  return { ok: true, document: candidate, feature: next };
}
