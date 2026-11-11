import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { expect, test, type Page } from '@playwright/test';
import { NETGEN_ASSETS } from '../../packages/fem/src/assets.js';
import { FemClient, type FemCompletion, type FemWorkerPort } from '../../packages/fem/src/client.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';
import { NETGEN_WHEEL, TETRA_MESH_SCHEMA, type TetraMeshInput, type TetraMeshResult } from '../../packages/fem/src/tetraMesh.js';

// Netgen modified-source replacement, Root-only. Kept in packages/fem/runtime/sources/netgen-rebuild/ and copied by
// stage_replacement.py to e2e/tests/ of an isolated copy whose Netgen wheel, runtime manifest row and NETGEN_ASSETS row
// were replaced together by the rebuilt (modified) wheel. Same bridge and route shape as the r221 OOFEM replacement:
// the production FemClient runs in the test process and every request reaches the actual classic Worker
// (fem/worker.js), whose offlineBrowser.ts checks each asset against the compiled pins (length first, then SHA-256)
// before Pyodide starts. No check is disabled and no reply is canned. Only the wheel request is routed, to read the
// actual served bytes (awaited) and to deliver the bytes of each case.
declare global {
  interface Window {
    pcadFemReply?: (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => Promise<void>;
    pcadFemWorkers?: Map<number, Worker>;
  }
}
interface Identity { readonly bytes: number; readonly sha256: string }
/** The shipped wheel (product parent). The modified identity is the rebuilt declaration compiled into this copy. */
const ORIGINAL: Identity = { bytes: 2809006, sha256: '3f0d507e8daa11b5a26654d904c529d6c1338e9a3a4c7d7728152f3596954ba3' };
const declared = NETGEN_ASSETS.filter(pin => pin.file === NETGEN_WHEEL);
const MODIFIED: Identity = { bytes: declared[0]?.bytes ?? -1, sha256: declared[0]?.sha256 ?? '' };
const identity = (bytes: Buffer): Identity => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
/** The 2 x 3 x 4 mm box of tetraMesh.test.ts (legacy convex PLC): exact volume 24 mm^3. */
const input: TetraMeshInput = { schema: TETRA_MESH_SCHEMA, units: 'mm',
  source: { documentId: 'r86-netgen-replacement', revision: 1, featureId: 'solid', bodyKey: 'solid:1' },
  coordinates: [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4, 2, 3, 4, 0, 3, 4],
  triangles: [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], tagCount: 6 };

/** Same bridge as fem-wheel-replacement (r221) and solid-modal-worker.spec.ts: FemWorkerPort to actual page Workers. */
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

interface Exchange { readonly served: Identity[]; readonly delivered: Identity[]; readonly routeErrors: string[]; readonly phases: FemPhase[] }

/** Routes only the Netgen wheel; awaits the actual served response and delivers `bytes(actual)`. Any handler error
 * aborts the request (the mesh then fails) and is reported, so a broken route can never pass silently. */
async function mesh(page: Page, bytes: (actual: Buffer) => Buffer): Promise<{ completion: FemCompletion<TetraMeshResult>; exchange: Exchange }> {
  const exchange: Exchange = { served: [], delivered: [], routeErrors: [], phases: [] };
  const pageErrors: string[] = [];
  page.on('pageerror', error => { pageErrors.push(error.message); });
  await page.route('**/fem/assets/' + NETGEN_WHEEL, async route => {
    try {
      const response = await route.fetch();
      const actual = await response.body();
      exchange.served.push(identity(actual));
      const body = bytes(actual);
      exchange.delivered.push(identity(body));
      const headers = Object.fromEntries(Object.entries(response.headers()).filter(([name]) => name !== 'content-length'));
      await route.fulfill({ status: response.status(), headers, body });
    } catch (error) {
      exchange.routeErrors.push(String(error));
      await route.abort('failed');
    }
  });
  let client: FemClient | null = null;
  try {
    await page.goto('/');
    const bridge = await browserWorkers(page);
    client = new FemClient(bridge.create);
    const completion = await client.meshTetrahedra(input, { onPhase: phase => { exchange.phases.push(phase); } });
    await expect.poll(bridge.live).toBe(0);
    expect(exchange.routeErrors).toEqual([]);
    expect(bridge.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    return { completion, exchange };
  } finally {
    client?.dispose();
    await page.unrouteAll({ behavior: 'wait' });
  }
}

function originalWheel(): Buffer {
  const path = process.env.PCAD_NETGEN_ORIGINAL_WHEEL;
  if (path === undefined || path === '') throw new Error('PCAD_NETGEN_ORIGINAL_WHEEL (the shipped product wheel) is required');
  const bytes = readFileSync(path);
  expect(identity(bytes)).toEqual(ORIGINAL);
  return bytes;
}

test.beforeAll(() => {
  // The isolated copy must declare exactly one rebuilt wheel that differs from the shipped one.
  expect(declared).toHaveLength(1);
  expect(MODIFIED.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(MODIFIED.sha256).not.toBe(ORIGINAL.sha256);
});

test('作り直した宣言で、変えた Netgen wheel を実Workerが受け入れて 2×3×4 mm の箱を体積 24 mm³ で分割する', async ({ page }) => {
  const { completion, exchange } = await mesh(page, actual => actual);
  expect(exchange.served).toEqual([MODIFIED]);
  expect(exchange.delivered).toEqual([MODIFIED]);
  expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
  if (completion.kind !== 'result') throw new Error('No product-loader result with the modified Netgen wheel');
  expect(exchange.phases).toContain('solving');
  expect(completion.result.kind).toBe('netgen-convex-tetra-mesh');
  expect(completion.result.tetrahedra.length % 4).toBe(0);
  expect(completion.result.tetrahedra.length).toBeGreaterThan(0);
  expect(Math.abs(completion.result.volumeMm3 - 24) / 24).toBeLessThanOrEqual(1e-9);
  expect(completion.result.minTetVolumeMm3).toBeGreaterThan(0);
});

test('同じアプリで、元の Netgen wheel は長さか SHA-256 の違いで断る', async ({ page }) => {
  const original = originalWheel();
  const reason = original.byteLength === MODIFIED.bytes ? 'SHA-256' : 'size';
  const { completion, exchange } = await mesh(page, () => original);
  expect(exchange.served).toEqual([MODIFIED]);
  expect(exchange.delivered).toEqual([ORIGINAL]);
  expect(completion.kind).toBe('failed');
  if (completion.kind !== 'failed') throw new Error('The original Netgen wheel must be refused');
  expect(completion.failure).toEqual({ code: 'asset-corrupt', message: `asset-corrupt: ${NETGEN_WHEEL} (${reason})` });
  expect(exchange.phases).toEqual(['loading-assets']);
});

test('同じアプリで、同じ長さで1バイトだけ変えた Netgen wheel は SHA-256 の違いで断る', async ({ page }) => {
  const { completion, exchange } = await mesh(page, actual => {
    const corrupt = Buffer.from(actual);
    const middle = corrupt.byteLength >> 1;
    corrupt.writeUInt8(corrupt.readUInt8(middle) ^ 0xff, middle);
    return corrupt;
  });
  expect(exchange.served).toEqual([MODIFIED]);
  expect(exchange.delivered.map(row => row.bytes)).toEqual([MODIFIED.bytes]);
  expect(exchange.delivered.map(row => row.sha256)).not.toContain(MODIFIED.sha256);
  expect(completion.kind).toBe('failed');
  if (completion.kind !== 'failed') throw new Error('A same-size Netgen wheel with another SHA-256 must be refused');
  expect(completion.failure).toEqual({ code: 'asset-corrupt', message: `asset-corrupt: ${NETGEN_WHEEL} (SHA-256)` });
  expect(exchange.phases).toEqual(['loading-assets']);
});
