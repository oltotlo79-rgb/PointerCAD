import { expect, test, type Locator, type Page } from '@playwright/test';
import { rectangleFace, tree, chooseSheet, volume } from './sheetUiFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

async function reachable(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); await expect(locator).toBeVisible();
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('操作欄の表示領域を取得できません');
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('P10 板金は150%表示で入力と確定に到達でき、100×60の板厚編集・Undo・抑制解除が形へ反映される', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('group', { name: '拡大率' }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await rectangleFace(page, 100, 60); await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  for (const [label, value] of [['板厚','2'], ['内半径','3'], ['K係数','0.4']]) {
    const input = base.getByRole('textbox', { name: new RegExp(`^${label}`, 'u') });
    await reachable(page, input); await input.fill(value);
  }
  await reachable(page, base.getByRole('button', { name: '作成', exact: true }));
  await page.screenshot({ path: info.outputPath('sheet-base-150.png') });
  await base.getByRole('button', { name: '作成', exact: true }).click(); await tree(page, '板金基板1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(12000, 5);
  const thickness = page.locator('.pcad-panel--right .pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: /^板厚$/ }) }).locator('input');
  await thickness.fill('3'); await thickness.press('Tab'); await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(18000, 5);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(thickness).toHaveValue('2');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(12000, 5);
  const row = tree(page, '板金基板1');
  for (const action of ['抑制する', '抑制を解く']) {
    await row.click({ button: 'right' });
    const changing = await beginRecompute(page);
    await page.getByRole('menuitem', { name: action, exact: true }).click(); await waitForRecompute(page, changing);
  }
  await row.click(); await expect.poll(() => volume(page)).toBeCloseTo(12000, 5);
  for (const name of ['フランジ', '指定線で曲げる', '曲げリリーフ']) {
    await chooseSheet(page, name);
    const form = page.getByRole('form', { name, exact: true });
    const inputs = form.getByRole('textbox');
    for (let i = 0; i < await inputs.count(); i++) await reachable(page, inputs.nth(i));
    await reachable(page, form.getByRole('button', { name: '作成', exact: true }));
    await page.screenshot({ path: info.outputPath(`sheet-${name}-150.png`) });
    await form.getByRole('button', { name: '取消', exact: true }).click();
  }
  expect(errors).toEqual([]);
});
