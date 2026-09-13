import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

/** Continue the parameter flow using its saved coefficient table and the real coordinate popover. */
export async function mathCoordinateFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const point = page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true });
  await point.click();
  const popover = page.locator('.pcad-popover'), dialog = page.locator('.pcad-math-dialog');
  const fields = popover.locator('input.pcad-field__input');
  await expect(fields).toHaveCount(3);
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await expect(dialog.locator('textarea')).toBeVisible();
  await dialog.locator('textarea').fill('coef("幅")*2+sin(30)');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(popover.locator('.pcad-field__message').first()).toHaveText('= 8.5');
  await fields.nth(1).fill('2'); await fields.nth(2).fill('0');
  await page.screenshot({ path: info.outputPath('math-coordinate.png'), fullPage: true });
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const tree = page.locator('.pcad-panel--left');
  await expect(tree.getByRole('button', { name: '点1', exact: true })).toBeVisible();
  const document = await savePart(page, info, 'math-coordinate.pcad', app);
  const feature = document.sketches[0].features.find(item => item.kind === 'point');
  expect(feature).toMatchObject({ kind: 'point', at: { mode: 'absolute',
    x: { value: 8.5, source: 'coef("幅")*2+sin(30)', mathDefinition: { format: 'pointercad-math/1' } },
    y: { value: 2 }, z: { value: 0 } } });
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(tree.getByRole('button', { name: '点1', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(tree.getByRole('button', { name: '点1', exact: true })).toBeVisible();
  await tree.getByRole('button', { name: '点1', exact: true }).click();
  const properties = page.locator('.pcad-panel--right');
  const tab = properties.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabProperties'), exact: true });
  await tab.click(); await expect(tab).toHaveAttribute('aria-selected', 'true');
  const xLabel = uiMessage('numericInput', 'numericInput.field.x');
  const xField = properties.getByRole('textbox', { name: xLabel, exact: true });
  await expect(xField).toHaveValue('coef("幅")*2+sin(30)');
  await properties.getByRole('button', { name: `${xLabel}: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue('coef("幅")*2+sin(30)');
  await dialog.locator('textarea').fill('coef("幅")*3+sin(30)');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(properties.locator('.pcad-field__message').filter({ hasText: /^= 12\.5$/u })).toBeVisible();
  const edited = await savePart(page, info, 'math-point-edited.pcad', app);
  expect(edited.sketches[0].features.find(item => item.kind === 'point')).toMatchObject({ at: {
    x: { value: 12.5, source: 'coef("幅")*3+sin(30)', mathDefinition: { format: 'pointercad-math/1' } },
  } });
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(xField).toHaveValue('coef("幅")*2+sin(30)');
}
