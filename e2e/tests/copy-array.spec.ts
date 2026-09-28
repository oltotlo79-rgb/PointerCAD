import { expect, test } from '@playwright/test';
import { copyArrayCaptureFlow } from './copyArrayCaptureFlow.js';

test('P12 ミラー・複写・並べる章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await copyArrayCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
