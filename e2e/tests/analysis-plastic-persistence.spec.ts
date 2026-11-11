import { test } from '@playwright/test';
import { analysisPlasticPersistenceFlow } from './analysisPlasticPersistenceFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
test('実画面の小変形の弾塑性解析: 入力・停止・条件変更・保存再開・再計算', async ({ page }, info) => {
  await analysisPlasticPersistenceFlow(page, info);
});
