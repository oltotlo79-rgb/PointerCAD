import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, type FemRequest } from './protocol.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { bucklingInputSha256, translateBeamBuckling } from './bucklingTranslation.js';
import { bucklingResultMatches, decodeBeamBuckling, isBeamBucklingResult } from './bucklingResults.js';

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => reverseObjectKeys(item));
  if (value !== null && typeof value === 'object') {
    const entries: [string, unknown][] = Object.entries(value);
    return Object.fromEntries(entries.reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
  }
  return value;
}

async function associatedResult() {
  const input = bucklingFixture();
  const { plan } = translateBeamBuckling(input);
  const hash = await bucklingInputSha256(input);
  const result = decodeBeamBuckling({ schema: 'pointercad-oofem-buckling-result/1',
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.length * 6 - 6, referenceEquilibriumResidual: 0, maximumStiffnessOrthogonalityError: 0,
    modes: [1, 2].map(number => ({ number, loadFactor: number, normalizedResidual: 0,
      nodes: plan.nodes.map(node => ({ number: node.number,
        translation: [0, node.number === 2 ? 1 : 0, 0], rotation: [0, 0, 0] })) })),
  }, input, hash);
  return { input, hash, result };
}

describe('explicit linear buckling core contract', () => {
  it('owns the input and preserves exact pinned translations with free bending rotations', () => {
    const input = bucklingFixture({ pinned: true });
    const before = JSON.stringify(input);
    const prepared = translateBeamBuckling(input);
    expect(prepared.plan.nodes).toHaveLength(17);
    expect(prepared.plan.members).toHaveLength(16);
    expect(prepared.plan.nodes[0].restrained).toEqual([true, true, true, true, false, false]);
    expect(prepared.plan.nodes[1].restrained).toEqual([false, true, true, false, false, false]);
    expect(prepared.plan.nodes[1].load).toEqual([-1, 0, 0, 0, 0, 0]);
    expect(prepared.input.geometry).not.toBe(input.geometry);
    expect(prepared.input.supports[0].restrained).not.toBe(input.supports[0].restrained);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('uses equivalent SI reference forces and moment scaling for metre and millimetre inputs', () => {
    const metre = translateBeamBuckling(bucklingFixture({ pinned: true })).plan;
    const mm = translateBeamBuckling(bucklingFixture({ pinned: true, millimetres: true })).plan;
    expect(mm.nodes).toEqual(metre.nodes);
    expect(mm.members).toEqual(metre.members);
    expect(mm.sections[0].iyM4).toBeCloseTo(metre.sections[0].iyM4, 24);
    expect(mm.materials[0].youngPa).toBeCloseTo(metre.materials[0].youngPa, 3);
  });

  it.each([
    { supports: [] },
    { supports: [{ nodeId: 'absent', restrained: [true, true, true, true, true, true] }] },
    { supports: [{ nodeId: 'node-0', restrained: [true, true, true] }] },
    { supports: [{ nodeId: 'node-0', restrained: [1, true, true, true, true, true] }] },
    { referenceLoads: [] },
    { referenceLoads: [{ id: 'x', kind: 'nodal', nodeId: 'node-1', force: [0, 0, 0], moment: [0, 0, 0] }] },
    { referenceLoads: [{ id: 'x', kind: 'nodal', nodeId: 'node-1', force: [Number.NaN, 0, 0], moment: [0, 0, 0] }] },
    { schema: 'pointercad-beam/1' },
    { script: 'print(1)' },
  ])('rejects invalid or implicit input before worker creation: %j', change => {
    expect(() => translateBeamBuckling({ ...bucklingFixture(), ...change })).toThrow();
  });

  it('binds load sign and physical supports into the input hash', async () => {
    const input = bucklingFixture();
    expect(await bucklingInputSha256(input)).not.toBe(await bucklingInputSha256(bucklingFixture({ loadScale: -1 })));
    expect(await bucklingInputSha256(input)).not.toBe(await bucklingInputSha256(bucklingFixture({ pinned: true })));
    // Tension is valid input; the native eigenproblem must reject absent positive modes.
    expect(translateBeamBuckling(bucklingFixture({ loadScale: -1 })).plan.nodes[1].load[0]).toBe(1);
    expect(() => decodeBeamBuckling({ schema: 'pointercad-oofem-buckling-result/1', modes: [] }, input, '0'.repeat(64))).toThrow();
  });

  it('rejects invalid eigenvalues, residuals, support motion and stale association in the decoder', async () => {
    const input = bucklingFixture();
    const { plan } = translateBeamBuckling(input);
    const hash = await bucklingInputSha256(input);
    // Protocol-only shape, explicitly not a native numerical oracle.
    const modes = [1, 2].map(number => ({ number, loadFactor: number, normalizedResidual: 0,
      nodes: plan.nodes.map(node => ({ number: node.number,
        translation: [0, node.number === 2 ? 1 : 0, 0], rotation: [0, 0, 0] })) }));
    const raw = { schema: 'pointercad-oofem-buckling-result/1', modes,
      normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
      freeDofs: plan.nodes.length * 6 - 6, referenceEquilibriumResidual: 0, maximumStiffnessOrthogonalityError: 0 };
    const result = decodeBeamBuckling(raw, input, hash);
    expect(bucklingResultMatches(result, input, hash)).toBe(true);
    for (const loadFactor of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decodeBeamBuckling({ ...raw, modes: [{ ...modes[0], loadFactor }, modes[1]] }, input, hash)).toThrow();
    }
    expect(() => decodeBeamBuckling({ ...raw, modes: [{ ...modes[0], normalizedResidual: 1.0001e-8 }, modes[1]] }, input, hash)).toThrow();
    expect(() => decodeBeamBuckling({ ...raw, modes: [{ ...modes[0], nodes: modes[0].nodes.map(node => ({
      ...node, translation: node.number === 1 ? [0, 0.01, 0] : node.translation,
    })) }, modes[1]] }, input, hash)).toThrow();
    expect(bucklingResultMatches({ ...result, source: { ...result.source, geometryRevision: 'stale' } }, input, hash)).toBe(false);
    expect(bucklingResultMatches(result, input, 'f'.repeat(64))).toBe(false);
  });


  it('accepts identical top-level, source, mode and node fields in different object insertion orders', async () => {
    const { input, hash, result } = await associatedResult();
    const reordered = reverseObjectKeys(result);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(result));
    expect(reordered).toEqual(result);
    expect(bucklingResultMatches(reordered, input, hash)).toBe(true);
  });

  it('retains exact membership, source, topology, array order and normalized values', async () => {
    const { input, hash, result } = await associatedResult();
    const missing: Record<string, unknown> = { ...result };
    delete missing.structuralCertification;
    const missingNode: Record<string, unknown> = { ...result.modes[0].nodes[1] };
    delete missingNode.nodeId;
    const nodeChange = (node: unknown): unknown => ({ ...result, modes: result.modes.map((mode, index) =>
      index === 0 ? { ...mode, nodes: mode.nodes.map((value, nodeIndex) => nodeIndex === 1 ? node : value) } : mode) });
    const invalid: readonly (readonly [string, unknown])[] = [
      ['missing field', missing], ['extra field', { ...result, extra: true }],
      ['source extra field', { ...result, source: { ...result.source, extra: true } }],
      ['mode extra field', { ...result, modes: result.modes.map(mode => ({ ...mode, extra: true })) }],
      ['node missing field', nodeChange(missingNode)],
      ['node extra field', nodeChange({ ...result.modes[0].nodes[1], extra: true })],
      ['changed source', { ...result, source: { ...result.source, geometryRevision: 'stale' } }],
      ['changed hash', { ...result, inputSha256: 'f'.repeat(64) }],
      ['mode order', { ...result, modes: [...result.modes].reverse() }],
      ['node order', { ...result, modes: result.modes.map(mode => ({ ...mode, nodes: [...mode.nodes].reverse() })) }],
      ['position', nodeChange({ ...result.modes[0].nodes[1], positionM: [999, 0, 0] })],
      ['normalization', { ...result, modes: result.modes.map(mode => ({ ...mode,
        nodes: mode.nodes.map(node => ({ ...node, translation: node.translation.map(value => value * 0.5) })) })) }],
    ];
    for (const [label, value] of invalid) expect(bucklingResultMatches(value, input, hash), label).toBe(false);
  });

  it('rejects sparse and nonfinite vectors before accepting any result, including omitted zero components', async () => {
    const { input, hash, result } = await associatedResult();
    const sparse: number[] = [];
    sparse.length = 3;
    sparse[1] = 1;
    for (const field of ['translation', 'rotation', 'positionM'] as const) {
      for (const vector of [sparse, [0, Number.NaN, 0], [0, Number.POSITIVE_INFINITY, 0]]) {
        const invalid = { ...result, modes: result.modes.map(mode => ({ ...mode,
          nodes: mode.nodes.map((node, index) => index === 1 ? { ...node, [field]: vector } : node) })) };
        expect(isBeamBucklingResult(invalid), field).toBe(false);
        expect(bucklingResultMatches(invalid, input, hash), field).toBe(false);
      }
    }
    const sparseNodes = result.modes[0].nodes.slice(0, 0);
    sparseNodes.length = result.modes[0].nodes.length;
    for (let index = 1; index < sparseNodes.length; index += 1) {
      sparseNodes[index] = result.modes[0].nodes[index];
    }
    expect(Object.hasOwn(sparseNodes, 0)).toBe(false);
    expect(sparseNodes.slice(1)).toEqual(result.modes[0].nodes.slice(1));
    expect(bucklingResultMatches({ ...result, modes: [{ ...result.modes[0], nodes: sparseNodes }, result.modes[1]] }, input, hash)).toBe(false);
  });

  it('aborts a solving worker once and ignores a captured late terminal callback', async () => {
    const observed: { request: FemRequest | null } = { request: null };
    let terminations = 0;
    const worker: FemWorkerPort = { postMessage(value) { observed.request = value; },
      terminate() { terminations += 1; }, onmessage: null, onerror: null, onmessageerror: null };
    const client = new FemClient(() => worker);
    const signal = new AbortController();
    const pending = client.analyzeBuckling(bucklingFixture(), { signal: signal.signal });
    const request = observed.request;
    if (request === null || worker.onmessage === null) throw new Error('No actual buckling dispatch');
    expect(isRequest(request)).toBe(true);
    expect(request.kind).toBe('analyze-beam-buckling-3d');
    const callback = worker.onmessage;
    callback(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase', identity: request.identity, phase: 'solving' } }));
    signal.abort();
    callback(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'failure', identity: request.identity,
      failure: { code: 'solver-failed', message: 'late' } } }));
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(terminations).toBe(1);
    expect(worker.onmessage).toBeNull();
    client.dispose();
    expect(terminations).toBe(1);
  });

  it('rejects invalid replacement asynchronously and closes the previous request', async () => {
    let terminated = 0;
    const worker: FemWorkerPort = { postMessage: () => undefined, terminate() { terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null };
    const client = new FemClient(() => worker);
    const pending = client.analyzeBuckling(bucklingFixture());
    await expect(client.analyzeBuckling({})).rejects.toBeInstanceOf(Error);
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    expect(terminated).toBe(1);
    client.dispose();
  });
});
