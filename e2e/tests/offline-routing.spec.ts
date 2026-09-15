import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createOfflineRoutingFixture } from './offlineRoutingFixture.js';

interface RoutingRecord {
  readonly path: string;
  readonly destination: string;
  readonly clientId: string;
  readonly resultingClientId: string;
}
function isRoutingRecord(value: unknown): value is RoutingRecord {
  return typeof value === 'object' && value !== null
    && 'path' in value && typeof value.path === 'string'
    && 'destination' in value && typeof value.destination === 'string'
    && 'clientId' in value && typeof value.clientId === 'string'
    && 'resultingClientId' in value && typeof value.resultingClientId === 'string';
}

async function openControlledPage(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-state', 'reload');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-state', 'ready');
}

test('P12 通信なし利用の準備: 子処理の参照先を実ブラウザーで確認する', async ({ page }, info) => {
  const fixture = await createOfflineRoutingFixture();
  try {
    await openControlledPage(page, fixture.url);
    const result: unknown = JSON.parse(await page.locator('#result').innerText());
    expect(result).toEqual({ value: { edition: 'original', value: 42 }, responseUrl: `${fixture.url}/asset.json` });
    await expect.poll(async () => page.locator('#events').innerText()).toContain('/asset.json');
    const value: unknown = JSON.parse(await page.locator('#events').innerText());
    if (!Array.isArray(value) || !value.every(isRoutingRecord)) throw new Error('Invalid routing diagnostic');
    const records: readonly RoutingRecord[] = value;
    await writeFile(info.outputPath('worker-client-routing.json'), JSON.stringify({
      project: info.project.name, records, result, productAcceptance: false,
    }, null, 2));
    const worker = records.find(record => record.path === '/worker.js');
    const asset = records.find(record => record.path === '/asset.json');
    expect(worker).toBeDefined(); expect(asset).toBeDefined();
    // A failed equality means client binding needs a different verified route before product integration.
    expect(worker?.resultingClientId).not.toBe('');
    expect(asset?.clientId).toBe(worker?.resultingClientId);
  } finally { await fixture.close(); }
});

test('P12 通信なし利用の準備: 2画面の排他を実ブラウザーで確認する', async ({ page, context }, info) => {
  const fixture = await createOfflineRoutingFixture();
  try {
    await openControlledPage(page, fixture.url);
    await page.evaluate(() => {
      void navigator.locks.request('pointercad-routing-probe', async () => {
        document.documentElement.dataset.lock = 'held';
        await new Promise<void>(resolve => document.addEventListener('release-probe-lock', () => resolve(), { once: true }));
      }).catch(error => { document.documentElement.dataset.lock = String(error); });
    });
    await expect(page.locator('html')).toHaveAttribute('data-lock', 'held');
    const second = await context.newPage();
    try {
      await second.goto(fixture.url);
      const acquiredWhileHeld = await second.evaluate(async () => navigator.locks.request(
        'pointercad-routing-probe', { ifAvailable: true }, lock => lock !== null,
      ));
      expect(acquiredWhileHeld).toBe(false);
      await page.evaluate(() => document.dispatchEvent(new Event('release-probe-lock')));
      await expect.poll(async () => second.evaluate(async () => navigator.locks.request(
        'pointercad-routing-probe', { ifAvailable: true }, lock => lock !== null,
      ))).toBe(true);
      await writeFile(info.outputPath('two-window-preparation-lock.json'), JSON.stringify({
        project: info.project.name, acquiredWhileHeld, acquiredAfterRelease: true, productAcceptance: false,
      }, null, 2));
    } finally { await second.close(); }
  } finally { await fixture.close(); }
});
