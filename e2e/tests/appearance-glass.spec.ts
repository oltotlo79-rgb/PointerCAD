import { expect, test } from '@playwright/test';
import { appearanceGlassCaptureFlow } from './appearanceGlassCaptureFlow.js';

test('P12 ガラス・鏡と映り込みの章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await appearanceGlassCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
