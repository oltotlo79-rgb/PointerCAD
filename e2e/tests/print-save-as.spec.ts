import { expect, test } from '@playwright/test';
import { printSaveAsCaptureFlow } from './printSaveAsCaptureFlow.js';

test('P12-17 印刷する・別名で保存するの章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await printSaveAsCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
