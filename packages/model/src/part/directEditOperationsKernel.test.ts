import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { writeBrepBytes } from '../../../kernel/src/occt/brepBytes.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { solidMeshBuffers, type CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createDirectKernelBridge, type SolidBody } from '../kernelBridge.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import { resolveSubShapeReference } from '../kernelBridge/referenceResolution.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { appendSolid, createEmptyPartDocument } from './createPartDocument.js';
import { createHoleTranslateFeature, createFaceRotateFeature } from './directEditOperations.js';
import { buildEx18DirectSeed, directExpression as ev, directFaceReference, directPlanarFace,
  directImportedBrep, withEx18UnselectedBody, type Ex18DirectSeed } from './ex18RouteBuildersDirect.js';
import { resolvePart } from './resolvePart.js';
import { recomputePart } from './recomputePart.js';
import type { PrimitiveFeature } from './types.js';

const TIMEOUT = 180_000;
beforeAll(loadOcctForNode, TIMEOUT);
function boxSeed(): Ex18DirectSeed {
  const box: PrimitiveFeature = { id: 'box', name: 'box', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 4) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: ev('40'), sizeY: ev('30'), sizeZ: ev('8') } };
  return { part: appendSolid(createEmptyPartDocument(), box), targetId: box.id };
}
function edgeReference(body: SolidBody, curved = false): SubShapeRef {
  const edge = body.edges.find(item => curved ? item.curveKind === 'circle'
    : item.curveKind === 'line' && Math.hypot(item.midpoint[0] - 20, item.midpoint[1], item.midpoint[2] - 8) < 1e-6);
  if (edge === undefined) throw new Error('missing hinge');
  const semantic = createSubShapeReference(body, 'edge', edge.index);
  if (semantic !== null) return semantic;
  const ref: SubShapeRef = { bodyFeatureId: body.featureId, index: edge.index, fingerprint: { kind: 'edge',
    curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
  if (resolveSubShapeReference(body, ref).status !== 'matched') throw new Error('unresolved hinge');
  return ref;
}
function select(body: SolidBody, kind: 'holeTranslate' | 'faceRotate', value: number, curved = false) {
  const face = kind === 'holeTranslate' ? body.faces.find(item => item.surfaceKind === 'cylinder')
    : directPlanarFace(body, [0, 0, 1], 8);
  if (face === undefined) throw new Error('missing edit face');
  const common = { id: 'edit', name: 'edit', targetFeatureId: body.featureId, face: directFaceReference(body, face) };
  return kind === 'holeTranslate' ? createHoleTranslateFeature({ ...common, translation: [ev(String(value)), ev('0'), ev('0')] })
    : createFaceRotateFeature({ ...common, hinge: edgeReference(body, curved), angle: ev(String(value)) });
}
function verify(body: SolidBody, kind: 'holeTranslate' | 'faceRotate', value: number) {
  expect(body.isValid).toBe(true);
  const expected = kind === 'holeTranslate' ? 40 * 30 * 8 - Math.PI * 3 ** 2 * 8
    : 9600 + 18000 * Math.tan(value * Math.PI / 180);
  expect(Math.abs(body.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
  if (kind === 'holeTranslate') {
    const cylinder = body.faces.find(face => face.surfaceKind === 'cylinder');
    expect(cylinder).toBeDefined();
    if (cylinder === undefined) throw new Error('missing moved hole');
    expect(Math.hypot(cylinder.centroid[0] - (10 + value), cylinder.centroid[1] - 15)).toBeLessThanOrEqual(1e-6);
    expect(cylinder.radius).toBeCloseTo(3, 10);
  } else {
    const top = body.faces.find(face => face.axis !== null && face.axis[2] > 0.9);
    if (top?.axis === null || top === undefined) throw new Error('missing rotated face');
    expect(Math.abs(Math.atan2(-top.axis[1], top.axis[2]) - value * Math.PI / 180)).toBeLessThanOrEqual(1e-8);
  }
}

describe('model → plan → worker → native direct edits', () => {
  it.each([
    ['holeTranslate', 2, false], ['holeTranslate', -2, false], ['holeTranslate', 2, true],
    ['faceRotate', 5, false], ['faceRotate', -5, false], ['faceRotate', 5, true],
  ] as const)('%s %s, STEP=%s', async (kind, value, stepInput) => {
    const oc = await loadOcctForNode();
    const cache = createShapeCache<CachedSolid>(128, undefined, entry => solidMeshBuffers(entry.mesh));
    const api = createKernelApi(loadOcctForNode, cache);
    const bridge = createDirectKernelBridge(api);
    try {
      let seed = kind === 'holeTranslate' ? await buildEx18DirectSeed('A', bridge) : boxSeed();
      if (stepInput) {
        expect((await recomputePart(seed.part, bridge)).errors).toEqual([]);
        const key = resolvePart(seed.part).steps.find(step => step.featureId === seed.targetId)?.key;
        if (key === undefined) throw new Error('missing STEP key');
        const output = await api.exportShapes({ format: 'step', bodies: [{ bodyKey: key, name: null, color: null }] });
        if (output.format !== 'step') throw new Error('wrong export');
        const read = await api.importShape({ format: 'step', bytes: output.bytes });
        const imported = read.bodies[0];
        if (imported.bodyKind === 'mesh') throw new Error('wrong import');
        seed = directImportedBrep(imported.brepBytes, 'seed.step', output.bytes.byteLength);
      }
      seed = withEx18UnselectedBody(seed);
      const before = await recomputePart(seed.part, bridge, { importedShapes: seed.importedShapes });
      expect(before.errors).toEqual([]);
      const target = before.bodies.find(body => body.featureId === seed.targetId);
      if (target === undefined) throw new Error('missing target');
      const key = resolvePart(seed.part, { importedShapes: seed.importedShapes }).steps.find(step => step.featureId === seed.targetId)?.key;
      if (key === undefined) throw new Error('missing key');
      const borrowed = cache.get(key);
      if (borrowed === undefined) throw new Error('missing borrowed shape');
      const sha = () => createHash('sha256').update(writeBrepBytes(oc, borrowed.shape)).digest('hex');
      const beforeSha = sha();
      const feature = select(target, kind, value);
      const document = appendSolid(seed.part, feature);
      const snapshot = JSON.stringify(document);
      const result = await recomputePart(document, bridge, { importedShapes: seed.importedShapes });
      expect(result.errors).toEqual([]);
      expect(result.bodies.map(body => body.featureId).sort()).toEqual(['direct-unselected', 'edit']);
      const body = result.bodies.find(body => body.featureId === 'edit');
      if (body === undefined) throw new Error('missing result');
      verify(body, kind, value);
      const expectedVolume = kind === 'holeTranslate' ? 9600 - 72 * Math.PI : 9600 + 18000 * Math.tan(value * Math.PI / 180);
      const cylinder = body.faces.find(item => item.surfaceKind === 'cylinder');
      const top = body.faces.find(item => item.axis !== null && item.axis[2] > 0.9);
      process.stdout.write('EX18 model route ' + JSON.stringify({ kind, value, stepInput, volume: body.volume,
        relativeVolumeError: Math.abs(body.volume - expectedVolume) / expectedVolume,
        axisError: cylinder === undefined ? null : Math.hypot(cylinder.centroid[0] - (10 + value), cylinder.centroid[1] - 15),
        angleError: kind !== 'faceRotate' || top?.axis === null || top === undefined ? null
          : Math.abs(Math.atan2(-top.axis[1], top.axis[2]) - value * Math.PI / 180), borrowedSha: beforeSha }) + '\n');
      expect(result.bodies.find(item => item.featureId === 'direct-unselected')).toEqual(before.bodies.find(item => item.featureId === 'direct-unselected'));
      if (kind === 'holeTranslate') {
        for (const side of target.faces.filter(face => face.surfaceKind === 'plane' && face.axis?.[2] === 0)) {
          const kept = body.faces.find(face => face.surfaceKind === 'plane'
            && Math.hypot(...face.centroid.map((coordinate, i) => coordinate - side.centroid[i])) < 1e-6);
          expect(kept?.area).toBeCloseTo(side.area, 8);
        }
      }
      expect(sha()).toBe(beforeSha);
      expect(JSON.stringify(document)).toBe(snapshot);
      const again = await recomputePart(document, bridge, { importedShapes: seed.importedShapes });
      expect(again.errors).toEqual([]);
      expect(again.cacheHits).toBe(resolvePart(document, { importedShapes: seed.importedShapes }).steps.length);
      expect(again.bodies).toEqual(result.bodies);
    } finally { await api.releasePart('part:current'); cache.clear(); }
  }, TIMEOUT);

  it.each(['hole-contact', 'bottom-contact', 'unknown-face', 'other-face', 'other-hinge', 'curved-hinge'] as const)(
    'refuses %s while preserving source SHA, unrelated body, document and cache', async scenario => {
      const oc = await loadOcctForNode();
      const cache = createShapeCache<CachedSolid>(128, undefined, entry => solidMeshBuffers(entry.mesh));
      const api = createKernelApi(loadOcctForNode, cache);
      const bridge = createDirectKernelBridge(api);
      try {
        const holeShape = scenario === 'hole-contact' || scenario === 'curved-hinge';
        const seed = withEx18UnselectedBody(holeShape ? await buildEx18DirectSeed('A', bridge) : boxSeed());
        const before = await recomputePart(seed.part, bridge);
        const target = before.bodies.find(body => body.featureId === seed.targetId);
        if (target === undefined) throw new Error('missing target');
        const sourceStep = resolvePart(seed.part).steps.find(step => step.featureId === seed.targetId);
        if (sourceStep === undefined) throw new Error('missing source step');
        const borrowed = cache.get(sourceStep.key);
        if (borrowed === undefined) throw new Error('missing source cache');
        const sha = () => createHash('sha256').update(writeBrepBytes(oc, borrowed.shape)).digest('hex');
        const beforeSha = sha(), size = cache.size;
        const kind = scenario === 'hole-contact' ? 'holeTranslate' : 'faceRotate';
        let feature = select(target, kind, scenario === 'hole-contact' ? -7 : scenario === 'bottom-contact' ? -20 : 5,
          scenario === 'curved-hinge');
        if (scenario === 'other-face') feature = { ...feature, face: { ...feature.face, bodyFeatureId: 'direct-unselected' } };
        if (scenario === 'other-hinge' && feature.kind === 'faceRotate') feature = { ...feature, hinge: { ...feature.hinge, bodyFeatureId: 'direct-unselected' } };
        if (scenario === 'unknown-face') feature = { ...feature, face: { bodyFeatureId: seed.targetId, index: 9999,
          fingerprint: { kind: 'face', surfaceKind: 'sphere', area: 99, position: [1e6, 1e6, 1e6], axis: null, radius: 1 } } };
        const document = appendSolid(seed.part, feature), snapshot = JSON.stringify(document);
        const result = await recomputePart(document, bridge);
        expect(result.errors.some(error => error.featureId === 'edit' && error.message.length > 0)).toBe(true);
        expect(result.bodies).toEqual(before.bodies);
        expect(cache.size).toBe(size);
        expect(cache.get(sourceStep.key)).toBe(borrowed);
        expect(sha()).toBe(beforeSha);
        expect(JSON.stringify(document)).toBe(snapshot);
        // The same borrowed input remains usable after each rejected candidate.
        const recoveryKind = holeShape ? 'holeTranslate' : 'faceRotate';
        const recovery = await recomputePart(appendSolid(seed.part, select(target, recoveryKind, recoveryKind === 'holeTranslate' ? 2 : 5)), bridge);
        expect(recovery.errors).toEqual([]);
        const edited = recovery.bodies.find(body => body.featureId === 'edit');
        if (edited === undefined) throw new Error('missing recovery');
        verify(edited, recoveryKind, recoveryKind === 'holeTranslate' ? 2 : 5);
      } finally { await api.releasePart('part:current'); cache.clear(); }
    }, TIMEOUT);
});
