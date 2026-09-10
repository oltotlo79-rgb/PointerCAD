import type { DatumDefinition, DrawingDocument, GeometricToleranceFrame, Point2 } from '@pointercad/drawing';
import { nextSerialId } from '../sketch/createSketchDocument.js';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { resolveDrawingGdt, type GdtIssue } from './gdtValidation.js';

export type DrawingGdtEditResult = { readonly ok: true; readonly document: DrawingDocument; readonly id: string }
  | { readonly ok: false; readonly issues: readonly GdtIssue[] };
export function drawingManufacturingIds(document: DrawingDocument): readonly string[] {
  return [...document.datums, ...document.gdtFrames, ...document.weldSymbols].map((item) => item.id);
}
export function nextDatumLabel(document: DrawingDocument): string | null {
  return Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)).find((label) => !document.datums.some((datum) => datum.label === label)) ?? null;
}
export function putDrawingDatum(document: DrawingDocument, candidate: Omit<DatumDefinition, 'id'>, context: DimensionResolveContext,
  expected?: DatumDefinition): DrawingGdtEditResult {
  if (expected !== undefined && document.datums.find((item) => item.id === expected.id) !== expected)
    return { ok: false, issues: [{ code: 'target', message: '編集対象が変わりました。データムを選び直してください。' }] };
  const id = expected?.id ?? nextSerialId(drawingManufacturingIds(document), 'datum-'), datum = { ...candidate, id };
  const next = { ...document, datums: expected === undefined ? [...document.datums, datum] : document.datums.map((item) => item === expected ? datum : item) };
  const result = resolveDrawingGdt(next, context).datums.find((item) => item.datum.id === id);
  if (result === undefined || result.issues.length > 0) return { ok: false, issues: result?.issues ?? [{ code: 'target', message: 'データムを解決できません。' }] };
  return { ok: true, id, document: expected !== undefined && JSON.stringify(expected) === JSON.stringify(datum) ? document : next };
}
export function putDrawingGdtFrame(document: DrawingDocument, candidate: Omit<GeometricToleranceFrame, 'id'>, context: DimensionResolveContext,
  expected?: GeometricToleranceFrame): DrawingGdtEditResult {
  if (expected !== undefined && document.gdtFrames.find((item) => item.id === expected.id) !== expected)
    return { ok: false, issues: [{ code: 'target', message: '編集対象が変わりました。公差枠を選び直してください。' }] };
  const id = expected?.id ?? nextSerialId(drawingManufacturingIds(document), 'gdt-'), frame = { ...candidate, id };
  const next = { ...document, gdtFrames: expected === undefined ? [...document.gdtFrames, frame] : document.gdtFrames.map((item) => item === expected ? frame : item) };
  const result = resolveDrawingGdt(next, context).frames.find((item) => item.frame.id === id);
  if (result === undefined || result.issues.length > 0) return { ok: false, issues: result?.issues ?? [{ code: 'target', message: '公差枠を解決できません。' }] };
  return { ok: true, id, document: expected !== undefined && JSON.stringify(expected) === JSON.stringify(frame) ? document : next };
}
export function moveDrawingManufacturing(document: DrawingDocument, ids: ReadonlySet<string>, offset: Point2): DrawingDocument {
  if (!offset.every(Number.isFinite) || offset.every((value) => value === 0)) return document;
  if ([...document.datums, ...document.gdtFrames, ...document.weldSymbols].some((item) => ids.has(item.id)
    && !item.position.every((value, index) => Number.isFinite(value + offset[index])))) return document;
  let changed = false;
  const move = <T extends { readonly id: string; readonly position: Point2 }>(items: readonly T[]): readonly T[] => items.map((item) => {
    if (!ids.has(item.id)) return item;
    const position: Point2 = [item.position[0] + offset[0], item.position[1] + offset[1]];
    changed = true; return { ...item, position };
  });
  const datums = move(document.datums), gdtFrames = move(document.gdtFrames), weldSymbols = move(document.weldSymbols);
  return changed ? { ...document, datums, gdtFrames, weldSymbols } : document;
}
