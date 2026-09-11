import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { camFlow } from './camFlow.js';
test('P11b 加工先の実Electron受渡し・保存取消・F1を確認する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await camFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
