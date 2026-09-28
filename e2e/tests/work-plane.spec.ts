import { expect, test } from '@playwright/test';
import { workPlaneCaptureFlow } from './workPlaneCaptureFlow.js';

test('P12 作図面を選ぶ章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await workPlaneCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
