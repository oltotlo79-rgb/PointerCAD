import { expect, test } from '@playwright/test';
import { replaceSubassemblyCaptureFlow } from './replaceSubassemblyCaptureFlow.js';

test('P12 部品を差し替える・組を置く章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await replaceSubassemblyCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
