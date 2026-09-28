import { expect, test } from '@playwright/test';
import { solidBasicsCaptureFlow } from './solidBasicsCaptureFlow.js';

test('P12-17 厚みをつける・回すの章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await solidBasicsCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
