import { test } from '@playwright/test';
import { analysisAdvancedFlow } from './analysisAdvancedFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
for (const mode of ['modal', 'buckling'] as const) {
  test(`実画面の立体解析 ${mode}: 入力・停止・保存再開・条件変更`, async ({ page }, info) => {
    await analysisAdvancedFlow(page, info, mode);
  });
}
