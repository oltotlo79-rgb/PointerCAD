import { absoluteCoordinate, resolvePlaneSpec, type AssemblyDocument, type ContextReferenceLink } from '@pointercad/model';
import { appendCoordinatePoints, commitWorkPlane } from '../sketch/referenceCommands.js';
import { prepareDocumentEdit } from '../store/documentDerived.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AssemblyMateFaceHit } from '../viewport/createAssemblyLayer.js';
import { contextPlanePoints, currentAssemblyContext, pickedContextFace } from './assemblyContextGeometry.js';

export function nextContextLinkId(document: AssemblyDocument): string {
  const ids = new Set(document.contextReferences?.map(link => link.id));
  let serial = 1;
  while (ids.has(`context-${String(serial)}`)) serial += 1;
  return `context-${String(serial)}`;
}

/** Three ordinary points, an ordinary plane and its optional stable source share one parent publication. */
export function copyPickedAssemblyPlane(hit: AssemblyMateFaceHit | null): void {
  const state = useAppStore.getState(), edit = state.partEdit, assembly = state.assembly;
  if (edit === null || assembly === null || edit.contextPick?.kind !== 'plane'
    || state.activeTool !== 'select' || state.numericInput !== null) return;
  const source = hit === null ? null : pickedContextFace(state, edit.componentId, hit);
  const points = source === null ? null : contextPlanePoints(source, source.reference, false);
  if (hit === null || source === null || points === null) {
    state.setFileMessage({ key: 'assembly.partEdit.planeCopyUnavailable', failed: true });
    return;
  }
  const local = appendCoordinatePoints(state.document, points.map(point => absoluteCoordinate(...point)));
  const [p1, p2, p3] = local.points;
  if (p1?.kind !== 'point' || p2?.kind !== 'point' || p3?.kind !== 'point') return;
  const spec = { kind: 'threePoints', p1, p2, p3 } as const;
  const positions = new Map([[p1.pointId, points[0]], [p2.pointId, points[1]], [p3.pointId, points[2]]]);
  if (!resolvePlaneSpec(spec, { point: reference => reference.kind === 'point' ? positions.get(reference.pointId) ?? null : null,
    axis: () => null, workPlane: () => null }).ok) {
    state.setFileMessage({ key: 'assembly.partEdit.planeCopyUnavailable', failed: true });
    return;
  }
  const plane = commitWorkPlane(local.document, spec);
  const contextPlaneLink: ContextReferenceLink | undefined = source.reference.origin === undefined ? undefined : {
    id: nextContextLinkId(assembly), targetComponentId: edit.componentId, targetReferenceId: plane.featureId,
    sourceComponentId: hit.componentId, source: source.reference,
    plane: { targetPartRef: edit.partRef, targetPartId: state.document.id, sourcePartRef: source.partKey,
      sourcePartId: source.partId, pointIds: [p1.pointId, p2.pointId, p3.pointId] },
  };
  void state.commitAssemblyPartPlacement(prepareDocumentEdit(state, plane.document, false), {
    ...(contextPlaneLink === undefined ? {} : { contextPlaneLink }),
    isCurrent: current => current.partEdit?.contextPick === edit.contextPick && currentAssemblyContext(current) === source.view,
    onApplied: current => {
      current.setPartEditContextPick(null);
      current.setWorkPlane(plane.featureId);
    },
  });
}
