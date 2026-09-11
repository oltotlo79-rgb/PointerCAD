import { expect, test } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { panel, writeDraft, successfulRun } from './scriptsFlow.js';
import { readRecomputeStats } from './recompute.js';
import { measureViewportFps } from './viewportRenderStats.js';

test('P11 自動作図実行中の実描画性能が30fps以上で、失敗した処理を反映しない', async ({ page }) => {
  await page.goto('/'); await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '自動作図', '自動作図');
  await panel(page).getByRole('combobox', { name: '例を開く', exact: true }).selectOption('grid');
  await successfulRun(page);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  const before = await readRecomputeStats(page);
  await writeDraft(page, '実行中の応答', '// この行の次で実行時間を使う\nwhile(true){}');
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  const running = panel(page).getByRole('status').filter({ hasText: /^処理を実行中$/u });
  await expect(running).toBeVisible();
  const measured = await measureViewportFps(page);
  await expect(running).toBeVisible();
  console.log(`[実測] 自動作図の実Worker処理中: ${measured.fps.toFixed(1)} fps（${measured.completedRenders}描画/${measured.elapsedMs.toFixed(1)}ms、下限30fps）`);
  expect(measured.fps).toBeGreaterThanOrEqual(30);
  await expect(panel(page).getByRole('alert')).toContainText('上限5秒');
  await expect(panel(page).getByRole('button', { name: /エラーの行へ移動 user-script.js:2/u })).toBeVisible();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(before.requestedGeneration);
});
