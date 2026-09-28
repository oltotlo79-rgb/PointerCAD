import { expect, test } from '@playwright/test';
import { sketchFilletCaptureFlow } from './sketchFilletCaptureFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('P12 線の角を丸める・面取りする章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await sketchFilletCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
