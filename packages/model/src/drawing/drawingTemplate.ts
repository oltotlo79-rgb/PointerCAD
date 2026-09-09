import { paperSizeOf, type DrawingDocument, type DrawingLayer, type DrawingSheet, type DrawingSource } from '@pointercad/drawing';
import { createDrawingDocument } from './createDrawingDocument.js';

/** 図や参照モデルを含めず、次の図面で使い回す用紙の設定だけを持つ(FR-725)。 */
export interface DrawingTemplate {
  readonly name: string;
  readonly sheet: DrawingSheet;
  readonly layers: readonly DrawingLayer[];
}
export type DrawingTemplateResult =
  | { readonly ok: true; readonly template: DrawingTemplate }
  | { readonly ok: false; readonly reason: 'emptyName' | 'invalidPaper' | 'invalidScale' | 'invalidTextHeight' | 'invalidFields' | 'invalidLayers' };

export function validateDrawingTemplate(template: DrawingTemplate): DrawingTemplateResult {
  if (template.name.trim().length === 0) return { ok: false, reason: 'emptyName' };
  const paper = paperSizeOf(template.sheet.paperSizeId);
  if (paper === undefined || paper.orientation !== template.sheet.orientation) return { ok: false, reason: 'invalidPaper' };
  const scales = template.sheet.scaleOptions ?? [template.sheet.scale];
  if (!Number.isFinite(template.sheet.scale) || template.sheet.scale <= 0 || scales.length === 0
    || !scales.every((scale) => Number.isFinite(scale) && scale > 0)
    || new Set(scales).size !== scales.length) return { ok: false, reason: 'invalidScale' };
  if (template.sheet.textHeight !== undefined && (!Number.isFinite(template.sheet.textHeight) || template.sheet.textHeight <= 0)) {
    return { ok: false, reason: 'invalidTextHeight' };
  }
  const fields = template.sheet.titleBlockFields;
  if (fields !== undefined && (fields.length === 0 || new Set(fields.map((field) => field.key)).size !== fields.length
    || fields.some((field) => field.key.trim().length === 0 || field.label.trim().length === 0
      || (field.widthWeight !== undefined && (!Number.isFinite(field.widthWeight) || field.widthWeight <= 0))))) {
    return { ok: false, reason: 'invalidFields' };
  }
  if (template.layers.length === 0 || new Set(template.layers.map((layer) => layer.id)).size !== template.layers.length
    || template.layers.some((layer) => layer.id.trim().length === 0 || layer.name.trim().length === 0
      || !Number.isFinite(layer.lineWidth) || layer.lineWidth <= 0)) return { ok: false, reason: 'invalidLayers' };
  return { ok: true, template };
}

/** 明示した3項目だけをコピーし、投影図・注記・寸法・表・風船・元モデルを引き継がない。 */
export function createDrawingTemplate(document: DrawingDocument, name: string): DrawingTemplateResult {
  const template: DrawingTemplate = { name: name.trim(), sheet: structuredClone(document.sheet),
    layers: structuredClone(document.layers) };
  return validateDrawingTemplate(template);
}

export function drawingFromTemplate(
  template: DrawingTemplate, name: string, source: DrawingSource,
): { readonly ok: true; readonly document: DrawingDocument } | Extract<DrawingTemplateResult, { readonly ok: false }> {
  const checked = validateDrawingTemplate(template);
  if (!checked.ok) return checked;
  const base = createDrawingDocument(name, source);
  return { ok: true, document: { ...base, sheet: structuredClone(template.sheet), layers: structuredClone(template.layers) } };
}
