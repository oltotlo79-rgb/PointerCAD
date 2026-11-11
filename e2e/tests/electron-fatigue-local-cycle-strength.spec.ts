import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { fatigueLocalCycleFlow } from './fatigueLocalCycleFlow.js';

test('F3 局所サイクルの寿命を、実Electronでも普通の操作で入力・計算・保存・元に戻す・開き直しする', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await fatigueLocalCycleFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
