import { expect, test } from '@playwright/test';
import { withBrowserFailureDiagnostics } from './browserFailureDiagnostics.js';
import { dwgFlow } from './dwgFlow.js';
test('P11b DWGは選択前に変換手順へ案内し文書を変えない', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // 2026-09-23: the worker's reused Firefox closed during this first goto and its browser trace was lost.
  // Record which stage saw the page, context or browser close, with the time and host memory.
  await withBrowserFailureDiagnostics(page, info, async (stage) => {
    stage('起動画面へ移動'); await page.goto('/');
    stage('DWG案内の操作'); await dwgFlow(page, info);
  });
  expect(errors).toEqual([]);
});
