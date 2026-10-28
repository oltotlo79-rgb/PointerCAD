import { beforeAll, describe, expect, it } from 'vitest';
import { appendSolid, recomputePart, type PartDocument, type PartRecomputeResult } from '@pointercad/model';
import { createInspectableNativeKernelForNodeTests, initializeNativeKernelForNodeTests }
  from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { appendEx18DirectEdit, buildEx18DirectSeed, directFaceReference, directPlanarFace,
  withEx18UnselectedBody } from '../../../model/src/part/ex18RouteBuildersDirect.js';
import { consumedIds, partErrorMessage } from './solidHistoryState.js';
import { summarizeSolid } from './solidSummary.js';
import { buildTreeSections } from './treeSummary.js';

const TIMEOUT = 180_000;
beforeAll(initializeNativeKernelForNodeTests, TIMEOUT);

function expectDisplayAgreement(document: PartDocument, result: PartRecomputeResult) {
  const rows = buildTreeSections(document, document.sketches[0].id, [], result.errors)
    .find(section => section.key === 'solid')?.rows;
  if (rows === undefined) throw new Error('Missing solid tree section');
  const visible = rows.filter(row => !row.suppressed && !row.consumed && !row.hasError).map(row => row.id);
  expect(visible).toEqual(result.bodies.map(body => body.featureId));
  expect(new Set(visible).size).toBe(visible.length);
  const consumed = consumedIds(document, result.errors);
  for (const feature of document.solids) {
    const row = rows.find(item => item.id === feature.id);
    expect(row?.consumed).toBe(consumed.has(feature.id));
    expect(summarizeSolid(document, feature, result.errors).consumed).toBe(row?.consumed);
    expect(row?.errorMessage).toBe(partErrorMessage(result.errors, feature.id));
  }
}

describe('history consumption agrees with native returned bodies', () => {
  it.each(['target', 'tool'] as const)('another successful boolean consumes the failed edit input as %s', async operand => {
    const native = await createInspectableNativeKernelForNodeTests();
    try {
      const seed = withEx18UnselectedBody(await buildEx18DirectSeed('A', native.bridge));
      const initial = await recomputePart(seed.part, native.bridge);
      const source = initial.bodies.find(body => body.featureId === seed.targetId);
      if (source === undefined) throw new Error('Missing native source');
      const reference = directFaceReference(source, directPlanarFace(source, [1, 0, 0], 40));
      const consumed = appendSolid(seed.part, { id: 'other-consumer', name: 'Other consumer', kind: 'boolean',
        suppressed: false, operation: 'union',
        targetFeatureId: operand === 'target' ? seed.targetId : 'direct-unselected',
        toolFeatureId: operand === 'target' ? 'direct-unselected' : seed.targetId });
      // Model prevents consuming the same input twice before native evaluation; kernel-level tests
      // separately cover the equivalent two executed steps and both boolean operands.
      const document = appendEx18DirectEdit({ ...seed, part: consumed }, reference, '-28');
      const result = await recomputePart(document, native.bridge);
      expect(result.errors.map(error => error.featureId)).toEqual(['direct-edit']);
      expect(result.errors[0].code).toBe('consumedTwice');
      expectDisplayAgreement(document, result);
      expect(result.bodies.map(body => body.featureId)).toEqual(['other-consumer']);
      expect(consumedIds(document, result.errors).has(seed.targetId)).toBe(true);
    } finally { native.dispose(); }
  }, TIMEOUT);

  it('saved failure, edited failure and correction preserve the normal input consumption', async () => {
    const native = await createInspectableNativeKernelForNodeTests();
    try {
      const seed = withEx18UnselectedBody(await buildEx18DirectSeed('A', native.bridge));
      const initial = await recomputePart(seed.part, native.bridge);
      const source = initial.bodies.find(body => body.featureId === seed.targetId);
      if (source === undefined) throw new Error('Missing native source');
      const reference = directFaceReference(source, directPlanarFace(source, [1, 0, 0], 40));
      const success = appendEx18DirectEdit(seed, reference, '5');
      const failed = appendEx18DirectEdit(seed, reference, '-28');
      for (const document of [structuredClone(failed), success, failed, success]) {
        const snapshot = JSON.stringify(document);
        const result = await recomputePart(document, native.bridge);
        expectDisplayAgreement(document, result);
        expect(JSON.stringify(document)).toBe(snapshot);
        const consumed = consumedIds(document, result.errors);
        expect(consumed.has('direct-plate')).toBe(true);
        expect(consumed.has('direct-unselected')).toBe(false);
        expect(consumed.has(seed.targetId)).toBe(result.errors.length === 0);
        if (result.errors.length !== 0) {
          expect(result.errors).toHaveLength(1);
          expect(partErrorMessage(result.errors, 'direct-edit')).toMatch(/穴/);
          expect(result.bodies.find(body => body.featureId === seed.targetId)).toEqual(source);
        }
      }
    } finally { native.dispose(); }
  }, TIMEOUT);
});
