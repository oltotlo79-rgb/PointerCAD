import { expect, test } from '@playwright/test';
import { canvasCaptureFlow } from './canvasCaptureFlow.js';

test('P12 下絵を敷く章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await canvasCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
