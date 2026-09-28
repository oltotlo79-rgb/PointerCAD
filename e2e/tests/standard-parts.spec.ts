import { expect, test } from '@playwright/test';
import { standardPartsCaptureFlow } from './standardPartsCaptureFlow.js';

test('P12 規格部品を置く章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await standardPartsCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
