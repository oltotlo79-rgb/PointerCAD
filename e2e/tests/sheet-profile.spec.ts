import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { openSheetPart } from './sheetPartFlow.js';
import { sheetProfileFile } from './sheetProfileFixture.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

const tree = (page: Page, name: string) => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
async function choose(page: Page, name: string) {
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^板金/ }).first().click();
  await page.locator('.pcad-menu__panel[aria-label="板金"]').getByRole('button', { name, exact: true }).click();
}
async function volume(page: Page) {
  const value = await page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^体積$/ }).locator('xpath=following-sibling::dd[1]').textContent();
  return Number(value?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
}

test('P10 板金の任意輪郭・穴・複数縁・曲げ条件を指定してU板を作り、展開と保存往復に保持する', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await openSheetPart(page, '台形フランジの作図.pcad', sheetProfileFile());
  await tree(page, '基板の面').click(); await choose(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  await base.getByRole('textbox', { name: /^板厚/ }).fill('2');
  await base.getByRole('textbox', { name: /^内半径/ }).fill('3');
  await base.getByRole('button', { name: '作成', exact: true }).click();
  await tree(page, '板金基板1').click(); await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
  await choose(page, 'フランジ'); const form = page.getByRole('form', { name: 'フランジ', exact: true });
  for (const edge of [1,3]) await form.getByRole('checkbox', { name: `パネル 1 / 縁 ${edge}`, exact: true }).check();
  await form.getByRole('combobox', { name: 'フランジの輪郭', exact: true }).selectOption('profile');
  const outer = form.getByRole('combobox', { name: 'フランジの外周', exact: true });
  const outerValue = await outer.getByRole('option', { name: / \/ 台形の面$/u }).getAttribute('value');
  if (!outerValue) throw new Error('台形の面の選択値が必要です');
  await outer.selectOption(outerValue);
  await form.getByRole('checkbox', { name: / \/ 穴の面$/u }).check();
  await form.getByRole('combobox', { name: '接続する基準縁', exact: true }).selectOption({ label: '縁 1' });
  await form.getByRole('textbox', { name: /^始端の距離/ }).fill('5');
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('長さ'); await expect(tree(page, 'フランジ1')).toHaveCount(0);
  await form.getByRole('textbox', { name: /^始端の距離/ }).fill('0');
  await form.getByRole('checkbox', { name: 'この曲げの内半径を指定', exact: true }).check();
  await form.getByRole('textbox', { name: /^内半径/ }).fill('2*2');
  await form.getByRole('checkbox', { name: 'この曲げのK係数を指定', exact: true }).check();
  await form.getByRole('textbox', { name: /^K係数/ }).fill('0.3');
  await form.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath('sheet-profile-preview.png') });
  await form.getByRole('button', { name: '作成', exact: true }).click(); await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(6200 + 484 * Math.PI, 4);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('sheet-profile-created.png') });
  await choose(page, '板金の展開'); const flat = page.getByRole('form', { name: '板金の展開', exact: true });
  await flat.getByRole('combobox', { name: '固定面', exact: true }).selectOption({ label: 'パネル 3' });
  await flat.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(flat.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  expect(Number((await flat.getByRole('status').textContent())?.match(/体積: ([\d.]+)/u)?.[1])).toBeCloseTo(6200 + 444 * Math.PI, 4);
  await page.screenshot({ path: testInfo.outputPath('sheet-profile-flat.png') });
  const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const path = testInfo.outputPath('sheet-profile.pcad'); await (await saving).saveAs(path);
  const bytes = await readFile(path), decoded = readPcadFile(bytes); if (!decoded.ok) throw new Error(decoded.error.message);
  const flange = decoded.document.solids[1]; expect(flange.kind).toBe('sheetFlange');
  if (flange.kind !== 'sheetFlange') throw new Error('フランジの履歴が必要です');
  expect(flange.edges).toHaveLength(2); expect(flange.profile?.holes).toHaveLength(1);
  expect(flange.rule).toMatchObject({ innerRadius: { source: '2*2', value: 4 }, kFactor: { source: '0.3', value: 0.3 } });
  await page.reload(); await openSheetPart(page, 'sheet-profile.pcad', bytes); await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page)).toBeCloseTo(6200 + 484 * Math.PI, 4);
  const angle = page.locator('.pcad-panel--right .pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: /^曲げ角$/ }) }).locator('input');
  const changing = await beginRecompute(page);
  await angle.fill('-90'); await angle.press('Tab'); await waitForRecompute(page, changing);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(6200 + 484 * Math.PI, 4);
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await expect(angle).toHaveValue('90'); await waitForRecompute(page, undo);
  expect(errors).toEqual([]);
});
