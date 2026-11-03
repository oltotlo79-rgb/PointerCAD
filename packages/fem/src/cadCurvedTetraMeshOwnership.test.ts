import { describe, expect, it } from 'vitest';
import type { AnalysisBoundarySource } from '@pointercad/model';
import type { FemClient } from './client.js';
import { cantilever } from './analysisCases.testSupport.js';
import { context, ownedClient } from './cadSolidFinite.testSupport.js';
import { meshCadCurvedBoundary } from './cadCurvedTetraMesh.js';

// Real client generation and synthetic boundary transport; no native numerical qualification is implied.
const options = { boundary: { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 },
  nodeToleranceMm: 1e-7, maximumChordDeviationMm: 1, maximumVolumeDeviationMm3: 1 };
function curvedContext() {
  const base = context();
  return { ...base, body: { ...base.body, faces: base.body.faces.map((face, index) =>
    index === 0 ? { ...face, surfaceKind: 'sphere' as const } : face) } };
}
function heldBoundary() {
  let finish: (() => void) | undefined;
  let reject: (() => void) | undefined;
  const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => new Promise((resolve, fail) => {
    finish = () => resolve({ kind: 'failed', bodyKey: request.bodyKey, code: 'fixture', message: 'fixture', faceIndex: null });
    reject = () => fail(new Error('delayed failure'));
  }) };
  return { source, finish: () => { if (finish === undefined) throw new Error('boundary not requested'); finish(); },
    fail: () => { if (reject === undefined) throw new Error('boundary not requested'); reject(); } };
}

describe('curved CAD preparation shares the real client generation', () => {
  it.each(['new-solver', 'invalid-solver', 'disposed', 'abort', 'rejected-boundary'] as const)(
    'does not cancel a newer solver or dispatch an old boundary after %s', async mode => {
      const h = ownedClient(), held = heldBoundary(), controller = new AbortController();
      const narrowed: Pick<FemClient, 'meshTetrahedra'> = h.client;
      const pending = meshCadCurvedBoundary(narrowed, held.source, curvedContext, options, { signal: controller.signal });
      let newer: ReturnType<FemClient['analyze']> | undefined;
      try {
        expect(h.requests).toHaveLength(0);
        if (mode === 'new-solver' || mode === 'rejected-boundary') newer = h.client.analyze(cantilever());
        else if (mode === 'invalid-solver') await expect(h.client.analyze({})).rejects.toThrow();
        else if (mode === 'disposed') h.client.dispose();
        else controller.abort();
        if (mode === 'rejected-boundary') held.fail(); else held.finish();
        await expect(pending).resolves.toEqual({ kind: 'cancelled', reason:
          mode === 'new-solver' || mode === 'invalid-solver' || mode === 'rejected-boundary' ? 'superseded' : mode });
        expect(h.requests.filter(request => request.kind === 'mesh-cad-convex-tetra')).toHaveLength(0);
        if (newer !== undefined) {
          expect(h.workers).toHaveLength(1);
          expect(h.workers[0].terminations).toBe(0);
          h.client.dispose();
          await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
        } else expect(h.workers).toHaveLength(0);
      } finally { held.finish(); h.client.dispose(); await pending; if (newer !== undefined) await newer; }
    });

  it('does not release an existing finite lease on a boundary failure', async () => {
    const h = ownedClient(), lease = h.client.beginSolidFinitePreparation(), held = heldBoundary();
    try {
      const pending = meshCadCurvedBoundary(lease, held.source, curvedContext, options, { signal: lease.signal });
      held.finish();
      await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'fixture' });
      expect(lease.cancellation()).toBeNull();
      expect(lease.signal.aborted).toBe(false);
      expect(h.requests).toHaveLength(0);
    } finally { lease.release(); h.client.dispose(); }
  });
});
