import { expect, test } from '@playwright/test';
import { measureCaptureFlow } from './measureCaptureFlow.js';

test('P12 長さ・角度・面積を測る章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await measureCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
