/// <reference lib="dom" />
import { expect, test } from '@playwright/test';

test('Web 版が起動し、空のスケッチの案内が出る', async ({ page }) => {
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

  // 起動直後はまだ何もかいていないので、最初の一歩の案内が出る(NFR-UX-6、§0.a-0.2)。
  // 幾何カーネル(Worker + OCCT)を通る経路は、面を張るタスク23 の sketch.spec.ts が受け持つ。
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // ビューキューブも常時表示されている(FR-103)。
  await expect(page.locator('canvas.pcad-viewcube')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
