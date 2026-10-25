import { expect, test } from '@playwright/test';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { parseDocument, serializeDocument } from '../../packages/io/src/pcad/documentJson.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import type { SubShapeQuery } from '../../packages/kernel/src/types.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import type { SubShapeRef } from '../../packages/model/src/geometry/subShapeRef.js';
import { createDirectKernelBridge } from '../../packages/model/src/kernelBridge.js';
import { createSubShapeReference } from '../../packages/model/src/kernelBridge/createSubShapeReference.js';
import { resolveSubShapeReference } from '../../packages/model/src/kernelBridge/referenceResolution.js';
import { appendSolid, createEmptyPartDocument, DEFAULT_PRIMITIVE_AXIS,
  replaceSolid } from '../../packages/model/src/part/createPartDocument.js';
import { resolvePart } from '../../packages/model/src/part/resolvePart.js';
import type { PrimitiveFeature } from '../../packages/model/src/part/types.js';
import { absoluteCoordinate } from '../../packages/model/src/sketch/createSketchDocument.js';

function box(id: string, height: number): PrimitiveFeature {
  return { id, name: id, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'box', sizeX: expressionValueFromNumber(40),
      sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(height) } };
}

function faceQuery(reference: SubShapeRef): Extract<SubShapeQuery, { kind: 'face' }> {
  const fingerprint = reference.fingerprint;
  if (fingerprint.kind !== 'face') throw new Error('saved face fingerprint missing');
  return { kind: 'face', index: reference.index, surfaceKind: fingerprint.surfaceKind,
    area: fingerprint.area, position: fingerprint.position, axis: fingerprint.axis,
    radius: fingerprint.radius, ...(reference.origin === undefined ? {} : { origin: reference.origin }) };
}

test('saved Box face origins resolve through a fresh native cache after reopen', async () => {
  test.setTimeout(180_000);
  const oc = await loadOcctForNode();
  const firstApi = createKernelApi(() => Promise.resolve(oc));
  const firstBridge = createDirectKernelBridge(firstApi);
  const original = appendSolid(createEmptyPartDocument(), box('box-1', 20));
  const firstPlan = resolvePart(original);
  expect(firstPlan.errors).toEqual([]);
  const first = await firstBridge.recomputeSolids(firstPlan.steps);
  expect(first.failures).toEqual([]);
  const firstBody = first.bodies[0];
  if (firstBody?.origins?.state !== 'tracked') throw new Error('native Box origin table missing');
  const face = (role: 'top' | 'bottom'): SubShapeRef => {
    const binding = firstBody.origins?.state === 'tracked' ? firstBody.origins.bindings.find(item =>
      item.origin.identity.kind === 'box-face' && item.origin.identity.role === role) : undefined;
    if (binding?.state !== 'unique') throw new Error(`native ${role} binding missing`);
    const reference = createSubShapeReference(firstBody, 'face', binding.current.index);
    if (reference?.origin === undefined) throw new Error(`native ${role} saved origin missing`);
    return reference;
  };
  const top = face('top'), bottom = face('bottom');
  const withReferences = { ...original, selectionSets: [{ id: 'faces', name: 'faces', members: [
    { kind: 'face' as const, ref: top }, { kind: 'face' as const, ref: bottom }] }] };
  const reopened = parseDocument(serializeDocument(withReferences, { savedAt: '2026-10-04T00:00:00.000Z' }));
  expect(reopened.ok).toBe(true);
  if (!reopened.ok) throw new Error('saved document did not parse');
  const [reopenedTop, reopenedBottom] = reopened.document.selectionSets[0]?.members ?? [];
  if (reopenedTop?.kind !== 'face' || reopenedBottom?.kind !== 'face') throw new Error('saved face refs missing');
  expect(reopenedTop.ref).toEqual(top);
  expect(reopenedBottom.ref).toEqual(bottom);

  // No shape, cache entry, or live reference crosses this API/bridge boundary.
  const api = createKernelApi(() => Promise.resolve(oc));
  const bridge = createDirectKernelBridge(api);
  expect(api).not.toBe(firstApi);
  expect(bridge).not.toBe(firstBridge);
  const savedSolid = reopened.document.solids[0];
  if (savedSolid?.kind !== 'primitive' || savedSolid.shape.kind !== 'box') throw new Error('saved Box missing');
  const changed = replaceSolid(reopened.document, savedSolid.id, { ...savedSolid,
    shape: { ...savedSolid.shape, sizeZ: expressionValueFromNumber(30) } });
  const changedPlan = resolvePart(changed);
  expect(changedPlan.errors).toEqual([]);
  const current = await bridge.recomputeSolids(changedPlan.steps);
  expect(current.failures).toEqual([]);
  expect(current.cacheHits).toBe(0);
  const currentBody = current.bodies[0];
  if (currentBody === undefined) throw new Error('reopened native body missing');
  const resolved = resolveSubShapeReference(currentBody, reopenedTop.ref);
  expect(resolved.status).toBe('matched');
  if (resolved.status !== 'matched') throw new Error('saved top origin did not resolve');
  expect(resolved.match.basis).toBe('semantic');
  const measured = await api.measure({ kind: 'distance', targets: [
    { bodyKey: changedPlan.steps[0].key, subShape: faceQuery(reopenedTop.ref) },
    { bodyKey: changedPlan.steps[0].key, subShape: faceQuery(reopenedBottom.ref) }] });
  expect(measured.kind).toBe('distance');
  if (measured.kind !== 'distance') throw new Error('native face distance failed');
  expect(measured.distance).toBeCloseTo(30, 6);
  expect(reopenedTop.ref).toEqual(top);
  expect(reopenedBottom.ref).toEqual(bottom);

  const otherPlan = resolvePart(appendSolid(createEmptyPartDocument(), box('box-2', 30)));
  expect(otherPlan.errors).toEqual([]);
  const other = await bridge.recomputeSolids(otherPlan.steps);
  expect(other.failures).toEqual([]);
  const otherBody = other.bodies[0];
  if (otherBody === undefined) throw new Error('other native body missing');
  expect(resolveSubShapeReference(otherBody, reopenedTop.ref).status).toBe('missing');
  const denied = await api.measure({ kind: 'distance', targets: [
    { bodyKey: otherPlan.steps[0].key, subShape: faceQuery(reopenedTop.ref) },
    { bodyKey: changedPlan.steps[0].key, subShape: faceQuery(reopenedBottom.ref) }] });
  expect(denied.kind).toBe('failed');
});
