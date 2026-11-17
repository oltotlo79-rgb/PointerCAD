import type { AssemblyDocument } from '../types.js';
import { applyPlacementToDirection, applyPlacementToPoint } from '../placementMath.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { scaleVec3 } from '../../sketch/vec3.js';
import { withinMagnitude } from '../../numericTolerance.js';
import type { EntryBoltedJointRequest, EntryBoltedJointResult, EntryHoleSelection, FasteningExtensionRejection } from './holeEntryTypes.js';
import { entryHeadRejections, entryHeadSpec, fastenerHeadForEntry, type EntryHeadSpec } from './holeEntry.js';
import { isRejection, washerFor, type WasherChoice } from './selectFastener.js';
import { planBoltedJoint, planBoltedJointForHead, threadForSelections } from './planBoltedJoint.js';
import { localSelectionRejections, resolveWorldHole } from './frames.js';
import { placementOnAxis } from './fastenerPlacements.js';
import { FASTENING_LENGTH_TOLERANCE_MM, type BoltedJointPlan, type BoltedJointRejection, type FasteningWasherKind } from './types.js';

function rejected(rejections: readonly BoltedJointRejection[], entryRejections: readonly FasteningExtensionRejection[] = []): EntryBoltedJointResult {
  return { ok: false, rejections, entryRejections };
}

function entryDimensionsValid(selection: EntryHoleSelection): boolean {
  const entry = selection.entry;
  return entry === undefined || (Number.isFinite(entry.diameter) && entry.diameter > 0
    && Number.isFinite(entry.depth) && entry.depth > 0
    && (entry.kind !== 'countersink' || (Number.isFinite(entry.angle) && entry.angle > 0 && entry.angle < 180)));
}

function headWashers(kinds: readonly FasteningWasherKind[], nominal: string): WasherChoice[] | BoltedJointRejection {
  const out: WasherChoice[] = [];
  for (const kind of kinds) {
    const choice = washerFor(kind, nominal);
    if (isRejection(choice)) return choice;
    out.push(choice);
  }
  return out;
}

function withCatalogBolt(document: AssemblyDocument, selection: EntryHoleSelection, joint: BoltedJointPlan,
  head: EntryHeadSpec, washers: readonly WasherChoice[], revisions: ReadonlyMap<string, string>): EntryBoltedJointResult {
  const resolved = resolveWorldHole(document, selection, revisions);
  if ('rejection' in resolved) return rejected([resolved.rejection]);
  const hole = resolved.hole, moved = joint.alignment.movedComponentIds.includes(selection.componentId);
  const origin = moved ? applyPlacementToPoint(joint.alignment.delta, hole.matingPoint) : hole.matingPoint;
  const into = moved ? applyPlacementToDirection(joint.alignment.delta, hole.into) : hole.into;
  const thickness = selection.hole.kind === 'clearance' ? selection.hole.length : NaN;
  const topFromSeat = head.includesHead ? head.seatDepth : head.headHeight;
  const offset = thickness - head.seatDepth + topFromSeat + washers.reduce((sum, washer) => sum + washer.thickness, 0);
  return { ok: true, plan: { joint, headKind: fastenerHeadForEntry(selection.entry),
    ...(selection.entry === undefined ? {} : { entry: selection.entry }), bolt: {
    source: createCatalogItemSource(head.family, head.row, { length: String(joint.boltLength) }),
    placement: placementOnAxis(origin, into, offset, scaleVec3(into, -1)),
  } } };
}

/** Entry-aware counterpart of the unchanged legacy result type. New reasons are returned alongside legacy reasons. */
export function planEntryBoltedJoint(document: AssemblyDocument, request: EntryBoltedJointRequest,
  partRevisions: ReadonlyMap<string, string> = new Map()): EntryBoltedJointResult {
  const local = [request.first, request.second].flatMap(selection => [...localSelectionRejections(selection),
    ...(entryDimensionsValid(selection) ? [] : [{ code: 'invalidDimension' as const,
      detail: { componentId: selection.componentId, name: 'holeEntry' } }])]);
  if (local.length > 0) return rejected(local);
  const head = request.first.hole.kind === 'clearance' ? request.first : request.second;
  const far = head === request.first ? request.second : request.first;
  const wrongSide = [head, far].filter(selection => selection.entry !== undefined
    && (selection === far || selection.entry.side !== 'outer'));
  if (wrongSide.length > 0) return rejected([], wrongSide.map(selection => ({ code: 'entryOnFarSide',
    detail: { componentId: selection.componentId, holeFeatureId: selection.holeFeatureId } })));
  if (head.entry === undefined) {
    const result = planBoltedJoint(document, request, partRevisions);
    return result.ok ? { ok: true, plan: { joint: result.plan, headKind: fastenerHeadForEntry(head.entry) } } : rejected(result.rejections);
  }
  if (head.entry.kind === 'counterbore' && request.explicitBolt === undefined) {
    return rejected([{ code: 'boltSizeUnspecified', detail: { reason: 'counterboreRequiresExplicitNominal' } }]);
  }
  const thread = threadForSelections(request, head, far);
  if (isRejection(thread)) return rejected([thread]);
  const spec = entryHeadSpec(head.entry, thread.nominal, thread.pitch);
  if (isRejection(spec)) return rejected([spec]);
  const washers = headWashers(request.headWashers, thread.nominal);
  if (isRejection(washers)) return rejected([washers]);
  if (head.entry.kind === 'countersink' && washers.length > 0) {
    return rejected([{ code: 'washerDoesNotFit', detail: { componentId: head.componentId, reason: 'countersunkHeadWasher' } }]);
  }
  const fit = entryHeadRejections(head.entry, spec, Math.max(0, ...washers.map(washer => washer.outsideDiameter)),
    washers.reduce((sum, washer) => sum + washer.thickness, 0));
  if (fit.length > 0) return rejected([], fit.map(issue => ({ ...issue,
    detail: { ...issue.detail, componentId: head.componentId, holeFeatureId: head.holeFeatureId } })));
  if (head.entry.kind === 'countersink' && head.hole.kind === 'clearance') {
    const depth = (head.entry.diameter - head.hole.diameter) / (2 * Math.tan(head.entry.angle * Math.PI / 360));
    if (!withinMagnitude(head.entry.depth - depth, FASTENING_LENGTH_TOLERANCE_MM)) {
      return rejected([{ code: 'invalidDimension', detail: { componentId: head.componentId, name: 'countersinkDepth' } }]);
    }
  }
  const result = planBoltedJointForHead(document, request, partRevisions, spec);
  return result.ok ? withCatalogBolt(document, head, result.plan, spec, washers, partRevisions) : rejected(result.rejections);
}
