import { expect, test } from '@playwright/test';
import { writePcadFile } from '../../packages/io/src/index.js';
import { sheetPerformanceFixture } from '../../packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js';
import { openSheetPart } from './sheetPartFlow.js';
import { measureViewportFps, readViewportRenderStats } from './viewportRenderStats.js';
import { readRecomputeStats } from './recompute.js';

test('P10 板金100段の実描画性能が30fps以上で、オービットによる再計算を発生させない', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  const document = sheetPerformanceFixture(25, -225, -215); expect(document.solids).toHaveLength(100);
  await page.goto('/'); await openSheetPart(page, '板金100段.pcad', writePcadFile(document));
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: /^切欠き付きU板\d+$/u })).toHaveCount(25);
  const render = await readViewportRenderStats(page);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders).toBeGreaterThan(render.completedRenders);
  // ホームは原点へ戻す操作。25個すべての実メッシュが画面内へ収まる距離にする。
  await page.locator('canvas.pcad-viewport__canvas').hover(); await page.mouse.wheel(0, 1500);
  const ids = Array.from({ length: 25 }, (_, i) => `relief-${i}`).sort();
  const framed = () => page.evaluate(() => [...(window.pcadViewportFramedBodies?.() ?? [])].sort());
  await expect.poll(framed).toEqual(ids);
  await page.screenshot({ path: testInfo.outputPath('sheet-100-features-before.png') });
  const before = await readRecomputeStats(page), fps = await measureViewportFps(page);
  console.log(`[実測] 板金100段・U板25個のビューポート: ${fps.fps.toFixed(1)} fps（${fps.completedRenders}描画/${fps.elapsedMs.toFixed(1)}ms、下限30fps）`);
  expect(fps.fps).toBeGreaterThanOrEqual(30);
  const after = await readRecomputeStats(page);
  expect(after.requestedGeneration).toBe(before.requestedGeneration);
  expect(after.completedGeneration).toBe(before.completedGeneration);
  expect(after.lastOutcome).toBe('success');
  expect(await framed()).toEqual(ids);
  await testInfo.attach('板金100段の実描画測定', { body: JSON.stringify({ ...fps, before, after }), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('sheet-100-features.png') });
  expect(errors).toEqual([]);
});
