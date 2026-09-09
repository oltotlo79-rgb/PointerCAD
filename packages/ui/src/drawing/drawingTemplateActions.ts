import { createDrawingTemplate, validateDrawingTemplate } from '@pointercad/model';
import { readDrawingTemplateFile, writeDrawingTemplateFile } from '@pointercad/io';
import type { DrawingSheet } from '@pointercad/drawing';
import { openFileThrough, saveFileAsThrough } from '../file/fileGateway.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { createDrawingFromCurrentPart } from './createDrawingCommands.js';

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
