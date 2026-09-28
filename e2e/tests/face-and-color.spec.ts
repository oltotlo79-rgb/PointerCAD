import { expect, test } from '@playwright/test';
import { faceAndColorCaptureFlow } from './faceAndColorCaptureFlow.js';

test('P12 面を張る・色を変える章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await faceAndColorCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
