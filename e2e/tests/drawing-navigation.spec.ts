import { expect, test } from '@playwright/test';
import { drawingNavigationFlow } from './drawingNavigationFlow.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

test('EX10 図面の移動2枠・拡大縮小2枠とズーム中心の実選択・文書保持', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await drawingNavigationFlow(page, info); expect(errors).toEqual([]);
});
