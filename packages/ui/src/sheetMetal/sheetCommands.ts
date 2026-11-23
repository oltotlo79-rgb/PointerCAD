/** 板金の入力から文書変更への境界。解析失敗時は変更を作らない。 */
import type { EvaluateOptions } from '@pointercad/expression';
import { appendSolid, replaceSolid, resolvePart, type LengthUnit, type PartDocument, type SheetConvertLookup, type SheetMetalFeature } from '@pointercad/model';
import type { SheetFieldKey } from './sheetFields.js';
import { evaluateSheetDraft } from './sheetDraft.js';
import { partErrorMessage } from '../solid/surfaceBodyFailureText.js';

/**
 * `options.sheetRecognition` は立体を板金へ変える行(M-08)の認識の答え(店の sheetRecognitionLookup)。渡すと、変換した板金を
 * 元にする加工も、確定前の確かめ(純な解決)で元の板金を見つけられる。
 */
export function buildSheetCreation(document: PartDocument, feature: SheetMetalFeature,
  sources: Readonly<Partial<Record<SheetFieldKey, string>>>, lengthUnit: LengthUnit,
  options: EvaluateOptions & { readonly sheetRecognition?: SheetConvertLookup },
  original?: SheetMetalFeature, millimetreSourceKeys: ReadonlySet<SheetFieldKey> = new Set()):
  { readonly ok: true; readonly document: PartDocument; readonly feature: SheetMetalFeature }
  | { readonly ok: false; readonly message: string; readonly field?: SheetFieldKey } {
  if (original !== undefined && (document.solids.find((item) => item.id === original.id) !== original || original.id !== feature.id || original.kind !== feature.kind))
    return { ok: false, message: '編集元の板金が変わりました。選び直してから編集してください。' };
  const evaluated = evaluateSheetDraft(feature, sources, lengthUnit, options, millimetreSourceKeys); if (!evaluated.ok) return evaluated;
  const next = evaluated.feature;
  const candidate = original === undefined ? appendSolid(document, next) : replaceSolid(document, original.id, next);
  const resolved = resolvePart(candidate, options.sheetRecognition === undefined ? {} : { sheetRecognition: options.sheetRecognition });
  const problem = resolved.errors.find((error) => error.featureId === next.id);
  if (problem !== undefined) return { ok: false, message: partErrorMessage(problem) };
  if (!resolved.steps.some((step) => step.featureId === next.id)) return { ok: false, message: '板金の元になる面または縁を選んでください。' };
  return { ok: true, document: candidate, feature: next };
}
