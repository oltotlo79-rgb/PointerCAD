import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { parseDxfTags, readDxf } from '../../packages/io/src/index.js';

export interface SheetStepFiles { readonly flat: string; readonly folded: string }
export async function sheetExportFlow(page: Page, testInfo: TestInfo): Promise<SheetStepFiles> {
  const form = page.getByRole('form', { name: '板金の展開', exact: true });
  const paths = { flatDxf: testInfo.outputPath('sheet-relief-flat.dxf'), flatStep: testInfo.outputPath('sheet-relief-flat.step'), foldedStep: testInfo.outputPath('sheet-relief-folded.step') };
  for (const [kind, label] of [['flatDxf','展開DXF'], ['flatStep','展開STEP'], ['foldedStep','折曲げSTEP']] as const) {
    const download = page.waitForEvent('download');
    await form.getByRole('button', { name: label, exact: true }).click();
    await (await download).saveAs(paths[kind]);
    await expect(form.getByRole('button', { name: label, exact: true })).toBeEnabled();
    await expect(form.getByRole('alert')).toHaveCount(0);
  }
  const dxf = readDxf(parseDxfTags(await readFile(paths.flatDxf, 'utf8')));
  expect(dxf.unit).toBe('mm');
  const cuts = dxf.entities.filter((entity) => entity.layer === 'CUT_OUTER');
  expect(cuts.length).toBeGreaterThan(4);
  expect(cuts.some((entity) => entity.kind === 'arc')).toBe(true);
  expect(dxf.entities.some((entity) => entity.layer === 'BEND_UP')).toBe(true);
  expect(dxf.entities.every((entity) => ['CUT_OUTER','CUT_HOLES','BEND_UP','BEND_DOWN'].includes(entity.layer))).toBe(true);
  for (const path of [paths.flatStep, paths.foldedStep]) {
    const text = await readFile(path, 'utf8'); expect(text.startsWith('ISO-10303-21;')).toBe(true);
  }
  expect(await readFile(paths.flatStep, 'utf8')).not.toBe(await readFile(paths.foldedStep, 'utf8'));
  await page.screenshot({ path: testInfo.outputPath('sheet-exported.png') });
  return { flat: paths.flatStep, folded: paths.foldedStep };
}

export async function verifySheetStepFiles(page: Page, partPath: string, files: SheetStepFiles): Promise<void> {
  await page.reload();
  const open = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await open).setFiles(partPath);
  const left = page.locator('.pcad-panel--left');
  await expect(left.getByRole('button', { name: '曲げリリーフ1', exact: true })).toBeVisible({ timeout: 60_000 });
  for (const [path, expectedVolume] of [[files.flat, 4976 + 186 * Math.PI], [files.folded, 5000 + 200 * Math.PI - 78 * (6 + Math.PI) / 19]] as const) {
    const section = left.locator('.pcad-tree__sections > li').filter({ hasText: 'ソリッド' });
    const header = section.locator('.pcad-tree__row--section').first();
    if (await header.getAttribute('aria-expanded') === 'false') await header.click();
    const rows = section.locator('.pcad-tree__row--child'), count = await rows.count();
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイルのほかの操作/ }).first().click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.pcad-toolbar').getByRole('group', { name: 'ファイルのほかの操作', exact: true }).getByRole('button', { name: '読み込む', exact: true }).click();
    await (await chooser).setFiles(path);
    await expect(rows).toHaveCount(count + 1, { timeout: 60_000 });
    await rows.last().click();
    const value = page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^体積$/ }).locator('xpath=following-sibling::dd[1]');
    await expect.poll(async () => Number((await value.textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN), { timeout: 60_000 }).toBeCloseTo(expectedVolume, 4);
  }
}
