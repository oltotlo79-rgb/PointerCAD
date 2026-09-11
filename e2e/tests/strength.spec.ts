import { expect, test } from '@playwright/test';
import { strengthFlow } from './strengthFlow.js';

test('P11b 強度の三方式・材料条件・式と結果・F1を形状再計算なしで操作する', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await strengthFlow(page, info); expect(errors).toEqual([]);
});
