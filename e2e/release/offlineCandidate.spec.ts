import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseToolMenuItem } from '../tests/assemblyTestSupport.js';
import { serveOfflineCandidate } from './offlineCandidateServer.js';
import { helpReaderFlow } from '../tests/helpReaderFlow.js';
import {
  verifyOfflineAssemblyPlacement,
  verifyOfflineDrawingSheet,
  verifyOfflineExactMath,
  verifyOfflineScript,
  verifyOfflineSheetMetalBaseFlange,
} from './offlineDomainCoverage.js';

const volume = (page: Page) => page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: '体積' })
  .locator('xpath=following-sibling::dd[1]');
const treeBox = (page: Page) => page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true });

test('P12 配布候補を設定から保存し、切断後に実CADの作図・保存再開・全説明書と全PDFを使う', async ({ page, context }, info) => {
  // 追加計算部・自動作図・組立・図面・板金の5操作(P12-22①)を切断後の後半で足すため、
  // 既定の300秒(offline-candidate.config.ts)より大きく確保する(数学の厳密計算の初回準備は
  // 最大90秒、計算自体も重ければ225秒まで許容するため。mathEditorReady.ts 参照)。
  test.setTimeout(900_000);
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
    // P12-22①: 追加計算部・自動作図・組立・図面・板金も、通信を切ったこの実CADで
    // 最小の1操作ずつ使えることを確かめる(棚卸しで見つかった抜け。各操作の間、想定外の
    // 通信が増えないことも確かめる)。(c)以降は文書をアセンブリ→図面→新規部品と切り替える。
    await verifyOfflineExactMath(offline, server);
    await verifyOfflineScript(offline, server);
    await verifyOfflineAssemblyPlacement(offline, server, saved);
    await verifyOfflineDrawingSheet(offline, server);
    await verifyOfflineSheetMetalBaseFlange(offline, server);
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

const OFFLINE_STATUS = {
  idle: 'この端末ではまだ準備していません。',
  ready: 'この端末で通信なしの利用を準備できました。',
  download: '必要なファイルを取得できないか、内容が一致しません。通信を確認して準備をやり直してください。',
  storage: 'この端末へ保存できませんでした。空き容量とブラウザーの保存設定を確認してください。',
} as const;
const offlineRegion = (page: Page) => page.getByRole('region', { name: '通信なしで使う', exact: true });
// After a failed update the button returns to its first-time label, so accept either product label.
const prepareButton = (page: Page) => offlineRegion(page).getByRole('button', { name: /^(通信なしで使う準備|新しい版を準備)$/u });
/** Reopening the settings runs the product's own check of the saved editions. */
async function reopenSettings(page: Page): Promise<void> {
  if (await offlineRegion(page).count() > 0) await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(offlineRegion(page)).toBeVisible();
}
async function prepareAndWait(page: Page, status: string): Promise<void> {
  await prepareButton(page).click();
  await expect(offlineRegion(page).getByRole('status')).toHaveText(status, { timeout: 180_000 });
}
/** Only the app's own edition caches; the completion marker is read without creating a cache. */
async function savedEditions(page: Page): Promise<{ name: string; complete: boolean }[]> {
  return page.evaluate(async () => {
    const result: { name: string; complete: boolean }[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('pointercad-offline-edition-v1-')) continue;
      const marker = await caches.match(new URL('offline-assets.json', document.baseURI).href, { cacheName: name });
      result.push({ name, complete: marker !== undefined });
    }
    return result;
  });
}

test('P12 配布候補の準備の障害: 1資産の破損・途中切断・画面を閉じた中断・保存領域の削除で完了を偽らず、旧版を保つ', async ({ page, context }, info) => {
  // Three full preparations of the real candidate, one interrupted and two failed ones.
  test.setTimeout(900_000);
  const server = await serveOfflineCandidate();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const middle = server.manifest.assets[Math.floor(server.manifest.assets.length / 2)];
  try {
    await page.goto(server.url);
    await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
    await reopenSettings(page);
    await expect(offlineRegion(page).getByRole('status')).toHaveText(OFFLINE_STATUS.idle);
    // (1) One asset differs in a single byte: the same length must still be refused.
    server.inject({ corrupt: decodeURIComponent(middle.url) });
    await prepareAndWait(page, OFFLINE_STATUS.download);
    expect(await savedEditions(page)).toEqual([]);
    // (2) The connection drops in the middle of a body.
    server.inject({ disconnectAfterAssets: Math.floor(server.manifest.assets.length / 3) });
    await prepareAndWait(page, OFFLINE_STATUS.download);
    expect(await savedEditions(page)).toEqual([]);
    // A browser may retry a dropped request; each kind must have happened at least once.
    expect(new Set(server.injectedFaults().map(fault => fault.fault))).toEqual(new Set(['corrupt', 'disconnect']));
    server.inject({});
    await prepareAndWait(page, OFFLINE_STATUS.ready);
    const [first] = await savedEditions(page);
    expect(first).toMatchObject({ complete: true });
    // (3) The preparing page closes before its own clean-up runs; the next preparation reclaims it.
    const other = await context.newPage();
    await other.goto(server.url);
    await expect(other.locator('canvas.pcad-viewport__canvas')).toBeVisible();
    await reopenSettings(other);
    await prepareButton(other).click();
    await expect.poll(async () => (await savedEditions(page)).filter(edition => !edition.complete).length,
      { timeout: 120_000 }).toBe(1);
    await other.close();
    const interrupted = (await savedEditions(page)).filter(edition => !edition.complete);
    expect(interrupted).toHaveLength(1);
    await reopenSettings(page);
    await expect(offlineRegion(page).getByRole('status')).toHaveText(OFFLINE_STATUS.ready);
    await prepareAndWait(page, OFFLINE_STATUS.ready);
    const after = await savedEditions(page);
    expect(after.map(edition => edition.name)).not.toContain(interrupted[0].name);
    expect(after).toHaveLength(2);
    expect(after.every(edition => edition.complete)).toBe(true);
    expect(after[0].name).toBe(first.name);
    // (4) The browser removes the saved data: never report success, and do not open stale bytes offline.
    await page.evaluate(async () => { for (const name of await caches.keys()) await caches.delete(name); });
    await reopenSettings(page);
    await expect(offlineRegion(page).getByRole('status')).toHaveText(OFFLINE_STATUS.idle);
    await context.setOffline(true); server.disconnect();
    const offline = await context.newPage();
    // The Worker answers 503 with guidance (or passes on the host's 503); the browser may also refuse outright.
    const refused = await offline.goto(server.url).catch(() => null);
    expect(refused === null || refused.status() === 503).toBe(true);
    await expect(offline.locator('canvas.pcad-viewport__canvas')).toHaveCount(0);
    const shown = await offline.locator('body').textContent().catch(() => null);
    expect(errors).toEqual([]);
    await info.attach('offline-fault-recovery', { body: JSON.stringify({ buildId: server.manifest.buildId,
      corrupted: middle.url, injected: server.injectedFaults(), reclaimed: interrupted[0].name,
      editionsAfterRetry: after.length, shownAfterRemoval: shown }), contentType: 'application/json' });
  } finally {
    await context.setOffline(false);
    await server.close();
  }
});

test('P12 配布候補の準備の障害: 保存容量の不足では理由を示し、旧版で通信なしに開ける(Chromiumの容量上書き)', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'The storage quota can only be overridden through the Chromium DevTools protocol.');
  test.setTimeout(900_000);
  const server = await serveOfflineCandidate();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.url);
    await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
    await reopenSettings(page);
    await prepareAndWait(page, OFFLINE_STATUS.ready);
    const [prepared] = await savedEditions(page);
    const devtools = await context.newCDPSession(page), origin = new URL(server.url).origin;
    const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
    // Room for a small part of a second edition only.
    await devtools.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage + 5_000_000 });
    await prepareAndWait(page, OFFLINE_STATUS.storage);
    expect(await savedEditions(page)).toEqual([prepared]);
    await reopenSettings(page);
    await expect(offlineRegion(page).getByRole('status')).toHaveText(OFFLINE_STATUS.ready);
    await devtools.send('Storage.overrideQuotaForOrigin', { origin });
    await context.setOffline(true); server.disconnect();
    const offline = await context.newPage();
    await offline.goto(server.url);
    await expect(offline.locator('canvas.pcad-viewport__canvas')).toBeVisible();
    expect(errors).toEqual([]);
    await info.attach('offline-quota', { body: JSON.stringify({ usage, kept: prepared.name }), contentType: 'application/json' });
  } finally {
    await context.setOffline(false);
    await server.close();
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
