import { describe, expect, it } from 'vitest';
import type { AnalysisBoundaryReply, AnalysisBoundarySource } from '@pointercad/model';
import type { FemClient } from './client.js';
import { meshCadBoundary } from './cadTetraMesh.js';
import { cantilever } from './analysisCases.testSupport.js';
import { boundaryMesh, context, kernel, ownedClient } from './cadSolidFinite.testSupport.js';

// Real FemClient ownership; the analytic Worker/geometry fixtures do not certify native numerics.
const options = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
function heldBoundary() {
  let finish: ((reply: AnalysisBoundaryReply) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  let bodyKey: string | undefined;
  const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => {
    bodyKey = request.bodyKey;
    return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  } };
  return { source,
    finish: (): void => {
      if (finish === undefined || bodyKey === undefined) throw new Error('Boundary was not requested');
      finish({ kind: 'mesh', bodyKey, mesh: boundaryMesh() });
    },
    fail: (): void => {
      if (reject === undefined) throw new Error('Boundary was not requested');
      reject(new Error('Delayed extractor failure'));
    },
  };
}

describe('planar CAD preparation shares the real client generation', () => {
  it.each(['new-solver', 'invalid-solver', 'disposed', 'abort'] as const)(
    'cannot dispatch an old boundary after %s, including a type-narrowed real client', async mode => {
      const h = ownedClient(), current = context(), held = heldBoundary(), controller = new AbortController();
      const narrowed: Pick<FemClient, 'meshTetrahedra'> = h.client;
      const pending = meshCadBoundary(narrowed, held.source, () => current, options, { signal: controller.signal });
      let newer: ReturnType<FemClient['analyze']> | undefined;
      try {
        expect(h.requests).toHaveLength(0);
        if (mode === 'new-solver') newer = h.client.analyze(cantilever());
        else if (mode === 'invalid-solver') await expect(h.client.analyze({})).rejects.toThrow();
        else if (mode === 'disposed') h.client.dispose();
        else controller.abort();
        held.finish();
        await expect(pending).resolves.toEqual({ kind: 'cancelled',
          reason: mode === 'new-solver' || mode === 'invalid-solver' ? 'superseded' : mode });
        expect(h.requests.filter(request => request.kind === 'mesh-cad-convex-tetra')).toHaveLength(0);
        if (newer !== undefined) {
          expect(h.workers).toHaveLength(1);
          expect(h.workers[0].terminations).toBe(0);
          h.client.dispose();
          await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
          expect(h.workers[0].terminations).toBe(1);
        } else expect(h.workers).toHaveLength(0);
      } finally { held.finish(); h.client.dispose(); await pending; if (newer !== undefined) await newer; }
    });

  it('preserves supersession even if the delayed extractor rejects', async () => {
    const h = ownedClient(), held = heldBoundary();
    const pending = meshCadBoundary(h.client, held.source, context, options);
    const newer = h.client.analyze(cantilever());
    try {
      held.fail();
      await expect(pending).resolves.toEqual({ kind: 'cancelled', reason: 'superseded' });
      expect(h.workers).toHaveLength(1); expect(h.workers[0].terminations).toBe(0);
    } finally { held.finish(); h.client.dispose(); await pending; await newer; }
  });

  it('publishes one current mesh and releases only its own reservation', async () => {
    const h = ownedClient();
    try {
      const result = await meshCadBoundary(h.client, kernel(), context, options);
      expect(result.kind).toBe('result');
      expect(h.requests.map(request => request.kind)).toEqual(['mesh-cad-convex-tetra']);
      expect(h.workers.map(worker => worker.terminations)).toEqual([1]);
      const next = h.client.analyze(cantilever());
      expect(h.workers[1].terminations).toBe(0);
      h.client.dispose();
      await expect(next).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { h.client.dispose(); }
  });

  it('does not reserve again or release the existing finite lease', async () => {
    const h = ownedClient(), lease = h.client.beginSolidFinitePreparation();
    try {
      const result = await meshCadBoundary(lease, kernel(), context, options, { signal: lease.signal });
      expect(result.kind).toBe('result');
      expect(lease.cancellation()).toBeNull(); expect(lease.signal.aborted).toBe(false);
      expect(h.requests).toHaveLength(1);
      if (result.kind !== 'result') throw new Error('Expected owned mesh');
      await expect(lease.meshTetrahedra(result.mesh.input)).rejects.toThrow('already dispatched');
    } finally { lease.release(); h.client.dispose(); }
  });

  it('keeps a newer same-client boundary when the old boundary finishes last', async () => {
    const h = ownedClient(), held = heldBoundary();
    const old = meshCadBoundary(h.client, held.source, context, options);
    try {
      expect((await meshCadBoundary(h.client, kernel(), context, options)).kind).toBe('result');
      held.finish();
      await expect(old).resolves.toEqual({ kind: 'cancelled', reason: 'superseded' });
      expect(h.requests).toHaveLength(1); expect(h.workers[0].terminations).toBe(1);
    } finally { held.finish(); h.client.dispose(); await old; }
  });

  it('does not steal ownership from an analysis started by an old reservation abort listener', async () => {
    const h = ownedClient(), old = h.client.beginSolidFinitePreparation();
    let newer: ReturnType<FemClient['analyze']> | undefined;
    old.signal.addEventListener('abort', () => { newer = h.client.analyze(cantilever()); }, { once: true });
    let boundaries = 0;
    try {
      const result = await meshCadBoundary(h.client, kernel(() => { boundaries++; }), context, options);
      expect(result).toEqual({ kind: 'cancelled', reason: 'superseded' });
      expect(boundaries).toBe(0); expect(h.workers).toHaveLength(1); expect(h.workers[0].terminations).toBe(0);
      h.client.dispose();
      await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { old.release(); h.client.dispose(); if (newer !== undefined) await newer; }
  });
});
