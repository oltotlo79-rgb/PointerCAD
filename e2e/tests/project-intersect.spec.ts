import { expect, test } from '@playwright/test';
import { projectIntersectCaptureFlow } from './projectIntersectCaptureFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('P12 立体から線を取り込む(投影・断面)章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await projectIntersectCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
