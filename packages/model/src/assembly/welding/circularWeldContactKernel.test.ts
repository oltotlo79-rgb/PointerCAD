import { expressionValueFromNumber as number } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { createDirectKernelBridge, type SolidBody, type SolidFaceEntry } from '../../kernelBridge.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../part/createPartDocument.js';
import { recomputePart } from '../../part/recomputePart.js';
import type { PrimitiveShape } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { resolveJointOccurrence, type JointOccurrenceInputs } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent } from '../types.js';
import { resolveCircularWeldContact, type CircularWeldContactRequest } from './circularWeldContact.js';
import { resolveCircularWeldSelection, type CircularWeldSelectionContext } from './circularWeldSelection.js';
import { WELD_DIRECTION_TOLERANCE as D, WELD_LENGTH_TOLERANCE_MM as L } from './types.js';
import { COVERED_RATIO } from './weldContact.js';

// N1 is one native geometry/contact connection, not a saved/UI/strength result.
// Independent areas: (13^2-10^2)*pi/4 = 69*pi/4; 10*4*pi/2 = 20*pi mm^2.
// Ownership and beforeAll deadline follow circularFilletWeldGeometryKernel.test.ts.
const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

function unique<T>(rows: readonly T[], label: string): T {
  const value = rows[0];
  if (rows.length !== 1 || value === undefined) throw new Error(`${label}: expected one, got ${rows.length}`);
  return value;
}
function part(id: string, origin: Vec3, shape: PrimitiveShape) {
  const document = { ...createEmptyPartDocument(), id };
  const feature = createPrimitiveFeature(document, shape.kind,
    { kind: 'coordinate', value: absoluteCoordinate(...origin) });
  return appendSolid(document, { ...feature, shape });
}
function component(id: string, partRef: string): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef },
    placement: { position: [number(0), number(0), number(0)], rotation: [0, 0, 0, 1] },
    fixed: true, visible: true, suppressed: false };
}
function facePick(context: CircularWeldSelectionContext, path: readonly string[], body: SolidBody, face: SolidFaceEntry) {
  const resolved = resolveJointOccurrence(context.inputs, path, context.view);
  if (!resolved.ok) throw new Error(resolved.code);
  const occurrence = resolved.occurrence;
  const step = unique(occurrence.resolvedPart.steps.filter(s => s.featureId === body.featureId && s.visible
    && occurrence.resolvedPart.liveBodyIds.includes(s.featureId)), 'current selected body');
  const reference: SubShapeRef = { bodyFeatureId: body.featureId, index: face.index,
    fingerprint: { kind: 'face', surfaceKind: face.surfaceKind, area: face.area,
      position: face.centroid, axis: face.axis, radius: face.radius } };
  return { path, reference, sourceKey: occurrence.sourceKey, bodyKey: step.key,
    placementKey: JSON.stringify([occurrence.worldPlacement.position, occurrence.worldPlacement.rotation]) };
}

describe('native finite circular contact N1', () => {
  it('connects the actual lower circle, full cylinder wall and finite plate top', async () => {
    // Primitive box origin is its centre; cylinder origin is its bottom centre.
    const cylinderPart = part('native-contact-cylinder', [0, 0, 0],
      { kind: 'cylinder', radius: number(10), height: number(10) });
    const platePart = part('native-contact-plate', [0, 0, -5],
      { kind: 'box', sizeX: number(40), sizeY: number(40), sizeZ: number(10) });
    const parts = [cylinderPart, platePart];
    try {
      const embeddedCylinder = await embedPart(EMPTY_PART_LIBRARY, cylinderPart, 'cylinder.pcad', 'cylinder.pcad');
      const embeddedPlate = await embedPart(embeddedCylinder.library, platePart, 'plate.pcad', 'plate.pcad');
      const document = { ...createAssemblyDocument('native circular contact'), components: [
        component('cylinder', embeddedCylinder.partRef), component('plate', embeddedPlate.partRef)] };
      const inputs: JointOccurrenceInputs = { document, library: embeddedPlate.library, subAssemblies: new Map() };
      const byPart = new Map<string, readonly SolidBody[]>();
      for (const [key, document] of [[embeddedCylinder.partRef, cylinderPart], [embeddedPlate.partRef, platePart]] as const) {
        const computed = await recomputePart(document, bridge);
        expect(computed.errors, document.id).toEqual([]);
        const body = unique(computed.bodies, document.id);
        expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('solid');
        expect(body.mesh.positions.length).toBeGreaterThan(0);
        byPart.set(key, computed.bodies);
      }
      const context: CircularWeldSelectionContext = { inputs,
        view: { source: inputs, resolved: resolveAssembly(document, { library: inputs.library, subAssemblies: inputs.subAssemblies }) },
        bodiesOf: occurrence => byPart.get(occurrence.partKey) ?? null };
      const cylinder = unique(byPart.get(embeddedCylinder.partRef) ?? [], 'cylinder body');
      const plate = unique(byPart.get(embeddedPlate.partRef) ?? [], 'plate body');
      // Select by native geometry, never by a remembered face/edge index or axis origin.
      const wall = unique(cylinder.faces.filter(f => f.surfaceKind === 'cylinder' && f.radius !== null
        && Math.abs(f.radius - 10) <= L && f.cylinderExterior === true && f.cylinderSpan != null), 'full exterior wall');
      const top = unique(plate.faces.filter(f => f.surfaceKind === 'plane' && Math.abs(f.centroid[2]) <= L
        && f.planarBasis !== undefined && f.planarBasis.normal[2] >= 1 - D), 'upward finite plate top');
      const lower = unique(cylinder.edges.filter(e => e.curveKind === 'circle' && e.radius !== null
        && Math.abs(e.radius - 10) <= L && e.circleBasis !== undefined
        && Math.hypot(...e.circleBasis.origin) <= L
        && Math.abs(Math.abs(e.circleBasis.normal[2]) - 1) <= D), 'lower circular edge');
      expect(wall.boundaryEdgeIndices).toContain(lower.index);
      expect(top.boundaryEdgeIndices?.length).toBeGreaterThan(0);
      const edge = { path: ['cylinder'], reference: { bodyFeatureId: cylinder.featureId, index: lower.index,
        fingerprint: { kind: 'edge' as const, curveKind: 'circle' as const, length: lower.length,
          position: lower.midpoint, axis: lower.axis, radius: lower.radius } } };
      const evidence = resolveCircularWeldSelection(context, edge.path, edge.reference);
      if (evidence === null) throw new Error('Current native circular evidence unavailable');
      expect(Math.abs(Math.abs(evidence.normal[2]) - 1)).toBeLessThanOrEqual(D);
      const normalDirection = evidence.normal[2] > 0 ? 1 : -1;
      expect(evidence.normal[2] * normalDirection).toBeCloseTo(1, 12); // world +Z leg
      const [lo, hi] = evidence.parameterRange;
      expect(hi - lo).toBeGreaterThanOrEqual(Math.PI / 2);
      const from = evidence.orientation === 1 ? lo : hi;
      const to = from + evidence.orientation * Math.PI / 2;
      // Separate authored and current fixture records; no resolver result supplies an oracle.
      const intervals = [{ beadId: 'native-quarter', beadSourceKey: 'native-quarter-definition-1', fromParameter: from, toParameter: to }];
      const currentBeads = [{ beadId: 'native-quarter', beadSourceKey: 'native-quarter-definition-1', fromParameter: from, toParameter: to }];
      const request: CircularWeldContactRequest = { edge, plane: facePick(context, ['plate'], plate, top),
        cylinder: facePick(context, ['cylinder'], cylinder, wall),
        definition: { kind: 'circular-weld-path', evidence, intervals }, currentBeads,
        section: { radialLegMm: 3, normalLegMm: 4, radialDirection: 1, normalDirection } };
      const before = JSON.stringify(request), result = resolveCircularWeldContact(context, request);
      expect(result.reason).toBeNull();
      const contact = unique(result.contacts, 'native contact');
      expect(contact.beadId).toBe('native-quarter');
      expect(contact.planeAreaMm2).toBeCloseTo(69 * Math.PI / 4, 10);
      expect(contact.cylinderAreaMm2).toBeCloseTo(20 * Math.PI, 10);
      expect(Number.isFinite(contact.coveredRatio)).toBe(true);
      expect(contact.coveredRatio).toBeGreaterThanOrEqual(COVERED_RATIO);
      expect(JSON.stringify(request)).toBe(before);
    } finally {
      const released = await Promise.allSettled(parts.map(document => bridge.releasePart(document.id)));
      expect(released.filter(row => row.status === 'rejected')).toEqual([]);
    }
  });
});
