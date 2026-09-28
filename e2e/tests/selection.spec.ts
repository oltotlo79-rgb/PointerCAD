import { expect, test } from '@playwright/test';
import { selectionCaptureFlow } from './selectionCaptureFlow.js';

test('P12 選ぶものを絞る・選んだ組に名前を付ける章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await selectionCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
