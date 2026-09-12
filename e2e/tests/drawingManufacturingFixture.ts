/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';

/** New annotation text may paint before the source check completes; wait for the actual editable sheet. */
export async function waitForDrawingReady(page: Page): Promise<void> {
  await expect(page.locator('.pcad-drawing-sheet')).toHaveAttribute('aria-busy', 'false', { timeout: KERNEL_TIMEOUT_MS });
}

/** 縦線・横線は矩形の一辺が0でも描かれる。線の長さ・塗り・表示変換で確認する。 */
export async function expectDrawingStroke(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluateAll((elements) => elements.some((element) => {
    if (!(element instanceof SVGPathElement)) return false;
    const style = getComputedStyle(element), matrix = element.getScreenCTM();
    return element.getTotalLength() > 0 && style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0
      && style.display !== 'none' && style.visibility === 'visible' && matrix !== null && Math.hypot(matrix.a, matrix.b) > 0;
  }))).toBe(true);
}

export async function createBox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
}

export async function drawingFromBox(page: Page): Promise<void> {
  await createBox(page);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  await waitForDrawingReady(page);
}

export async function chooseDrawingMenu(page: Page, group: string, item: string): Promise<void> {
  await waitForDrawingReady(page);
  const menu = page.locator('.pcad-toolbar .pcad-toolbar__group').filter({
    has: page.locator('.pcad-toolbar__group-label', { hasText: new RegExp(`^${group}$`, 'u') }),
  });
  await menu.locator('.pcad-menu__trigger').click();
  await menu.getByRole('button', { name: item, exact: true }).click();
}
