import { expect, test, type Page } from '@playwright/test';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';
import type { SolidModalInput } from '../../packages/fem/src/solidModalModel.js';

// The production FemClient runs in the test process; every request reaches the actual browser classic Worker built
// from packages/fem/src/worker.ts (fem/worker.js, same URL and name as createProductFemWorker in productWorker.ts),
// which loads the packaged Pyodide, NumPy, OOFEM and solidModal.py through the offline loader. No reply is canned.
declare global {
  interface Window {
    pcadFemReply?: (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => Promise<void>;
    pcadFemWorkers?: Map<number, Worker>;
  }
}

const RHO = 7.85e-9;
const source = { documentId: 'browser-modal', revision: 4, meshKey: 'tet:4' };
/** Unit tet (L = 10 mm, nu = 0) with node 1 x and node 2 x free: K = diag(E L / 6, E L / 12),
 * M = rho V / 20 [[2, 1], [1, 2]], V = L^3 / 6; the 2 x 2 generalized eigenproblem is solved in closed form below. */
function supported(): SolidModalInput {
  return { schema: 'pointercad-solid-tet4-modal/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7850 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }], modeCount: 2 };
}
function closedForm(): number[] {
  const volume = 1000 / 6, k1 = 205000 * 10 / 6, k2 = 205000 * 10 / 12, d = RHO * volume / 10, o = RHO * volume / 20;
  const a = d * d - o * o, b = d * (k1 + k2), root = Math.sqrt(b * b - 4 * a * k1 * k2), larger = (b + root) / (2 * a);
  return [k1 * k2 / (a * larger), larger];
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

test.describe('solid modal on the actual browser Worker and packaged OOFEM', () => {
  test('the production client solves the closed-form supported reference offline and cleans up its Worker', async ({ page }) => {
    const pageErrors: string[] = [], requests: string[] = [];
    page.on('pageerror', error => { pageErrors.push(error.message); });
    page.on('request', request => { requests.push(request.url()); });
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const bridge = await browserWorkers(page);
    const client = new FemClient(bridge.create);
    const phases: FemPhase[] = [];
    const completion = await client.analyzeSolidModal(supported(), { onPhase: phase => { phases.push(phase); } });
    expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
    if (completion.kind !== 'result') throw new Error('No actual native modal result');
    const result = completion.result;
    expect(result.source).toEqual(source);
    expect([result.applicability, result.rigidBodyModes, result.freeDofs]).toEqual(['supported', 0, 2]);
    closedForm().forEach((lambda, index) => {
      expect(Math.abs(result.modes[index].eigenvaluePerSecondSquared - lambda) / lambda).toBeLessThanOrEqual(1e-9);
    });
    expect(result.maximumElementMassError).toBeLessThanOrEqual(1e-10);
    expect(phases).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
    await expect.poll(bridge.live).toBe(0);
    expect(requests.filter(url => new URL(url).origin !== origin)).toEqual([]);
    expect(requests.some(url => url.endsWith('/fem/assets/solidModal.py'))).toBe(true);
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
    const aborted = await client.analyzeSolidModal(supported(), { signal: controller.signal,
      onPhase: phase => { if (phase === 'solving') controller.abort(); } });
    expect(aborted).toMatchObject({ kind: 'cancelled', reason: 'abort' });
    await expect.poll(() => closed).toBe(1);
    const superseded = client.analyzeSolidModal(supported());
    const current = client.analyzeSolidModal(supported());
    expect(await superseded).toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    const completion = await current;
    expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
    if (completion.kind !== 'result') throw new Error('No actual native modal result after restart');
    closedForm().forEach((lambda, index) => {
      expect(Math.abs(completion.result.modes[index].eigenvaluePerSecondSquared - lambda) / lambda).toBeLessThanOrEqual(1e-9);
    });
    // The superseded Worker may be terminated before the browser reports it as started, so only the aborted and the
    // completed Workers are required to emit close; every bridged Worker must be gone.
    await expect.poll(() => closed).toBeGreaterThanOrEqual(2);
    await expect.poll(bridge.live).toBe(0);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    client.dispose();
  });
});
