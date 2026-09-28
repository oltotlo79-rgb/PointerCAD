import { expect, test } from '@playwright/test';
import { jointCaptureFlow } from './jointCaptureFlow.js';

test('P12 ジョイントで動きを残す章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await jointCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
