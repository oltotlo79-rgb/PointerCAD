import { expect, test } from '@playwright/test';
import { assemblyPlaceCaptureFlow } from './assemblyPlaceCaptureFlow.js';

test('P12 部品を配置する章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await assemblyPlaceCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
