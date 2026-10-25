import { test } from '@playwright/test';
import { partAssetLifetimeFlow } from './partAssetLifetimeFlow.js';

test.use({ browserName: 'chromium' });

test.describe('部品添付 chromium', () => {
  test('BRepとmeshの所有は部品をまたぐUndo・保存再開でも保たれる', async ({ page }, info) => {
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await partAssetLifetimeFlow(page, info);
  });
});
