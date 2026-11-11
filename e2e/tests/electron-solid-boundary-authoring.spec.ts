import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { solidBoundaryAuthoringFlow } from './solidBoundaryAuthoringFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });

test('三面の独立した固定・指定変位と重力を保存し、再開して実計算と未対応の理由を確認する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await solidBoundaryAuthoringFlow(page, info, app);
  } finally { await app.close(); }
});
