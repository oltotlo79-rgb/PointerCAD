import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { analysisAdvancedFlow } from './analysisAdvancedFlow.js';

for (const mode of ['modal', 'buckling'] as const) {
  test(`実Electronの立体解析 ${mode}: 入力・停止・保存再開・条件変更`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await analysisAdvancedFlow(await app.firstWindow(), info, mode, app); }
    finally { await app.close(); }
  });
}
