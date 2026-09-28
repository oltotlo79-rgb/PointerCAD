import { expect, test } from '@playwright/test';
import { constraintsCaptureFlow } from './constraintsCaptureFlow.js';

test('P12 形を条件で決める(拘束)章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await constraintsCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
