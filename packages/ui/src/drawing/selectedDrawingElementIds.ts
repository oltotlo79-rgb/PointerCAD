import type { DrawingDocument } from '@pointercad/drawing';

export function selectedDrawingElementIds(document: DrawingDocument, selectedIds: readonly string[]): ReadonlySet<string> {
  const selected = new Set(selectedIds);
  const layers = new Set(document.layers.filter((layer) => selected.has(layer.id)).map((layer) => layer.id));
  if (layers.size === 0) return selected;
  for (const collection of [document.views, document.dimensions, document.annotations, document.tables, document.balloons,
    document.datums, document.gdtFrames, document.weldSymbols]) {
    for (const item of collection) if (layers.has(item.layerId)) selected.add(item.id);
  }
  return selected;
}
