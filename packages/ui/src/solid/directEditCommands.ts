/** Direct editing uses model constructors and the existing staged document commit. */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendSolid, createFaceRotateFeature, createHoleTranslateFeature, liveBodyIds,
  nextSolidId, nextSolidName, type SubShapeRef,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';
import type { MachiningContext } from './machiningCommands.js';
import type { SolidCommandOutcome } from './solidCommands.js';
import { parseSubShapeId, subShapeRefOf } from './subShapeSelection.js';

export type DirectEditToolId = 'holeTranslate' | 'faceRotate';
export const DEFAULT_HOLE_TRANSLATION_MM = 1;
export const DEFAULT_FACE_ROTATION_DEGREES = 5;

type Materials =
  | { readonly ok: false; readonly reasonKey: MessageKey }
  | { readonly ok: true; readonly face: SubShapeRef; readonly hinge: SubShapeRef | null };

function materials(context: MachiningContext, tool: DirectEditToolId): Materials {
  const ids = [...new Set(context.selection)];
  const refs = ids.map(id => subShapeRefOf(context.bodies, id));
  const faces = refs.filter(ref => ref?.fingerprint.kind === 'face');
  const edges = refs.filter(ref => ref?.fingerprint.kind === 'edge');
  const face = faces[0];
  if (ids.length !== (tool === 'holeTranslate' ? 1 : 2) || faces.length !== 1 || face === null || face === undefined
    || (tool === 'faceRotate' && edges.length !== 1)) {
    return { ok: false, reasonKey: tool === 'holeTranslate' ? 'directEditError.oneCylinder' : 'directEditError.faceAndEdge' };
  }
  if (!liveBodyIds(context.document).includes(face.bodyFeatureId)) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  if (face.fingerprint.kind !== 'face' || face.fingerprint.surfaceKind !== (tool === 'holeTranslate' ? 'cylinder' : 'plane')) {
    return { ok: false, reasonKey: tool === 'holeTranslate' ? 'directEditError.oneCylinder' : 'shapeError.noFlatFace' };
  }
  if (tool === 'holeTranslate') return { ok: true, face, hinge: null };
  const hinge = edges[0];
  if (hinge === null || hinge === undefined) return { ok: false, reasonKey: 'directEditError.faceAndEdge' };
  if (hinge.bodyFeatureId !== face.bodyFeatureId) return { ok: false, reasonKey: 'directEditError.sameBody' };
  if (hinge.fingerprint.kind !== 'edge' || hinge.fingerprint.curveKind !== 'line') {
    return { ok: false, reasonKey: 'directEditError.straightHinge' };
  }
  // Early geometric rejection only. The model/worker verifies actual topological membership.
  const body = context.bodies.find(item => item.featureId === face.bodyFeatureId);
  const edgeId = ids.map(parseSubShapeId).find(item => item?.kind === 'edge');
  const edge = body?.edges.find(item => item.index === edgeId?.index);
  const plane = body?.faces.find(item => item.index === face.index);
  if (edge === undefined || plane?.axis === null || plane === undefined) {
    return { ok: false, reasonKey: 'directEditError.hingeOnFace' };
  }
  const normal = plane.axis;
  if ([edge.start, edge.end].some(point => Math.abs(
    (point[0] - plane.centroid[0]) * normal[0] + (point[1] - plane.centroid[1]) * normal[1]
    + (point[2] - plane.centroid[2]) * normal[2],
  ) > 1e-6)) return { ok: false, reasonKey: 'directEditError.hingeOnFace' };
  return { ok: true, face, hinge };
}

export function directEditRejection(context: MachiningContext, tool: DirectEditToolId): MessageKey | null {
  const selected = materials(context, tool);
  return selected.ok ? null : selected.reasonKey;
}

export function commitDirectEdit(context: MachiningContext, commit: SolidInputCommit, tool: DirectEditToolId): SolidCommandOutcome {
  const selected = materials(context, tool);
  if (!selected.ok) return selected;
  const id = nextSolidId(context.document, tool);
  const common = { id, name: nextSolidName(context.document, tool), targetFeatureId: selected.face.bodyFeatureId, face: selected.face };
  if (tool === 'holeTranslate') {
    const translation = [commit.values.translationX ?? expressionValueFromNumber(DEFAULT_HOLE_TRANSLATION_MM),
      commit.values.translationY ?? expressionValueFromNumber(0), commit.values.translationZ ?? expressionValueFromNumber(0)] as const;
    if (!translation.every(value => Number.isFinite(value.value)) || Math.hypot(...translation.map(value => value.value)) < 1e-6) {
      return { ok: false, reasonKey: 'directEditError.translation' };
    }
    return { ok: true, document: appendSolid(context.document, createHoleTranslateFeature({ ...common, translation })), featureId: id };
  }
  const angle = commit.values.rotationAngle ?? expressionValueFromNumber(DEFAULT_FACE_ROTATION_DEGREES);
  if (!Number.isFinite(angle.value) || angle.value === 0) return { ok: false, reasonKey: 'directEditError.angle' };
  if (selected.hinge === null) return { ok: false, reasonKey: 'directEditError.faceAndEdge' };
  return { ok: true, document: appendSolid(context.document, createFaceRotateFeature({ ...common, hinge: selected.hinge, angle })), featureId: id };
}
