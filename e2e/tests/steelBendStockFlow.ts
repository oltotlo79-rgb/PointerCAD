/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import type { PartDocument } from '../../packages/model/src/index.js';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { componentRows, disableFilePickers } from './boltedJointTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { waitForStartupReady } from './startupHealth.js';
import { chooseSteelFlatBar50x6 } from './steelPickerFlow.js';
import { expectSteelStockCsv, expectSteelStockCsvProvenance, expectSteelStockTableHeader,
  expectSteelStockTableRevisions, SS400_FLAT } from './steelStockExpectation.js';

/*
 * EX08/EX03 public host flow: an SS400 FB 50×6 bend made in the standard-part picker, then the picker's own cut-list
 * table and its 切断リストをCSVで保存 button, then a saved .pcada reopen and the same table/CSV again.
 * Every step is a user action through the UI; no fixture file is loaded and no store state is injected.
 * Independent expectation (steelBend.test.ts closed form, not read from the exporter): FB 50×6 bent towards +X with
 * inside radius 30 has the centroid radius 30 + 50 / 2 = 55, so the developed length is 200 + 100 + 55 * pi / 2.
 * No density, strength or catalog value is introduced; the catalog expectations are independently fixed in steelStockExpectation.ts.
 */
const DEVELOPED = 300 + 55 * Math.PI / 2;
const SS400_FLAT_COLUMNS = SS400_FLAT.columns;
const FINISHED_UNKNOWN = '未確定（加工履歴の確認が必要）';
const COLUMN = { kind: 0, stockLength: 7, quantity: 8, totalLength: 9, paths: 10, notice: 11, finished: 13 } as const;

function picker(page: Page): Locator {
  return page.getByRole('dialog', { name: '規格部品を置く', exact: true });
}
function choice(dialog: Locator, label: string): Locator {
  return dialog.getByRole('combobox', { name: label, exact: true });
}
function stockDetails(dialog: Locator): Locator {
  return dialog.locator('details').filter({ has: dialog.page().locator('summary', { hasText: '鋼材切断リスト' }) });
}


async function openSteelPicker(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, '組む', '規格部品');
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await choice(dialog, '種類').selectOption('structuralSection');
  await chooseSteelFlatBar50x6(dialog, { grade: 'SS400', size: SS400_FLAT_COLUMNS[4], condition: SS400_FLAT_COLUMNS[5] });
  return dialog;
}

/** User action: the bend fields of the picker (labels as in steelBendFlow.ts), then the ordinary placement. */
async function placeBend(page: Page): Promise<void> {
  const dialog = await openSteelPicker(page);
  await dialog.getByRole('checkbox', { name: '曲げ部品を作る', exact: true }).check();
  await dialog.getByLabel('曲げ半径 R (mm)', { exact: true }).fill('30');
  await dialog.getByLabel('曲げ角度 (度)', { exact: true }).fill('90');
  await dialog.getByLabel('第1脚の寸法 (mm)', { exact: true }).fill('200');
  await dialog.getByLabel('第2脚の寸法 (mm)', { exact: true }).fill('100');
  await dialog.getByRole('combobox', { name: '半径の基準', exact: true }).selectOption('inside');
  await dialog.getByRole('combobox', { name: '脚寸法の基準', exact: true }).selectOption('tangent');
  await dialog.getByRole('button', { name: '曲げ部品の配置へ', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
  await expect(placement).toBeVisible();
  const token = await beginRecompute(page);
  await placement.getByRole('button', { name: '置く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(1);
}

/** The picker's cut-list table: one bend row whose stock and finished cells both equal the developed length. */
async function expectBendTable(dialog: Locator): Promise<string> {
  const details = stockDetails(dialog);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const rows = details.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expectSteelStockTableHeader(details);
  const cells = await rows.first().locator('td').allTextContents();
  expectSteelStockTableRevisions(cells, SS400_FLAT);
  expect(cells.slice(0, 2)).toEqual(['SS400', 'FB 50×6']);
  expect(cells[3], 'finished length is proved, not unknown').not.toBe(FINISHED_UNKNOWN);
  expect(cells[3]).toBe(cells[2]);
  expect(Math.abs(Number(cells[2]) - DEVELOPED) / DEVELOPED).toBeLessThan(1e-12);
  expect([cells[4], cells[5]]).toEqual(['1', cells[2]]);
  await expect(details.locator('tfoot td')).toHaveText(['1', cells[2]]);
  return cells[2];
}

/** Real CSV button; web download or Electron save dialog (as steelStockCsvFlow.ts). */
async function exportCsv(page: Page, dialog: Locator, path: string, app: ElectronApplication | undefined): Promise<Buffer> {
  const details = stockDetails(dialog);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const button = details.getByRole('button', { name: '切断リストをCSVで保存', exact: true });
  await expect(button).toBeEnabled();
  let bytes: Buffer;
  if (app === undefined) {
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    await download.saveAs(path);
    bytes = await readFile(path);
  } else {
    await saveTarget(app, path);
    await button.click();
    bytes = await diskFile(path);
  }
  await expect(details.getByRole('status').filter({ hasText: 'CSVを保存しました。' })).toBeVisible();
  return bytes;
}

/** The CSV has exactly one cut row for the placed bend component, with the table's stock and finished lengths. */
async function expectBendCsv(page: Page, bytes: Buffer, stockCell: string): Promise<void> {
  const rows = expectSteelStockCsv(bytes);
  const cut = rows.filter(row => row[COLUMN.kind] === '切断明細');
  expect(cut).toHaveLength(1);
  const row = cut[0];
  expectSteelStockCsvProvenance(row, SS400_FLAT);
  expect(row.slice(1, 7)).toEqual(SS400_FLAT_COLUMNS);
  expect([row[COLUMN.stockLength], row[COLUMN.quantity], row[COLUMN.totalLength], row[COLUMN.finished]])
    .toEqual([stockCell, '1', stockCell, stockCell]);
  const placed = (await readAssemblyStats(page)).components;
  expect(placed).toHaveLength(1);
  expect(placed[0].sourceKind).toBe('part');
  expect(JSON.parse(row[COLUMN.paths] ?? '')).toEqual([[placed[0].id]]);
  const total = rows.filter(item => item[COLUMN.kind] === '集計できた鋼材の合計');
  expect(total.map(item => [item[COLUMN.quantity], item[COLUMN.totalLength], item[COLUMN.notice]]))
    .toEqual([['1', stockCell, '']]);
  expect(rows.filter(item => item[COLUMN.kind] === '集計対象外')).toHaveLength(0);
}

/*
 * Second case helpers (task171). The open/cut/save/refresh steps are a minimal local copy of steelEditableStockFlow.ts
 * lines 120-148 and 271-311 (its helpers are not exported); selectors and names are the ones used there.
 */
function solidRow(page: Page, name: string): Locator {
  return page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: 'ソリッド' })
    .getByRole('button', { name, exact: true });
}
function propertyValue(page: Page, key: string): Locator {
  return page.locator('.pcad-panel--right').locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}
function propertyField(page: Page, label: string): Locator {
  return page.locator('.pcad-panel--right .pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`, 'u') }) })
    .locator('input.pcad-field__input');
}
async function componentMenu(page: Page, index: number): Promise<Locator> {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
  });
  await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__more').nth(index).click();
  return page.locator('.pcad-tree__menu');
}
/** Saves through a real control: web download or the native Electron save dialog. */
async function savedThrough(page: Page, control: Locator, path: string, app: ElectronApplication | undefined): Promise<Buffer> {
  if (app === undefined) {
    const [download] = await Promise.all([page.waitForEvent('download'), control.click()]);
    expect(download.suggestedFilename()).toMatch(/\.(pcad|csv)$/u);
    await download.saveAs(path);
    return readFile(path);
  }
  await saveTarget(app, path);
  await control.click();
  return diskFile(path);
}

/** User action: the same bend as the first case, ticked 加工できる部品にする; the part file is saved before placement. */
async function placeEditableBend(page: Page, path: string, app: ElectronApplication | undefined): Promise<PartDocument> {
  const dialog = await openSteelPicker(page);
  await dialog.getByRole('checkbox', { name: '曲げ部品を作る', exact: true }).check();
  await dialog.getByLabel('曲げ半径 R (mm)', { exact: true }).fill('30');
  await dialog.getByLabel('曲げ角度 (度)', { exact: true }).fill('90');
  await dialog.getByLabel('第1脚の寸法 (mm)', { exact: true }).fill('200');
  await dialog.getByLabel('第2脚の寸法 (mm)', { exact: true }).fill('100');
  await dialog.getByRole('combobox', { name: '半径の基準', exact: true }).selectOption('inside');
  await dialog.getByRole('combobox', { name: '脚寸法の基準', exact: true }).selectOption('tangent');
  await dialog.getByRole('checkbox', { name: '加工できる部品にする', exact: true }).check();
  await expect(dialog.getByText('保存した部品ファイルを開いて切断や穴を加えて保存し', { exact: false })).toBeVisible();
  const bytes = await savedThrough(page, dialog.getByRole('button', { name: '曲げ部品の配置へ', exact: true }), path, app);
  const read = await readDocumentBundle(new Uint8Array(bytes), 'part');
  if (!read.ok || read.bundle.kind !== 'part') throw new Error('Saved editable bend did not decode');
  const part = read.bundle.document;
  expect(part.id).toMatch(/^part-uuid:/u);
  expect(part.steelStockSource).toMatchObject({ catalog: 'flatBar', size: 'FB 50×6',
    options: { steelProduct: 'SS400:flatBar:FB 50×6', materialGrade: 'SS400' } });
  expect(part.solids.map(solid => solid.kind)).toEqual(['sweep']);
  await expect(dialog).toHaveCount(0);
  const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
  await expect(placement).toBeVisible();
  const token = await beginRecompute(page);
  await placement.getByRole('button', { name: '置く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(placement).toHaveCount(0);
  await expect(componentRows(page)).toHaveCount(1);
  return part;
}

/** User action on the opened bend part: 加工→切断 on the XY plane, keeping the face side, 距離 100 (inside the first leg). */
async function cutOpenedBend(page: Page, bend: PartDocument): Promise<void> {
  const stockName = bend.solids.at(-1)?.name;
  if (stockName === undefined) throw new Error('Editable bend has no solid');
  await solidRow(page, stockName).click();
  await chooseToolMenuItem(page, '加工', '切断');
  const popover = page.locator('.pcad-popover');
  await expect(page.locator('.pcad-popover__title')).toHaveText('切る面');
  const cutToken = await beginRecompute(page);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await expect(popover).toHaveCount(0);
  await waitForRecompute(page, cutToken);
  await solidRow(page, '切断1').click();
  await expect(propertyValue(page, '切る面の決め方')).toHaveText('作図面からずらす');
  await expect(propertyValue(page, '残す側')).toHaveText('面の表側');
  const distanceToken = await beginRecompute(page);
  await propertyField(page, '距離').fill('100');
  await waitForRecompute(page, distanceToken);
  await waitForSettledRecompute(page);
  await solidRow(page, '切断1').click();
  await expect(propertyField(page, '距離')).toHaveValue('100');
}

/** User action: 元の部品を取り込み直す on the bend row, choosing the edited file (web chooser / native Electron dialog). */
async function refreshFromFile(page: Page, path: string, app: ElectronApplication | undefined): Promise<void> {
  const menu = await componentMenu(page, 0);
  const action = menu.getByRole('menuitem', { name: '元の部品を取り込み直す', exact: true });
  await expect(action).toHaveAttribute('aria-disabled', 'false');
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  const token = await beginRecompute(page);
  await action.click();
  if (chooser !== null) await (await chooser).setFiles(path);
  await expect(page.getByRole('alertdialog', { name: '同じ元部品か確認', exact: true })).toHaveCount(0);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
}

/** After machining: one row, same purchased stock, quantity 1, finished length 未確定 in the table. */
async function expectUnknownTable(dialog: Locator, stockCell: string): Promise<void> {
  const details = stockDetails(dialog);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const rows = details.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expectSteelStockTableHeader(details);
  const cells = await rows.first().locator('td').allTextContents();
  expectSteelStockTableRevisions(cells, SS400_FLAT);
  expect(cells.slice(0, 6))
    .toEqual(['SS400', 'FB 50×6', stockCell, FINISHED_UNKNOWN, '1', stockCell]);
  await expect(details.locator('tfoot td')).toHaveText(['1', stockCell]);
}

/** After machining: the single cut row keeps product columns, stock, quantity, total and the occurrence; finished is 未確定. */
async function expectUnknownCsv(page: Page, bytes: Buffer, stockCell: string, componentId: string): Promise<void> {
  const rows = expectSteelStockCsv(bytes);
  const cut = rows.filter(row => row[COLUMN.kind] === '切断明細');
  expect(cut).toHaveLength(1);
  expectSteelStockCsvProvenance(cut[0], SS400_FLAT);
  expect(cut[0].slice(1, 7)).toEqual(SS400_FLAT_COLUMNS);
  expect([cut[0][COLUMN.stockLength], cut[0][COLUMN.quantity], cut[0][COLUMN.totalLength], cut[0][COLUMN.finished]])
    .toEqual([stockCell, '1', stockCell, FINISHED_UNKNOWN]);
  expect(JSON.parse(cut[0][COLUMN.paths] ?? '')).toEqual([[componentId]]);
  expect((await readAssemblyStats(page)).components.map(component => component.id)).toEqual([componentId]);
  const total = rows.filter(item => item[COLUMN.kind] === '集計できた鋼材の合計');
  expect(total.map(item => [item[COLUMN.quantity], item[COLUMN.totalLength], item[COLUMN.notice]])).toEqual([['1', stockCell, '']]);
  expect(rows.filter(item => item[COLUMN.kind] === '集計対象外')).toHaveLength(0);
}

export function registerSteelBendStockTest(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('EX08 曲げ鋼材の切断リスト', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('SS400 FB 50×6 の曲げを画面で作り、切断リストの表とCSVが展開長さの1行になり、保存と開き直しでも同じCSVになる', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      if (app === undefined) {
        await disableFilePickers(page);
        await page.goto('/');
      } else {
        expect(page.url()).toBe('app://pointercad/index.html');
      }
      await waitForStartupReady(page);
      await resetAssemblyFileGateway(page);
      const start = await beginRecompute(page);
      await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
      await waitForRecompute(page, start);
      await expect(componentRows(page)).toHaveCount(0);

      await placeBend(page);
      const dialog = await openSteelPicker(page);
      const stockCell = await expectBendTable(dialog);
      const first = await exportCsv(page, dialog, info.outputPath('steel-bend-stock.csv'), app);
      await expectBendCsv(page, first, stockCell);

      // The CSV row is the saved bent part: its purchased length and its single sweep along the bend path.
      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const savedPath = info.outputPath('steel-bend-stock.pcada');
      await saveFlowFile(page, savedPath, app);
      const saved = await readDocumentBundle(await readFile(savedPath), 'assembly');
      if (!saved.ok || saved.bundle.kind !== 'assembly') throw new Error('Saved assembly did not decode');
      const source = saved.bundle.document.components[0]?.source;
      if (source?.kind !== 'part') throw new Error('Bend was not saved as an editable part');
      const part = saved.bundle.embeddedDocuments.get(source.partRef)?.document;
      if (part === undefined) throw new Error('Bent part missing from the saved bundle');
      expect(part.steelStockSource).toMatchObject({ catalog: 'flatBar', size: 'FB 50×6' });
      expect(Number(part.steelStockSource?.options.length)).toBe(Number(stockCell));
      expect(part.solids.map(solid => solid.kind)).toEqual(['sweep']);

      await openSaveFlowFile(page, savedPath, app);
      const reopened = await openSteelPicker(page);
      expect(await expectBendTable(reopened)).toBe(stockCell);
      const second = await exportCsv(page, reopened, info.outputPath('steel-bend-stock-reopened.csv'), app);
      await expectBendCsv(page, second, stockCell);
      expect(second.equals(first)).toBe(true);
      expect(errors).toEqual([]);
    });

    test('加工できる曲げ部品を保存して置き、部品ファイルを切断して取り込み直すと、完成長が未確定になり、購入長・出どころ・数量は保存と開き直しでも残る', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      if (app === undefined) {
        await disableFilePickers(page);
        await page.goto('/');
      } else {
        expect(page.url()).toBe('app://pointercad/index.html');
      }
      await waitForStartupReady(page);
      await resetAssemblyFileGateway(page);
      const start = await beginRecompute(page);
      await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
      await waitForRecompute(page, start);
      await expect(componentRows(page)).toHaveCount(0);

      // 1) Assembly: the editable bend (saved part file first), its proved developed length in the table and CSV.
      const partPath = info.outputPath('SS400 FB 50×6 bend.pcad');
      const bend = await placeEditableBend(page, partPath, app);
      const componentId = (await readAssemblyStats(page)).components[0]?.id ?? '';
      let dialog = await openSteelPicker(page);
      const stockCell = await expectBendTable(dialog);
      expect(Number(bend.steelStockSource?.options.length)).toBe(Number(stockCell));
      await expectBendCsv(page, await exportCsv(page, dialog, info.outputPath('editable-bend.csv'), app), stockCell);
      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const assemblyPath = info.outputPath('editable-bend.pcada');
      await saveFlowFile(page, assemblyPath, app);

      // 2) Part: open the saved bend file, cut it with the visible tool, save the edited file.
      await openSaveFlowFile(page, partPath, app);
      await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
      await cutOpenedBend(page, bend);
      const cutPath = info.outputPath('SS400 FB 50×6 bend-cut.pcad');
      const cutRead = await readDocumentBundle(new Uint8Array(await saveFlowFile(page, cutPath, app)), 'part');
      if (!cutRead.ok || cutRead.bundle.kind !== 'part') throw new Error('Cut bend did not decode');
      const machined = cutRead.bundle.document;
      expect(machined.id).toBe(bend.id);
      expect(machined.steelStockSource).toEqual(bend.steelStockSource);
      expect(machined.solids.slice(0, bend.solids.length)).toEqual(bend.solids);
      expect(machined.solids.slice(bend.solids.length).map(feature => feature.kind)).toEqual(['cut']);

      // 3) Assembly: refresh the original part; the stock stays, the finished length becomes unknown.
      await openSaveFlowFile(page, assemblyPath, app);
      await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
      await refreshFromFile(page, cutPath, app);
      dialog = await openSteelPicker(page);
      await expectUnknownTable(dialog, stockCell);
      const unknown = await exportCsv(page, dialog, info.outputPath('editable-bend-cut.csv'), app);
      await expectUnknownCsv(page, unknown, stockCell, componentId);
      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // 4) Save and reopen: the machined part, its provenance and the unknown classification persist.
      const machinedAssemblyPath = info.outputPath('editable-bend-cut.pcada');
      await saveFlowFile(page, machinedAssemblyPath, app);
      const saved = await readDocumentBundle(await readFile(machinedAssemblyPath), 'assembly');
      if (!saved.ok || saved.bundle.kind !== 'assembly') throw new Error('Machined assembly did not decode');
      const source = saved.bundle.document.components[0]?.source;
      if (source?.kind !== 'part') throw new Error('Bend component is not a part');
      const embedded = saved.bundle.embeddedDocuments.get(source.partRef)?.document;
      expect(embedded?.steelStockSource).toEqual(bend.steelStockSource);
      expect(embedded?.solids.map(feature => feature.kind)).toEqual(['sweep', 'cut']);
      await openSaveFlowFile(page, machinedAssemblyPath, app);
      dialog = await openSteelPicker(page);
      await expectUnknownTable(dialog, stockCell);
      const reopened = await exportCsv(page, dialog, info.outputPath('editable-bend-cut-reopened.csv'), app);
      await expectUnknownCsv(page, reopened, stockCell, componentId);
      expect(reopened.equals(unknown)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}
