import { test } from '@playwright/test';
import { analysisFatigueNativeFlow } from './analysisFatigueNativeFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });

test('実ソリッド解析の要素応力から比例荷重の疲労を見積もり、入力の変更・保存・開き直しで古い結果を使わない', async ({ page }, info) => {
  await analysisFatigueNativeFlow(page, info);
});
