import type { DatumReference, DrawingDocument, Point2 } from '@pointercad/drawing';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { nextDatumLabel, putDrawingDatum, putDrawingGdtFrame } from './gdtEdit.js';
import type { GdtIssue } from './gdtValidation.js';

export type DrawingGdtCopyResult = { readonly ok: true; readonly document: DrawingDocument; readonly ids: readonly string[] }
  | { readonly ok: false; readonly issues: readonly GdtIssue[] };

/** 複製は全対象の検証が済んだ文書だけを返す。同時に複製する基準への参照も付け替える。 */
export function duplicateDrawingGdt(document: DrawingDocument, ids: ReadonlySet<string>, offset: Point2,
  context: DimensionResolveContext): DrawingGdtCopyResult {
  if (!offset.every(Number.isFinite)) return { ok: false, issues: [{ code: 'placement', message: '複製先の位置を有限の長さで指定してください。' }] };
  const datums = document.datums.filter((item) => ids.has(item.id)), frames = document.gdtFrames.filter((item) => ids.has(item.id));
  if (datums.length + frames.length === 0) return { ok: true, document, ids: [] };
  const position = (point: Point2): Point2 => [point[0] + offset[0], point[1] + offset[1]];
  let next = document;
  const copied: string[] = [], datumIds = new Map<string, string>();
  for (const datum of datums) {
    const label = nextDatumLabel(next);
    if (label === null) return { ok: false, issues: [{ code: 'label', message: 'データム名A〜Zをすべて使用しています。不要なデータムを整理してください。' }] };
    const result = putDrawingDatum(next, { ...datum, label, position: position(datum.position) }, context);
    if (!result.ok) return result;
    next = result.document; copied.push(result.id); datumIds.set(datum.id, result.id);
  }
  const member = (value: { readonly datumId: string; readonly material: 'none' | 'maximum' }) => ({ ...value, datumId: datumIds.get(value.datumId) ?? value.datumId });
  const reference = (value: DatumReference): DatumReference => value.kind === 'single' ? { kind: 'single', member: member(value.member) }
    : { kind: 'common', members: [member(value.members[0]), member(value.members[1])] };
  for (const frame of frames) {
    const result = putDrawingGdtFrame(next, { ...frame, position: position(frame.position),
      segments: frame.segments.map((segment) => ({ ...segment, datums: segment.datums.map(reference) })) }, context);
    if (!result.ok) return result;
    next = result.document; copied.push(result.id);
  }
  return { ok: true, document: next, ids: copied };
}
