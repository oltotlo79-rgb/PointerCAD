import { expect, test } from '@playwright/test';
import { referenceGeometryCaptureFlow } from './referenceGeometryCaptureFlow.js';

test('P12 基準の軸・点・座標系を作る章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await referenceGeometryCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
