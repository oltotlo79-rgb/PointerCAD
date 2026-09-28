import { expect, test } from '@playwright/test';
import { saveAndOpenCaptureFlow } from './saveAndOpenCaptureFlow.js';

test('P12-17 保存する・開くの章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await saveAndOpenCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
