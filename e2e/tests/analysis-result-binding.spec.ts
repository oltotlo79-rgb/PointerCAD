import { test } from '@playwright/test';
import { analysisResultBindingFlow } from './analysisResultBindingFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });

test('立体解析の実結果は材料・メッシュ条件の変更と古い計算の応答で残らず、表示の設定だけでは消えない', async ({ page }, info) => {
  await analysisResultBindingFlow(page, info, false);
});
