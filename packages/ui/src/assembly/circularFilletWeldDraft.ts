/** Circular weld authoring state only. A saved snapshot never certifies current contact. */
import { evaluateExpression, exactExpressionValueFromNumber } from '@pointercad/expression';
import {
  applyCircularFilletWeld, planCircularFilletWeld, readCircularFilletWeldSource, resolveCircularWeldSelection,
  resolveJointOccurrence, resolveSubShapeReference, segmentsFromLengthsAndGaps,
  type ApplyCircularFilletWeldResult, type AssemblyDocument, type CircularFilletWeldFailure, type CircularFilletWeldPlan, type CircularFilletWeldRequest,
  type CircularWeldPathEvidence, type JointOccurrenceCommandContext, type StandardPartSource, type SubShapeRef,
} from '@pointercad/model';

export interface CircularDraftPick { readonly path: readonly string[]; readonly reference: SubShapeRef }
export interface CircularFilletWeldDraft {
  readonly documentId: string; readonly sourceDocument: AssemblyDocument; readonly documentStamp: string;
  readonly operation: 'create' | 'replace'; readonly weldId: string; readonly draftEpoch: string;
  readonly picks: readonly CircularDraftPick[]; readonly mode: 'continuous' | 'intermittent';
  readonly start: string; readonly lengths: string; readonly gaps: string; readonly radialLeg: string; readonly normalLeg: string;
  readonly radialDirection: 1 | -1 | null; readonly normalDirection: 1 | -1 | null; readonly materialId: string;
  readonly beadIds: readonly string[]; readonly savedSources: readonly StandardPartSource[];
}
export type CircularDraftFields = Partial<Pick<CircularFilletWeldDraft, 'mode' | 'start' | 'lengths' | 'gaps' | 'radialLeg'
  | 'normalLeg' | 'radialDirection' | 'normalDirection' | 'materialId'>>;
 type CircularDraftIssue = 'stale' | 'picks' | 'dimension' | 'segments' | 'material' | 'preview-changed';
export type CircularDraftPreview = { readonly ok: true; readonly draft: CircularFilletWeldDraft; readonly context: JointOccurrenceCommandContext;
  readonly request: CircularFilletWeldRequest; readonly plan: CircularFilletWeldPlan }
  | { readonly ok: false; readonly reason: CircularDraftIssue | CircularFilletWeldFailure };

const text = (value: number): string => exactExpressionValueFromNumber(value).source;
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
function owned<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(owned); Object.freeze(value); }
  return value;
}
function freezeDraft(value: CircularFilletWeldDraft): CircularFilletWeldDraft {
  owned(value.picks); owned(value.beadIds); owned(value.savedSources);
  return Object.freeze(value);
}
function number(source: string): number | null {
  if (!source.trim()) return null;
  const value = evaluateExpression(source);
  return value.ok && Number.isFinite(value.value.value) ? value.value.value : null;
}
function numbers(source: string): readonly number[] | null {
  if (!source.trim()) return [];
  const rows = source.split(/[,、]/u).map(number);
  return rows.every((v): v is number => v !== null) ? rows : null;
}
export function createCircularFilletWeldDraft(document: AssemblyDocument, weldId: string, draftGeneration: string): CircularFilletWeldDraft {
  return freezeDraft({ documentId: document.id, sourceDocument: document, documentStamp: JSON.stringify(document),
    operation: 'create', weldId, draftEpoch: draftGeneration, picks: [], mode: 'continuous', start: '0', lengths: '', gaps: '',
    radialLeg: '', normalLeg: '', radialDirection: null, normalDirection: null, materialId: '', beadIds: [], savedSources: [] });
}
/** Only an actual change consumes a fresh caller-issued epoch. */
export function editCircularFilletWeldDraft(draft: CircularFilletWeldDraft, fields: CircularDraftFields, nextGeneration: string): CircularFilletWeldDraft | null {
  const next = { ...draft, ...fields };
  if (Object.entries(fields).every(([key, value]) => Reflect.get(draft, key) === value)) return draft;
  if (!nextGeneration.trim() || nextGeneration === draft.draftEpoch) return null;
  return freezeDraft({ ...next, draftEpoch: nextGeneration });
}
export function circularFilletWeldPickKind(draft: CircularFilletWeldDraft): 'plane' | 'edge' | 'cylinder' | null {
  return (['plane', 'edge', 'cylinder'] as const)[draft.picks.length] ?? null;
}
export function appendCircularFilletWeldPick(draft: CircularFilletWeldDraft, pick: CircularDraftPick, nextGeneration: string): CircularFilletWeldDraft | null {
  const kind = circularFilletWeldPickKind(draft), f = pick.reference.fingerprint;
  if (kind === null || !pick.path.length || !nextGeneration.trim() || nextGeneration === draft.draftEpoch
    || (kind === 'edge' ? f.kind !== 'edge' || f.curveKind !== 'circle' : f.kind !== 'face' || f.surfaceKind !== kind)) return null;
  if (kind === 'cylinder' && draft.picks[0] !== undefined && same(draft.picks[0].path, pick.path)) return null;
  return freezeDraft({ ...draft, picks: [...draft.picks, structuredClone(pick)], draftEpoch: nextGeneration });
}

/** Restores all original beads and provenance for editing; picks are deliberately empty. */
export function restoreCircularFilletWeldDraft(document: AssemblyDocument, weldId: string, draftGeneration: string): CircularFilletWeldDraft | null {
  if (document.components.some(component => component.source.kind === 'standardPart'
    && component.source.options.weldCircular !== undefined && readCircularFilletWeldSource(component.source) === null)) return null;
  const rows = document.components.flatMap(component => {
    if (component.source.kind !== 'standardPart' || component.source.options.weldCircular === undefined) return [];
    const saved = readCircularFilletWeldSource(component.source);
    return saved?.options.weldId === weldId ? [{ component, saved, source: structuredClone(component.source) }] : [];
  });
  const first = rows[0];
  if (!first || !draftGeneration.trim()) return null;
  const path = first.saved.options.path, intervals = path.intervals, e = path.evidence;
  if (rows.length !== intervals.length || rows.length > 64 || new Set(rows.map(r => r.saved.options.beadId)).size !== rows.length
    || rows.some(r => JSON.stringify(r.saved.options.path) !== JSON.stringify(path)
      || JSON.stringify(r.saved.options.parents) !== JSON.stringify(first.saved.options.parents)
      || JSON.stringify(r.saved.section) !== JSON.stringify({ ...first.saved.section, beadId: r.saved.section.beadId })
      || r.component.materialId !== first.component.materialId)) return null;
  const ordered = intervals.map(i => rows.find(r => r.saved.options.beadId === i.beadId));
  if (ordered.some(r => r === undefined)) return null;
  const base = e.orientation === 1 ? e.parameterRange[0] : e.parameterRange[1];
  const start = e.orientation * (intervals[0].fromParameter - base) * e.radiusMm;
  const lengths = intervals.map(i => e.orientation * (i.toParameter - i.fromParameter) * e.radiusMm);
  const gaps = intervals.slice(1).map((i, index) => e.orientation * (i.fromParameter - intervals[index].toParameter) * e.radiusMm);
  return freezeDraft({ ...createCircularFilletWeldDraft(document, weldId, draftGeneration), operation: 'replace',
    mode: intervals.length === 1 ? 'continuous' : 'intermittent', start: text(start), lengths: lengths.map(text).join(', '),
    gaps: gaps.map(text).join(', '), radialLeg: text(first.saved.section.radialLegMm), normalLeg: text(first.saved.section.normalLegMm),
    radialDirection: first.saved.section.radialDirection, normalDirection: first.saved.section.normalDirection,
    materialId: first.component.materialId ?? '', beadIds: intervals.map(i => i.beadId), savedSources: rows.map(r => r.source) });
}

/** Millimetres measured from the actual traversal start are mapped without rounding. */
export function circularDraftIntervals(draft: CircularFilletWeldDraft, evidence: CircularWeldPathEvidence): CircularFilletWeldRequest['intervals'] | null {
  const [lo, hi] = evidence.parameterRange, radius = evidence.radiusMm, sign = evidence.orientation;
  const total = (hi - lo) * radius, start = number(draft.start);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(radius) || radius <= 0 || start === null || start < 0 || start >= total) return null;
  const lengths = draft.mode === 'continuous' && !draft.lengths.trim() ? [total - start] : numbers(draft.lengths);
  const gaps = numbers(draft.gaps);
  if (lengths === null || gaps === null || lengths.length < 1 || lengths.length > 64
    || (draft.mode === 'continuous' && (lengths.length !== 1 || gaps.length !== 0))
    || lengths.some(v => v <= 0) || gaps.some(v => v < 0) || gaps.length !== lengths.length - 1) return null;
  const segments = segmentsFromLengthsAndGaps(start, lengths, gaps);
  if (segments === null || segments.some(s => s.start < 0 || s.length <= 0 || s.start + s.length > total)) return null;
  const base = sign === 1 ? lo : hi;
  const at = (v: number): number => v === 0 ? base : v === total ? (sign === 1 ? hi : lo) : base + sign * v / radius;
  const ids = segments.map((_, i) => draft.beadIds[i] ?? `${draft.weldId}:bead:${String(i + 1)}`);
  if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) return null;
  return segments.map((s, i) => ({ beadId: ids[i], fromParameter: at(s.start), toParameter: at(s.start + s.length) }));
}

function currentFace(context: JointOccurrenceCommandContext, pick: CircularDraftPick, surface: 'plane' | 'cylinder') {
  const resolved = resolveJointOccurrence(context.inputs, pick.path, context.view);
  if (!resolved.ok) return null;
  const o = resolved.occurrence, bodies = context.bodiesOf(o)?.filter(b => b.featureId === pick.reference.bodyFeatureId);
  if (bodies?.length !== 1 || !bodies[0].isValid || bodies[0].bodyKind !== 'solid') return null;
  const steps = o.resolvedPart.steps.filter(s => s.featureId === bodies[0].featureId && s.visible && o.resolvedPart.liveBodyIds.includes(s.featureId));
  const found = resolveSubShapeReference(bodies[0], pick.reference);
  if (steps.length !== 1 || !steps[0].key.trim() || found.status !== 'matched' || found.match.geometry.kind !== 'face'
    || found.match.geometry.surfaceKind !== surface) return null;
  return { path: [...pick.path], reference: structuredClone(found.match.reference), sourceKey: o.sourceKey, bodyKey: steps[0].key,
    placementKey: JSON.stringify([o.worldPlacement.position, o.worldPlacement.rotation]) };
}
export function previewCircularFilletWeldDraft(context: JointOccurrenceCommandContext, draft: CircularFilletWeldDraft): CircularDraftPreview {
  if (context.inputs.document !== draft.sourceDocument || context.inputs.document.id !== draft.documentId
    || JSON.stringify(context.inputs.document) !== draft.documentStamp
    || context.view.source !== context.inputs) return { ok: false, reason: 'stale' };
  const [planePick, edge, cylinderPick] = draft.picks;
  if (!planePick || !edge || !cylinderPick || draft.picks.length !== 3 || same(planePick.path, cylinderPick.path)) return { ok: false, reason: 'picks' };
  const plane = currentFace(context, planePick, 'plane'), cylinder = currentFace(context, cylinderPick, 'cylinder');
  const evidence = resolveCircularWeldSelection(context, edge.path, edge.reference);
  if (plane === null || cylinder === null || evidence === null) return { ok: false, reason: 'stale' };
  const radialLegMm = number(draft.radialLeg), normalLegMm = number(draft.normalLeg);
  if (radialLegMm === null || normalLegMm === null || radialLegMm <= 0 || normalLegMm <= 0
    || draft.radialDirection === null || draft.normalDirection === null
    || (draft.radialDirection === -1 && radialLegMm >= evidence.radiusMm)) return { ok: false, reason: 'dimension' };
  if (!draft.materialId.trim()) return { ok: false, reason: 'material' };
  const intervals = circularDraftIntervals(draft, evidence);
  if (intervals === null) return { ok: false, reason: 'segments' };
  const request: CircularFilletWeldRequest = owned({ operation: draft.operation, weldId: draft.weldId, draftEpoch: draft.draftEpoch,
    plane, edge: structuredClone(edge), cylinder, intervals,
    section: { radialLegMm, normalLegMm, radialDirection: draft.radialDirection, normalDirection: draft.normalDirection }, materialId: draft.materialId });
  const result = planCircularFilletWeld(context, request);
  return result.ok ? { ok: true, draft, context, request, plan: result.plan } : result;
}
export function commitCircularFilletWeldDraft(context: JointOccurrenceCommandContext, draft: CircularFilletWeldDraft,
  preview: Extract<CircularDraftPreview, { readonly ok: true }>): ApplyCircularFilletWeldResult | { readonly ok: false; readonly document: AssemblyDocument; readonly reason: CircularDraftIssue } {
  if (preview.draft !== draft || preview.context !== context || context.inputs.document !== draft.sourceDocument
    || context.inputs.document.id !== draft.documentId || JSON.stringify(context.inputs.document) !== draft.documentStamp
    || context.view.source !== context.inputs) return { ok: false, document: context.inputs.document, reason: 'preview-changed' };
  return applyCircularFilletWeld(context, preview.request, preview.plan);
}
