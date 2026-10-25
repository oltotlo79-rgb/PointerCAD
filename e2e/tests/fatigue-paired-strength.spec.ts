import { expect, test } from '@playwright/test';
import { fatigueStrainPairedFlow } from './fatigueStrainPairedFlow.js';

test('F1 組のひずみと応力の履歴を、普通の操作で入力・拒否・計算・保存・開き直しする', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await fatigueStrainPairedFlow(page, info); expect(errors).toEqual([]);
});
