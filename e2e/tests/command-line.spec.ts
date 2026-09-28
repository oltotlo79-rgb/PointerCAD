import { expect, test } from '@playwright/test';
import { commandLineCaptureFlow } from './commandLineCaptureFlow.js';

test('P12 キーボードだけでかく(コマンドの欄)章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await commandLineCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
