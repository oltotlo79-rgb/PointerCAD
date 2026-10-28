/**
 * EX-18 route 5 (assembly-context references), real OCCT: the bracket hole centre is a sketch point placed relative to
 * the part reference point P (existing PointReference kind 'point'), and P is driven by the assembly-context link
 * (frozen applyContextReference) from the top-face centre of another placed part B. Moving B and re-applying the link
 * moves the hole; save/read and Undo/Redo keep the link; same-id local point, deleted P and a solid-derived P refuse.
 * Needs the route-5 bridge fragments (candidate-8 edits/route5-bridge-fragments.json).
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createNativeKernelBridgeForNodeTests, initializeNativeKernelForNodeTests } from '../../model/src/testing/createNativeKernelBridge.node.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { readPcadFile, writePcadFile } from '../../io/src/pcad/pcadFile.js';
import { subShapeElementId, subShapeRefOf } from '../src/solid/subShapeSelection.js';
import { createUndoStack, pushUndo, redo, undo } from '../../model/src/history/undoStack.js';
import { type KernelBridge, type SolidBody, type SolidFaceEntry } from '../../model/src/kernelBridge.js';
import { resolveSubShapeReference } from '../../model/src/kernelBridge/referenceResolution.js';
import {
  appendReference, appendSolid, createEmptyPartDocument, removeReference, replaceReference, replaceSketch,
} from '../../model/src/part/createPartDocument.js';
import { recomputePart } from '../../model/src/part/recomputePart.js';
import type { HoleFeature, PartDocument, PrimitiveFeature, ReferencePointFeature, SubShapeRef } from '../../model/src/part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../../model/src/sketch/createSketchDocument.js';
import type { SketchDocument } from '../../model/src/sketch/types.js';
import type { Vec3 } from '../../model/src/sketch/vec3.js';
import { addComponent, createComponentFor } from '../../model/src/assembly/assemblyEdit.js';
import { applyContextReference, contextPointResolverFromBodies, type ContextReferenceLink } from '../../model/src/assembly/contextReference.js';
import { createAssemblyDocument } from '../../model/src/assembly/createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument, Placement } from '../../model/src/assembly/types.js';

const OCCT_TIMEOUT_MS = 180_000;
let bridge: KernelBridge;
beforeAll(async () => {
  await initializeNativeKernelForNodeTests();
  bridge = createNativeKernelBridgeForNodeTests();
}, OCCT_TIMEOUT_MS);

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`test expression did not evaluate: ${source}`);
  return result.value;
}

const P_ID = 'refpoint-1';

function box(id: string, center: Vec3, size: Vec3): PrimitiveFeature {
  return { id, name: id, suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(center[0], center[1], center[2]) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: expr(String(size[0])), sizeY: expr(String(size[1])), sizeZ: expr(String(size[2])) } };
}

function bodyOf(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const body = bodies.find((entry) => entry.featureId === featureId);
  if (body === undefined) throw new Error(`body ${featureId} missing`);
  return body;
}

function topOf(body: SolidBody, z: number): SolidFaceEntry {
  const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - z) < 1e-9);
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`top faces at z=${String(z)}: ${String(found.length)}`);
  return face;
}

function pickRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const ref = subShapeRefOf([body], subShapeElementId(body.featureId, 'face', face.index));
  if (ref === null) throw new Error(`the pick path refused face ${String(face.index)} of ${body.featureId}`);
  return ref;
}

function placement(position: Vec3): Placement {
  return { position: [expr(String(position[0])), expr(String(position[1])), expr(String(position[2]))], rotation: [0, 0, 0, 1] };
}

/** Expected bracket with the hole axis at x=holeX, y=15 (independent of the code under test). */
function expectBracketAt(body: SolidBody, holeX: number): void {
  expect(body.isValid).toBe(true);
  const volume = 40 * 30 * 10 - Math.PI * 9 * 10;
  expect(Math.abs(body.volume - volume)).toBeLessThanOrEqual(volume * 1e-6);
  const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - 3) < 1e-7);
  expect(walls).toHaveLength(1);
  expect(Math.abs((walls[0]?.axisOrigin?.[0] ?? NaN) - holeX)).toBeLessThanOrEqual(1e-6);
  expect(Math.abs((walls[0]?.axisOrigin?.[1] ?? NaN) - 15)).toBeLessThanOrEqual(1e-6);
}

/** Part A: the plate, P (placeholder coordinate), the hole point relative (0,0,0) to P, and the hole. */
async function bracketPart(): Promise<{ readonly part: PartDocument; readonly sketch: SketchDocument }> {
  const placeholder: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: absoluteCoordinate(0, 0, 0) } };
  const base = createEmptyPartDocument();
  const center = createPointFeature(base.sketches[0], { mode: 'relative', base: { kind: 'point', pointId: P_ID },
    dx: expr('0'), dy: expr('0'), dz: expr('0') });
  const sketch = appendFeature(base.sketches[0], center);
  const plateOnly = appendSolid(appendReference(replaceSketch(base, sketch), placeholder), box('box-1', [20, 15, 5], [40, 30, 10]));
  const plate = await recomputePart(plateOnly, bridge);
  expect(plate.errors).toEqual([]);
  const plateBody = bodyOf(plate.bodies, 'box-1');
  const hole: HoleFeature = { id: 'hole-1', name: 'hole-1', suppressed: false, kind: 'hole', targetFeatureId: 'box-1',
    face: pickRef(plateBody, topOf(plateBody, 10)), centers: [{ sketchId: sketch.id, pointFeatureId: center.id }],
    diameter: expr('6'), depth: { kind: 'through' }, tiltAngle: expr('0'), tiltAzimuth: expr('0') };
  return { part: appendSolid(plateOnly, hole), sketch };
}

describe('EX-18 route 5 assembly-context bracket (real OCCT)', () => {
  it('B moves, the context link re-drives P, the hole follows; save/read and Undo/Redo keep it; unsafe P refuses', async () => {
    // B: a 2x2x2 block whose top-face centre is its local (0,0,0); its placement puts that point in the world.
    const blockPart = appendSolid(createEmptyPartDocument(), box('block-1', [0, 0, -1], [2, 2, 2]));
    const blockBodies = (await recomputePart(blockPart, bridge)).bodies;
    const block = bodyOf(blockBodies, 'block-1');
    const source = pickRef(block, topOf(block, 0));
    const { part: bracket } = await bracketPart();

    let document: AssemblyDocument = createAssemblyDocument('route 5');
    const a: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: 'bracket' }), placement: placement([0, 0, 0]) };
    document = addComponent(document, a);
    const b: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: 'block' }), placement: placement([10, 15, 10]) };
    document = addComponent(document, b);
    const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: P_ID,
      sourceComponentId: b.id, source };
    const drive = (assembly: AssemblyDocument, part: PartDocument): PartDocument => {
      const update = applyContextReference({ document: assembly, links: [link],
        partDocument: (component) => component.id === a.id ? part : null,
        resolvePoint: contextPointResolverFromBodies((component) => component.id === b.id ? blockBodies : null,
          resolveSubShapeReference) }, link);
      if ('code' in update) throw new Error(JSON.stringify(update));
      return update.part;
    };

    const first = drive(document, bracket);
    const atFirst = await recomputePart(first, bridge);
    expect(atFirst.errors).toEqual([]);
    expectBracketAt(bodyOf(atFirst.bodies, 'hole-1'), 10);

    // Move B along x by 15 and re-apply the same link: P and the hole move to x=25.
    const moved = { ...document, components: document.components.map((component) =>
      component.id === b.id ? { ...component, placement: placement([25, 15, 10]) } : component) };
    const second = drive(moved, first);
    const atSecond = await recomputePart(second, bridge);
    expect(atSecond.errors).toEqual([]);
    expectBracketAt(bodyOf(atSecond.bodies, 'hole-1'), 25);

    // The saved history alone keeps the relative sketch point and P.
    const read = readPcadFile(writePcadFile(second, { savedAt: '2026-10-16T00:00:00.000Z' }));
    if (!read.ok) throw new Error(read.error.message);
    const reopened = await recomputePart(read.document, bridge);
    expect(reopened.errors).toEqual([]);
    expectBracketAt(bodyOf(reopened.bodies, 'hole-1'), 25);

    // Undo back to the first drive and redo the move.
    const back = undo(pushUndo(createUndoStack(first), second));
    expectBracketAt(bodyOf((await recomputePart(back.present, bridge)).bodies, 'hole-1'), 10);
    expectBracketAt(bodyOf((await recomputePart(redo(back).present, bridge)).bodies, 'hole-1'), 25);

    // Refusals: no hole body is produced and an error is reported.
    const refusesHole = async (part: PartDocument): Promise<void> => {
      const result = await recomputePart(part, bridge);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.bodies.some((entry) => entry.featureId === 'hole-1')).toBe(false);
    };
    // Deleted P (stale parent).
    await refusesHole(removeReference(second, P_ID));
    // P defined by a solid vertex could cycle back through solids built from this sketch: refused.
    const vertexDefined: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint',
      definition: { kind: 'vertex', vertex: source } };
    await refusesHole(replaceReference(second, P_ID, vertexDefined));
    // A local sketch point with the same id as P, earlier in the sketch history so it is already resolved when the
    // hole point looks P up, is ambiguous: refused, never silently chosen.
    const sketch = second.sketches[0];
    const sameId = { ...createPointFeature(sketch, absoluteCoordinate(5, 5, 10)), id: P_ID };
    await refusesHole(replaceSketch(second, { ...sketch, features: [sameId, ...sketch.features] }));
  }, OCCT_TIMEOUT_MS);
});
