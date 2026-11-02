/// <reference lib="dom" />
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';
import { modalFixture } from '../../packages/fem/src/modal.testSupport.js';
import { beamWeldSpanContactInputSha256, type BeamWeldSpanContactInput } from '../../packages/fem/src/beamWeldSpanContact.js';
import { recoverBeamWeldSpanStress } from '../../packages/fem/src/beamWeldSpanStress.js';
import { WELD_SPAN_CONTACT_ASSETS } from '../../packages/fem/src/beamWeldSpanAssets.js';

// Real Worker and packaged Pyodide/NumPy/OOFEM. Numerical input is a declared analytic benchmark,
// never a store/source replacement or injected solver reply. Samples are Gauss values, not exact maxima.
declare global {
  interface Window {
    pcadFemReply?: (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => Promise<void>;
    pcadFemWorkers?: Map<number, Worker>;
  }
}

/** Bridges FemWorkerPort to page Workers. terminate() really terminates the browser Worker. */
async function browserWorkers(page: Page) {
  const ports = new Map<number, BrowserWorker>();
  const errors: string[] = [];
  const messages: { id: number; kind: string; data: unknown }[] = [];
  await page.exposeFunction('pcadFemReply', (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => {
    if (messages.length >= 64) { errors.push('Worker message observation bound'); return; }
    messages.push({ id, kind, data: structuredClone(data) });
    if (kind === 'error') errors.push(String(data));
    ports.get(id)?.deliver(kind, data);
  });
  await page.evaluate(() => { window.pcadFemWorkers = new Map(); });
  class BrowserWorker implements FemWorkerPort {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
    private readonly ready: Promise<void>;
    constructor(readonly id: number) {
      ports.set(id, this);
      this.ready = page.evaluate(workerId => {
        const worker = new Worker(new URL('./fem/worker.js', document.baseURI), { name: 'pointercad-linear-beam' });
        worker.onmessage = event => { void window.pcadFemReply?.(workerId, 'message', event.data); };
        worker.onerror = event => { void window.pcadFemReply?.(workerId, 'error', event.message); };
        worker.onmessageerror = () => { void window.pcadFemReply?.(workerId, 'messageerror', null); };
        window.pcadFemWorkers?.set(workerId, worker);
      }, id);
    }
    postMessage(message: FemRequest): void {
      void this.ready.then(() => page.evaluate(([workerId, request]) => {
        window.pcadFemWorkers?.get(workerId)?.postMessage(request);
      }, [this.id, message] as const));
    }
    terminate(): void {
      ports.delete(this.id);
      void this.ready.then(() => page.evaluate(workerId => {
        window.pcadFemWorkers?.get(workerId)?.terminate();
        window.pcadFemWorkers?.delete(workerId);
      }, this.id));
    }
    deliver(kind: 'message' | 'error' | 'messageerror', data: unknown): void {
      if (kind === 'message') this.onmessage?.(new MessageEvent('message', { data }));
      else if (kind === 'messageerror') this.onmessageerror?.(new MessageEvent('messageerror', { data: null }));
      // Node may lack ErrorEvent; an unrecognized reply still fails the request as invalid-protocol, never as success.
      else if (typeof ErrorEvent === 'function') this.onerror?.(new ErrorEvent('error', { message: String(data) }));
      else this.onmessage?.(new MessageEvent('message', { data: { browserWorkerError: String(data) } }));
    }
  }
  let next = 0;
  return {
    errors, messages,
    create: (): FemWorkerPort => new BrowserWorker(++next),
    live: (): Promise<number> => page.evaluate(() => window.pcadFemWorkers?.size ?? -1),
  };
}



function input(segments = 1): BeamWeldSpanContactInput {
  const base = modalFixture({ free: true, modes: 1, segments });
  return { schema: 'pointercad-weld-span/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base, nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1, 0, -1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
}

const FACTORS = [1, 0, -1] as const;
function precise(actual: number, expected: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  if (expected === 0) expect(Math.abs(actual)).toBeLessThanOrEqual(1e-12);
  else expect(Math.abs((actual - expected) / expected)).toBeLessThanOrEqual(1e-9);
}
async function persist(info: TestInfo, name: string, value: unknown): Promise<string> {
  const file = info.outputPath(name);
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return file;
}

// Independent EA/L and exact piecewise-linear layer integrals; no solver output generates these expectations.
for (const segments of [1, 2]) test(`native long-weld stress: ${segments} element(s) per beam`, async ({ page }, info) => {
  const startedAt = performance.now(), source = input(segments), before = JSON.stringify(source);
  const displacements = segments === 1 ? [0, 8/9500, 0, 11/9500] : [0, 76/97000, 0, 118/97000, 47/97000, 50/97000];
  const first = segments === 1 ? [4/19, 8/19, 0, 0] : [1/97, 29/97, 0, 0, 18/97, 0];
  const second = segments === 1 ? [0, 0, -4/19, -8/19] : [0, 0, -1/97, -29/97, 0, -18/97];
  const force = segments === 1 ? 12/19 : 48/97, energy = segments === 1 ? 3/45125 : 159/2352250;
  const expected = { factors: FACTORS, displacements, first, second, forceN: force, energyJ: energy,
    stressFormula: segments === 1 ? 'tau_s=2000*factor*3*x/19000 Pa' : 'tau_s=2000*factor*(x<1?3*x:39*x-36)/97000 Pa',
    normalPa: 0, shearAcrossPa: 0, areaM2: 2, meshNodes: segments === 1 ? 4 : 6 };
  const raw: Record<string, unknown> = { input: source, expected, passed: false, nativeResultReceived: false };
  const artifacts: string[] = [], pageErrors: string[] = [], requests: string[] = [], responseErrors: string[] = [];
  const responses: { url: string; status: number; bytes: number; sha256: string }[] = [];
  const pendingResponses: Promise<void>[] = [];
  let started = 0, closed = 0, origin = '', failure: unknown = null, cleanupFailure: unknown = null;
  let bridge: Awaited<ReturnType<typeof browserWorkers>> | null = null, client: FemClient | null = null;
  const controller = new AbortController(); let deadline: ReturnType<typeof setTimeout> | undefined;
  page.on('pageerror', error => { pageErrors.push(error.message); });
  page.on('request', request => { requests.push(request.url()); });
  page.on('worker', worker => { if (/\/fem\/worker\.js$/u.test(worker.url())) { started += 1; worker.once('close', () => { closed += 1; }); } });
  page.on('response', response => {
    const name = new URL(response.url()).pathname;
    if (!name.endsWith('/fem/worker.js') && !WELD_SPAN_CONTACT_ASSETS.some(p => name.endsWith('/fem/assets/' + p.file))) return;
    pendingResponses.push(response.body().then(bytes => { responses.push({ url: response.url(), status: response.status(),
      bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }); },
    (error: unknown) => { responseErrors.push(String(error)); }));
  });
  try {
    artifacts.push(await persist(info, 'native-weld-input.json', { input: source, expected }));
    await page.goto('/'); origin = new URL(page.url()).origin;
    bridge = await browserWorkers(page); client = new FemClient(bridge.create);
    const remainingMs = info.timeout - (performance.now() - startedAt) - 30_000;
    if (remainingMs <= 0) throw new Error('No remaining finite functional budget before actual request');
    raw.requestBudgetMs = remainingMs; deadline = setTimeout(() => { controller.abort(); }, remainingMs);
    const phases: FemPhase[] = [];
    const completion = await client.analyzeWeldSpanContact(source, { signal: controller.signal, onPhase: phase => { phases.push(phase); } });
    raw.completion = completion; raw.phases = phases; raw.nativeResultReceived = completion.kind === 'result';
    // Persist the actual owned response and transport before numerical or stress assertions.
    artifacts.push(await persist(info, 'native-weld-response.json', { input: source, expected, completion, phases, messages: bridge.messages }));
    expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
    if (completion.kind !== 'result') throw new Error('No actual native long-weld result');
    const result = completion.result, stress = await recoverBeamWeldSpanStress(source, result);
    raw.stress = stress;
    artifacts.push(await persist(info, 'native-weld-stress.json', stress));
    const hash = await beamWeldSpanContactInputSha256(source);
    expect(result.kind).toBe('oofem-beam-weld-span-contact'); expect(result.inputSha256).toBe(hash);
    expect(result.structuralCertification).toBe(false); expect(stress.inputSha256).toBe(hash); expect(stress.structuralCertification).toBe(false);
    expect(result.states.map(s => s.loadFactor)).toEqual(FACTORS); expect(stress.states.map(s => s.loadFactor)).toEqual(FACTORS);
    for (const [index, factor] of FACTORS.entries()) {
      const state = result.states[index], weld = state.welds[0], sampled = stress.states[index].welds[0];
      expect(state.meshNodes).toHaveLength(expected.meshNodes); expect(state.welds).toHaveLength(1);
      expect(result.contact.states[index].nodes).toHaveLength(4);
      expect(result.contact.states[index].contacts[0].state).toBe('open');
      precise(result.contact.states[index].contacts[0].gapM, .01-factor*displacements[3]);
      state.meshNodes.forEach((node, at) => {
        expect(node.number).toBe(at+1); precise(node.displacementM[0], factor*displacements[at]);
        node.displacementM.slice(1).forEach(v => precise(v, 0)); node.rotationRad.forEach(v => precise(v, 0));
      });
      for (const [at, values] of weld.first.entries()) values.forEach((v, axis) => precise(v, axis === 0 ? factor*first[at] : 0));
      for (const [at, values] of weld.second.entries()) values.forEach((v, axis) => precise(v, axis === 0 ? factor*second[at] : 0));
      precise(weld.forceOnFirstN[0], factor*force); weld.forceOnFirstN.slice(1).forEach(v => precise(v, 0));
      weld.momentAtCenterNm.forEach(v => precise(v, 0)); precise(weld.energyJ, factor*factor*energy);
      expect(sampled.sampling).toBe('gauss-4x2-per-cell'); expect(sampled.points).toHaveLength(8*segments); expect(sampled.structuralCertification).toBe(false);
      const gauss = [-Math.sqrt((3+2*Math.sqrt(6/5))/7), -Math.sqrt((3-2*Math.sqrt(6/5))/7),
        Math.sqrt((3-2*Math.sqrt(6/5))/7), Math.sqrt((3+2*Math.sqrt(6/5))/7)];
      const positions = Array.from({ length: segments }, (_, cell) => gauss.flatMap(g => [(cell+(1+g)/2)*2/segments, (cell+(1+g)/2)*2/segments])).flat().sort((a,b) => a-b);
      sampled.points.map(p => p.positionM[0]).sort((a,b) => a-b).forEach((x, at) => precise(x, positions[at]));
      let integratedForce = 0, integratedEnergy = 0, area = 0;
      for (const point of sampled.points) {
        const x = point.positionM[0], delta = factor*(segments === 1 ? 3*x/19000 : (x<1 ? 3*x : 39*x-36)/97000);
        precise(point.positionM[1], 0); precise(Math.abs(point.positionM[2]), 1/(2*Math.sqrt(3)));
        precise(point.relativeDisplacementM[0], delta); point.relativeDisplacementM.slice(1).forEach(v => precise(v, 0));
        precise(point.shearAlongPa, 2000*delta); precise(point.normalPa, 0); precise(point.shearAcrossPa, 0);
        expect(point.areaWeightM2).toBeGreaterThan(0); area += point.areaWeightM2;
        integratedForce += point.shearAlongPa*point.areaWeightM2;
        integratedEnergy += .2*point.areaWeightM2/2*(point.normalPa**2/1000+(point.shearAlongPa**2+point.shearAcrossPa**2)/400);
      }
      precise(area, 2); precise(integratedForce, factor*force); precise(integratedEnergy, factor*factor*energy);
    }
    const altered = { ...source, patches: source.patches.map(p => ({ ...p, thicknessM: .3 })) };
    await expect(recoverBeamWeldSpanStress(altered, result)).rejects.toThrow();
    await expect(recoverBeamWeldSpanStress(source, { ...result, inputSha256: '0'.repeat(64) })).rejects.toThrow();
    const incomplete = { ...result, states: result.states.map((state, i) => i === 0 ? { ...state, meshNodes: state.meshNodes.slice(0,-1) } : state) };
    await expect(recoverBeamWeldSpanStress(source, incomplete)).rejects.toThrow();
    expect(JSON.stringify(source)).toBe(before); expect(phases).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
    await Promise.all(pendingResponses);
    for (const pin of WELD_SPAN_CONTACT_ASSETS) {
      const loaded = responses.filter(row => new URL(row.url).pathname.endsWith('/fem/assets/' + pin.file)); expect(loaded.length).toBeGreaterThan(0);
      for (const row of loaded) { expect(row.status).toBe(200); expect(row.bytes).toBe(pin.bytes); expect(row.sha256).toBe(pin.sha256); }
    }
    expect(responses.some(row => new URL(row.url).pathname.endsWith('/fem/worker.js') && row.status === 200 && row.bytes > 0)).toBe(true);
    expect(requests.some(url => new URL(url).pathname.endsWith('/fem/assets/beamContact.py'))).toBe(false);
    expect(requests.filter(url => new URL(url).origin !== origin)).toEqual([]);
    expect(responseErrors).toEqual([]); expect(bridge.errors).toEqual([]); expect(pageErrors).toEqual([]);
    await expect.poll(bridge.live).toBe(0); expect(started).toBe(1); await expect.poll(() => closed).toBe(1);
    raw.passed = true;
  } catch (error) { failure = error; raw.failure = String(error); }
  finally {
    if (deadline !== undefined) clearTimeout(deadline); controller.abort(); client?.dispose();
    try {
      if (bridge !== null) {
        await page.evaluate(() => { for (const worker of window.pcadFemWorkers?.values() ?? []) worker.terminate(); window.pcadFemWorkers?.clear(); });
        await expect.poll(bridge.live).toBe(0); await expect.poll(() => closed).toBe(started);
      }
    } catch (error) { cleanupFailure = error; raw.cleanupFailure = String(error); raw.passed = false; }
    await Promise.all(pendingResponses);
    if (pageErrors.length + responseErrors.length + (bridge?.errors.length ?? 0) > 0) { cleanupFailure ??= new Error('Browser/Worker/asset error during benchmark or cleanup'); raw.passed = false; }
    raw.cleanup = { complete: cleanupFailure === null, started, closed, clientDisposed: client !== null };
    raw.pageErrors = pageErrors; raw.workerErrors = bridge?.errors ?? []; raw.responseErrors = responseErrors;
    raw.requests = requests; raw.responses = responses; raw.messages = bridge?.messages;
    artifacts.push(await persist(info, 'native-weld-benchmark.json', raw));
    for (const file of artifacts) await info.attach(file.split(/[\\/]/u).at(-1) ?? 'native-weld', { path: file, contentType: 'application/json' });
  }
  if (failure !== null) throw failure; if (cleanupFailure !== null) throw cleanupFailure;
});
