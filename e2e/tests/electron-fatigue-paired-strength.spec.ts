import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { fatigueStrainPairedFlow } from './fatigueStrainPairedFlow.js';

test('F1 組のひずみと応力の履歴を、実Electronでも普通の操作で入力・計算・保存・開き直しする', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await fatigueStrainPairedFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
