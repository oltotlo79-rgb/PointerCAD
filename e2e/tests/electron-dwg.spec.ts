import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { dwgFlow } from './dwgFlow.js';
test('P11b DWGの変換案内を実Electronで開ける', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await dwgFlow(page, info); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
