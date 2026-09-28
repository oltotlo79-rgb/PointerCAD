import { expect, test } from '@playwright/test';
import { sphereGridCaptureFlow } from './sphereGridCaptureFlow.js';

test('P12 球の表面に点を置くの章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await sphereGridCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
