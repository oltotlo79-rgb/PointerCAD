import { expect, test } from '@playwright/test';
import { fatigueLocalCycleFlow } from './fatigueLocalCycleFlow.js';

test('F3 局所サイクルの寿命を、普通の操作で入力・拒否・計算・保存・元に戻す・開き直しする', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await fatigueLocalCycleFlow(page, info); expect(errors).toEqual([]);
});
