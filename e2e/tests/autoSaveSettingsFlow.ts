/// <reference lib="dom" />
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';

/** 記憶上の控えではなく、実ブラウザーのIndexedDBから保存済みのバイト列を読む。 */
async function backupBytes(page: Page): Promise<number[][]> {
  return page.evaluate(() => new Promise<number[][]>((resolve, reject) => {
    const request = indexedDB.open('pointercad');
    request.onerror = () => reject(new Error('控えの保管庫を開けません'));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('autosave')) { database.close(); resolve([]); return; }
      const transaction = database.transaction('autosave', 'readonly'), reading = transaction.objectStore('autosave').getAll();
      let rows: number[][] = [];
      reading.onsuccess = () => {
        const value: unknown = reading.result;
        if (!Array.isArray(value)) return;
        rows = value.flatMap((record: unknown) => typeof record === 'object' && record !== null && 'bytes' in record
          && record.bytes instanceof Uint8Array ? [Array.from(record.bytes)] : []);
      };
      transaction.oncomplete = () => { database.close(); resolve(rows); };
      transaction.onerror = transaction.onabort = () => { database.close(); reject(new Error('控えを読み取れません')); };
    };
  }));
}

export async function autoSaveSettingsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
  await chooseToolMenuItem(page, '作る', '箱');
  const created = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter'); await waitForRecompute(page, created);
  const before = await savePart(page, info, 'interval-original.pcad', app), generation = (await readRecomputeStats(page)).requestedGeneration;
  const settings = page.getByRole('button', { name: '設定', exact: true }); await settings.click();
  const form = page.getByRole('form', { name: '自動保存の間隔', exact: true });
  const input = form.getByLabel('保存する間隔（分）', { exact: true });
  const apply = form.getByRole('button', { name: '保存間隔を適用', exact: true });
  await expect(input).toHaveValue('5');
  for (const value of ['0', '61', 'NaN', '1.5']) {
    await input.fill(value); await expect(apply).toBeDisabled(); await expect(input).toHaveAttribute('aria-invalid', 'true');
  }
  await form.getByRole('button', { name: '間隔の変更を取り消す', exact: true }).click(); await expect(input).toHaveValue('5');
  await input.fill('1'); await settings.click(); await settings.click(); await expect(input).toHaveValue('5');
  await input.fill('1'); await apply.click(); await expect(form).toContainText('現在は1分ごと');
  await form.getByRole('button', { name: '既定の5分へ戻す', exact: true }).click();
  await expect(input).toHaveValue('5'); await expect(form).toContainText('現在は1分ごと');
  await form.getByRole('button', { name: '間隔の変更を取り消す', exact: true }).click(); await expect(input).toHaveValue('1');
  await form.scrollIntoViewIfNeeded();
  await captureManualDetail(page, info, { name: 'auto-save-interval', dialog: form, script: new URL(import.meta.url),
    fixture: { before, autoSaveMinutes: 1, originalGeneration: generation } });
  await settings.click(); expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
  expect(await savePart(page, info, 'interval-settings-only.pcad', app)).toEqual(before);

  // 保存間隔の変更後に実際の編集を加え、1分の到来から同じ保存経路へ入る。
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of ['1', '2', '3'].entries()) await fields.nth(index).fill(value);
  const point = await beginRecompute(page); await fields.first().press('Enter'); await page.keyboard.press('Escape');
  await waitForRecompute(page, point);
  await page.clock.fastForward(60_000);
  await expect.poll(async () => (await backupBytes(page)).length).toBe(1);
  const [bytes] = await backupBytes(page), opened = readPcadFile(new Uint8Array(bytes));
  if (!opened.ok || opened.kind !== 'part') throw new Error('実際の控えから部品を開けません');
  const current = await savePart(page, info, 'interval-after-point.pcad', app);
  expect(opened.document).toEqual(current); expect(current).not.toEqual(before);
  await expect.poll(async () => (await backupBytes(page)).length).toBe(0);
  await page.reload(); await waitForStartupHealth(page, info); await settings.click(); await expect(input).toHaveValue('1');
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  await input.fill('2');
  const cancel = form.getByRole('button', { name: '間隔の変更を取り消す', exact: true });
  await cancel.click(); await expect(input).toHaveValue('1');
  for (const button of [apply, cancel, form.getByRole('button', { name: '既定の5分へ戻す', exact: true })]) {
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); if (box === null) throw new Error('設定のボタンがありません');
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1440); expect(box.y + box.height).toBeLessThanOrEqual(900);
  }
  await input.focus(); await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('保存間隔を適用');
  await page.keyboard.press('Escape');
  await expect(form).toBeVisible();
}
