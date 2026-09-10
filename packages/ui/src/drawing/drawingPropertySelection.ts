import type { DrawingDocument } from '@pointercad/drawing';

type ElementSelection = { readonly kind: 'view'; readonly element: DrawingDocument['views'][number] }
  | { readonly kind: 'dimension'; readonly element: DrawingDocument['dimensions'][number] }
  | { readonly kind: 'annotation'; readonly element: DrawingDocument['annotations'][number] }
  | { readonly kind: 'datum'; readonly element: DrawingDocument['datums'][number] }
  | { readonly kind: 'gdt'; readonly element: DrawingDocument['gdtFrames'][number] }
  | { readonly kind: 'weld'; readonly element: DrawingDocument['weldSymbols'][number] }
  | { readonly kind: 'balloon'; readonly element: DrawingDocument['balloons'][number] }
  | { readonly kind: 'table'; readonly element: DrawingDocument['tables'][number] }
  | { readonly kind: 'layer'; readonly element: DrawingDocument['layers'][number] };

export type DrawingPropertySelection = ElementSelection | { readonly kind: 'sheet' }
  | { readonly kind: 'multiple'; readonly count: number } | { readonly kind: 'empty' };

/** 対応表示用のcomponent: IDを編集対象として数えない。保存状態は複製しない。 */
export function drawingPropertySelection(document: DrawingDocument | null, selectedIds: readonly string[]): DrawingPropertySelection {
  if (document === null) return { kind: 'empty' };
  const ids = new Set(selectedIds), candidates: ElementSelection[] = [];
  for (const element of document.views) if (ids.has(element.id)) candidates.push({ kind: 'view', element });
  for (const element of document.dimensions) if (ids.has(element.id)) candidates.push({ kind: 'dimension', element });
  for (const element of document.annotations) if (ids.has(element.id)) candidates.push({ kind: 'annotation', element });
  for (const element of document.datums) if (ids.has(element.id)) candidates.push({ kind: 'datum', element });
  for (const element of document.gdtFrames) if (ids.has(element.id)) candidates.push({ kind: 'gdt', element });
  for (const element of document.weldSymbols) if (ids.has(element.id)) candidates.push({ kind: 'weld', element });
  for (const element of document.balloons) if (ids.has(element.id)) candidates.push({ kind: 'balloon', element });
  for (const element of document.tables) if (ids.has(element.id)) candidates.push({ kind: 'table', element });
  for (const element of document.layers) if (ids.has(element.id)) candidates.push({ kind: 'layer', element });
  if (candidates.length === 0) return { kind: 'sheet' };
  if (candidates.length > 1) return { kind: 'multiple', count: candidates.length };
  return candidates[0];
}
