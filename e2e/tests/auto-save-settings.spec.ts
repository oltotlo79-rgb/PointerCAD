import { expect, test } from '@playwright/test';
import { autoSaveSettingsFlow } from './autoSaveSettingsFlow.js';

test('P12-8 自動保存の間隔を取消・変更し、実際の控えと保存・再起動・F1へ接続する', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.clock.install(); await page.goto('/');
  await autoSaveSettingsFlow(page, info); expect(errors).toEqual([]);
});
