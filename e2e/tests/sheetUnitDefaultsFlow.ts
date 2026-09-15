import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { reopen, setDefaults } from './sheetOperationDefaultsFlow.js';
import { create, field } from './sheetToolDefaultsFlow.js';
import { chooseSheet, rectangleFace, tree, volume } from './sheetUiFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

async function setUnit(page: Page, unit: 'mm' | 'inch'): Promise<void> {
  const button = page.locator('button.pcad-statusbar__unit'), expected = `単位: ${unit}`;
  if ((await button.textContent())?.trim() !== expected) await button.click();
  await expect(button).toHaveText(expected);
}

const thicknessLabel = (form: Locator) => form.locator('label.pcad-field').filter({ hasText: /^板厚/u });

/** 設定のmm、手入力のinch、保存式を実形状と同じ確認に含める。 */
export async function sheetUnitDefaultsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
  await setUnit(page, 'mm'); await rectangleFace(page);
  await setDefaults(page, [['板厚', '25.4']]); await setUnit(page, 'inch');
  await chooseSheet(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  await expect(field(base, '板厚')).toHaveValue('25.4');
  await expect(thicknessLabel(base).locator('span').last()).toHaveText('mm');
  await create(page, base, '板金基板1');
  await setUnit(page, 'mm');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(50 * 30 * 25.4, 4);

  await tree(page, '面1').click(); await setUnit(page, 'inch'); await chooseSheet(page, '板金基板');
  await expect(field(base, '板厚')).toHaveValue('25.4');
  await field(base, '板厚').fill('1');
  await expect(thicknessLabel(base).locator('span').last()).toHaveText('in');
  await create(page, base, '板金基板2'); await setUnit(page, 'mm');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(50 * 30 * 25.4, 4);
  const created = await savePart(page, info, 'sheet-unit-defaults-created.pcad', app);
  const values = created.solids.flatMap(item => item.kind === 'sheetBase' ? [item.rule.thickness] : []);
  expect(values.map(value => value.source)).toEqual(['25.4', '(1)in']);
  expect(values.map(value => value.value)).toEqual([25.4, 25.4]);

  await setUnit(page, 'inch'); await reopen(page, info, 'sheet-unit-defaults-created.pcad', app);
  expect(await savePart(page, info, 'sheet-unit-defaults-reopened.pcad', app)).toEqual(created);
  await tree(page, '板金基板1').click();
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await expect(field(base, '板厚')).toHaveValue('25.4');
  await expect(thicknessLabel(base).locator('span').last()).toHaveText('mm');
  await base.getByRole('button', { name: '取消', exact: true }).click();
  expect(await savePart(page, info, 'sheet-unit-defaults-edit-cancelled.pcad', app)).toEqual(created);

  await tree(page, '板金基板2').click();
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await expect(field(base, '板厚')).toHaveValue('(1)in');
  await field(base, '板厚').fill('0.5');
  await expect(thicknessLabel(base).locator('span').last()).toHaveText('in');
  await base.getByRole('button', { name: '変更を適用', exact: true }).click(); await expect(base).toHaveCount(0);
  await setUnit(page, 'mm');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(50 * 30 * 12.7, 4);
  const edited = await savePart(page, info, 'sheet-unit-defaults-edited.pcad', app);
  expect(edited.solids.flatMap(item => item.kind === 'sheetBase' ? [item.rule.thickness.value] : [])).toEqual([25.4, 12.7]);
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await waitForRecompute(page, undo);
  expect(await savePart(page, info, 'sheet-unit-defaults-undone.pcad', app)).toEqual(created);
}
