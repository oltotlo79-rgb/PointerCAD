import { createDrawingTemplate, evaluateDrawingSheetExpression, validateDrawingTemplate } from '@pointercad/model';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { readDrawingTemplateFile, writeDrawingTemplateFile } from '@pointercad/io';
import type { DrawingSheet } from '@pointercad/drawing';
import { openFileThrough, saveFileAsThrough } from '../file/fileGateway.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { createDrawingFromCurrentPart } from './createDrawingCommands.js';

export interface DrawingSheetDraft {
  readonly scale: string;
  readonly scaleOptions: string;
  readonly textHeight: string;
  readonly fields: NonNullable<DrawingSheet['titleBlockFields']>;
}

export interface DrawingSheetDraftErrors {
  readonly scale?: string;
  readonly scaleOptions?: string;
  readonly textHeight?: string;
  readonly fields: readonly { readonly label?: string; readonly width?: string }[];
}

/** 関数の引数のカンマは候補の区切りにしない(root(8, 3)等)。 */
function scaleSources(source: string): readonly string[] {
  const values: string[] = [];
  let start = 0, depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth = Math.max(0, depth - 1);
    else if (source[index] === ',' && depth === 0) { values.push(source.slice(start, index).trim()); start = index + 1; }
  }
  values.push(source.slice(start).trim());
  return values;
}

/** 表示単位に依らず紙面のmmと無次元の倍率を評価する。エラー時には部分適用しない。 */
export function parseDrawingSheetDraft(sheet: DrawingSheet, draft: DrawingSheetDraft):
  | { readonly ok: true; readonly sheet: DrawingSheet }
  | { readonly ok: false; readonly errors: DrawingSheetDraftErrors } {
  const evaluate = (source: string, quantity: 'length' | 'ratio'): { value: number; error?: string } => {
    const result = evaluateDrawingSheetExpression(source, quantity);
    if (result.ok) return { value: result.value.value };
    return { value: 0, error: result.reason === 'expression' ? result.message
      : t(result.reason === 'positive' ? 'drawing.sheet.positive' : 'drawing.sheet.unitless') };
  };
  const scale = evaluate(draft.scale, 'ratio'), height = evaluate(draft.textHeight, 'length');
  const sources = scaleSources(draft.scaleOptions), values = sources.map((source) => evaluate(source, 'ratio'));
  const invalidOption = values.findIndex((value) => value.error !== undefined);
  const optionError = invalidOption >= 0 ? t('drawing.sheet.candidateError')
    .replace('{index}', String(invalidOption + 1)).replace('{reason}', values[invalidOption].error ?? '')
    : new Set(values.map((value) => value.value)).size !== values.length ? t('drawing.sheet.duplicateScales') : undefined;
  const widths = draft.fields.map((field) => evaluate(field.widthExpression ?? exactExpressionValueFromNumber(field.widthWeight ?? 1).source, 'ratio'));
  const fieldErrors = draft.fields.map((field, index) => ({
    ...(field.label.trim() === '' ? { label: t('drawing.sheet.emptyFieldLabel') } : {}),
    ...(widths[index].error === undefined ? {} : { width: widths[index].error }),
  }));
  if (scale.error !== undefined || height.error !== undefined || optionError !== undefined
    || fieldErrors.some((field) => field.label !== undefined || field.width !== undefined)) {
    return { ok: false, errors: { scale: scale.error, textHeight: height.error, scaleOptions: optionError, fields: fieldErrors } };
  }
  return { ok: true, sheet: { ...sheet, scale: scale.value, scaleExpression: draft.scale,
    scaleOptions: values.map((value) => value.value), scaleOptionExpressions: sources,
    textHeight: height.value, textHeightExpression: draft.textHeight,
    titleBlockFields: draft.fields.map(({ fixedText, ...field }, index) => ({ ...field,
      widthWeight: widths[index].value,
      widthExpression: field.widthExpression ?? exactExpressionValueFromNumber(field.widthWeight ?? 1).source,
      ...(fixedText === undefined || fixedText === '' ? {} : { fixedText }),
    })),
  } };
}

export function commitDrawingSheet(sheet: DrawingSheet): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  const checked = validateDrawingTemplate({ name: document.name, sheet, layers: document.layers });
  if (!checked.ok) { state.setDrawingMessage(t('drawing.template.invalid')); return false; }
  if (JSON.stringify(document.sheet) === JSON.stringify(sheet)) return true;
  state.applyDrawing({ ...document, sheet }); return true;
}

export async function saveCurrentDrawingTemplate(name: string): Promise<boolean> {
  const state = useAppStore.getState(), document = state.drawing;
  // ひな形は設定だけなので投影計算を待たずに保存できる。
  if (document === null) return false;
  const created = createDrawingTemplate(document, name);
  if (!created.ok) { state.setDrawingMessage(t('drawing.template.invalid')); return false; }
  const stillCurrent = (): boolean => useAppStore.getState().drawing === document;
  try {
    const bytes = writeDrawingTemplateFile(created.template, new Date().toISOString());
    const safeName = Array.from(created.template.name, (character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/u.test(character) ? '_' : character).join('');
    const saved = await saveFileAsThrough(state.fileGateway, `${safeName}.pcadt`, 'pcadt', bytes);
    if (stillCurrent()) state.setDrawingMessage(t(saved ? 'drawing.template.saved' : 'drawing.template.cancelled'));
    return saved;
  } catch {
    if (stillCurrent()) state.setDrawingMessage(t('drawing.template.saveFailed'));
    return false;
  }
}

export async function createDrawingFromTemplateFile(): Promise<boolean> {
  const state = useAppStore.getState();
  if (state.drawing !== null || state.isComputing) return false;
  const stillCurrent = (): boolean => {
    const current = useAppStore.getState();
    return current.document === state.document && current.assembly === state.assembly && current.drawing === null
      && current.assemblyLibrary === state.assemblyLibrary && current.activeDocumentId === state.activeDocumentId;
  };
  try {
    const picked = await openFileThrough(state.fileGateway, ['pcadt']);
    if (picked === null || !stillCurrent()) return false;
    const result = readDrawingTemplateFile(picked.bytes);
    if (!result.ok) {
      useAppStore.setState({ fileMessage: { key: 'drawing.template.invalidFile', failed: true } }); return false;
    }
    return await createDrawingFromCurrentPart(result.template);
  } catch {
    if (stillCurrent()) useAppStore.setState({ fileMessage: { key: 'drawing.template.invalidFile', failed: true } });
    return false;
  }
}
