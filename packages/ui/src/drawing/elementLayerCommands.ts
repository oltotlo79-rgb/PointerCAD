import type { DrawingPropertySelection } from './drawingPropertySelection.js';
import { useAppStore } from '../store/useAppStore.js';

export function setDrawingElementLayer(selection: DrawingPropertySelection, layerId: string): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy || !('element' in selection) || selection.kind === 'layer'
    || !document.layers.some((layer) => layer.id === layerId)) return false;
  const { element, kind } = selection;
  if (!state.drawingSelectedIds.includes(element.id)) return false;
  const collections = { view: document.views, dimension: document.dimensions, annotation: document.annotations,
    table: document.tables, balloon: document.balloons, datum: document.datums, gdt: document.gdtFrames, weld: document.weldSymbols };
  // 古いプロパティ欄からの入力を、再選択後の別の要素へ適用しない。
  if (!collections[kind].some((item) => item === element)) return false;
  if (element.layerId === layerId) return true;
  function replace<T extends { readonly id: string; readonly layerId: string }>(items: readonly T[]): readonly T[] {
    return items.map((item) => item.id === element.id ? { ...item, layerId } : item);
  }
  state.applyDrawing({ ...document,
    views: kind === 'view' ? replace(document.views) : document.views,
    dimensions: kind === 'dimension' ? replace(document.dimensions) : document.dimensions,
    annotations: kind === 'annotation' ? replace(document.annotations) : document.annotations,
    tables: kind === 'table' ? replace(document.tables) : document.tables,
    balloons: kind === 'balloon' ? replace(document.balloons) : document.balloons,
    datums: kind === 'datum' ? replace(document.datums) : document.datums,
    gdtFrames: kind === 'gdt' ? replace(document.gdtFrames) : document.gdtFrames,
    weldSymbols: kind === 'weld' ? replace(document.weldSymbols) : document.weldSymbols,
  });
  return true;
}
