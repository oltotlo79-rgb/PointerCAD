import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import { FEM_ASSETS } from '../../packages/fem/src/assets.js';
import type { FemRequest } from '../../packages/fem/src/protocol.js';
import { runBucklingNativeChecks } from '../../packages/fem/src/bucklingNative.testSupport.js';
import { runTransientNativeChecks } from '../../packages/fem/src/transientNative.testSupport.js';
import { runTransientDampingNativeChecks } from '../../packages/fem/src/transientDampingNative.testSupport.js';
import { runTransientBenchmark } from '../../packages/fem/src/transientBenchmark.testSupport.js';

// Existing production FemClient/browser Worker bridge, without result injection.
// All physics assertions and Euler tolerances remain in runBucklingNativeChecks.
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
  const raw: { id: number; kind: string; data: unknown }[] = [];
  await page.exposeFunction('pcadFemReply', (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => {
    raw.push({ id, kind, data });
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
    errors, raw,
    create: (): FemWorkerPort => new BrowserWorker(++next),
    live: (): Promise<number> => page.evaluate(() => window.pcadFemWorkers?.size ?? -1),
  };
}

/** Observe the bytes actually delivered by the existing runtime asset requests; never replace or inject responses. */
function observeAssets(page: Page) {
  const names = FEM_ASSETS.map(asset => asset.file);
  const responses: { url: string; status: number; bytes: number; sha256: string }[] = [];
  const errors: string[] = [], pending: Promise<void>[] = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (!path.endsWith('/fem/worker.js') && !names.some(name => path.endsWith('/fem/assets/' + name))) return;
    pending.push(response.body().then(bytes => { responses.push({ url: response.url(), status: response.status(),
      bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }); }, (error: unknown) => { errors.push(String(error)); }));
  });
  return { responses, errors, pending };
}
async function attachJson(info: TestInfo, name: string, value: unknown): Promise<void> {
  const file = info.outputPath(name);
  expect(file.length, 'Windows output path must stay within 240 characters').toBeLessThanOrEqual(240);
  await writeFile(file, JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'wx' });
  await info.attach(name, { path: file, contentType: 'application/json' });
}

const sourcePaths = [
  "packages/fem/src/bucklingNative.testSupport.ts",
  "packages/fem/src/transientNative.testSupport.ts",
  "packages/fem/src/transientDampingNative.testSupport.ts",
  "packages/fem/src/transientBenchmark.testSupport.ts",
  "packages/fem/src/transient.testSupport.ts",
  "packages/fem/src/transientModel.ts",
  "packages/fem/src/transientTranslation.ts",
  "packages/fem/src/transientResults.ts",
  "packages/fem/src/buckling.testSupport.ts",
  "packages/fem/src/modal.testSupport.ts",
  "packages/fem/src/client.ts",
  "packages/fem/src/protocol.ts",
  "packages/fem/src/worker.ts",
  "packages/fem/src/offlineBrowser.ts",
  "packages/fem/src/runtime.ts",
  "packages/fem/src/assets.ts",
  "packages/fem/src/bucklingModel.ts",
  "packages/fem/src/bucklingTranslation.ts",
  "packages/fem/src/bucklingResults.ts",
  "packages/fem/src/beamAnalysis.py",
  "packages/fem/runtime/assets/beamAnalysis.py",
  "packages/fem/runtime/manifest.json",
  "e2e/playwright.config.ts",
  "scripts/check.ps1",
  "e2e/tests/beam-buckling-native.spec.ts"
] as const;
async function sourcePins() {
  return Promise.all(sourcePaths.map(async path => {
    const bytes = await readFile(new URL('../../' + path, import.meta.url));
    return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}


// Preserve the original rejection object, including when evidence cleanup also fails.
async function withPreservedFailure(run: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let failed = false;
  let primary: unknown;
  try { await run(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (error) {
    if (!failed) throw error;
    console.error('Additional evidence or cleanup failure:', error);
  }
  if (failed) throw primary;
}

test('beam Euler native checks', async ({ page }, info) => {
  const before = await sourcePins();
  await attachJson(info, 'beam-source-before.json', before);
  const pageErrors: string[] = [], requests: string[] = [];
  const assets = observeAssets(page);
  page.on('pageerror', error => { pageErrors.push(error.message); });
  page.on('request', request => { requests.push(request.url()); });
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const bridge = await browserWorkers(page);
  const client = new FemClient(bridge.create);
  let records = 0, checksPassed = false;
  await withPreservedFailure(async () => {
    await runBucklingNativeChecks(client, async value => {
      records += 1;
      await attachJson(info, `beam-${String(records).padStart(2, '0')}.json`, value);
    });
    expect(records).toBe(15); // 12 validated solutions and 3 expected native refusals.
    await expect.poll(bridge.live).toBe(0);
    await Promise.all(assets.pending);
    expect(requests.filter(url => new URL(url).origin !== origin)).toEqual([]);
    for (const pin of FEM_ASSETS) {
      const observed = assets.responses.filter(response => new URL(response.url).pathname.endsWith('/fem/assets/' + pin.file));
      expect(observed.length, pin.file).toBeGreaterThan(0);
      for (const response of observed) {
        expect([response.status, response.bytes, response.sha256], pin.file).toEqual([200, pin.bytes, pin.sha256]);
      }
    }
    expect(assets.responses.some(response => new URL(response.url).pathname.endsWith('/fem/worker.js'))).toBe(true);
    expect(assets.errors).toEqual([]);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    checksPassed = true;
  }, async () => {
    const cleanupErrors: unknown[] = [];
    const attempt = async (action: () => Promise<void> | void): Promise<void> => {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    };
    let live: number | null = null, sourceStable = false;
    await attempt(() => client.dispose());
    await attempt(async () => { await expect.poll(bridge.live).toBe(0); live = await bridge.live(); });
    await attempt(async () => { await Promise.all(assets.pending); });
    await attempt(async () => {
      const after = await sourcePins();
      sourceStable = JSON.stringify(before) === JSON.stringify(after);
      await attachJson(info, 'beam-source-after.json', after);
      expect(sourceStable, 'Source changed during the actual native run').toBe(true);
    });
    const cleanupMessages = cleanupErrors.map(error => String(error));
    await attempt(() => attachJson(info, 'beam-evidence.json', {
      checksPassed, records, sourceStable, rawReplies: bridge.raw, workerErrors: bridge.errors,
      pageErrors, assets: assets.responses, assetReadErrors: assets.errors, expectedAssetPins: FEM_ASSETS,
      cleanup: { live, errors: cleanupMessages },
      passed: checksPassed && sourceStable && cleanupMessages.length === 0 && live === 0,
    }));
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Evidence or cleanup failed');
  });
});

// This uses the bundled OOFEM matrices and real Newmark computation; the result's
// nativeTransientSolver flag remains false, as asserted by both existing checks.
async function transientChecks(page: Page, info: TestInfo, label: string, expectedRecords: number,
  check: (client: FemClient, record: (value: unknown) => Promise<void>) => Promise<void>): Promise<void> {
  const before = await sourcePins();
  await attachJson(info, `${label}-source-before.json`, before);
  const pageErrors: string[] = [], requests: string[] = [];
  const assets = observeAssets(page);
  page.on('pageerror', error => { pageErrors.push(error.message); });
  page.on('request', request => { requests.push(request.url()); });
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const bridge = await browserWorkers(page);
  const client = new FemClient(bridge.create);
  let records = 0, checksPassed = false;
  await withPreservedFailure(async () => {
    await check(client, async value => {
      records += 1;
      await attachJson(info, `${label}-${String(records).padStart(2, '0')}.json`, value);
    });
    expect(records).toBe(expectedRecords);
    await expect.poll(bridge.live).toBe(0);
    await Promise.all(assets.pending);
    expect(requests.filter(url => new URL(url).origin !== origin)).toEqual([]);
    for (const pin of FEM_ASSETS) {
      const observed = assets.responses.filter(response => new URL(response.url).pathname.endsWith('/fem/assets/' + pin.file));
      expect(observed.length, pin.file).toBeGreaterThan(0);
      for (const response of observed) {
        expect([response.status, response.bytes, response.sha256], pin.file).toEqual([200, pin.bytes, pin.sha256]);
      }
    }
    expect(assets.responses.some(response => new URL(response.url).pathname.endsWith('/fem/worker.js'))).toBe(true);
    expect(assets.errors).toEqual([]);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    checksPassed = true;
  }, async () => {
    const cleanupErrors: unknown[] = [];
    const attempt = async (action: () => Promise<void> | void): Promise<void> => {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    };
    let live: number | null = null, sourceStable = false;
    await attempt(() => client.dispose());
    await attempt(async () => { await expect.poll(bridge.live).toBe(0); live = await bridge.live(); });
    await attempt(async () => { await Promise.all(assets.pending); });
    await attempt(async () => {
      const after = await sourcePins();
      sourceStable = JSON.stringify(before) === JSON.stringify(after);
      await attachJson(info, `${label}-source-after.json`, after);
      expect(sourceStable, 'Source changed during the actual transient run').toBe(true);
    });
    const cleanupMessages = cleanupErrors.map(error => String(error));
    await attempt(() => attachJson(info, `${label}-evidence.json`, {
      checksPassed, records, sourceStable, rawReplies: bridge.raw, workerErrors: bridge.errors,
      pageErrors, assets: assets.responses, assetReadErrors: assets.errors, expectedAssetPins: FEM_ASSETS,
      cleanup: { live, errors: cleanupMessages },
      passed: checksPassed && sourceStable && cleanupMessages.length === 0 && live === 0,
    }));
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Evidence or cleanup failed');
  });
}

test('beam transient real matrix and Newmark checks', async ({ page }, info) => {
  await transientChecks(page, info, 'transient', 19, runTransientNativeChecks);
});

test('beam transient damping real matrix and Newmark checks', async ({ page }, info) => {
  await transientChecks(page, info, 'damping', 14, runTransientDampingNativeChecks);
});

// Root's bounded cost/accuracy benchmark (P03) through the same procedure. runTransientBenchmark keeps all of its
// assertions (result, free DOFs, work bound, equilibrium/energy <= 1e-8) and records 3 cases + 1 decision = 4.
// The measured times are saved as evidence for Root's judgement; they add no pass condition here.
test('beam transient bounded benchmark', async ({ page }, info) => {
  await transientChecks(page, info, 'benchmark', 4, async (client, record) => {
    await runTransientBenchmark(client, record);
  });
});
