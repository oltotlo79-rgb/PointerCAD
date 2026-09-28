import { expect, test } from '@playwright/test';
import { shapesCaptureFlow } from './shapesCaptureFlow.js';

test('P12 四角・多角形・長穴・円をかく章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await shapesCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
