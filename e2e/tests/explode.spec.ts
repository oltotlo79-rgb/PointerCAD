import { expect, test } from '@playwright/test';
import { explodeCaptureFlow } from './explodeCaptureFlow.js';

test('P12 分解した見せ方を作る章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await explodeCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
