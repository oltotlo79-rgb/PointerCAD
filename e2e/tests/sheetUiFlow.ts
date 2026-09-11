import { expect, type Page } from '@playwright/test';

export const tree = (page: Page, name: string) => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
export async function command(page: Page, text: string) {
  const input = page.locator('#pcad-command-line-input'); await input.click(); await input.fill(text); await input.press('Enter');
}
export async function chooseSheet(page: Page, name: string) {
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^板金/ }).first().click();
  await page.locator('.pcad-menu__panel[aria-label="板金"]').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('form', { name, exact: true })).toBeVisible();
}
export async function volume(page: Page): Promise<number> {
  const value = await page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^体積$/ }).locator('xpath=following-sibling::dd[1]').textContent();
  return Number(value?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
}
export async function rectangleFace(page: Page, width = 50, height = 30) {
  const sketch = page.getByRole('group', { name: 'スケッチ', exact: true });
  await sketch.getByRole('button', { name: '選択', exact: true }).click();
  await sketch.locator('.pcad-menu__trigger').first().click();
  await page.locator('.pcad-menu__panel[aria-label="作図"]').getByRole('button', { name: '矩形', exact: true }).click();
  const popup = page.locator('.pcad-popover'), fields = popup.locator('input.pcad-field__input');
  for (let i = 0; i < 3; i++) await fields.nth(i).fill('0');
  await fields.first().press('Enter');
  await expect(page.locator('.pcad-popover__title')).toHaveText('矩形の 2 つ目の角');
  await popup.getByRole('button', { name: '絶対', exact: true }).click();
  for (const [i, value] of [String(width), String(height), '0'].entries()) await fields.nth(i).fill(value);
  await fields.first().press('Enter');
  await fields.first().press('Escape');
  await tree(page, '矩形1').click();
  await sketch.getByRole('button', { name: '面', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
  await expect(tree(page, '面1')).toBeVisible();
}
