import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { chooseSheet, rectangleFace, tree, volume } from './sheetUiFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

const defaults = [
  ['板厚', '2'], ['内半径', '3'], ['K係数', '0.35'], ['フランジの長さ', '25'], ['曲げ角', '60'],
  ['始端の距離', '1'], ['終端の距離', '2'], ['入口の中心位置', '4'], ['切欠きの幅', '5'], ['切欠きの深さ', '6'],
] as const;

export const field = (form: Locator, name: string) => form.getByRole('textbox', { name: new RegExp(`^${name}(?: |$)`, 'u') });
export const settingsButton = (page: Page) => page.getByRole('button', { name: '設定', exact: true });

export async function openDefaults(page: Page): Promise<Locator> {
  await settingsButton(page).click();
  const form = page.getByRole('form', { name: '道具の初期値', exact: true });
  await form.getByLabel('変更する入力', { exact: true }).selectOption({ label: '板金' });
  return form;
}

export async function create(page: Page, form: Locator, name: string): Promise<void> {
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, name)).toBeVisible();
  await tree(page, name).click();
}

/** 設定値の実形状への適用、継承、取消、保存とUndoを3環境の同じ操作で検査する。 */
export async function sheetToolDefaultsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info); await rectangleFace(page);
  await chooseSheet(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  await create(page, base, '板金基板1');
  await expect.poll(() => volume(page)).toBeCloseTo(1500, 5);
  const original = await savePart(page, info, 'sheet-defaults-original.pcad', app);
  const generation = (await readRecomputeStats(page)).requestedGeneration;

  const form = await openDefaults(page), apply = form.getByRole('button', { name: '初期値を適用', exact: true });
  await expect(form.locator('.pcad-tool-defaults__field input')).toHaveCount(10);
  for (const [name, invalid] of [['K係数', '0.6'], ['曲げ角', '180'], ['始端の距離', '-1'], ['K係数', '0.4mm'], ['内半径', '1/0']]) {
    const input = field(form, name), previous = await input.inputValue();
    await input.fill(invalid); await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(apply).toBeDisabled(); await input.fill(previous);
  }
  for (const [name, value] of defaults) await field(form, name).fill(value);
  await apply.click(); await settingsButton(page).click();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
  expect(await savePart(page, info, 'sheet-defaults-settings-only.pcad', app)).toEqual(original);

  // 既存の基板を開き直しても、設定した2で既存の1を置き換えない。
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  const editBase = page.getByRole('form', { name: '板金基板', exact: true });
  await expect(editBase.getByRole('button', { name: '変更を適用', exact: true })).toBeVisible();
  await expect(field(editBase, '板厚')).toHaveValue('1');
  await editBase.getByRole('button', { name: '取消', exact: true }).click();

  await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  await expect(field(base, '板厚')).toHaveValue('2');
  await openDefaults(page); await field(form, '板厚').fill('3'); await apply.click(); await settingsButton(page).click();
  await expect(field(base, '板厚')).toHaveValue('2');
  await create(page, base, '板金基板2');
  await expect.poll(() => volume(page)).toBeCloseTo(3000, 5);
  await chooseSheet(page, '板金基板'); await expect(field(base, '板厚')).toHaveValue('3');
  await base.getByRole('button', { name: '取消', exact: true }).click();

  await tree(page, '板金基板2').click(); await chooseSheet(page, 'フランジ');
  const flange = page.getByRole('form', { name: 'フランジ', exact: true });
  for (const [name, value] of defaults.slice(3, 7)) await expect(field(flange, name)).toHaveValue(value);
  const radiusOverride = flange.getByRole('checkbox', { name: 'この曲げの内半径を指定', exact: true });
  const kOverride = flange.getByRole('checkbox', { name: 'この曲げのK係数を指定', exact: true });
  await expect(radiusOverride).not.toBeChecked(); await expect(kOverride).not.toBeChecked();
  await radiusOverride.check(); await kOverride.check();
  await expect(field(flange, '内半径')).toHaveValue('3'); await expect(field(flange, 'K係数')).toHaveValue('0.35');
  await radiusOverride.uncheck(); await kOverride.uncheck();
  await flange.getByRole('checkbox', { name: 'パネル 1 / 縁 1', exact: true }).check();
  await create(page, flange, 'フランジ1');
  await expect.poll(() => volume(page)).toBeCloseTo(3000 + 47 * 25 * 2 + 47 * 8 * Math.PI / 3, 4);
  const created = await savePart(page, info, 'sheet-defaults-created.pcad', app);
  expect(created.solids.filter(item => item.kind === 'sheetBase').map(item => item.rule.thickness.value)).toEqual([1, 2]);
  expect(created.solids.find(item => item.kind === 'sheetFlange')).toMatchObject({
    length: { source: '25', value: 25 }, angle: { source: '60', value: 60 },
    startOffset: { source: '1', value: 1 }, endOffset: { source: '2', value: 2 },
    rule: { innerRadius: null, kFactor: null },
  });

  // 保存済みの曲げで上書きを有効にし、設定変更後の再編集でも保存した式を保つ。
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await radiusOverride.check(); await kOverride.check();
  await field(flange, '内半径').fill('2+2'); await field(flange, 'K係数').fill('0.3');
  await flange.getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(flange).toHaveCount(0);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 47 * 25 * 2 + 47 * 10 * Math.PI / 3, 4);
  const overridden = await savePart(page, info, 'sheet-defaults-overridden.pcad', app);
  expect(overridden.solids.find(item => item.kind === 'sheetFlange')).toMatchObject({
    rule: { innerRadius: { source: '2+2', value: 4 }, kFactor: { source: '0.3', value: 0.3 } },
  });
  await openDefaults(page); await field(form, '内半径').fill('7'); await field(form, 'K係数').fill('0.2');
  await apply.click(); await settingsButton(page).click();
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await expect(radiusOverride).toBeChecked(); await expect(kOverride).toBeChecked();
  await expect(field(flange, '内半径')).toHaveValue('2+2'); await expect(field(flange, 'K係数')).toHaveValue('0.3');
  await flange.getByRole('button', { name: '取消', exact: true }).click();
  expect(await savePart(page, info, 'sheet-defaults-override-cancelled.pcad', app)).toEqual(overridden);
  const restoreInheritance = await beginRecompute(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, restoreInheritance);
  expect(await savePart(page, info, 'sheet-defaults-override-undone.pcad', app)).toEqual(created);
  await tree(page, 'フランジ1').click();

  await chooseSheet(page, '曲げリリーフ');
  const relief = page.getByRole('form', { name: '曲げリリーフ', exact: true });
  for (const [name, value] of defaults.slice(7)) await expect(field(relief, name)).toHaveValue(value);
  await relief.getByRole('button', { name: '取消', exact: true }).click();
  expect(await savePart(page, info, 'sheet-defaults-cancelled.pcad', app)).toEqual(created);

  const undo = await beginRecompute(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, undo);
  const undone = await savePart(page, info, 'sheet-defaults-undone.pcad', app);
  expect(undone.solids).toEqual(created.solids.filter(item => item.kind !== 'sheetFlange'));

  await page.reload(); await waitForStartupHealth(page, info);
  await openDefaults(page);
  for (const [name, value] of defaults) await expect(field(form, name)).toHaveValue(
    name === '板厚' ? '3' : name === '内半径' ? '7' : name === 'K係数' ? '0.2' : value);
  await settingsButton(page).click();
  const path = info.outputPath('sheet-defaults-created.pcad');
  if (app !== undefined) await openTarget(app, path);
  const opening = await beginRecompute(page);
  if (app === undefined) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '開く', exact: true }).click()]);
    await chooser.setFiles(path);
  } else await page.getByRole('button', { name: '開く', exact: true }).click();
  await waitForRecompute(page, opening);
  expect(await savePart(page, info, 'sheet-defaults-reopened.pcad', app)).toEqual(created);
  await tree(page, 'フランジ1').click(); await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中');
}
