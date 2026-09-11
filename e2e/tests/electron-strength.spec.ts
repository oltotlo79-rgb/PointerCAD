import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { strengthFlow } from './strengthFlow.js';

test('P11b 強度の三方式と材料条件を実Electronでも操作できる', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await strengthFlow(page, info); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
