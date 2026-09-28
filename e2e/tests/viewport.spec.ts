import { expect, test } from '@playwright/test';
import { viewportCaptureFlow } from './viewportCaptureFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('P12 画面を回す・動かす・拡大する章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await viewportCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
