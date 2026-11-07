import { test } from '@playwright/test';
import { plasticBarPlateauFlow } from './plasticBarPlateauFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
test('実画面の棒の弾塑性: 降伏棚の入力・計算・保存再開・再計算・棚の変更と空欄', async ({ page }, info) => {
  await plasticBarPlateauFlow(page, info);
});
