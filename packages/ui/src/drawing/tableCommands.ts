import { createPaperFrame, paperSizeOf, type DrawingDocument, type DrawingTable, type OutlinedText, type Point2 } from '@pointercad/drawing';
import { nextDrawingBalloonId, nextDrawingTableId, resolveDrawingAnnotationTarget } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingTables } from './tableDisplay.js';

export type DrawingTableDraft = Pick<DrawingTable, 'kind' | 'position' | 'columns' | 'rows' | 'options'>;
export function commitDrawingTable(draft: DrawingTableDraft, id?: string,
  outline: (text: string, size: number) => OutlinedText = drawingFont.outline): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  if (draft.kind === 'bom' && document.source.sourceKind !== 'assembly'
    || draft.kind === 'hole' && document.source.sourceKind !== 'part') {
    state.setDrawingMessage(t('drawing.table.selectSource')); return false;
  }
  const existing = id === undefined ? undefined : document.tables.find((table) => table.id === id);
  if (id !== undefined && existing === undefined) return false;
  const paper = paperSizeOf(document.sheet.paperSizeId), layer = document.layers[0];
  if (paper === undefined || layer === undefined) return false;
  const frame = createPaperFrame(paper).inner;
  if (!draft.position.every(Number.isFinite) || draft.position[0] < frame.left || draft.position[0] >= frame.right
    || draft.position[1] > frame.top || draft.position[1] <= frame.bottom
    || Object.entries(draft.options).some(([key, value]) =>
      (key.startsWith('width.') || key === 'rowHeight' || key === 'textHeight')
      && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
    || draft.kind === 'hole' && (!document.views.some((view) => view.id === draft.options.viewId)
      || ['datumX', 'datumY', 'datumZ'].some((key) => draft.options[key] !== undefined
        && (typeof draft.options[key] !== 'number' || !Number.isFinite(draft.options[key]))))) {
    state.setDrawingMessage(t('drawing.table.invalid')); return false;
  }
  const table: DrawingTable = { ...existing, ...draft, id: existing?.id ?? nextDrawingTableId(document), layerId: existing?.layerId ?? layer.id };
  const next = { ...document, tables: existing === undefined ? [...document.tables, table]
    : document.tables.map((item) => item.id === id ? table : item) };
  // 穴表の行は確定後に現在の加工面から非同期で導く。その他は字体込みで紙内に収まるか調べる。
  if (table.kind !== 'hole' && displayDrawingTables(next, state.drawingSourceResolution, outline).unresolved.includes(table.id)) {
    state.setDrawingMessage(t('drawing.table.unresolved')); return false;
  }
  if (existing !== undefined && JSON.stringify(table) === JSON.stringify(existing)) return true;
  state.applyDrawing(next); state.selectDrawingIds([table.id]); return true;
}

export function startDrawingBalloon(): boolean {
  const state = useAppStore.getState();
  if (state.drawing?.source.sourceKind !== 'assembly' || state.drawingBusy) {
    state.setDrawingMessage(t('drawing.table.selectSource')); return false;
  }
  const target = state.drawingTargets.length === 1 ? state.drawingTargets[0] : undefined;
  state.setDrawingTool('balloon');
  // 部品の線を先に選んでから風船を呼んだ場合も、その選択を利用する。
  if (target?.kind === 'subShape' && target.componentId !== undefined) state.setDrawingTargets([target]);
  state.setDrawingMessage(t('drawing.table.selectComponent')); return true;
}

export function commitDrawingBalloon(position: Point2,
  outline: (text: string, size: number) => OutlinedText = drawingFont.outline): boolean {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  const target = state.drawingTargets[0];
  if (document === null || source === null || state.drawingBusy || state.drawingTargets.length !== 1
    || target?.kind !== 'subShape' || target.componentId === undefined) return false;
  const row = source.bomRows?.find((item) => item.componentIds.includes(target.componentId ?? ''));
  const point = resolveDrawingAnnotationTarget(target, document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
  const layer = document.layers[0];
  if (row === undefined || point === null || layer === undefined) return false;
  const id = nextDrawingBalloonId(document);
  const next: DrawingDocument = { ...document, balloons: [...document.balloons, { id, itemNumber: row.number,
    componentIds: [target.componentId], position, leader: [point], sourceTarget: target,
    targetKind: target.ref.fingerprint.kind === 'face' ? 'face' : 'edge', layerId: layer.id }] };
  if (displayDrawingTables(next, source, outline).unresolved.includes(id)) {
    state.setDrawingMessage(t('drawing.table.unresolved')); return false;
  }
  state.applyDrawing(next); state.setDrawingTool('select'); state.selectDrawingIds([id]); return true;
}

export function deleteDrawingTables(): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null) return false;
  const ids = new Set(state.drawingSelectedIds);
  const tables = document.tables.filter((table) => !ids.has(table.id)), balloons = document.balloons.filter((item) => !ids.has(item.id));
  if (tables.length === document.tables.length && balloons.length === document.balloons.length) return false;
  state.applyDrawing({ ...document, tables, balloons }); state.selectDrawingIds([]); return true;
}

export interface DrawingTableDrag { readonly document: DrawingDocument; readonly id: string; readonly start: Point2; readonly position: Point2 }
export function beginDrawingTableDrag(id: string, start: Point2): DrawingTableDrag | null {
  const document = useAppStore.getState().drawing;
  const item = document?.tables.find((table) => table.id === id) ?? document?.balloons.find((item) => item.id === id);
  return document == null || item === undefined ? null : { document, id, start, position: item.position };
}
export function previewDrawingTableDrag(drag: DrawingTableDrag, point: Point2): DrawingDocument {
  const position: Point2 = [drag.position[0] + point[0] - drag.start[0], drag.position[1] + point[1] - drag.start[1]];
  return { ...drag.document, tables: drag.document.tables.map((table) => table.id === drag.id ? { ...table, position } : table),
    balloons: drag.document.balloons.map((item) => item.id === drag.id ? { ...item, position } : item) };
}
export function finishDrawingTableDrag(drag: DrawingTableDrag, point: Point2,
  outline: (text: string, size: number) => OutlinedText = drawingFont.outline): boolean {
  const state = useAppStore.getState();
  if (state.drawing !== drag.document || !point.every(Number.isFinite) || point.every((value, index) => value === drag.start[index])) return false;
  const next = previewDrawingTableDrag(drag, point);
  if (displayDrawingTables(next, state.drawingSourceResolution, outline).unresolved.includes(drag.id)) {
    state.setDrawingMessage(t('drawing.table.unresolved')); return false;
  }
  state.applyDrawing(next); return true;
}
