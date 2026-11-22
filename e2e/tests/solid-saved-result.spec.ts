import { test } from '@playwright/test';
import { disableFilePickers } from './filePickers.js';
import { solidSavedResultFlow } from './solidSavedResultFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });

test('立体の静解析の結果は部品と一緒に保存され、開き直すと計算し直さずに同じ値と保存した結果の 1 行が出て、材料を変えると消える', async ({ page }, info) => {
  await disableFilePickers(page);
  await solidSavedResultFlow(page, info);
});
