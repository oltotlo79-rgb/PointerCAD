import { expect, test } from '@playwright/test';
import { localDataCaptureFlow } from './localDataCaptureFlow.js';

test('P12 作図したデータの保存場所と通信章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await localDataCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
