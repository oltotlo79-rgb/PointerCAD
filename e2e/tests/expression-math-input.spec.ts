import { expect, test } from '@playwright/test';
import { expressionInspectionFlow } from './expressionInspectionFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

test('R19 数式入力中の単位・参照元・使用箇所・誤りの位置を出し、変換確定のEnterと表示切替で原式を保つ', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await expressionInspectionFlow(page);
  expect(errors).toEqual([]);
});
