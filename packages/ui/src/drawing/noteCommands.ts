import { note, paperSizeOf, type Annotation, type DrawingDocument, type Point2 } from '@pointercad/drawing';
import { nextDrawingAnnotationId } from '@pointercad/model';
import { drawingFont } from './drawingFont.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export interface DrawingNoteInput {
  readonly id?: string;
  readonly text: string;
  readonly position: Point2;
  readonly heightMm: number;
  readonly leader?: { readonly target: Point2; readonly end: 'arrow' | 'dot' };
}

/** 注記は用紙上の文字。表面性状や加工記号の編集を通常注記へ誤変換しない。 */
export function saveDrawingNote(input: DrawingNoteInput): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  const existing = input.id === undefined ? undefined : document.annotations.find((item) => item.id === input.id);
  if (input.id !== undefined && (existing === undefined || existing.surfaceFinish !== undefined
    || existing.machiningFeatureId !== undefined || !['note', 'leaderNote'].includes(existing.kind))) return false;
  const paper = paperSizeOf(document.sheet.paperSizeId);
  if (input.text.trim().length === 0 || input.text.length > 10000 || paper === undefined
    || !Number.isFinite(input.heightMm) || input.heightMm <= 0 || input.heightMm > 100) {
    state.setDrawingMessage(t('drawing.error.noteInvalid')); return false;
  }
  const geometry = note({ ...input, measureText: (text, size) => drawingFont.outline(text, size).metrics });
  if (geometry === null) { state.setDrawingMessage(t('drawing.error.fontFailed')); return false; }
  const annotation: Annotation = {
    id: existing?.id ?? nextDrawingAnnotationId(document), kind: input.leader === undefined ? 'note' : 'leaderNote',
    text: input.text.replace(/\r\n?/gu, '\n'), position: input.position, height: input.heightMm,
    layerId: existing?.layerId ?? 'layer-5',
    ...(existing?.style === undefined ? {} : { style: existing.style }),
    ...(input.leader === undefined ? {} : { leader: [input.leader.target], leaderEnd: input.leader.end }),
  };
  state.applyDrawing({ ...document, annotations: existing === undefined ? [...document.annotations, annotation]
    : document.annotations.map((item) => item.id === existing.id ? annotation : item) });
  state.setDrawingTool('select'); state.selectDrawingIds([annotation.id]);
  return true;
}

export interface DrawingAnnotationDrag {
  readonly document: DrawingDocument;
  readonly annotation: Annotation;
  readonly start: Point2;
}

export function beginDrawingAnnotationDrag(id: string, start: Point2): DrawingAnnotationDrag | null {
  const state = useAppStore.getState(), document = state.drawing;
  const annotation = document?.annotations.find((item) => item.id === id);
  if (document == null || annotation === undefined || state.drawingBusy || !start.every(Number.isFinite)) return null;
  return { document, annotation, start };
}

/** 引出線の先は形状に残し、文字の位置だけ移す。履歴の更新はpointerupで1回。 */
export function previewDrawingAnnotationDrag(drag: DrawingAnnotationDrag, current: Point2): Annotation | null {
  if (!current.every(Number.isFinite)) return null;
  return { ...drag.annotation, position: [drag.annotation.position[0] + current[0] - drag.start[0],
    drag.annotation.position[1] + current[1] - drag.start[1]] };
}

export function finishDrawingAnnotationDrag(drag: DrawingAnnotationDrag, current: Point2): boolean {
  const state = useAppStore.getState();
  if (state.drawing !== drag.document || state.drawingBusy || (current[0] === drag.start[0] && current[1] === drag.start[1])) return false;
  const annotation = previewDrawingAnnotationDrag(drag, current);
  if (annotation === null) return false;
  state.applyDrawing({ ...drag.document, annotations: drag.document.annotations.map((item) => item.id === annotation.id ? annotation : item) });
  state.selectDrawingIds([annotation.id]);
  return true;
}
