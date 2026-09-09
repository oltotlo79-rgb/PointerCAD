import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';

const rendererRoot = fileURLToPath(new URL('../../apps/desktop/dist/renderer/', import.meta.url));
const mimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf',
};
let server: Server;
let origin: string;

// Electron用の実ビルドを配る。HTTPでの検査と実Electronの確認を区別し、
// ?urlの置換を終えた生WASM経路をWindows/Linux両方の通常E2Eで保護する。
test.beforeAll(async () => {
  const root = resolve(rendererRoot);
  server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!target.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      let bytes: Buffer;
      try { bytes = await readFile(target); } catch { response.writeHead(404).end(); return; }
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(target)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      response.end(bytes);
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Desktop renderer server did not start');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error === undefined ? resolveClosed() : reject(error)));
});

for (const missingManifest of ['network-error', '404'] as const) {
  test(`desktop配布用の生WASMで箱を作れる（manifest ${missingManifest}）`, async ({ page }) => {
    const fetchedWasm: string[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('.wasm') && response.ok()) fetchedWasm.push(response.url());
    });
    await page.route('**/occt/manifest.json', async (route) => {
      if (missingManifest === 'network-error') await route.abort('failed');
      else await route.fulfill({ status: 404, body: '' });
    });
    await page.goto(origin);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
    await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
    const token = await beginRecompute(page);
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
    await waitForRecompute(page, token);
    expect(fetchedWasm.length).toBeGreaterThan(0);
    await expect(page.locator('.pcad-statusbar')).not.toContainText('計算に失敗しました');
    if (await page.locator('.pcad-popover').count()) await page.locator('.pcad-popover input').first().press('Escape');
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').evaluateAll((elements) =>
      elements.reduce((sum, element) => sum + (element instanceof SVGPathElement ? element.getTotalLength() : 0), 0)),
    { timeout: 60000 }).toBeGreaterThan(0);
  });
}
