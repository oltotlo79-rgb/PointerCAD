import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';
import type { SolidAnalysisInput } from '../../packages/fem/src/solidAnalysisModel.js';
import type { AnalysisMaterialCapacity } from '../../packages/model/src/analysis/analysisModel.js';
import { solidInputSha256 } from '../../packages/fem/src/solidAnalysisTranslation.js';
import { summarizeSolidYield } from '../../packages/fem/src/solidYieldSummary.js';
import { SOLID_ASSETS } from '../../packages/fem/src/assets.js';

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


const CASES = [
  { name: 'SS400 t16 tension', forceN: 1, thicknessMm: 16, yieldMPa: 245, conditionId: 'ss400-plate-0-16' },
  { name: 'SS400 t40 compression', forceN: -2, thicknessMm: 40, yieldMPa: 235, conditionId: 'ss400-plate-16-40' },
] as const;
function capacity(value: typeof CASES[number]): AnalysisMaterialCapacity {
  return { materialConditionId: value.conditionId, condition: '圧延鋼板（熱処理の指定なし）',
    thicknessMm: value.thicknessMm, yieldMPa: value.yieldMPa, sourceId: 'jisf-g3101-draft',
    evidence: 'standard-draft', basis: 'minimum' };
}
function inputOf(value: typeof CASES[number]): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'solid-yield-native-oracle', revision: 1, meshKey: 'unit-tet' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 210000, poisson: 0, capacity: capacity(value) }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [value.forceN, 0, 0] }], surfaceLoads: [] };
}
function precise(actual: number, expected: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(actual).toBeCloseTo(expected, 12);
  if (expected !== 0) expect(Math.abs((actual - expected) / expected)).toBeLessThanOrEqual(1e-9);
}
async function persist(info: TestInfo, name: string, value: unknown): Promise<string> {
  const file = info.outputPath(name);
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return file;
}

test.describe('solid yield on actual browser Worker and packaged native OOFEM', () => {
  for (const value of CASES) test(`source-bound unit-tet benchmark ${value.name}`, async ({ page }, info) => {
    const startedAt = performance.now();
    const input = inputOf(value), before = JSON.stringify(input);
    // Independent one-DOF analytic tet: L=1mm, nu=0, K=E*L/6, V=L^3/6.
    // Elastic E is this explicit benchmark parameter; no catalog E is inferred from the yield condition.
    const E = 210000, L = 1, F = value.forceN;
    const expected = { stiffnessNPerMm: E * L / 6, displacementMm: 6 * F / (E * L),
      stressMPa: 6 * F / (L * L), energyNmm: 3 * F * F / (E * L), reactionN: -F,
      yieldRatio: value.yieldMPa / Math.abs(6 * F / (L * L)) };
    const raw: Record<string, unknown> = { input, expected, nativeResultReceived: false, passed: false };
    const artifacts: string[] = [];
    const pageErrors: string[] = [], requests: string[] = [], responseErrors: string[] = [];
    const responses: { url: string; status: number; bytes: number; sha256: string }[] = [];
    const pendingResponses: Promise<void>[] = [];
    let started = 0, closed = 0, origin = '', failure: unknown = null, cleanupFailure: unknown = null;
    let bridge: Awaited<ReturnType<typeof browserWorkers>> | null = null, client: FemClient | null = null;
    const controller = new AbortController(); let deadline: ReturnType<typeof setTimeout> | undefined;
    page.on('pageerror', error => { pageErrors.push(error.message); });
    page.on('request', request => { requests.push(request.url()); });
    page.on('worker', worker => {
      if (/\/fem\/worker\.js$/u.test(worker.url())) { started += 1; worker.once('close', () => { closed += 1; }); }
    });
    page.on('response', response => {
      if (!/\/fem\/(?:worker\.js|assets\/solidAnalysis\.py)$/u.test(new URL(response.url()).pathname)) return;
      pendingResponses.push(response.body().then(bytes => { responses.push({ url: response.url(), status: response.status(),
        bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }); },
      (error: unknown) => { responseErrors.push(String(error)); }));
    });
    try {
      artifacts.push(await persist(info, 'solid-yield-input.json', { input, expected }));
      await page.goto('/'); origin = new URL(page.url()).origin;
      bridge = await browserWorkers(page); client = new FemClient(bridge.create);
      // Retain the configured 180s test and original client 60s solve limit. Reserve its existing
      // expect(30s) window for owned cleanup; this is a finite functional budget, not a speed score.
      const remainingMs = info.timeout - (performance.now() - startedAt) - 30_000;
      if (remainingMs <= 0) throw new Error('No remaining functional budget before actual request');
      raw.requestBudgetMs = remainingMs;
      deadline = setTimeout(() => { controller.abort(); }, remainingMs);
      const phases: FemPhase[] = [];
      const completion = await client.analyzeSolid(input, { signal: controller.signal, onPhase: phase => { phases.push(phase); } });
      raw.completion = completion; raw.phases = phases; raw.nativeResultReceived = completion.kind === 'result';
      artifacts.push(await persist(info, 'solid-yield-native-response.json', { input, expected, completion, phases }));
      expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
      if (completion.kind !== 'result') throw new Error('No actual capacity-bound native result');
      const result = completion.result;
      expect(result.source).toEqual(input.source); expect(result.inputSha256).toBe(await solidInputSha256(input));
      expect(result.units).toBe('N-mm-MPa'); expect(result.structuralCertification).toBe(false);
      precise(result.displacementMm[1][0], expected.displacementMm);
      result.displacementMm.forEach((row, node) => row.forEach((number, axis) => {
        if (node !== 1 || axis !== 0) precise(number, 0);
      }));
      precise(result.elements[0].stressMPa[0], expected.stressMPa);
      result.elements[0].stressMPa.slice(1).forEach(number => precise(number, 0));
      precise(result.elements[0].strain[0], expected.displacementMm / L);
      result.reactionN.forEach((row, node) => row.forEach((number, axis) => precise(number, node === 0 && axis === 0 ? -F : 0)));
      precise(result.strainEnergyNmm, expected.energyNmm);
      precise(input.nodalLoads[0].forceN[0], F);
      precise(result.reactionN.reduce((sum, row) => sum + row[0], 0) + F, 0);
      precise(2 * result.strainEnergyNmm, F * result.displacementMm[1][0]);
      expect(result.reservedNumericBytes).toBeGreaterThan(0); expect(result.reservedNumericBytes).toBeLessThanOrEqual(input.numericBudgetBytes);
      const summary = await summarizeSolidYield(input, result); raw.summary = summary;
      precise(summary.elements[0].vonMisesMPa, Math.abs(expected.stressMPa));
      expect(summary.minimumYieldRatio).not.toBeNull();
      if (summary.minimumYieldRatio === null) throw new Error('A source-bound yield ratio was not evaluated');
      precise(summary.minimumYieldRatio, expected.yieldRatio);
      expect(summary.elements[0].capacity).toEqual(capacity(value)); expect(summary.missingMaterialIds).toEqual([]);
      expect(summary.structuralCertification).toBe(false);
      // One valid alternate material, same geometry/load: actual old response cannot authorize a new capacity epoch.
      const other = value.thicknessMm === 16 ? CASES[1] : CASES[0];
      await expect(summarizeSolidYield({ ...input, materials: [{ ...input.materials[0], capacity: capacity(other) }] }, result))
        .rejects.toThrow('current input/result mismatch');
      expect(JSON.stringify(input)).toBe(before);
      expect(phases).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
      await Promise.all(pendingResponses);
      const wrapper = SOLID_ASSETS.find(asset => asset.file === 'solidAnalysis.py');
      if (wrapper === undefined) throw new Error('Missing fixed native wrapper manifest entry');
      const loadedWrapper = responses.filter(row => new URL(row.url).pathname.endsWith('/fem/assets/solidAnalysis.py'));
      expect(loadedWrapper.length).toBeGreaterThan(0);
      for (const row of loadedWrapper) { expect(row.status).toBe(200); expect(row.bytes).toBe(wrapper.bytes); expect(row.sha256).toBe(wrapper.sha256); }
      expect(responses.some(row => new URL(row.url).pathname.endsWith('/fem/worker.js') && row.status === 200 && row.bytes > 0)).toBe(true);
      expect(requests.filter(url => new URL(url).origin !== origin)).toEqual([]);
      expect(responseErrors).toEqual([]); expect(bridge.errors).toEqual([]); expect(pageErrors).toEqual([]);
      await expect.poll(bridge.live).toBe(0); expect(started).toBe(1); await expect.poll(() => closed).toBe(1);
      raw.passed = true;
    } catch (error) { failure = error; raw.failure = String(error); }
    finally {
      if (deadline !== undefined) clearTimeout(deadline);
      controller.abort(); client?.dispose();
      try {
        if (bridge !== null) {
          await page.evaluate(() => { for (const worker of window.pcadFemWorkers?.values() ?? []) worker.terminate(); window.pcadFemWorkers?.clear(); });
          await expect.poll(bridge.live).toBe(0);
          await expect.poll(() => closed).toBe(started);
        }
      } catch (error) { cleanupFailure = error; raw.cleanupFailure = String(error); raw.passed = false; }
      await Promise.all(pendingResponses);
      if (pageErrors.length + responseErrors.length + (bridge?.errors.length ?? 0) > 0) {
        cleanupFailure ??= new Error('Browser/Worker/asset error during benchmark or cleanup'); raw.passed = false;
      }
      raw.cleanup = { complete: cleanupFailure === null, started, closed, clientDisposed: client !== null };
      raw.pageErrors = pageErrors; raw.workerErrors = bridge?.errors ?? []; raw.responseErrors = responseErrors;
      raw.requests = requests; raw.responses = responses;
      artifacts.push(await persist(info, 'solid-yield-benchmark.json', raw));
      for (const file of artifacts) await info.attach(file.split(/[\\/]/u).at(-1) ?? 'solid-yield', { path: file, contentType: 'application/json' });
    }
    if (failure !== null) throw failure;
    if (cleanupFailure !== null) throw cleanupFailure;
  });
});
