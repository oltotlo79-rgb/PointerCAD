import { expect, test } from '@playwright/test';
import { sketchToolsCaptureFlow } from './sketchToolsCaptureFlow.js';

test('P12 点・線・円弧をかく章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await sketchToolsCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
