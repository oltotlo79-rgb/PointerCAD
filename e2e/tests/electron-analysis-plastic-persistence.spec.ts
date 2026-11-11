import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { analysisPlasticPersistenceFlow } from './analysisPlasticPersistenceFlow.js';

test('実Electronの小変形の弾塑性解析: 入力・停止・条件変更・保存再開・再計算', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await analysisPlasticPersistenceFlow(page, info, app);
  } finally { await app.close(); }
});
