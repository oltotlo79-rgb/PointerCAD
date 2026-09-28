import { expect, test } from '@playwright/test';
import { exportCaptureFlow } from './exportCaptureFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });

test('P12 書き出す章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await exportCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
