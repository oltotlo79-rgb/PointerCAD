import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, resolveSubShapeReference, type KernelBridge, type SolidBody } from '../kernelBridge.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../sketch/createSketchDocument.js';
import type { CoordinateInput, SketchLineFeature } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type { PartDocument } from './types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const bridges: KernelBridge[] = [];
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });
function kernel(): KernelBridge {
  const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
  bridges.push(bridge); return bridge;
}
const number = expressionValueFromNumber;
function addBox(document: PartDocument, x = 0, width = 20): PartDocument {
  const primitive = createPrimitiveFeature(document, 'box');
  return appendSolid(document, { ...primitive, origin: { kind: 'coordinate', value: absoluteCoordinate(x + width / 2, 15, 20) },
    shape: { kind: 'box', sizeX: number(width), sizeY: number(30), sizeZ: number(40) } });
}
function box(width = 20): PartDocument { return addBox(createEmptyPartDocument(), 0, width); }
function bodyOf(result: PartRecomputeResult, id: string): SolidBody {
  const body = result.bodies.find(value => value.featureId === id);
  if (body === undefined || !body.isValid || result.cancelled) throw new Error(`Missing real body ${id}`);
  return body;
}
function referenceAt(body: SolidBody, position: Vec3): SubShapeRef {
  const matches = body.vertices.filter(vertex => vertex.position.every((value, axis) => Math.abs(value - position[axis]) < 1e-7));
  expect(matches).toHaveLength(1);
  const reference: SubShapeRef = { bodyFeatureId: body.featureId, index: matches[0].index,
    fingerprint: { kind: 'vertex', position: matches[0].position } };
  expect(resolveSubShapeReference(body, reference).status).toBe('matched');
  return reference;
}
function coordinate(reference: SubShapeRef): CoordinateInput {
  return { mode: 'relative', base: { kind: 'subShape', ref: reference }, dx: number(0), dy: number(0), dz: number(0) };
}
function connected(document: PartDocument, from: CoordinateInput, to: CoordinateInput): PartDocument {
  const sketch = document.sketches[0];
  const line: SketchLineFeature = { id: 'line-connected', name: 'connected', kind: 'line', planeId: 'free', from, to, construction: false };
  return replaceSketch(document, appendFeature(sketch, line));
}
function segment(result: PartRecomputeResult) {
  expect(result.cancelled).toBe(false);
  expect(result.errors).toEqual([]);
  const line = result.sketches[0].resolved.segments.find(value => value.featureId === 'line-connected');
  if (line === undefined) throw new Error('Connected line must resolve');
  return line;
}
function expectPosition(actual: Vec3, expected: Vec3): void {
  for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis], 7);
}

describe('connected references through real OCCT', () => {
  it.each([false, true])('resolves both semantic vertex ends from a cold cache (reversed=%s)', async reversed => {
    const bridge = kernel(), empty = createEmptyPartDocument();
    const primitive = createPrimitiveFeature(empty, 'box');
    const document = appendSolid(empty, { ...primitive,
      origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: number(20), sizeY: number(20), sizeZ: number(20) } });
    const body = bodyOf(await recomputePart(document, bridge), primitive.id);
    const first: Vec3 = reversed ? [10, 10, 10] : [-10, -10, -10];
    const second: Vec3 = reversed ? [-10, -10, -10] : [10, 10, 10];
    const capture = (position: Vec3): SubShapeRef => {
      const vertices = body.vertices.filter(vertex => vertex.position.every((value, axis) => Math.abs(value - position[axis]) < 1e-7));
      expect(vertices.length).toBe(1);
      const reference = createSubShapeReference(body, 'vertex', vertices[0].index);
      if (reference === null || reference.origin === undefined) throw new Error('Missing current semantic vertex reference');
      expect(resolveSubShapeReference(body, reference).status).toBe('matched');
      return reference;
    };
    const from = capture(first), to = capture(second);
    const saved = connected(document, coordinate(from), coordinate(to)), original = JSON.stringify(saved);
    const cold = createSubShapeCache();
    expect(cold.size).toBe(0);
    const outcome = await recomputePart(saved, bridge, { subShapes: cold });
    // Both ends are current after refresh; publishing an earlier failed sketch is still incorrect.
    expect(cold.size).toBe(2);
    expect(cold.resolve(from)).toMatchObject({ kind: 'vertex', position: first });
    expect(cold.resolve(to)).toMatchObject({ kind: 'vertex', position: second });
    expect(JSON.stringify(saved)).toBe(original);
    expect(from.fingerprint.position).toEqual(first); expect(to.fingerprint.position).toEqual(second);
    const line = segment(outcome);
    expectPosition(line.from, first); expectPosition(line.to, second);
    expect(Math.hypot(...line.from.map((value, axis) => value - line.to[axis]))).toBeCloseTo(Math.sqrt(1200), 7);
  });
  it('joins two actual vertices in 3D without flattening or replacing references', async () => {
    const bridge = kernel(), document = box(), id = document.solids[0].id;
    const body = bodyOf(await recomputePart(document, bridge), id);
    const from = referenceAt(body, [0, 0, 0]), to = referenceAt(body, [20, 30, 40]);
    const saved = connected(document, coordinate(from), coordinate(to));
    const line = segment(await recomputePart(saved, bridge));
    expectPosition(line.from, [0, 0, 0]); expectPosition(line.to, [20, 30, 40]);
    expect(Math.hypot(...line.to)).toBeCloseTo(Math.sqrt(2900), 7);
    expect(saved.sketches[0].features[0]).toMatchObject({ planeId: 'free',
      from: { base: { ref: from } }, to: { base: { ref: to } } });
  });
  it('joins separate bodies and a sketch point by relative references', async () => {
    const bridge = kernel();
    let document = addBox(box(), 100);
    let sketch = document.sketches[0];
    const point = createPointFeature(sketch, absoluteCoordinate(50, 60, 70), 'free');
    sketch = appendFeature(sketch, point); document = replaceSketch(document, sketch);
    const computed = await recomputePart(document, bridge);
    const first = referenceAt(bodyOf(computed, document.solids[0].id), [0, 0, 0]);
    const second = referenceAt(bodyOf(computed, document.solids[1].id), [120, 30, 40]);
    const between = segment(await recomputePart(connected(document, coordinate(first), coordinate(second)), bridge));
    expectPosition(between.from, [0, 0, 0]); expectPosition(between.to, [120, 30, 40]);
    const mixed = connected(document, { mode: 'relative', base: { kind: 'point', pointId: point.id },
      dx: number(0), dy: number(0), dz: number(0) }, coordinate(second));
    const line = segment(await recomputePart(mixed, bridge));
    expectPosition(line.from, [50, 60, 70]); expectPosition(line.to, [120, 30, 40]);
  });
  it('follows a uniquely matched changed width and keeps the saved fingerprint', async () => {
    const bridge = kernel(), document = box(), id = document.solids[0].id;
    const body = bodyOf(await recomputePart(document, bridge), id);
    const from = referenceAt(body, [0, 0, 0]), to = referenceAt(body, [20, 30, 40]);
    const saved = connected(document, coordinate(from), coordinate(to));
    const changed = { ...saved, solids: box(21).solids };
    const outcome = await recomputePart(changed, bridge);
    expect(resolveSubShapeReference(bodyOf(outcome, id), to).status).toBe('matched');
    expectPosition(segment(outcome).to, [21, 30, 40]);
    expect(changed.sketches[0].features).toEqual(saved.sketches[0].features);
    expect(to.fingerprint.position).toEqual([20, 30, 40]);
    expectPosition(segment(await recomputePart(saved, bridge)).to, [20, 30, 40]);
  });
  it('refuses renumbered actual OCCT vertices under the unchanged vertex threshold', async () => {
    const bridge = kernel(), document = box();
    const body = bodyOf(await recomputePart(document, bridge), document.solids[0].id);
    const ref = referenceAt(body, [20, 30, 40]);
    // Controlled metadata permutation, not a claim that this OCCT operation naturally renumbers vertices.
    const reordered = { ...body, vertices: body.vertices.map(vertex => ({ ...vertex, index: vertex.index + 10 })).reverse() };
    const resolution = resolveSubShapeReference(reordered, ref);
    expect(resolution.status).toBe('missing');
    expect(resolution.originalReference).toBe(ref);
    expect(ref.index).toBeLessThan(10);
  });
  it('rejects duplicate-index metadata derived from a real OCCT vertex', async () => {
    const bridge = kernel(), document = box();
    const body = bodyOf(await recomputePart(document, bridge), document.solids[0].id);
    const reference = referenceAt(body, [20, 30, 40]);
    const vertex = body.vertices.find(value => value.index === reference.index);
    if (vertex === undefined) throw new Error('vertex');
    // Deliberately malformed metadata boundary; normal OCCT vertices have distinct indices.
    expect(resolveSubShapeReference({ ...body, vertices: [vertex, { ...vertex }] }, reference).status).toBe('ambiguous');
  });
  it('does not resolve a deleted body from the saved fingerprint', async () => {
    const bridge = kernel(), document = box(), id = document.solids[0].id;
    const ref = referenceAt(bodyOf(await recomputePart(document, bridge), id), [20, 30, 40]);
    const saved = connected(document, coordinate(ref), absoluteCoordinate(80, 50, 60));
    const outcome = await recomputePart({ ...saved, solids: [] }, bridge);
    expect(outcome.sketches[0].resolved.segments.some(value => value.featureId === 'line-connected')).toBe(false);
    expect(outcome.errors.some(error => error.featureId === 'line-connected')).toBe(true);
    expect(saved.sketches[0].features[0]).toMatchObject({ from: { base: { ref } } });
  });
  it('follows a consumed upstream body using its current step key', async () => {
    const bridge = kernel(), document = box(), id = document.solids[0].id;
    const ref = referenceAt(bodyOf(await recomputePart(document, bridge), id), [20, 30, 40]);
    let changed = addBox(box(21), 10);
    changed = appendSolid(changed, { id: 'joined', name: 'joined', kind: 'boolean', suppressed: false,
      operation: 'union', targetFeatureId: id, toolFeatureId: changed.solids[1].id });
    const saved = connected(changed, coordinate(ref), absoluteCoordinate(80, 50, 60));
    const outcome = await recomputePart(saved, bridge);
    expect(outcome.bodies.map(value => value.featureId)).toEqual(['joined']);
    expectPosition(segment(outcome).from, [21, 30, 40]);
    expect(ref.fingerprint.position).toEqual([20, 30, 40]);
  });
});
