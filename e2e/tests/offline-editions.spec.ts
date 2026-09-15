import { expect, test, type Page } from '@playwright/test';
import { offlineAssetRoute } from '../../scripts/vite/offlineProtocol.mjs';
import { createOfflineEditionFixture } from './offlineEditionFixture.js';

/** Seed a known complete edition with real Response objects. This test targets serving, not preparation UI. */
async function seed(page: Page, fixture: Awaited<ReturnType<typeof createOfflineEditionFixture>>, edition: 'old' | 'new') {
  const manifest = fixture.manifest(edition);
  const routes = Object.fromEntries(manifest.assets.map(asset => [asset.url, offlineAssetRoute(asset.url)]));
  return page.evaluate(async ({ manifest, base, routes }) => {
    const cacheName = 'pointercad-offline-edition-v1-' + manifest.buildId + '-' + crypto.randomUUID();
    const cache = await caches.open(cacheName);
    for (const asset of manifest.assets) {
      const route = routes[asset.url];
      if (route === undefined) throw new Error('Missing fixture route');
      const response = await fetch(new URL(route, base), { headers: { 'X-PointerCAD-Offline-Prepare': '1' },
        cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error' });
      if (!response.ok || response.url !== new URL(route, base).href) {
        throw new Error('Fixture preparation failed: ' + asset.url);
      }
      await cache.put(new URL(asset.url, base), response);
    }
    await cache.put(new URL('offline-assets.json', base), new Response(JSON.stringify({
      format: 'pointercad-offline-ready/1', cacheName, manifest,
    }), { headers: { 'Content-Type': 'application/json' } }));
    return cacheName;
  }, { manifest, base: fixture.url, routes });
}
async function calculate(page: Page, edition: string, serial: number) {
  await page.getByRole('button', { name: '計算', exact: true }).click();
  await expect(page.locator('#result')).toHaveText(JSON.stringify({ serial, entryEdition: edition, valueEdition: edition }));
}
async function prepare(page: Page) {
  await page.getByRole('button', { name: '準備', exact: true }).click();
  await expect(page.locator('#preparation')).toHaveText(/"phase":"(?:ready|error)"/u);
  const state: unknown = JSON.parse(await page.locator('#preparation').innerText());
  expect(state).toMatchObject({ phase: 'ready', storedFiles: 7, totalFiles: 7 });
}
async function collect(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const worker = navigator.serviceWorker.controller;
    if (worker === null) { reject(new Error('No controlling worker')); return; }
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Cleanup did not reply')); }, 10_000);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close(); const value: unknown = event.data;
      if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== 'pointercad-offline-cleanup/1') {
        reject(new Error('Invalid cleanup reply')); return;
      }
      resolve();
    };
    worker.postMessage({ format: 'pointercad-offline-cleanup/1' }, [channel.port2]);
  }));
}

test('P12 通信なし利用の片付け: 実際の旧画面を閉じた後にだけ旧版を消し、新版の計算を保つ', async ({ page, context }) => {
  const fixture = await createOfflineEditionFixture();
  let next: Page | undefined;
  try {
    await page.goto(fixture.url); await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    const oldCache = await seed(page, fixture, 'old'); await page.reload(); await calculate(page, 'old', 1);
    fixture.next(); const newCache = await seed(page, fixture, 'new');
    next = await context.newPage(); await next.goto(fixture.url); await calculate(next, 'new', 1);
    await collect(next); expect(await next.evaluate(name => caches.has(name), oldCache)).toBe(true);
    await page.close(); await collect(next);
    expect(await next.evaluate(name => caches.has(name), oldCache)).toBe(false);
    expect(await next.evaluate(name => caches.has(name), newCache)).toBe(true);
    await context.setOffline(true); await calculate(next, 'new', 2);
  } finally { await context.setOffline(false); await next?.close(); await fixture.close(); }
});

test('P12 通信なし利用の準備: 製品の取得と登録を使い、2版の準備後も旧画面と計算を保つ', async ({ page, context }) => {
  const fixture = await createOfflineEditionFixture(true);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(fixture.url); await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await prepare(page); await page.reload(); await calculate(page, 'old', 1);
    fixture.next(); await prepare(page); await calculate(page, 'old', 2);
    const next = await context.newPage();
    try {
      await context.setOffline(true);
      await next.goto(fixture.url); await expect(next.locator('#edition')).toHaveText('new');
      await calculate(next, 'new', 1); await calculate(page, 'old', 3);
    } finally { await context.setOffline(false); await next.close(); }
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('P12 通信なし利用の説明書: 新版の準備後も旧画面から目次・次の章へ同じ版で進む', async ({ page, context }) => {
  const fixture = await createOfflineEditionFixture();
  try {
    await page.goto(fixture.url); await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await seed(page, fixture, 'old'); await page.reload(); await calculate(page, 'old', 1);
    fixture.next(); await seed(page, fixture, 'new');
    await context.setOffline(true);
    await page.getByRole('link', { name: '説明書', exact: true }).click();
    await expect(page.locator('#edition')).toHaveText('old');
    await page.getByRole('link', { name: '次の章', exact: true }).click();
    await expect(page.locator('#edition')).toHaveText('old');
    await page.getByRole('link', { name: '目次', exact: true }).click();
    await expect(page.locator('#edition')).toHaveText('old');
    const opened = context.waitForEvent('page');
    await page.getByRole('link', { name: '次の章', exact: true }).click({ modifiers: ['Control'] });
    const oldTab = await opened;
    await expect(oldTab.locator('#edition')).toHaveText('old');
    await oldTab.close();
    const next = await context.newPage();
    await next.goto(new URL('manual/index.html', fixture.url).href);
    await expect(next.locator('#edition')).toHaveText('new');
  } finally { await fixture.close(); }
});

test('P12 通信なし利用の接続: 実Cacheの新旧画面と子計算を混在させず、切断後も同じ版を開く', async ({ page, context }) => {
  const fixture = await createOfflineEditionFixture();
  try {
    await page.goto(fixture.url);
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    const oldCache = await seed(page, fixture, 'old');
    await page.reload();
    await expect(page.locator('#edition')).toHaveText('old');
    await calculate(page, 'old', 1);
    fixture.next();
    await seed(page, fixture, 'new');
    const next = await context.newPage();
    try {
      await next.goto(fixture.url);
      await expect(next.locator('#edition')).toHaveText('new');
      await calculate(next, 'new', 1);
      await calculate(page, 'old', 2);
      // Remove the network; real cached Response URLs, CSP, and module-Worker imports must still work.
      await context.setOffline(true);
      await calculate(page, 'old', 3);
      await calculate(next, 'new', 2);
      await next.reload();
      await expect(next.locator('#edition')).toHaveText('new');
      await calculate(next, 'new', 1);
      expect(await page.evaluate(name => caches.has(name), oldCache)).toBe(true);
    } finally { await context.setOffline(false); await next.close(); }
  } finally { await fixture.close(); }
});

test('P12 通信なし利用の接続: 保存された新版の一部が消えても、旧画面の内容を新版に置換しない', async ({ page, context }) => {
  const fixture = await createOfflineEditionFixture();
  try {
    await page.goto(fixture.url); await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await seed(page, fixture, 'old'); await page.reload(); await calculate(page, 'old', 1);
    fixture.next(); const newCache = await seed(page, fixture, 'new');
    await page.evaluate(async ({ name, url }) => {
      const cache = await caches.open(name); await cache.delete(new URL('value.json', url));
    }, { name: newCache, url: fixture.url });
    await context.setOffline(true);
    const next = await context.newPage();
    try {
      await next.goto(fixture.url); await expect(next.locator('#edition')).toHaveText('old');
      await calculate(next, 'old', 1); await calculate(page, 'old', 2);
    } finally { await context.setOffline(false); await next.close(); }
  } finally { await fixture.close(); }
});
