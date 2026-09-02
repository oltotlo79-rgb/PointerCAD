/// <reference lib="dom" />
import { expect, test } from '@playwright/test';

test('Web 版が起動し、幾何カーネルが計算した箱がビューポートに描かれる', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto('/');

  await expect(page).toHaveTitle('PointerCAD');

  // 画面が隔離状態で動いている(FR-1003)。
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  const viewport = page.locator('canvas.pcad-viewport__canvas');
  await expect(viewport).toBeVisible();

  const size = await viewport.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(100);
  expect(size?.height ?? 0).toBeGreaterThan(100);

  // 幾何カーネル(Worker + OCCT)の計算が終わると、三角形の数がプロパティ欄に出る。
  // OCCT の初期化に時間がかかるため、待ち時間を長めに取る。
  await expect(page.locator('.pcad-panel--right')).toContainText('三角形の数');
  await expect(page.locator('.pcad-panel--right')).toContainText('12', { timeout: 120_000 });

  // ビューキューブも常時表示されている(FR-103)。
  await expect(page.locator('canvas.pcad-viewcube')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
