import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';
import { prepareNativeBoltPreload } from '../../packages/fem/src/nativeBoltPreload.js';
import { prepareNativeBoltPreloadJob, decodeNativeBoltPreloadOwned } from '../../packages/fem/src/nativeBoltPreloadBinding.js';
import { FEM_ASSETS, BOLT_CONTACT_ASSETS } from '../../packages/fem/src/assets.js';
import { WELD_CONTACT_ASSETS } from '../../packages/fem/src/beamWeldAssets.js';
import { JOINT_CONTACT_ASSETS } from '../../packages/fem/src/beamJointAssets.js';
import { JOINT_INITIAL_STRAIN_ASSETS } from '../../packages/fem/src/beamJointInitialStrainAssets.js';

// Same real browser Worker/FemClient split as solid-modal-worker and solid-buckling-worker.
// Only the response returned by packaged Pyodide/NumPy/OOFEM is decoded: no Response/route/solver stub.
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
  await page.exposeFunction('pcadFemReply', (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => {
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
    errors,
    create: (): FemWorkerPort => new BrowserWorker(++next),
    live: (): Promise<number> => page.evaluate(() => window.pcadFemWorkers?.size ?? -1),
  };
}


async function persist(info: TestInfo, name: string, value: unknown): Promise<string> {
  const file = info.outputPath(name);
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return file;
}

// Independent existing two-spring oracle: NASA TM-106943 scope as recorded in nativeBoltPreload.test.ts.
// Native Beam3d stiffness plus the existing NumPy contact LCP; not a native contact solver or certification.
const INPUT_SHA = '704aec1afdbdf7f5b4c486d4058a57b293608aa26af3b9dc5ad36b3a9f43785a';
const LOADS = [0, 1000, 4999, 5000, 5001, 0] as const;
const EXPECTED = [[4000, 4000], [4200, 3200], [4999.8, .8], [5000, 0], [5001, 0], [4000, 4000]] as const;
const PROGRAMS = ['beamContact.py', 'beamBoltContact.py', 'beamWeldContact.py', 'beamJointContact.py', 'beamJointInitialStrain.py'] as const;
function finiteClose(actual: number, expected: number, absolute: number): void {
  expect(Number.isFinite(actual)).toBe(true); expect(Math.abs(actual - expected)).toBeLessThan(absolute);
}

test('native bolt preload actual Worker: six fixed stages, independent force energy equilibrium and ownership', async ({ page }, info) => {
  const startedAt = performance.now();
  const inputBytes = readFileSync(new URL('../../packages/fem/src/nativeBoltPreload.input.fixture.json', import.meta.url), 'utf8');
  expect(createHash('sha256').update(inputBytes).digest('hex')).toBe(INPUT_SHA);
  const plan: unknown = JSON.parse(inputBytes);
  const input = { source: { documentId: 'actual-native-bolt-proof', revision: 1 }, plan };
  const before = JSON.stringify(input), prepared = await prepareNativeBoltPreload(plan, inputBytes);
  const job = await prepareNativeBoltPreloadJob(input);
  expect(prepared.inputSha256).toBe(INPUT_SHA); expect(job.prepared.plan).toEqual(prepared.plan);
  // Historical fixture bytes are pretty JSON. The actual Worker request is the strict canonical plan.
  const canonicalInputSHA256 = createHash('sha256').update(JSON.stringify(job.prepared.plan)).digest('hex');
  expect(job.prepared.inputSha256).toBe(canonicalInputSHA256);
  const raw: Record<string, unknown> = { input, inputBytesSHA256: INPUT_SHA, canonicalInputSHA256, expected: EXPECTED, nativeResultReceived: false, passed: false };
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
    const path = new URL(response.url()).pathname;
    if (!path.endsWith('/fem/worker.js') && !PROGRAMS.some(name => path.endsWith('/fem/assets/' + name))) return;
    pendingResponses.push(response.body().then(bytes => { responses.push({ url: response.url(), status: response.status(),
      bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }); }, (error: unknown) => { responseErrors.push(String(error)); }));
  });
  try {
    artifacts.push(await persist(info, 'native-bolt-input.json', { input, inputBytes, expected: EXPECTED, loads: LOADS }));
    await page.goto('/'); origin = new URL(page.url()).origin;
    bridge = await browserWorkers(page); client = new FemClient(bridge.create);
    const remainingMs = info.timeout - (performance.now() - startedAt) - 30_000;
    if (remainingMs <= 0) throw new Error('No remaining finite functional budget before actual request');
    raw.requestBudgetMs = remainingMs; deadline = setTimeout(() => { controller.abort(); }, remainingMs);
    const phases: FemPhase[] = [];
    const completion = await client.analyzeNativeBoltPreload(input, { signal: controller.signal, onPhase: phase => { phases.push(phase); } });
    raw.completion = completion; raw.phases = phases; raw.nativeResultReceived = completion.kind === 'result';
    artifacts.push(await persist(info, 'native-bolt-response.json', { input, expected: EXPECTED, completion, phases }));
    expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
    if (completion.kind !== 'result') throw new Error('No actual native preload result');
    const result = completion.result;
    expect(result.source).toEqual(input.source); expect(result.planSha256).toBe(canonicalInputSHA256);
    expect(result.nativeContactSolver).toBe(false); expect(result.structuralCertification).toBe(false);
    expect(result.method).toBe('native-beam3d-plus-series-bolt-and-existing-lcp');
    expect(result.lockAfterState).toBe(0); finiteClose(result.lockedShorteningM, 50e-6, 1e-12);
    expect(result.states.map(state => state.externalLoadN)).toEqual(LOADS);
    finiteClose(result.boltComplianceMPerN, 1e-8, 1e-18); finiteClose(result.memberComplianceMPerN, 2.5e-9, 1e-18);
    const energies: number[] = [], positions: number[] = [];
    result.states.forEach((state, index) => {
      const [n, q] = EXPECTED[index], p = LOADS[index], cb = 1e-8, cm = 2.5e-9;
      finiteClose(state.boltTensionN, n, 1e-8); finiteClose(state.memberCompressionN, q, 1e-8);
      finiteClose(state.boltTensionN - state.memberCompressionN - p, 0, 1e-8);
      finiteClose(state.elasticExtensionM, cb * n, 1e-12); finiteClose(state.extensionM, cb * n - 50e-6, 1e-12);
      finiteClose(state.gapM, index === 4 ? 1e-8 : 0, 1e-12);
      const ub = cb * n * n / 2, um = cm * q * q / 2;
      finiteClose(state.boltEnergyJ, ub, 1e-9 * ub);
      finiteClose(state.memberEnergyJ, um, Math.max(1e-9 * um, 1e-15));
      const reactions = state.supportReactions.reduce((sum, node) => sum.map((v, axis) => v + node.forceN[axis]), [0, 0, 0]);
      finiteClose(reactions[0] + p, 0, 1e-8); finiteClose(reactions[1], 0, 1e-8); finiteClose(reactions[2], 0, 1e-8);
      const numeric = result.contact.states[index]; expect(numeric.equilibriumResidual).toBeLessThanOrEqual(1e-9);
      expect(numeric.penetration).toBeLessThanOrEqual(1e-9); expect(numeric.complementarity).toBeLessThanOrEqual(1e-9);
      energies.push(state.boltEnergyJ + state.memberEnergyJ); positions.push(state.extensionM);
    });
    // Exact piecewise-linear work: split the unload across independently known Psep=5000N.
    for (let i = 1; i < energies.length; i += 1) {
      const work = i === 5
        ? (5001 + 5000) / 2 * (0 - positions[i - 1]) + 5000 / 2 * (positions[i] - 0)
        : (LOADS[i - 1] + LOADS[i]) / 2 * (positions[i] - positions[i - 1]);
      finiteClose(energies[i] - energies[i - 1], work, 1e-9 * .125050005);
    }
    const end = energies.length - 1;
    finiteClose(energies[end], energies[0], 1e-9 * .1); finiteClose(positions[end], positions[0], 1e-12);
    const changed = await prepareNativeBoltPreloadJob({ source: input.source, plan: { ...prepared.plan,
      declaration: { ...prepared.plan.declaration, modelSource: { ...prepared.plan.declaration.modelSource, reference: 'Different explicit valid source' } } } });
    expect(changed.prepared.inputSha256).not.toBe(canonicalInputSHA256);
    expect(() => decodeNativeBoltPreloadOwned(result, changed)).toThrow();
    expect(() => decodeNativeBoltPreloadOwned({ ...result, source: { ...input.source, revision: 2 } }, job)).toThrow('native-preload-result-owner');
    expect(JSON.stringify(input)).toBe(before); expect(phases).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
    await Promise.all(pendingResponses);
    const allAssets = [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS, ...JOINT_INITIAL_STRAIN_ASSETS];
    for (const name of PROGRAMS) {
      const asset = allAssets.find(row => row.file === name); if (asset === undefined) throw new Error('Missing fixed native program ' + name);
      const loaded = responses.filter(row => new URL(row.url).pathname.endsWith('/fem/assets/' + name)); expect(loaded.length).toBeGreaterThan(0);
      for (const row of loaded) { expect(row.status).toBe(200); expect(row.bytes).toBe(asset.bytes); expect(row.sha256).toBe(asset.sha256); }
    }
    expect(responses.some(row => new URL(row.url).pathname.endsWith('/fem/worker.js') && row.status === 200 && row.bytes > 0)).toBe(true);
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
    raw.requests = requests; raw.responses = responses;
    artifacts.push(await persist(info, 'native-bolt-benchmark.json', raw));
    for (const file of artifacts) await info.attach(file.split(/[\\/]/u).at(-1) ?? 'native-bolt', { path: file, contentType: 'application/json' });
  }
  if (failure !== null) throw failure; if (cleanupFailure !== null) throw cleanupFailure;
});
