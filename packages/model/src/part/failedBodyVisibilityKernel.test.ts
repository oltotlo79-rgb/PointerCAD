import { createHash } from 'node:crypto';
import { stdout } from 'node:process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createInspectableNativeKernelForNodeTests, initializeNativeKernelForNodeTests }
  from '../testing/createNativeKernelBridge.node.js';
import { appendEx18DirectEdit, buildEx18DirectSeed, directFaceReference, directPlanarFace,
  directImportedBrep, withEx18UnselectedBody } from './ex18RouteBuildersDirect.js';
import { EX18_ORACLE_DIRECT_SEEDS } from './ex18RouteFixtures.js';
import { compareEx18Shape } from './ex18ShapeOracle.js';
import { recomputePart } from './recomputePart.js';
import { resolvePart } from './resolvePart.js';
import { appendSolid } from './createPartDocument.js';

const TIMEOUT = 180_000;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
beforeAll(initializeNativeKernelForNodeTests, TIMEOUT);

describe('failed direct-edit input visibility with native shapes', () => {
  it.each([false, true])('preserves distinct shared-BRep input IDs with other import consumed=%s', async consumeOriginal => {
    const native = await createInspectableNativeKernelForNodeTests();
    try {
      const built = await buildEx18DirectSeed('A', native.bridge);
      await recomputePart(built.part, native.bridge);
      const key = resolvePart(built.part).steps.find(step => step.featureId === built.targetId)?.key;
      if (key === undefined) throw new Error('Missing source key');
      const bytes = native.inspectShape(key).readBrepBytes();
      const seed = directImportedBrep(bytes, 'shared.step', bytes.byteLength);
      const original = seed.part.solids[0];
      const twin = { ...original, id: 'imported-twin', name: 'Imported twin' };
      const inputs = withEx18UnselectedBody({ ...seed, part: { ...seed.part, solids: [...seed.part.solids, twin] } }).part;
      // Establish the other successful consumer before snapshotting the input to the failed edit.
      const part = consumeOriginal ? appendSolid(inputs, { id: 'other-consumer', name: 'Other import consumer',
        kind: 'boolean', suppressed: false, operation: 'union', targetFeatureId: original.id,
        toolFeatureId: 'direct-unselected' }) : inputs;
      const options = { importedShapes: seed.importedShapes };
      const resolved = resolvePart(part, options);
      const importedSteps = resolved.steps.filter(step => step.plan.kind === 'importedSolid');
      expect(new Set(importedSteps.map(step => step.key)).size).toBe(2);
      expect(importedSteps[0].key).toBe(resolvePart(seed.part, options).steps[0].key);
      const before = await recomputePart(part, native.bridge, options);
      expect(before.errors).toEqual([]);
      const warm = await recomputePart(part, native.bridge, options);
      expect(warm.cacheHits).toBe(resolved.steps.length);
      expect(warm.bodies).toEqual(before.bodies);
      const borrowed = importedSteps.map(step => native.inspectShape(step.key));
      const digests = borrowed.map(shape => sha(shape.readBrepBytes()));
      const releases = borrowed.map(shape => vi.spyOn(shape.owner, 'delete'));
      const shapeReleases = borrowed.map(shape => vi.spyOn(shape.handle, 'delete'));
      const source = before.bodies.find(body => body.featureId === twin.id);
      if (source === undefined) throw new Error('Missing twin source');
      const face = directFaceReference(source, directPlanarFace(source, [1, 0, 0], 40));
      const failed = appendEx18DirectEdit({ ...seed, part, targetId: twin.id }, face, '-28');
      const document = failed;
      const snapshot = JSON.stringify(document);
      const result = await recomputePart(document, native.bridge, { ...options, generation: 19 });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].featureId).toBe('direct-edit');
      expect(result.generation).toBe(19);
      expect(result.bodies.map(body => body.featureId)).toEqual(consumeOriginal
        ? [twin.id, 'other-consumer'] : before.bodies.map(body => body.featureId));
      expect(result.bodies.find(body => body.featureId === twin.id)).toEqual(source);
      if (!consumeOriginal) expect(result.bodies).toEqual(before.bodies);
      expect(JSON.stringify(document)).toBe(snapshot);
      expect(borrowed.map(shape => sha(shape.readBrepBytes()))).toEqual(digests);
      for (const release of [...releases, ...shapeReleases]) expect(release).not.toHaveBeenCalled();
      for (const shape of borrowed) {
        expect(shape.measure().validity).toMatchObject({ valid: true, closed: true });
        expect(compareEx18Shape(shape.measure(), EX18_ORACLE_DIRECT_SEEDS.A).failures).toEqual([]);
      }
      stdout.write('EX18 shared import IDs ' + JSON.stringify({ consumeOriginal, keys: importedSteps.map(step => step.key),
        shaBefore: digests, shaAfter: borrowed.map(shape => sha(shape.readBrepBytes())),
        warmCacheHits: warm.cacheHits, ids: result.bodies.map(body => body.featureId), generation: result.generation,
        borrowedDeleteCalls: releases.map(release => release.mock.calls.length) }) + '\n');
    } finally { vi.restoreAllMocks(); native.dispose(); }
  }, TIMEOUT);

  it.each(['saved failure', 'successful edit becomes failure', 'failure corrected'] as const)(
    '%s preserves the current input without presenting an old finished shape', async route => {
      const native = await createInspectableNativeKernelForNodeTests();
      try {
        const seed = withEx18UnselectedBody(await buildEx18DirectSeed('A', native.bridge));
        const before = await recomputePart(seed.part, native.bridge);
        expect(before.errors).toEqual([]);
        const source = before.bodies.find(body => body.featureId === seed.targetId);
        if (source === undefined) throw new Error('Missing native source');
        const face = directFaceReference(source, directPlanarFace(source, [1, 0, 0], 40));
        const key = resolvePart(seed.part).steps.find(step => step.featureId === seed.targetId)?.key;
        if (key === undefined) throw new Error('Missing native key');
        const borrowed = native.inspectShape(key), digest = sha(borrowed.readBrepBytes());
        const ownerDelete = vi.spyOn(borrowed.owner, 'delete');
        const shapeDelete = vi.spyOn(borrowed.handle, 'delete');
        const failed = appendEx18DirectEdit(seed, face, '-28');
        const corrected = appendEx18DirectEdit(seed, face, '5');
        if (route === 'successful edit becomes failure') {
          const success = await recomputePart(corrected, native.bridge);
          expect(success.errors).toEqual([]);
          expect(success.bodies.map(body => body.featureId)).toEqual(['direct-unselected', 'direct-edit']);
        }
        // JSON reconstruction represents a saved feature without importing the higher IO layer.
        const candidate = route === 'saved failure' ? structuredClone(failed) : failed;
        const documentBytes = JSON.stringify(candidate);
        const rejected = await recomputePart(candidate, native.bridge, { generation: 17 });
        const measured = borrowed.measure(), compared = compareEx18Shape(measured, EX18_ORACLE_DIRECT_SEEDS.A);
        stdout.write('EX18 failed-body ' + JSON.stringify({ route, ids: rejected.bodies.map(body => body.featureId),
          errors: rejected.errors, shaBefore: digest, shaAfter: sha(borrowed.readBrepBytes()),
          validity: measured.validity, compared, generation: rejected.generation,
          ownerDeleteCalls: ownerDelete.mock.calls.length, shapeDeleteCalls: shapeDelete.mock.calls.length }) + '\n');
        expect(rejected.cancelled).toBe(false);
        expect(rejected.generation).toBe(17);
        expect(rejected.errors).toHaveLength(1);
        expect(rejected.errors[0]).toMatchObject({ featureId: 'direct-edit' });
        expect(rejected.errors[0].message.length).toBeGreaterThan(0);
        expect.soft(rejected.bodies.map(body => body.featureId)).toEqual([seed.targetId, 'direct-unselected']);
        expect.soft(rejected.bodies.find(body => body.featureId === seed.targetId)).toEqual(source);
        expect(rejected.bodies.some(body => body.featureId === 'direct-edit')).toBe(false);
        expect(rejected.bodies.find(body => body.featureId === 'direct-unselected'))
          .toEqual(before.bodies.find(body => body.featureId === 'direct-unselected'));
        expect(JSON.stringify(candidate)).toBe(documentBytes);
        expect(sha(borrowed.readBrepBytes())).toBe(digest);
        expect(ownerDelete).not.toHaveBeenCalled();
        expect(shapeDelete).not.toHaveBeenCalled();
        expect(measured.validity).toMatchObject({ valid: true, closed: true, solidCount: 1 });
        expect(compared.volumeRelativeError).toBeLessThanOrEqual(1e-9);
        expect(compared.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
        expect(compared.failures).toEqual([]);
        if (route === 'failure corrected') {
          const repaired = await recomputePart(corrected, native.bridge, { generation: 18 });
          expect(repaired.errors).toEqual([]);
          expect(repaired.bodies.map(body => body.featureId)).toEqual(['direct-unselected', 'direct-edit']);
          expect(repaired.generation).toBe(18);
          expect(sha(borrowed.readBrepBytes())).toBe(digest);
          expect(ownerDelete).not.toHaveBeenCalled();
          expect(shapeDelete).not.toHaveBeenCalled();
        }
      } finally { vi.restoreAllMocks(); native.dispose(); }
    }, TIMEOUT,
  );
});
