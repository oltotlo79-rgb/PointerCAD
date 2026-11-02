/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type ElectronApplication, type Page, type PlaywrightWorkerArgs, type TestInfo } from '@playwright/test';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { createEmptyPartDocument, createPrimitiveFeature, type PrimitiveFeature } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { parseOcctAssetManifest } from '../../packages/kernel/src/occt/occtAssetManifest.js';
import { DESKTOP_OCCT_TRANSPORT_ORIGIN, desktopOcctTransportUrl, validateDesktopOcctTransportReply } from '../../packages/kernel/src/occt/desktopOcctTransportContract.js';
import { launchDesktop, openTarget } from './electronAppFlow.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';

const rendererRoot = fileURLToPath(new URL('../../apps/desktop/dist/renderer/', import.meta.url));

// Node HTTP reads the actual owned listener's wire response without Chromium's
// fetch/CORS filtering. Renderer protection and product routing remain unchanged.
// No interception, replacement Response, asset mutation, redirects or test server.
async function deniedRequest(url: string) {
  try {
    const target = new URL(url);
    if (target.origin !== DESKTOP_OCCT_TRANSPORT_ORIGIN || target.username !== ''
      || target.password !== '' || target.hash !== '') throw new Error('Unexpected OCCT observation endpoint');
    return await new Promise<{
      requestedUrl: string; actualUrl: string; status: number; ok: boolean;
      headers: Record<string, string>; bodyBytes: number; bodyPrefix: number[];
      truncated: false; error: null;
    }>((resolve, reject) => {
      let request: ClientRequest | undefined, response: IncomingMessage | undefined;
      let settled = false, bodyBytes = 0;
      const prefix: number[] = [];
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Keep error listeners installed while destroy releases the owned socket.
        response?.destroy(); request?.destroy();
        if (error !== undefined) { reject(error); return; }
        if (response?.statusCode === undefined) { reject(new Error('HTTP status missing')); return; }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ requestedUrl: url, actualUrl: url, status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers, bodyBytes, bodyPrefix: prefix, truncated: false, error: null });
      };
      // Absolute deadline includes connection, headers, body and terminal end.
      const timer = setTimeout(() => { finish(new Error('OCCT HTTP observation timeout')); }, 25_000);
      try {
        request = get(target, { agent: false, headers: { Origin: 'app://pointercad' } }, incoming => {
          response = incoming;
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return;
            bodyBytes += chunk.byteLength;
            if (bodyBytes > 4096) { finish(new Error('OCCT HTTP observation body exceeds4096bytes')); return; }
            for (const byte of chunk) { if (prefix.length < 64) prefix.push(byte); else break; }
          });
          incoming.once('error', error => { finish(error); });
          incoming.once('aborted', () => { finish(new Error('OCCT HTTP response aborted')); });
          incoming.once('end', () => { finish(incoming.complete ? undefined : new Error('Incomplete HTTP response')); });
          incoming.once('close', () => { if (!settled) finish(new Error('HTTP response closed before end')); });
        });
        request.once('error', error => { finish(error); });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch (error) {
    return { requestedUrl: url, actualUrl: null, status: null, ok: null, headers: undefined,
      bodyBytes: null, bodyPrefix: [], truncated: null,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'unknown', message: String(error) } };
  }
}

async function openAndCheckCube(page: Page, app: ElectronApplication, fixture: string): Promise<number> {
  await openTarget(app, fixture);
  const token = await beginRecompute(page);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await waitForRecompute(page, token);
  await page.locator('.pcad-tree').getByRole('button', { name: 'transport-cube', exact: true }).click();
  const volume = page.locator('.pcad-panel--right').locator('dt.pcad-properties__key', { hasText: '体積' })
    .locator('xpath=following-sibling::dd[1]');
  // Same independent 20x20x20 mm cube used by W21's original material comparison.
  await expect.poll(async () => Math.abs(Number.parseFloat(await volume.innerText()) - 8000),
    { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
  await expect(page.locator('.pcad-tree__alert')).toHaveCount(0);
  return Number.parseFloat(await volume.innerText());
}

export async function electronOcctTransportNegative(
  playwright: PlaywrightWorkerArgs['playwright'], info: TestInfo,
): Promise<void> {
  const manifestBytes = await readFile(join(rendererRoot, 'occt/manifest.json'));
  const manifest = parseOcctAssetManifest(JSON.parse(manifestBytes.toString('utf8')));
  const { app, directory } = await launchDesktop(playwright, info);
  const child = app.process();
  const evidence: {
    scope: string; historical404Proven: false; manifestSha256: string; decodedSha256: string;
    pid: number | undefined; replies: Awaited<ReturnType<typeof deniedRequest>>[];
    geometryBefore: number | null; geometryAfter: number | null; pageErrors: string[];
    failure: string | null; cleanupError: string | null; exitCode: number | null; signalCode: string | null;
  } = { scope: 'Current owned Electron HTTP403 contract; NOT historical missing-manifest HTTP404 fallback',
    historical404Proven: false, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    decodedSha256: manifest.sha256, pid: child.pid, replies: [], geometryBefore: null, geometryAfter: null,
    pageErrors: [], failure: null, cleanupError: null, exitCode: null, signalCode: null };
  let failed = false, failure: unknown;
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => evidence.pageErrors.push(error.message));
    expect(page.url()).toBe('app://pointercad/index.html');
    const reply: unknown = await page.evaluate(async () => {
      const bridge: unknown = 'pointercadDesktop' in window ? window.pointercadDesktop : undefined;
      if (typeof bridge !== 'object' || bridge === null || !('prepareOcctTransport' in bridge)
        || typeof bridge.prepareOcctTransport !== 'function') throw new Error('Desktop OCCT bridge missing');
      return bridge.prepareOcctTransport();
    });
    const transport = validateDesktopOcctTransportReply(reply, manifest);
    if (transport.kind !== 'http') throw new Error('Owned HTTP transport unavailable; direct fallback is not negative HTTP proof');
    const empty = createEmptyPartDocument();
    const cube: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'box'), id: 'transport-cube', name: 'transport-cube',
      shape: { kind: 'box', sizeX: expressionValueFromNumber(20), sizeY: expressionValueFromNumber(20), sizeZ: expressionValueFromNumber(20) } };
    const fixture = join(directory, 'transport-cube.pcad');
    await writeFile(fixture, writePcadFile({ ...empty, solids: [cube] }), { flag: 'wx' });
    evidence.geometryBefore = await openAndCheckCube(page, app, fixture);
    const wrongSha = (manifest.sha256.startsWith('0') ? '1' : '0') + manifest.sha256.slice(1);
    // Missing manifest is the historical target, but this current fixed server
    // denies it with403. A valid-shaped, nonexistent WASM digest is also denied.
    for (const url of [new URL('/occt/manifest.json', transport.url).href,
      desktopOcctTransportUrl(wrongSha), `${transport.url}?unexpected=1`]) {
      const actual = await deniedRequest(url);
      evidence.replies.push(actual);
      expect(actual.error).toBeNull();
      expect(actual.status).toBe(403);
      expect(actual.ok).toBe(false);
      expect(actual.truncated).toBe(false);
      expect(actual.bodyBytes).toBe(0);
      expect(actual.bodyPrefix).toEqual([]);
      expect(actual.headers?.['cache-control']).toBe('no-store');
    }
    // New renderer/Worker after the negative requests must still load the real
    // verified WASM and compute the authored cube, not reuse a displayed value.
    await page.reload();
    evidence.geometryAfter = await openAndCheckCube(page, app, fixture);
    expect(evidence.pageErrors).toEqual([]);
    expect(createHash('sha256').update(await readFile(join(rendererRoot, 'occt/manifest.json'))).digest('hex'))
      .toBe(evidence.manifestSha256);
  } catch (error) {
    failed = true; failure = error;
    evidence.failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await app.close();
      await expect.poll(() => child.exitCode).toBe(0);
    } catch (error) {
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
      if (!failed) { failed = true; failure = error; }
    }
    evidence.exitCode = child.exitCode; evidence.signalCode = child.signalCode;
    const path = info.outputPath('electron-occt-transport-negative.json');
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    await info.attach('electron-occt-transport-negative', { path, contentType: 'application/json' });
  }
  if (failed) throw failure;
}
