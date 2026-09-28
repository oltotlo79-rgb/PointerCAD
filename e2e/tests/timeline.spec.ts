import { expect, test } from '@playwright/test';
import { timelineCaptureFlow } from './timelineCaptureFlow.js';

test('P12 途中まで戻して確かめる(タイムライン)章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await timelineCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
