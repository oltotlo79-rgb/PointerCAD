import { expect, test, type Page } from '@playwright/test';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';
import type { SolidBucklingInput } from '../../packages/fem/src/solidBucklingModel.js';

// Same bridge as the frozen solid-modal-worker.spec.ts: the production FemClient runs in the test process and every
// request reaches the actual browser classic Worker built from packages/fem/src/worker.ts (fem/worker.js), which loads
// the packaged Pyodide, NumPy, OOFEM and solidBuckling.py through the offline loader. No reply is canned. Until Root runs
// this, native support of Structural3DElement::computeInitialStressMatrix in the packaged wheel is UNPROVEN.
declare global {
  interface Window {
    pcadFemReply?: (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => Promise<void>;
    pcadFemWorkers?: Map<number, Worker>;
  }
}

const source = { documentId: 'browser-buckling', revision: 5, meshKey: 'tet:corner' };
interface Corner { readonly lengthMm: number; readonly youngMPa: number; readonly poisson: number; readonly loadN: number }
const BASE: Corner = { lengthMm: 10, youngMPa: 205000, poisson: 0.3, loadN: 1000 };
/** Corner tet (0,0,0),(L,0,0),(0,L,0),(0,0,L): vertices 0, 2, 3 fully prescribed, vertex 1 only z; force (-P, 0, 0) at
 * vertex 1 (compression toward the fixed face for P > 0). */
function corner(options: Partial<Corner> = {}): SolidBucklingInput {
  const { lengthMm: L, youngMPa, poisson, loadN: P } = { ...BASE, ...options };
  return { schema: 'pointercad-solid-tet4-buckling/1', modeCount: 2, reference: {
    schema: 'pointercad-solid-tet4/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa, poisson }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, false, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [-P, 0, 0] }], surfaceLoads: [] } };
}
/** Independent closed form (derived here, not read from the product). With g_1 = (1/L, 0, 0) and V = L^3/6:
 * K at the free vertex = diag(V (lambdaL + 2 mu), V mu) / L^2; the static stress sigma_xx = -P L / V gives the
 * tet4 initial-stress block Kg = V (g_1^T S g_1) I = -(P / L) I; det(K + lambda Kg) = 0 therefore has
 * lambda_y = mu L^2 / (6 P) and lambda_x = (lambdaL + 2 mu) L^2 / (6 P), ascending. */
function closedForm(options: Partial<Corner> = {}): [number, number] {
  const { lengthMm: L, youngMPa: E, poisson: nu, loadN: P } = { ...BASE, ...options };
  const mu = E / (2 * (1 + nu)), lame = E * nu / ((1 + nu) * (1 - 2 * nu));
  const volume = L ** 3 / 6, kxx = volume * (lame + 2 * mu) / L ** 2, kyy = volume * mu / L ** 2, kg = P / L;
  const factors = [kyy / kg, kxx / kg].sort((left, right) => left - right);
  return [factors[0], factors[1]];
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

test.describe('solid prestress buckling on the actual browser Worker and packaged OOFEM', () => {
  test('the production client reproduces the closed-form load factors, their 1/P and E scaling, offline', async ({ page }) => {
    const pageErrors: string[] = [], requests: string[] = [];
    page.on('pageerror', error => { pageErrors.push(error.message); });
    page.on('request', request => { requests.push(request.url()); });
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const bridge = await browserWorkers(page);
    const client = new FemClient(bridge.create);
    const phases: FemPhase[] = [];
    const first: number[] = [];
    for (const options of [{}, { loadN: 2000 }, { youngMPa: 410000 }] as const) {
      const completion = await client.analyzeSolidBuckling(corner(options), { onPhase: phase => { phases.push(phase); } });
      expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
      if (completion.kind !== 'result') throw new Error('No actual native buckling result');
      const result = completion.result;
      expect(result.source).toEqual(source);
      expect([result.scope, result.units, result.structuralCertification, result.freeDofs])
        .toEqual(['linear-elastic-prestress-bifurcation', 'N-mm-MPa', false, 2]);
      const expected = closedForm(options);
      expect(result.modes.map(mode => mode.number)).toEqual([1, 2]);
      result.modes.forEach((mode, index) => {
        expect(Math.abs(mode.loadFactor / expected[index] - 1)).toBeLessThanOrEqual(1e-9);
        expect(mode.normalizedResidual).toBeLessThanOrEqual(1e-8);
      });
      // Lowest mode: the free vertex moves sideways (y) only; prescribed vertices and z stay at zero; max translation 1.
      const shape = result.modes[0].shape;
      expect(Math.abs(shape[1][1])).toBeCloseTo(1, 10);
      expect([shape[1][0], shape[1][2]].map(Math.abs).every(value => value <= 1e-10)).toBe(true);
      expect([shape[0], shape[2], shape[3]].flat().every(value => value === 0)).toBe(true);
      expect(result.maximumElementInitialStressError).toBeLessThanOrEqual(1e-10);
      first.push(result.modes[0].loadFactor);
    }
    // Independent of the closed form: doubling P halves every factor, doubling E doubles it.
    expect(Math.abs(first[1] / first[0] - 0.5)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(first[2] / first[0] - 2)).toBeLessThanOrEqual(1e-9);
    expect(phases.slice(0, 4)).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
    await expect.poll(bridge.live).toBe(0);
    expect(requests.filter(url => new URL(url).origin !== origin)).toEqual([]);
    expect(requests.some(url => url.endsWith('/fem/assets/solidBuckling.py'))).toBe(true);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    client.dispose();
  });

  test('a tension reference state is refused natively and never reported as a load factor', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => { pageErrors.push(error.message); });
    await page.goto('/');
    const bridge = await browserWorkers(page);
    const client = new FemClient(bridge.create);
    const completion = await client.analyzeSolidBuckling(corner({ loadN: -1000 }));
    expect(completion.kind).toBe('failed');
    if (completion.kind !== 'failed') throw new Error('A tension reference state returned a result');
    expect(completion.failure.message).toContain('solid-buckling-no-positive-mode');
    await expect.poll(bridge.live).toBe(0);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    client.dispose();
  });

  test('abort during the native solve terminates the real Worker; supersession and a restarted request still solve', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => { pageErrors.push(error.message); });
    let closed = 0;
    page.on('worker', worker => { if (/\/fem\/worker\.js$/u.test(worker.url())) worker.once('close', () => { closed += 1; }); });
    await page.goto('/');
    const bridge = await browserWorkers(page);
    const client = new FemClient(bridge.create);
    const controller = new AbortController();
    const aborted = await client.analyzeSolidBuckling(corner(), { signal: controller.signal,
      onPhase: phase => { if (phase === 'solving') controller.abort(); } });
    expect(aborted).toMatchObject({ kind: 'cancelled', reason: 'abort' });
    await expect.poll(() => closed).toBe(1);
    const superseded = client.analyzeSolidBuckling(corner());
    const current = client.analyzeSolidBuckling(corner({ loadN: 2000 }));
    expect(await superseded).toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    const completion = await current;
    expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
    if (completion.kind !== 'result') throw new Error('No actual native buckling result after restart');
    // The restarted request is the P = 2000 one, not a stale reply of the superseded P = 1000 request.
    const expected = closedForm({ loadN: 2000 });
    completion.result.modes.forEach((mode, index) => {
      expect(Math.abs(mode.loadFactor / expected[index] - 1)).toBeLessThanOrEqual(1e-9);
    });
    await expect.poll(() => closed).toBeGreaterThanOrEqual(2);
    await expect.poll(bridge.live).toBe(0);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    client.dispose();
  });
});
