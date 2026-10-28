/**
 * EX-18 route 5 reference replacement and re-attachment, real OCCT. The bracket hole centre follows the part reference
 * point P, which the assembly-context link drives from the top-face centre of another placed part B. B's source solid
 * is then replaced (deleted and rebuilt as a different feature), so the saved link is stale: committing it must refuse
 * and change nothing. Re-picking the top face of the new solid and committing the same link id re-attaches it, and the
 * bracket recovers with the same independent oracle as routes 1-4 (volume, outside box, hole axis).
 * Needs the route-5 bridge (candidate-9 edits/route5-bridge-fragments-9.json). Uses only existing product API.
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createNativeKernelBridgeForNodeTests, initializeNativeKernelForNodeTests } from '../../model/src/testing/createNativeKernelBridge.node.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { subShapeElementId, subShapeRefOf } from '../src/solid/subShapeSelection.js';
import { type KernelBridge, type SolidBody, type SolidFaceEntry } from '../../model/src/kernelBridge.js';
import { resolveSubShapeReference } from '../../model/src/kernelBridge/referenceResolution.js';
import { appendReference, appendSolid, createEmptyPartDocument, replaceSketch } from '../../model/src/part/createPartDocument.js';
import { recomputePart } from '../../model/src/part/recomputePart.js';
import type { HoleFeature, PartDocument, PrimitiveFeature, ReferencePointFeature, SubShapeRef } from '../../model/src/part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../../model/src/sketch/createSketchDocument.js';
import type { Vec3 } from '../../model/src/sketch/vec3.js';
import { addComponent, createComponentFor } from '../../model/src/assembly/assemblyEdit.js';
import { commitContextReference, contextPointResolverFromBodies, type ContextReferenceLink } from '../../model/src/assembly/contextReference.js';
import { createAssemblyDocument } from '../../model/src/assembly/createAssemblyDocument.js';
import { embedPart, type PartLibrary, replacePartDocument } from '../../model/src/assembly/partLibrary.js';
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
    && Math.abs(face.axis[2] - 1) < 1e-9 && Math.abs(face.centroid[2] - z) < 1e-9);
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`top faces at z=${String(z)}: ${String(found.length)}`);
  return face;
}

/** The face reference a user pick on the current body produces (the viewport selection path). */
function pickRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const ref = subShapeRefOf([body], subShapeElementId(body.featureId, 'face', face.index));
  if (ref === null) throw new Error(`the pick path refused face ${String(face.index)} of ${body.featureId}`);
  return ref;
}

function placement(position: Vec3): Placement {
  return { position: [expr(String(position[0])), expr(String(position[1])), expr(String(position[2]))], rotation: [0, 0, 0, 1] };
}

function boundsOf(body: SolidBody): { readonly low: Vec3; readonly high: Vec3 } {
  const positions = body.mesh.positions;
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] + origin[axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return { low, high };
}

/**
 * The common bracket oracle of routes 1-4 (ex18BracketKernel.test.ts expectBracket): volume 12000 - 90*pi, outside box
 * [0,40]x[0,30]x[0,10], one r=3 wall. The hole axis is at x=holeX, y=15 (x=10 is the common bracket). Placement
 * arithmetic only adds integers here, so the axis tolerance is the same 1e-7 as the other routes.
 */
function expectBracketAt(body: SolidBody, holeX: number): void {
  expect(body.isValid).toBe(true);
  const volume = 40 * 30 * 10 - Math.PI * 9 * 10;
  expect(Math.abs(body.volume - volume)).toBeLessThanOrEqual(volume * 1e-6);
  const { low, high } = boundsOf(body);
  [0, 0, 0].forEach((value, axis) => expect(Math.abs(low[axis] - value)).toBeLessThanOrEqual(1e-3));
  [40, 30, 10].forEach((value, axis) => expect(Math.abs(high[axis] - value)).toBeLessThanOrEqual(1e-3));
  const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - 3) < 1e-7);
  expect(walls).toHaveLength(1);
  expect(Math.abs((walls[0]?.axisOrigin?.[0] ?? NaN) - holeX)).toBeLessThanOrEqual(1e-7);
  expect(Math.abs((walls[0]?.axisOrigin?.[1] ?? NaN) - 15)).toBeLessThanOrEqual(1e-7);
}

/** Part A: the plate, P (placeholder coordinate), the hole point relative (0,0,0) to P, and the hole. */
async function bracketPart(): Promise<PartDocument> {
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
  return appendSolid(plateOnly, hole);
}

describe('EX-18 route 5: replaced source solid, stale link refusal and re-attachment (real OCCT)', () => {
  it('a stale link refuses atomically; re-picking the new face under the same link id recovers the bracket', async () => {
    // B part, first version: a 2x2x2 block whose top-face centre is its local (0,0,0).
    const blockV1 = appendSolid(createEmptyPartDocument(), box('block-1', [0, 0, -1], [2, 2, 2]));
    const v1Bodies = (await recomputePart(blockV1, bridge)).bodies;
    const firstSource = pickRef(bodyOf(v1Bodies, 'block-1'), topOf(bodyOf(v1Bodies, 'block-1'), 0));

    const empty: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
    const bracket = await embedPart(empty, await bracketPart(), 'bracket.pcad', 'bracket.pcad');
    const block = await embedPart(bracket.library, blockV1, 'block.pcad', 'block.pcad');
    let document: AssemblyDocument = createAssemblyDocument('route 5 re-attach');
    const a: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: bracket.partRef }),
      placement: placement([0, 0, 0]) };
    document = addComponent(document, a);
    const b: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: block.partRef }),
      placement: placement([10, 15, 10]) };
    document = addComponent(document, b);
    const resolverFor = (bodies: readonly SolidBody[]) =>
      contextPointResolverFromBodies((component) => component.id === b.id ? bodies : null, resolveSubShapeReference);
    const bracketOf = async (library: PartLibrary): Promise<SolidBody> => {
      const part = library.parts.get(bracket.partRef);
      if (part === undefined) throw new Error('bracket part missing');
      const result = await recomputePart(part, bridge);
      expect(result.errors).toEqual([]);
      return bodyOf(result.bodies, 'hole-1');
    };

    const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: P_ID,
      sourceComponentId: b.id, source: firstSource };
    const first = await commitContextReference(document, block.library, link, resolverFor(v1Bodies));
    if ('code' in first) throw new Error(JSON.stringify(first));
    expectBracketAt(await bracketOf(first.library), 10);

    // Replace B's source solid: block-1 is gone, block-2 is a different 3x3x3 solid with its top-face centre at local
    // (0,0,0); B is also moved to (25,15,10). The saved link still names block-1's face.
    const blockV2 = appendSolid(createEmptyPartDocument(), box('block-2', [0, 0, -1.5], [3, 3, 3]));
    const v2Bodies = (await recomputePart(blockV2, bridge)).bodies;
    const replacedLibrary = await replacePartDocument(first.library, block.partRef, blockV2);
    const replaced: AssemblyDocument = { ...first.document, components: first.document.components.map((component) =>
      component.id === b.id ? { ...component, placement: placement([25, 15, 10]) } : component) };
    const bracketBefore = replacedLibrary.parts.get(bracket.partRef);
    const snapshot = JSON.stringify([replaced, [...replacedLibrary.parts]]);

    // Stale: refused with the existing code, nothing is built and the bracket keeps its last good geometry.
    expect(await commitContextReference(replaced, replacedLibrary, link, resolverFor(v2Bodies)))
      .toEqual({ code: 'sourceUnresolved', linkId: link.id });
    expect(JSON.stringify([replaced, [...replacedLibrary.parts]])).toBe(snapshot);
    expect(replacedLibrary.parts.get(bracket.partRef)).toBe(bracketBefore);
    expectBracketAt(await bracketOf(replacedLibrary), 10);

    // Re-attach: pick the top face of the new solid and commit under the same link id.
    const secondSource = pickRef(bodyOf(v2Bodies, 'block-2'), topOf(bodyOf(v2Bodies, 'block-2'), 0));
    const reattached: ContextReferenceLink = { ...link, source: secondSource };
    const second = await commitContextReference(replaced, replacedLibrary, reattached, resolverFor(v2Bodies));
    if ('code' in second) throw new Error(JSON.stringify(second));
    // One link, replaced in place (not duplicated), now naming the new solid.
    expect(second.document.contextReferences).toEqual([reattached]);
    expect(second.document.contextReferences?.[0]?.source.bodyFeatureId).toBe('block-2');
    expect(second.document.components).toEqual(replaced.components);
    // The downstream bracket recovers and follows the new source: hole at x=25, same volume and outside box.
    expectBracketAt(await bracketOf(second.library), 25);
    // B's part document is untouched by the commit.
    expect(second.library.parts.get(block.partRef)).toBe(replacedLibrary.parts.get(block.partRef));
  }, OCCT_TIMEOUT_MS);
});
