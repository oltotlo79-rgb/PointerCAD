import { test } from '@playwright/test';
import { shellAnalysisPersistenceFlow, shellAnalysisSolidRefusalFlow } from './shellAnalysisPersistenceFlow.js';

// Chromium (functional) and Firefox (explicit selection in playwright.config.ts) run the same shared flow.
test('薄板の解析: 実画面の平面シートで純曲げを実Workerで解き、保存・開き直し・再実行・条件変更を通す', async ({ page }, info) => {
  await shellAnalysisPersistenceFlow(page, info);
});

test('薄板の解析: ソリッドの箱は中央面にできず理由を表示し、FEM Workerを起動しない', async ({ page }, info) => {
  await shellAnalysisSolidRefusalFlow(page, info);
});
