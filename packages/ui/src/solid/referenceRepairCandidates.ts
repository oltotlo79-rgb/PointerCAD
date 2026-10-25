import { canonicalDrawingSourceText, resolveSubShapeReference, type SolidBody, type SubShapeRef,
  type SubShapeReferenceResolution } from '@pointercad/model';
import { subShapeElementId, subShapeRefOf } from './subShapeSelection.js';
import type { CurrentRepairSlot } from './referenceRepairContext.js';
import type { RepairRequirement } from './referenceRepairGeometry.js';

export interface RepairCandidate {
  readonly body: SolidBody;
  readonly reference: SubShapeRef;
  readonly selectable: boolean;
}

export function sameRepairReference(first: SubShapeRef, second: SubShapeRef): boolean {
  return canonicalDrawingSourceText(first) === canonicalDrawingSourceText(second);
}

export function repairResolution(slot: CurrentRepairSlot): SubShapeReferenceResolution {
  const bodies = slot.bodies.filter(body => body.featureId === slot.reference.bodyFeatureId && body.isValid);
  if (bodies.length !== 1) return { originalReference: slot.reference, status: bodies.length > 1 ? 'ambiguous' : 'missing', candidates: [] };
  return resolveSubShapeReference(bodies[0], slot.reference);
}

function accepts(reference: SubShapeRef, requirement: RepairRequirement): boolean {
  const fp = reference.fingerprint;
  if (!fp.position.every(Number.isFinite)) return false;
  if (fp.kind !== 'vertex') {
    const measure = fp.kind === 'face' ? fp.area : fp.length;
    if (!Number.isFinite(measure) || measure <= 0 || fp.radius !== null && (!Number.isFinite(fp.radius) || fp.radius <= 0)) return false;
    if (fp.axis !== null && (!fp.axis.every(Number.isFinite) || Math.hypot(...fp.axis) === 0)) return false;
  }
  switch (requirement) {
    case 'same-kind': return true;
    case 'plane': return fp.kind === 'face' && fp.surfaceKind === 'plane' && fp.axis !== null;
    case 'cylinder': return fp.kind === 'face' && fp.surfaceKind === 'cylinder' && fp.axis !== null;
    case 'line': return fp.kind === 'edge' && fp.curveKind === 'line' && fp.axis !== null;
    case 'circle': return fp.kind === 'edge' && fp.curveKind === 'circle' && fp.axis !== null && fp.radius !== null;
    case 'sphere': return fp.kind === 'face' && fp.surfaceKind === 'sphere' && fp.radius !== null;
  }
}

/** Enumerate current shapes for explicit selection, then require the shared resolver to prove each saved choice. */
export function repairCandidates(slot: CurrentRepairSlot): readonly RepairCandidate[] {
  const bodies = slot.bodies.filter(body => body.featureId === slot.reference.bodyFeatureId && body.isValid);
  if (bodies.length !== 1) return [];
  const body = bodies[0], kind = slot.reference.fingerprint.kind;
  const entries = kind === 'face' ? body.faces : kind === 'edge' ? body.edges : body.vertices;
  const resolution = repairResolution(slot);
  const preferred = new Set(resolution.candidates.map(candidate => candidate.reference.index));
  return entries.flatMap(entry => {
    if (entries.filter(other => other.index === entry.index).length !== 1) return [];
    // Drawing measurements require the native analytic center, not the fingerprint's centroid.
    if ((slot.requirement === 'circle' || slot.requirement === 'sphere')
      && (!('axisOrigin' in entry) || entry.axisOrigin === undefined || entry.axisOrigin === null
        || !entry.axisOrigin.every(Number.isFinite))) return [];
    const current = subShapeRefOf([body], subShapeElementId(body.featureId, kind, entry.index));
    // Split/merged origins may be displayed, but never silently downgraded to an index-only reference.
    const ref = current ?? resolution.candidates.find(candidate => candidate.reference.index === entry.index)?.reference;
    if (ref === undefined || !accepts(ref, slot.requirement)) return [];
    const check = current === null ? null : resolveSubShapeReference(body, current);
    return [{ body, reference: ref, selectable: check?.status === 'matched' && check.match.reference.index === entry.index }];
  }).sort((a, b) => Number(preferred.has(b.reference.index)) - Number(preferred.has(a.reference.index))
    || a.reference.index - b.reference.index);
}
