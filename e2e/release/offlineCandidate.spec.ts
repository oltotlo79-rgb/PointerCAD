import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseToolMenuItem } from '../tests/assemblyTestSupport.js';
import { serveOfflineCandidate } from './offlineCandidateServer.js';
import { helpReaderFlow } from '../tests/helpReaderFlow.js';

const volume = (page: Page) => page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: '体積' })
  .locator('xpath=following-sibling::dd[1]');
const treeBox = (page: Page) => page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true });

test('P12 配布候補を設定から保存し、切断後に実CADの作図・保存再開・全説明書と全PDFを使う', async ({ page, context }, info) => {
  const server = await serveOfflineCandidate();
  const errors: string[] = [];
  const completedChapters: string[] = [];
  context.on('page', opened => { opened.on('pageerror', error => errors.push(error.message)); });
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => {
    // Exercise the shipped download/input-file fallback supported by both browsers.
    for (const name of ['showSaveFilePicker', 'showOpenFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  const manual = JSON.parse(await readFile(join(server.folder, 'manual/manifest.json'), 'utf8')) as {
    chapters: { id: string; title: string }[]; volumes: { id: string; topics: string[] }[];
  };
  try {
    await page.goto(server.url);
    await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
    // The read-only progress reader exists in ordinary builds. Only the E2E file replacement hooks identify a diagnostic build.
    expect(await page.evaluate(() => ['pcadSetFileGateway', 'pcadResetFileGateway', 'pcadAssemblyStats']
      .filter(name => name in globalThis))).toEqual([]);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('region', { name: '通信なしで使う', exact: true });
    await expect(settings.getByRole('status')).toHaveText('この端末ではまだ準備していません。');
    await settings.getByRole('button', { name: '通信なしで使う準備', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('この端末で通信なしの利用を準備できました。', { timeout: 120_000 });
    await settings.getByRole('button', { name: '新しい版を準備', exact: true }).press('F1');
    const help = page.locator('.pcad-help__article');
    await expect(help).toHaveAttribute('data-help-topic', 'offline-use');
    await expect(help).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'ヘルプを閉じる (Esc)', exact: true }).click();
    await page.screenshot({ path: info.outputPath('offline-prepared.png') });
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await context.setOffline(true); server.disconnect();
    // A new page must load the app and a fresh OCCT Worker from the saved edition.
    const offline = await context.newPage(); offline.on('dialog', dialog => { void dialog.accept(); });
    await offline.goto(server.url);
    await expect(offline.locator('canvas.pcad-viewport__canvas')).toBeVisible();
    await chooseToolMenuItem(offline, '作る', '箱');
    const fields = offline.locator('.pcad-popover input.pcad-field__input');
    await expect(fields).toHaveCount(3);
    for (const [i, size] of ['20mm', '30mm', '40mm'].entries()) await fields.nth(i).fill(size);
    await fields.first().press('Enter');
    await expect(treeBox(offline)).toBeVisible();
    if (await offline.locator('.pcad-popover').count()) await offline.locator('.pcad-popover input').first().press('Escape');
    await treeBox(offline).click();
    await expect(volume(offline)).toHaveText('24000 mm³', { timeout: 90_000 });
    await offline.screenshot({ path: info.outputPath('offline-solid.png') });
    const saving = offline.waitForEvent('download');
    await offline.getByRole('button', { name: '保存', exact: true }).click();
    const download = await saving, saved = info.outputPath('offline-box.pcad');
    await download.saveAs(saved); expect((await readFile(saved)).byteLength).toBeGreaterThan(1_000);
    await offline.getByRole('button', { name: '新規', exact: true }).click();
    await expect(treeBox(offline)).toHaveCount(0);
    const opening = offline.waitForEvent('filechooser');
    await offline.getByRole('button', { name: '開く', exact: true }).click();
    await (await opening).setFiles(saved);
    await treeBox(offline).click();
    await expect(volume(offline)).toHaveText('24000 mm³', { timeout: 90_000 });
    // Every PDF and the adopted mathematics runtime can be read with the network removed.
    await helpReaderFlow(offline, info);
    const binary = server.manifest.assets.filter(asset => asset.url.startsWith('manual/pdf/') || asset.url.startsWith('exact-math/runtime/'));
    const downloaded = await offline.evaluate(async assets => {
      const results = [];
      for (const asset of assets) {
        const response = await fetch(new URL(asset.url, location.href));
        const bytes = await response.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        results.push({ url: asset.url, status: response.status, bytes: bytes.byteLength, hash });
      }
      return results;
    }, binary);
    expect(downloaded).toEqual(binary.map(asset => ({ url: asset.url, status: 200, bytes: asset.byteLength, hash: asset.sha256 })));
    const reading = await context.newPage();
    await reading.goto(new URL('manual/', server.url).href);
    for (const chapter of manual.chapters) {
      // Follow the shipped table of contents/next-chapter links, preserving the reader's edition.
      const link = completedChapters.length === 0
        ? reading.locator(`a[href="chapters/${chapter.id}.html"]`)
        : reading.locator(`.manual-chapters a[rel="next"][href="${chapter.id}.html"]`);
      await expect(link).toContainText(chapter.title); await link.click();
      await expect(reading.locator('article h1')).toHaveText(chapter.title);
      await reading.evaluate(() => { for (const image of Array.from(document.images)) image.loading = 'eager'; });
      await reading.waitForFunction(() => document.fonts.status === 'loaded'
        && Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
      completedChapters.push(chapter.id);
    }
    await reading.goto(new URL('manual/', server.url).href);
    await reading.locator('#manual-query').fill('矩形');
    await expect(reading.locator('#manual-search-results li').first()).toBeVisible();
    await reading.screenshot({ path: info.outputPath('offline-manual.png') });
    // Browsers may probe SW updates even when the context is offline. The server rejects these too.
    // No document, calculation, manual asset or unclassified request may reach the disconnected server.
    const unexpectedRequests = server.networkRequestsAfterDisconnect().filter(request =>
      request.path !== '/service-worker.js' || request.destination !== 'serviceworker'
      || request.serviceWorker !== 'script' || request.status !== 503);
    expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
    await info.attach('offline-complete-edition', { body: JSON.stringify({ buildId: server.manifest.buildId,
      storedAssets: server.manifest.assets.length, bytes: server.manifest.totalBytes, chapters: manual.chapters.length,
      pdfVolumes: manual.volumes.length, checkedBinaryAssets: downloaded.length, volume: 24_000,
      networkRequestsAfterDisconnect: server.networkRequestsAfterDisconnect() }), contentType: 'application/json' });
  } finally {
    await server.close();
    await info.attach('offline-diagnostics', { body: JSON.stringify({ errors, completedChapters,
      networkRequestsAfterDisconnect: server.networkRequestsAfterDisconnect() }), contentType: 'application/json' });
  }
});

for (const capability of ['caches', 'serviceWorker'] as const) {
  test(`P12 ${capability}へのアクセスをブラウザーが拒否しても作図と通常保存は使える`, async ({ page, context }, info) => {
    const server = await serveOfflineCandidate();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await context.addInitScript(name => {
        Object.defineProperty(name === 'caches' ? globalThis : navigator, name, {
          configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); },
        });
        for (const picker of ['showSaveFilePicker', 'showOpenFilePicker']) {
          Object.defineProperty(globalThis, picker, { configurable: true, value: undefined });
        }
      }, capability);
      await page.goto(server.url);
      await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
      await page.getByRole('button', { name: '設定', exact: true }).click();
      await expect(page.getByRole('region', { name: '通信なしで使う', exact: true }).getByRole('status'))
        .toContainText('この環境では通信なしの準備を利用できません');
      await page.getByRole('button', { name: '設定', exact: true }).click();
      await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
      await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
      await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true })).toBeVisible();
      await page.locator('.pcad-popover input.pcad-field__input').first().press('Escape');
      const saving = page.waitForEvent('download');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const path = info.outputPath('storage-denied.pcad'); await (await saving).saveAs(path);
      expect((await readFile(path)).byteLength).toBeGreaterThan(1_000);
      expect(errors).toEqual([]);
    } finally { await server.close(); }
  });
}
