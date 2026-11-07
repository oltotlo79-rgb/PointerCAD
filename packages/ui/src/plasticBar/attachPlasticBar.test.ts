import type { FemWorkerPort, PlasticBarInput } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachPlasticBar } from './attachPlasticBar.js';
import { BENCHMARK_EDITS, PLATEAU_EDITS, benchmarkResult } from './plasticBar.testSupport.js';
import { createPlasticBarSession, plasticBarResultIsCurrent, type PlasticBarEdit,
  type PlasticBarSession } from './plasticBarSession.js';

/** Pinned expected values: the same literals as the product constants, kept independent of them. */
const BENCHMARK_REFERENCE = 'Test benchmark constants, not a material specification';

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}
let attachment: ReturnType<typeof attachPlasticBar> | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });

const REFERENCE = BENCHMARK_REFERENCE;
const BENCHMARK = BENCHMARK_EDITS;
function session(): PlasticBarSession {
  const value = useAppStore.getState().plasticBarSession;
  if (value === null) throw new Error('No plastic-bar session');
  return value;
}
function opened(edits: readonly PlasticBarEdit[] = BENCHMARK): Port[] {
  const fixture = bucklingUiFixture(), ports: Port[] = [];
  useAppStore.setState({ ...fixture.state });
  attachment = attachPlasticBar(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().openPlasticBar();
  for (const edit of edits) useAppStore.getState().editPlasticBar(edit);
  return ports;
}
async function dispatched(): Promise<{ port: Port; ports: Port[]; input: PlasticBarInput }> {
  const ports = opened();
  useAppStore.getState().runPlasticBar();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port.request;
  if (request?.kind !== 'analyze-plastic-bar-1d') throw new Error('Expected a plastic-bar request');
  return { port, ports, input: request.input };
}
const resultFor = benchmarkResult;
function message(port: Port, data: unknown): void {
  const callback = port.onmessage;
  if (callback === null) throw new Error('Worker callback already released');
  callback(new MessageEvent('message', { data }));
}

describe('plastic-bar attachment, conversion and stale/cancelled responses', () => {
  it('starts with empty material values and never runs without a stated source', () => {
    const fresh = createPlasticBarSession('document');
    expect([fresh.draft.values.young, fresh.draft.values.poisson, fresh.draft.values.yieldStress,
      fresh.draft.values.hardening, fresh.draft.reference]).toEqual(['', '', '', '', '']);
    const ports = opened(BENCHMARK.filter(edit => edit.kind !== 'reference'));
    useAppStore.getState().runPlasticBar();
    expect(session().errorKey).toBe('plasticBar.error.source');
    expect(ports).toHaveLength(0);
  });

  it('rejects a plan outside the small-strain bound before creating a Worker', () => {
    const ports = opened([...BENCHMARK, { kind: 'knot', index: 0, source: '100' }]);
    useAppStore.getState().runPlasticBar();
    expect(session().errorKey).toBe('plasticBar.error.plan');
    expect(session().diagnostic).toContain('small-strain');
    expect(ports).toHaveLength(0);
  });

  it('sends the SI plan bound to the document revision and shows the matching result', async () => {
    const { port, input } = await dispatched();
    expect(input.plan).toEqual({ schema: 'pointercad-oofem-plastic-bar-plan/1', lengthM: 1, areaM2: 1e-4,
      material: { youngPa: 200e9, poisson: 0.3, yieldStressPa: 250e6, hardeningModulusPa: 2e9,
        source: { kind: 'user-supplied', reference: REFERENCE } },
      endDisplacementM: [0, 2.5e-3, 0, -2.5e-3, 0], stepsPerSegment: 1 });
    expect(input.source).toEqual({ documentId: session().ownerId, revision: session().revision });
    const result = await resultFor(input);
    const identity = port.request?.identity;
    message(port, { protocol: 'pointercad-fem/1', kind: 'phase', identity, phase: 'solving' });
    expect(session().phase).toBe('solving');
    message(port, { protocol: 'pointercad-fem/1', kind: 'result', identity, result });
    await vi.waitFor(() => expect(session().status).toBe('complete'));
    expect(session().result).toEqual(result);
    expect(plasticBarResultIsCurrent(session())).toBe(true);
    expect(session().result?.yielded).toBe(true);
    expect(port.terminated).toBe(1);
  });

  it('an edit while solving cancels and terminates the Worker; the captured late result is ignored', async () => {
    const { port, input } = await dispatched();
    const callback = port.onmessage, identity = port.request?.identity, before = session().revision;
    message(port, { protocol: 'pointercad-fem/1', kind: 'phase', identity, phase: 'solving' });
    useAppStore.getState().editPlasticBar({ kind: 'value', field: 'hardening', source: '3000' });
    expect(port.terminated).toBe(1);
    expect(port.onmessage).toBeNull();
    callback?.(new MessageEvent('message', { data: { protocol: 'pointercad-fem/1', kind: 'result', identity,
      result: await resultFor(input) } }));
    await Promise.resolve();
    expect(session().status).toBe('editing');
    expect(session().result).toBeNull();
    expect(session().revision).toBe(before + 1);
  });

  it('cancel keeps no result and a late result of the cancelled run is ignored', async () => {
    const { port, input } = await dispatched();
    const callback = port.onmessage, identity = port.request?.identity;
    useAppStore.getState().cancelPlasticBar();
    expect(session().status).toBe('cancelled');
    expect(port.terminated).toBe(1);
    callback?.(new MessageEvent('message', { data: { protocol: 'pointercad-fem/1', kind: 'result', identity,
      result: await resultFor(input) } }));
    await Promise.resolve();
    expect(session().result).toBeNull();
    expect(session().status).toBe('cancelled');
  });

  it('a result for an earlier revision is not current, and switching documents closes the session', async () => {
    const { port, input } = await dispatched();
    message(port, { protocol: 'pointercad-fem/1', kind: 'result', identity: port.request?.identity, result: await resultFor(input) });
    await vi.waitFor(() => expect(session().status).toBe('complete'));
    expect(plasticBarResultIsCurrent({ ...session(), revision: session().revision + 1 })).toBe(false);
    expect(plasticBarResultIsCurrent({ ...session(), ownerId: 'another-document' })).toBe(false);
    useAppStore.getState().runPlasticBar();
    const second = attachment?.statistics();
    expect(second?.live).toBe(1);
    useAppStore.setState({ activeDocumentId: 'another-document' });
    expect(useAppStore.getState().plasticBarSession).toBeNull();
    expect(attachment?.statistics().live).toBe(0);
  });

  it('starts with an empty plateau and sends no plateau key for it (the original law)', async () => {
    expect(createPlasticBarSession('document').draft.values.plateau).toBe('');
    const { input } = await dispatched();
    expect(Object.hasOwn(input.plan.material, 'plateauPlasticStrain')).toBe(false);
  });

  it('sends a 1% plateau as 0.01 in the plan, shows only its plateau result, and a plateau edit or document switch drops it', async () => {
    const ports = opened(PLATEAU_EDITS);
    useAppStore.getState().runPlasticBar();
    await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
    const port = ports[0], request = port.request;
    if (request?.kind !== 'analyze-plastic-bar-1d') throw new Error(`Expected a plastic-bar request, got ${session().errorKey}`);
    expect(request.input.plan.material).toEqual({ youngPa: 200e9, poisson: 0.3, yieldStressPa: 250e6, hardeningModulusPa: 2e9,
      plateauPlasticStrain: 0.01, source: { kind: 'user-supplied', reference: REFERENCE } });
    const result = await resultFor(request.input);
    expect(result.method).toBe('oofem-misesmat-htype1-truss1d-staticstructural/1');
    message(port, { protocol: 'pointercad-fem/1', kind: 'result', identity: request.identity, result });
    await vi.waitFor(() => expect(session().status).toBe('complete'));
    expect(plasticBarResultIsCurrent(session())).toBe(true);
    // Hand-derived plateau response (plasticBar.testSupport PLATEAU_STEPS): the stress stays at sigma0 = 250 MPa.
    expect(session().result?.samples.map(sample => sample.stressPa)).toEqual([250e6, -250e6, -250e6, 250e6]);
    const revision = session().revision;
    useAppStore.getState().editPlasticBar({ kind: 'value', field: 'plateau', source: '2%' });
    expect(session().result).toBeNull();
    expect(session().status).toBe('editing');
    expect(session().revision).toBe(revision + 1);
    useAppStore.getState().runPlasticBar();
    await vi.waitFor(() => expect(ports[1]?.request).toBeTruthy());
    const second = ports[1]?.request;
    if (second?.kind !== 'analyze-plastic-bar-1d') throw new Error('Expected a second plastic-bar request');
    expect(second.input.plan.material.plateauPlasticStrain).toBe(0.02);
    useAppStore.setState({ activeDocumentId: 'another-document' });
    expect(useAppStore.getState().plasticBarSession).toBeNull();
    expect(attachment?.statistics().live).toBe(0);
  });

  it('dispose releases the runner, the session and every Worker', async () => {
    await dispatched();
    attachment?.dispose();
    expect(useAppStore.getState().plasticBarRunner).toBeNull();
    expect(useAppStore.getState().plasticBarSession).toBeNull();
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });
});
