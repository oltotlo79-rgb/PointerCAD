import { expect, test } from '@playwright/test';
import { trackingCaptureFlow } from './trackingCaptureFlow.js';

test('P12 向きをそろえる(直交・角度・延長線)章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await trackingCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
