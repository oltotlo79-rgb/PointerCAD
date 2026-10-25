import { createKernelApi } from '@pointercad/kernel';
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { appendSolid, createEmptyPartDocument, replaceSketch, DEFAULT_PRIMITIVE_AXIS } from '../part/createPartDocument.js';
import { resolvePart } from '../part/resolvePart.js';
import { recomputePart } from '../part/recomputePart.js';
import type { ExtrudeFeature, PrimitiveFeature, SurfaceFeature } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { SketchDocument, SketchLineFeature } from '../sketch/types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

function fourLinePart(prefix: string, symmetric = false) {
  const part = createEmptyPartDocument();
  const source = part.sketches[0];
  const points = [[0, 0, 0], [20, 0, 0], [20, 15, 0], [0, 15, 0]] as const;
  const lines: SketchLineFeature[] = points.map((point, index) => ({
    id: `${prefix}-line-${index}`, name: `Line ${index}`, kind: 'line', planeId: 'xy',
    from: absoluteCoordinate(point[0], point[1], point[2]),
    to: absoluteCoordinate(points[(index + 1) % 4][0], points[(index + 1) % 4][1],
      points[(index + 1) % 4][2]),
    construction: false,
  }));
  const sketch: SketchDocument = { ...source, features: [...lines, {
    id: 'face', name: 'Face', kind: 'face', planeId: 'xy', color: '#ffffff',
    boundary: lines.map((line) => ({ featureId: line.id })),
  }] };
  const feature: ExtrudeFeature = { id: 'extrude', name: 'Extrude', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: 'face' },
    distance: expressionValueFromNumber(10), reversed: false, symmetric };
  return appendSolid(replaceSketch(part, sketch), feature);
}

function box(id: string, x: number): PrimitiveFeature {
  return { id, name: id, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(x, 0, 0) },
    axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'box', sizeX: expressionValueFromNumber(20),
      sizeY: expressionValueFromNumber(20), sizeZ: expressionValueFromNumber(20) },
  };
}

describe('public semantic producers', () => {
  it.each(['kernel', 'model'] as const)('keeps a native local box beside a real %s failure with its final receipt', async failureAt => {
    const good = box('good', 1e9);
    let document = appendSolid(createEmptyPartDocument(), good);
    const importedShapes = new Map([['invalid-brep', Uint8Array.of(1, 2, 3)]]);
    document = failureAt === 'kernel' ? appendSolid(document, { id: 'bad', name: 'Invalid B-rep',
      kind: 'importedSolid', suppressed: false, shapeRef: 'invalid-brep', bodyKind: 'solid',
      source: { format: 'step', fileName: 'invalid.step', unit: 'mm', byteLength: 3 } })
      : appendSolid(document, { ...box('bad', 0), shape: { kind: 'box', sizeX: expressionValueFromNumber(-1),
        sizeY: expressionValueFromNumber(20), sizeZ: expressionValueFromNumber(20) } });
    const api = createKernelApi(() => Promise.resolve(oc)), bridge = createDirectKernelBridge(api);
    const partId = `mixed-${failureAt}`;
    const result = await recomputePart(document, bridge, { partId, generation: 7, importedShapes,
      localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    try {
      expect(result.cancelled).toBe(false);
      expect(result.errors.some(error => error.featureId === 'bad')).toBe(true);
      if (failureAt === 'kernel') expect(result.errors.some(error => error.code === 'kernelFailed')).toBe(true);
      expect(result.bodies.map(body => body.featureId)).toEqual(['good']);
      const body = result.bodies[0];
      expect(body.coordinateFrame?.space).toBe('local');
      expect(body.volume).toBeCloseTo(8000, 5);
      const x = Array.from(body.mesh.positions).filter((_, index) => index % 3 === 0);
      expect(Math.max(...x) - Math.min(...x)).toBeCloseTo(20, 6);
      expect(result.meshJsAccounting).toMatchObject({ documentId: document.id, partId, generation: 7,
        reading: { status: 'known' }, final: { status: 'known', limitBytes: 512 * 1024 * 1024 } });
      const final = result.meshJsAccounting?.final;
      if (final?.status !== 'known') throw new Error('Missing actual post-token final reading');
      const bytes = body.mesh.positions.byteLength + body.mesh.normals.byteLength
        + body.mesh.indices.byteLength + body.mesh.edgePositions.byteLength;
      expect(final.replyBackingBytes).toBe(bytes);
      expect(final.replyCloneReservedBytes).toBe(bytes);
      expect(final.retainedBackingBytes + final.replyCloneReservedBytes).toBeLessThanOrEqual(final.limitBytes);
    } finally {
      await result.referenceMeshScope?.close();
      await api.releasePart(partId);
      bridge.dispose();
    }
  }, 180_000);

  it('recomputes two equal boxes with distinct current owners through primitive Copy reuse', async () => {
    const document = appendSolid(appendSolid(createEmptyPartDocument(), box('box-a', 0)), box('box-b', 35));
    const resolved = resolvePart(document);
    expect(resolved.errors).toEqual([]);
    expect(resolved.steps[0].key).not.toBe(resolved.steps[1].key);
    const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
    const result = await bridge.recomputeSolids(resolved.steps);
    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(2);
    for (const body of result.bodies) {
      expect(body.origins?.state).toBe('tracked');
      if (body.origins?.state !== 'tracked') continue;
      expect(body.origins.bindings).toHaveLength(26);
      expect(body.origins.bindings.every((binding) => binding.origin.identity.featureId === body.featureId)).toBe(true);
    }
  }, 180_000);

  it('keeps saved 4-line IDs through model, bridge, and native prism while rekeying changed IDs', async () => {
    const first = resolvePart(fourLinePart('first'));
    const second = resolvePart(fourLinePart('second'));
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(first.steps[0].key).not.toBe(second.steps[0].key);
    const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
    const result = await bridge.recomputeSolids(first.steps);
    expect(result.failures).toEqual([]);
    const origins = result.bodies[0]?.origins;
    expect(origins?.state).toBe('tracked');
    if (origins?.state !== 'tracked') return;
    expect(origins.bindings).toHaveLength(6);
    const sideIds = origins.bindings.flatMap((binding) => binding.origin.identity.kind === 'extrude-side'
      ? [binding.origin.identity.profile.lineFeatureId] : []);
    expect(sideIds).toEqual(['first-line-0', 'first-line-1', 'first-line-2', 'first-line-3']);
  }, 180_000);

  it('keeps the four saved side origins after a symmetric profile translation', async () => {
    const resolved = resolvePart(fourLinePart('symmetric', true));
    expect(resolved.errors).toEqual([]);
    const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
    const result = await bridge.recomputeSolids(resolved.steps);
    expect(result.failures).toEqual([]);
    const body = result.bodies[0];
    expect(body?.volume).toBeCloseTo(3_000, 5);
    const z = Array.from(body?.mesh.positions ?? []).filter((_, index) => index % 3 === 2);
    expect(Math.min(...z)).toBeCloseTo(-5, 5);
    expect(Math.max(...z)).toBeCloseTo(5, 5);
    const origins = body?.origins;
    expect(origins?.state).toBe('tracked');
    if (origins?.state !== 'tracked') return;
    expect(origins.bindings).toHaveLength(6);
    expect(origins.bindings.flatMap((binding) => binding.origin.identity.kind === 'extrude-side'
      ? [binding.origin.identity.profile.lineFeatureId] : []))
      .toEqual(['symmetric-line-0', 'symmetric-line-1', 'symmetric-line-2', 'symmetric-line-3']);
  }, 180_000);
});


it('carries a real saved parabolic profile through the public model and native prism history', async () => {
  const makeDocument = (curveId: string) => {
    const part = createEmptyPartDocument(), source = part.sketches[0];
    const sketch: SketchDocument = { ...source, features: [
      { id: curveId, name: 'Parabola', kind: 'spline', planeId: 'xy', mode: 'control', closed: false,
        construction: false, points: [absoluteCoordinate(0, 0, 0), absoluteCoordinate(0.5, 0, 0), absoluteCoordinate(1, 1, 0)] },
      { id: 'a', name: 'A', kind: 'line', planeId: 'xy', construction: false,
        from: absoluteCoordinate(1, 1, 0), to: absoluteCoordinate(1, 0, 0) },
      { id: 'b', name: 'B', kind: 'line', planeId: 'xy', construction: false,
        from: absoluteCoordinate(1, 0, 0), to: absoluteCoordinate(0, 0, 0) },
      { id: 'region', name: 'Region', kind: 'face', planeId: 'xy', color: '#ffffff',
        boundary: [{ featureId: curveId }, { featureId: 'a' }, { featureId: 'b' }] },
    ] };
    return appendSolid(replaceSketch(part, sketch), { id: 'extrude-curve', name: 'Extrude', kind: 'extrude',
      suppressed: false, profile: { sketchId: sketch.id, faceFeatureId: 'region' },
      distance: expressionValueFromNumber(1), reversed: false, symmetric: false });
  };
  const first = makeDocument('saved-spline'), second = makeDocument('different-spline');
  const resolved = resolvePart(first), other = resolvePart(second);
  expect(resolved.errors).toEqual([]);
  expect(other.errors).toEqual([]);
  expect(resolved.steps).toHaveLength(1);
  expect(other.steps).toHaveLength(1);
  expect(resolved.steps[0].key).not.toBe(other.steps[0].key);
  const api = createKernelApi(() => Promise.resolve(oc)), bridge = createDirectKernelBridge(api);
  const partId = 'whole-curve-provenance';
  const result = await recomputePart(first, bridge, { partId, generation: 1 });
  try {
    expect(result.cancelled).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    const body = result.bodies[0];
    // x=t,y=t^2 and unit height: independent integral is 1/3.
    expect(body.volume).toBeCloseTo(1 / 3, 8);
    const origins = body.origins;
    expect(origins?.state).toBe('tracked');
    if (origins?.state !== 'tracked') throw new Error('Missing native saved-curve origins');
    expect(origins.bindings).toHaveLength(5);
    expect(origins.bindings.every(binding => binding.state === 'unique')).toBe(true);
    expect(new Set(origins.bindings.map(binding => binding.state === 'unique' ? binding.current.index : -1)).size).toBe(5);
    expect(origins.bindings.flatMap(binding => binding.origin.identity.kind === 'extrude-curve-side'
      ? [binding.origin.identity.profile.curveFeatureId] : [])).toEqual(['saved-spline', 'a', 'b']);
    expect(origins.bindings.flatMap(binding => binding.origin.identity.kind === 'extrude-curve-cap'
      ? [binding.origin.identity.end] : [])).toEqual(['start', 'end']);
  } finally {
    await result.referenceMeshScope?.close();
    await api.releasePart(partId);
    bridge.dispose();
  }
}, 180_000);

function savedOpenSurface(prefix: string, owner = 'surface', reverseOrder = false) {
  const document = createEmptyPartDocument(), source = document.sketches[0];
  const lines: readonly SketchLineFeature[] = [
    { id: `${prefix}-a`, name: 'A', kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(20, 0, 0) },
    { id: `${prefix}-b`, name: 'B', kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(20, 0, 0), to: absoluteCoordinate(20, 15, 0) },
  ];
  const sketch: SketchDocument = { ...source, features: reverseOrder ? [...lines].reverse() : lines };
  const surface: SurfaceFeature = { id: owner, name: 'Open sweep', kind: 'surface', suppressed: false,
    operation: { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: lines.map(line => line.id) },
      distance: expressionValueFromNumber(10), reversed: false } };
  return appendSolid(replaceSketch(document, sketch), surface);
}

it('carries saved open-line owners through recompute and separates replaced or equal-geometry owners', async () => {
  const document = savedOpenSurface('first'), first = resolvePart(document);
  const reordered = resolvePart(savedOpenSurface('first', 'surface', true));
  const replaced = resolvePart(savedOpenSurface('replacement'));
  const otherOwner = resolvePart(savedOpenSurface('first', 'other-surface'));
  for (const result of [first, reordered, replaced, otherOwner]) expect(result.errors).toEqual([]);
  expect(first.steps[0].key).toBe(reordered.steps[0].key);
  expect(first.steps[0].key).not.toBe(replaced.steps[0].key);
  expect(first.steps[0].key).not.toBe(otherOwner.steps[0].key);
  const api = createKernelApi(() => Promise.resolve(oc)), bridge = createDirectKernelBridge(api);
  const partId = 'saved-open-surface';
  try {
    for (const [generation, current] of [document, savedOpenSurface('replacement')].entries()) {
      const result = await recomputePart(current, bridge, { partId, generation: generation + 1 });
      try {
        expect(result.errors).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        const body = result.bodies[0];
        expect(body.bodyKind).toBe('shell');
        expect(body.faces).toHaveLength(2);
        expect(body.origins?.state).toBe('tracked');
        if (body.origins?.state !== 'tracked') throw new Error('Native saved-line origins missing');
        expect(body.origins.bindings).toHaveLength(2);
        expect(body.origins.bindings.map(binding => binding.origin.identity)).toEqual(
          ['a', 'b'].map(suffix => ({ kind: 'surface-side', featureId: 'surface', profile: {
            sketchId: current.sketches[0].id,
            lineFeatureId: `${generation === 0 ? 'first' : 'replacement'}-${suffix}`, role: 'whole-line' } })));
      } finally { await result.referenceMeshScope?.close(); }
    }
  } finally { await api.releasePart(partId); bridge.dispose(); }
}, 180_000);

it('does not invent open surface provenance for a missing source line', () => {
  const document = savedOpenSurface('first'), sketch = document.sketches[0];
  const missing = replaceSketch(document, { ...sketch, features: sketch.features.filter(feature => feature.id !== 'first-b') });
  const resolved = resolvePart(missing);
  expect(resolved.errors.some(error => error.featureId === 'surface')).toBe(true);
  expect(resolved.steps.some(step => step.featureId === 'surface')).toBe(false);
});
