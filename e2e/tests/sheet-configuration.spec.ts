import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { sheetConfigurationFile, SHEET_CONFIGURATIONS } from './sheetConfigurationFixture.js';
import { openSheetPart } from './sheetPartFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

async function checkShape(page: Page, expected: { readonly folded: number; readonly flat: number }) {
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
  await page.locator('.pcad-panel--left').getByRole('button', { name: '切欠き付きU板1', exact: true }).click();
  const value = page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^体積$/ }).locator('xpath=following-sibling::dd[1]');
  await expect.poll(async () => Number((await value.textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0])).toBeCloseTo(expected.folded, 4);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^板金/ }).first().click();
  await page.locator('.pcad-menu__panel[aria-label="板金"]').getByRole('button', { name: '板金の展開', exact: true }).click();
  const flat = page.getByRole('form', { name: '板金の展開', exact: true });
  await flat.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(flat.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  expect(Number((await flat.getByRole('status').textContent())?.match(/体積: ([\d.]+)/u)?.[1])).toBeCloseTo(expected.flat, 4);
  await flat.getByRole('button', { name: '折曲げを表示', exact: true }).click();
  await flat.getByRole('button', { name: '閉じる', exact: true }).click();
}

test('P10 板金の構成で板厚・半径・K・両フランジを切り替え、展開・Undo・保存往復に追従する', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await openSheetPart(page, '板金の二構成.pcad', sheetConfigurationFile());
  await checkShape(page, SHEET_CONFIGURATIONS.default);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  const configuration = page.getByRole('combobox', { name: '構成', exact: true });
  await expect(configuration).toHaveValue('configuration-1');
  const switching = await beginRecompute(page);
  await configuration.selectOption({ label: '厚板' }); await waitForRecompute(page, switching);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await page.screenshot({ path: info.outputPath('sheet-configuration.png') });
  await checkShape(page, SHEET_CONFIGURATIONS.thick);
  const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const path = info.outputPath('sheet-configuration.pcad'); await (await saving).saveAs(path);
  const bytes = await readFile(path), decoded = readPcadFile(bytes); if (!decoded.ok) throw new Error(decoded.error.message);
  expect(decoded.document.activeConfigurationId).toBe('configuration-2');
  expect(decoded.document.configurations).toHaveLength(2);
  expect(decoded.document.solids[0]).toMatchObject({ kind: 'sheetBase', rule: { thickness: { source: '板厚', value: 3 }, innerRadius: { source: '内半径', value: 4 }, kFactor: { source: 'K値', value: 0.3 } } });
  for (const solid of decoded.document.solids.slice(1, 3)) expect(solid).toMatchObject({ kind: 'sheetFlange', length: { source: '腕長', value: 25 } });
  const undo = await beginRecompute(page); await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, undo);
  await checkShape(page, SHEET_CONFIGURATIONS.default);
  const redo = await beginRecompute(page); await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await waitForRecompute(page, redo);
  await checkShape(page, SHEET_CONFIGURATIONS.thick);
  await page.reload(); await openSheetPart(page, 'sheet-configuration.pcad', bytes);
  await checkShape(page, SHEET_CONFIGURATIONS.thick);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(configuration).toHaveValue('configuration-2');
  expect(errors).toEqual([]);
});
