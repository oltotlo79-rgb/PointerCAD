import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { plasticBarPlateauFlow } from './plasticBarPlateauFlow.js';

test('実Electronの棒の弾塑性: 降伏棚の入力・計算・保存再開・再計算・棚の変更と空欄', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await plasticBarPlateauFlow(page, info, app);
  } finally { await app.close(); }
});
