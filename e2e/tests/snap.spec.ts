import { expect, test } from '@playwright/test';
import { snapCaptureFlow } from './snapCaptureFlow.js';

test('P12 点にぴったり合わせる(吸着)章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await snapCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
