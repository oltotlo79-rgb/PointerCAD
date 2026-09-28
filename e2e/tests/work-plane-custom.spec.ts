import { expect, test } from '@playwright/test';
import { workPlaneCustomCaptureFlow } from './workPlaneCustomCaptureFlow.js';

test('P12 好きな向きの作業平面を作る章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await workPlaneCustomCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
