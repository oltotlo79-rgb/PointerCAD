import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import { FEM_ASSETS } from '../../packages/fem/src/assets.js';
import type { FemRequest } from '../../packages/fem/src/protocol.js';
import { runBucklingNativeChecks } from '../../packages/fem/src/bucklingNative.testSupport.js';

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
  try {
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
  } finally {
    client.dispose();
    let cleanupError: string | null = null, live: number | null = null;
    try { await expect.poll(bridge.live).toBe(0); live = await bridge.live(); }
    catch (error) { cleanupError = String(error); }
    await Promise.all(assets.pending);
    const after = await sourcePins();
    const sourceStable = JSON.stringify(before) === JSON.stringify(after);
    await attachJson(info, 'beam-source-after.json', after);
    await attachJson(info, 'beam-evidence.json', {
      checksPassed, records, sourceStable, rawReplies: bridge.raw, workerErrors: bridge.errors,
      pageErrors, assets: assets.responses, assetReadErrors: assets.errors, expectedAssetPins: FEM_ASSETS,
      cleanup: { live, cleanupError },
      passed: checksPassed && sourceStable && cleanupError === null && live === 0,
    });
    expect(sourceStable, 'Source changed during the actual native run').toBe(true);
    expect(cleanupError).toBeNull();
  }
});
