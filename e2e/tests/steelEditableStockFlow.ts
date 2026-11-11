/// <reference lib="dom" />
import { recomputePart } from '../../packages/model/src/part/recomputePart.js';
import { createInspectableNativeKernelForNodeTests } from '../../packages/model/src/testing/createNativeKernelBridge.node.js';
import { waitForStartupReady } from './startupHealth.js';
import { readFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import type { PartDocument } from '../../packages/model/src/index.js';
import { chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
import { componentRows, disableFilePickers } from './boltedJointTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { chooseSteelFlatBar50x6 } from './steelPickerFlow.js';
import { expectSteelStockCsv, expectSteelStockCsvProvenance, expectSteelStockTableHeader,
  expectSteelStockTableRevisions, SS400_FLAT, S45C_FLAT, type SteelStockProductExpectation as Product } from './steelStockExpectation.js';

/*
 * EX02 from the visible 加工できる部品にする command (task155; successor of the task154 flow, whose generated input
 * file this replaces). The user picks SS400 FB 50×6 1000 in the 規格部品 picker, ticks the box, saves the new part
 * file and places it; 複製する makes the second occurrence of the same source. Then: three ordinary picker bars, the
 * cut list and CSV, opening the saved part file, 加工→切断 with 距離 400, saving, 元の部品を取り込み直す through the real
 * file chooser, Undo/Redo, save/reopen and the drawing's cut-list table. Purchased stock length (素材購入長) stays 1000;
 * finished length (完成長) follows steelFinishedLength.ts (generator +Z stock plus transverse XY cuts only).
 *
 * Locators: selects and the length field by their own title (as steelBendFlow.ts), check boxes and buttons by role
 * and name. A `has` filter is always page-rooted: a dialog-rooted inner locator would require a second dialog inside
 * the element (the host145 failure at steelStockCsvFlow openPicker; task154's flow repeats that pattern).
 */


const STOCK_MM = 1000;
const LONG_STOCK_MM = 1500;
/** 切断 at z = 400 keeping the face side (面の表側) leaves z = 400..1000. */
const CUT_OFFSET_MM = 400;
const FINISHED_MM = STOCK_MM - CUT_OFFSET_MM;
/** FB 50×6 section area in mm². */
const SECTION_MM2 = 50 * 6;
/** The generator's part name (buildStandardPart.ts buildSteelProduct) and the saved file name. */
const PART_NAME = 'SS400 FB 50×6 長さ1000';
const PART_FILE = `${PART_NAME}.pcad`;

/** Titles copied from ja/assembly.json (assembly.guide.* and assembly.steel.*Guide). */
const TITLE = {
  category: '配置する規格部品の種類を選びます。種類に合わせて寸法の候補が切り替わります。',
  grade: '鋼種を選ぶと、製造元資料で確認した断面と寸法だけを表示します。',
  length: '部品の長さをmmまたは式で指定します。選んだ部品に長さの指定が必要な時に表示されます。',
} as const;

const COLUMN = { kind: 0, grade: 1, materialStandard: 2, productStandard: 3, shape: 4, size: 5, stockLength: 7,
  quantity: 8, totalLength: 9, paths: 10, notice: 11, finished: 13 } as const;

/** Placement order: the editable part and its duplicate, then three ordinary picker bars. */
const PICKER_BARS: readonly { readonly product: Product; readonly lengthMm: number }[] = [
  { product: SS400_FLAT, lengthMm: STOCK_MM }, // sibling with the same purchased stock, left a standard part
  { product: S45C_FLAT, lengthMm: STOCK_MM }, // other material
  { product: SS400_FLAT, lengthMm: LONG_STOCK_MM }, // other purchased length
];

interface ExpectedRow {
  readonly product: Product;
  readonly stockMm: number;
  readonly finishedMm: number;
  /** Indexes into the placement order (0, 1 = editable part; 2.. = picker bars). */
  readonly placements: readonly number[];
}
const UNMACHINED: readonly ExpectedRow[] = [
  { product: SS400_FLAT, stockMm: STOCK_MM, finishedMm: STOCK_MM, placements: [0, 1, 2] },
  { product: S45C_FLAT, stockMm: STOCK_MM, finishedMm: STOCK_MM, placements: [3] },
  { product: SS400_FLAT, stockMm: LONG_STOCK_MM, finishedMm: LONG_STOCK_MM, placements: [4] },
];
const MACHINED: readonly ExpectedRow[] = [
  { product: SS400_FLAT, stockMm: STOCK_MM, finishedMm: FINISHED_MM, placements: [0, 1] },
  { product: SS400_FLAT, stockMm: STOCK_MM, finishedMm: STOCK_MM, placements: [2] },
  { product: S45C_FLAT, stockMm: STOCK_MM, finishedMm: STOCK_MM, placements: [3] },
  { product: SS400_FLAT, stockMm: LONG_STOCK_MM, finishedMm: LONG_STOCK_MM, placements: [4] },
];
/** Purchased totals do not change with machining: 3 × 1000 + 1000 + 1500. */
const TOTAL_QUANTITY = 5;
const TOTAL_LENGTH_MM = 3 * STOCK_MM + STOCK_MM + LONG_STOCK_MM;

function csvRow(row: ExpectedRow): string[] {
  return ['切断明細', ...row.product.columns, String(row.stockMm), String(row.placements.length),
    String(row.stockMm * row.placements.length), String(row.finishedMm)];
}


function picker(page: Page): Locator {
  return page.getByRole('dialog', { name: '規格部品を置く', exact: true });
}
function stockDetails(page: Page): Locator {
  return picker(page).locator('details').filter({ has: page.locator('summary', { hasText: '鋼材切断リスト' }) });
}
function editableBox(page: Page): Locator {
  return picker(page).getByRole('checkbox', { name: '加工できる部品にする', exact: true });
}
function treeSection(page: Page, title: string): Locator {
  return page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: title });
}
function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
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
async function volumeOf(page: Page): Promise<number> {
  return Number((await propertyValue(page, '体積').innerText()).replaceAll(',', '').match(/[\d.]+/u)?.[0]);
}
/** The ⋯ menu of the n-th row in the 部品 section (placement order). */
async function componentMenu(page: Page, index: number): Promise<Locator> {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
  });
  await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__more').nth(index).click();
  return page.locator('.pcad-tree__menu');
}

async function openPicker(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, '組む', '規格部品');
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await dialog.getByTitle(TITLE.category, { exact: true }).selectOption('structuralSection');
  await expect(dialog.getByTitle(TITLE.grade, { exact: true })).toBeVisible();
  return dialog;
}
async function closePicker(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function chooseBar(dialog: Locator, product: Product, lengthMm: number): Promise<void> {
  await chooseSteelFlatBar50x6(dialog, { grade: product.grade, size: product.size, condition: product.columns[5] });
  await dialog.getByTitle(TITLE.length, { exact: true }).fill(String(lengthMm));
}
async function placeBar(page: Page, dialog: Locator, product: Product, lengthMm: number): Promise<void> {
  await chooseBar(dialog, product, lengthMm);
  await expect(editableBox(page)).not.toBeChecked();
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '置く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
}

/** Saves through a real control: web download or Electron save dialog. */
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

/** 加工できる部品にする: the part file is saved first, then the ordinary 部品を置く位置 dialog places it at the origin. */
async function placeEditableBar(page: Page, path: string, app: ElectronApplication | undefined): Promise<PartDocument> {
  const dialog = await openPicker(page);
  await chooseBar(dialog, SS400_FLAT, STOCK_MM);
  await editableBox(page).check();
  await expect(dialog.getByText('保存した部品ファイルを開いて切断や穴を加えて保存し', { exact: false })).toBeVisible();
  const button = dialog.getByRole('button', { name: '部品ファイルを保存して配置へ', exact: true });
  const bytes = await savedThrough(page, button, path, app);
  const read = await readDocumentBundle(new Uint8Array(bytes), 'part');
  if (!read.ok || read.bundle.kind !== 'part') throw new Error('Saved editable part did not decode');
  const part = read.bundle.document;
  expect(part.name).toBe(PART_NAME);
  expect(part.id).toMatch(/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(part.steelStockSource).toMatchObject({ catalog: 'flatBar', size: 'FB 50×6',
    options: { steelProduct: 'SS400:flatBar:FB 50×6', materialGrade: 'SS400', length: String(STOCK_MM) } });
  expect(part.solids.map(solid => solid.kind)).toEqual(['extrude']);
  await expect(dialog).toHaveCount(0);
  const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
  await expect(placement).toBeVisible();
  const token = await beginRecompute(page);
  await placement.getByRole('button', { name: '置く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(placement).toHaveCount(0);
  return part;
}

/** Eight columns: check the original six independently from catalog/generator revisions, then the totals. */
async function expectStockTable(page: Page, rows: readonly ExpectedRow[]): Promise<void> {
  const details = stockDetails(page);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const body = details.locator('tbody tr');
  await expect(body).toHaveCount(rows.length);
  await expectSteelStockTableHeader(details);
  const shown = await body.evaluateAll(trs => trs.map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent ?? '')));
  const expected = rows.map(row => ({ product: row.product, cells: [row.product.grade, row.product.size,
    String(row.stockMm), String(row.finishedMm), String(row.placements.length),
    String(row.stockMm * row.placements.length)] }));
  expect(shown.map(cells => cells.slice(0, 6).join('|')).sort()).toEqual(expected.map(row => row.cells.join('|')).sort());
  for (const cells of shown) {
    const row = expected.find(item => item.cells.join('|') === cells.slice(0, 6).join('|'));
    if (row === undefined) throw new Error(`Unexpected stock table row ${cells.join('|')}`);
    expectSteelStockTableRevisions(cells, row.product);
  }
  await expect(details.locator('tfoot td')).toHaveText([String(TOTAL_QUANTITY), String(TOTAL_LENGTH_MM)]);
}

async function exportCsv(page: Page, path: string, app: ElectronApplication | undefined): Promise<Buffer> {
  const details = stockDetails(page);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const button = details.getByRole('button', { name: '切断リストをCSVで保存', exact: true });
  await expect(button).toBeEnabled();
  const bytes = await savedThrough(page, button, path, app);
  await expect(details.getByRole('status').filter({ hasText: 'CSVを保存しました。' })).toBeVisible();
  return bytes;
}

/** Checks one CSV against the expected rows and placement ids; returns the cut rows in file order. */
function expectStockCsv(bytes: Buffer, rows: readonly ExpectedRow[], placementIds: readonly string[]): string[][] {
  const records = expectSteelStockCsv(bytes);
  const cut = records.filter(record => record[COLUMN.kind] === '切断明細');
  const summary = (record: readonly string[]): string[] => [...record.slice(0, COLUMN.paths), record[COLUMN.finished] ?? ''];
  expect(cut.map(summary).sort()).toEqual(rows.map(csvRow).sort());
  for (const record of cut) {
    const row = rows.find(item => csvRow(item).join('|') === summary(record).join('|'));
    if (row === undefined) throw new Error(`Unexpected CSV cut row ${summary(record).join('|')}`);
    expectSteelStockCsvProvenance(record, row.product);
    expect(record.slice(11, 13), 'cut row has no exclusion or assembly reference').toEqual(['', '']);
  }
  // Occurrence ids per row: the machined rows hold exactly the part occurrences, the sibling keeps its own row.
  const idsOf = (record: readonly string[]): string[] => {
    const paths: unknown = JSON.parse(record[COLUMN.paths] ?? '');
    if (!Array.isArray(paths)) throw new Error('Occurrence paths are not a list');
    return paths.map(path => {
      if (!Array.isArray(path) || path.length !== 1 || typeof path[0] !== 'string') throw new Error('Top-level path expected');
      return path[0];
    });
  };
  const byKey = new Map(cut.map(record => [summary(record).join('|'), idsOf(record).sort()]));
  for (const row of rows) {
    expect(byKey.get(csvRow(row).join('|')), `ids of ${csvRow(row).join('|')}`)
      .toEqual(row.placements.map(index => placementIds[index]).sort());
  }
  const total = records.filter(record => record[COLUMN.kind] === '集計できた鋼材の合計');
  expect(total.map(record => [record[COLUMN.quantity], record[COLUMN.totalLength], record[COLUMN.notice]]))
    .toEqual([[String(TOTAL_QUANTITY), String(TOTAL_LENGTH_MM), '']]);
  expect(records.filter(record => record[COLUMN.kind] === '集計対象外')).toHaveLength(0);
  expect(records).toHaveLength(2 + rows.length + 1);
  return cut;
}

/** One visible machining edit on the opened part: 加工→切断 (XY plane), then 距離 = 400 in the properties. */
async function machineOpenedBar(page: Page, bar: PartDocument): Promise<void> {
  const stockName = bar.solids.at(-1)?.name;
  if (stockName === undefined) throw new Error('Editable bar has no solid');
  await solidRow(page, stockName).click();
  await expect.poll(() => volumeOf(page), { timeout: KERNEL_TIMEOUT_MS }).toBe(SECTION_MM2 * STOCK_MM);
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
  await propertyField(page, '距離').fill(String(CUT_OFFSET_MM));
  await waitForRecompute(page, distanceToken);
  await waitForSettledRecompute(page);
  await solidRow(page, '切断1').click();
  await expect(propertyField(page, '距離')).toHaveValue(String(CUT_OFFSET_MM));
  // The modelled volume changes with the machining: 300 mm² × 600 mm instead of × 1000 mm.
  await expect.poll(() => volumeOf(page), { timeout: KERNEL_TIMEOUT_MS }).toBe(SECTION_MM2 * FINISHED_MM);
}

/** 元の部品を取り込み直す on the first 部品 row, choosing the edited file in the real chooser / Electron dialog. */
async function refreshFromFile(page: Page, path: string, app: ElectronApplication | undefined): Promise<void> {
  const menu = await componentMenu(page, 0);
  const action = menu.getByRole('menuitem', { name: '元の部品を取り込み直す', exact: true });
  await expect(action).toHaveAttribute('aria-disabled', 'false');
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  const token = await beginRecompute(page);
  await action.click();
  if (chooser !== null) await (await chooser).setFiles(path);
  // A fresh part-uuid lineage never needs the legacy same-source confirmation.
  await expect(page.getByRole('alertdialog', { name: '同じ元部品か確認', exact: true })).toHaveCount(0);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
}

/** The assembly drawing's cut-list table, row by row, in the same order as the CSV cut rows. */
async function expectDrawingStockTable(page: Page, csvCut: readonly string[][]): Promise<void> {
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この組立から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  const section = page.locator('.pcad-drawing-property-section[data-property-kind="table"]');
  if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
  await expect(section).toHaveAttribute('open', '');
  const editor = page.locator('.pcad-drawing-table-editor');
  await editor.getByLabel('表と部品番号', { exact: true }).selectOption('bom');
  await editor.getByRole('checkbox', { name: '鋼材切断リスト', exact: true }).check();
  await editor.getByRole('button', { name: '表を配置', exact: true }).click();
  const rows = page.locator('.pcad-drawing-svg [data-owner-id^="bom-row:"]');
  await expect.poll(() => rows.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  // Owner ids are drawingTableRowOwner(table, row) = bom-row:[tableId,row]; row 0 is the heading.
  const read = await rows.evaluateAll(elements => elements.map(element => ({
    owner: element.getAttribute('data-owner-id') ?? '',
    texts: Array.from(element.querySelectorAll('[aria-label]')).map(text => text.getAttribute('aria-label') ?? ''),
  })));
  const byRow = new Map<number, string>();
  for (const item of read) {
    const parsed: unknown = JSON.parse(item.owner.slice('bom-row:'.length));
    if (!Array.isArray(parsed) || typeof parsed[1] !== 'number') throw new Error(`Unexpected owner ${item.owner}`);
    byRow.set(parsed[1], (byRow.get(parsed[1]) ?? '') + item.texts.join(''));
  }
  // Cells may wrap inside their column; compare each row's text in reading order, whitespace removed.
  const squash = (text: string): string => text.replace(/\s+/gu, '');
  const expected = csvCut.map(record => {
    const product = [SS400_FLAT, S45C_FLAT].find(item => item.grade === record[COLUMN.grade]);
    if (product === undefined) throw new Error(`Unexpected drawing stock grade ${record[COLUMN.grade]}`);
    // steelCatalog.ts:9..11 fixes both revisions; ja/assembly.json names them in the drawing's standard cell.
    // Read the independent product snapshot, so a missing/incorrect revision in both CSV and drawing cannot agree by accident.
    const standard = `${product.columns[2]} / ${product.columns[1]}\n`
      + `カタログの版: ${product.additionalCsvColumns[0]}\n形状生成の版: ${product.additionalCsvColumns[1]}`;
    return squash([`${record[COLUMN.shape]} ${record[COLUMN.size]}`, record[COLUMN.grade], standard,
      record[COLUMN.stockLength], record[COLUMN.quantity], record[COLUMN.finished]].join(''));
  });
  expect([...byRow.keys()].sort((a, b) => a - b)).toEqual(expected.map((_, index) => index + 1));
  expect(expected.map((_, index) => squash(byRow.get(index + 1) ?? ''))).toEqual(expected);
}

export function registerSteelEditableStockTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('EX02 加工できる部品にした鋼材の切断リスト・CSV・図面', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('窓で平鋼を加工できる部品にして2配置し、切断で完成長600へ加工しても購入長1000の兄弟・鋼種違い・長さ違いと分かれ、表・CSV・図面・元に戻す・保存と開き直しが一致する', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      if (app === undefined) {
        await disableFilePickers(page);
        await page.goto('/');
      } else {
        expect(page.url()).toBe('app://pointercad/index.html');
      }
      await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

      // 1) Assembly: 加工できる部品にする → save → place; 複製する; then three ordinary picker bars.
      const start = await beginRecompute(page);
      await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
      await waitForRecompute(page, start);
      await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
      const barPath = info.outputPath(PART_FILE);
      const bar = await placeEditableBar(page, barPath, app);
      await expect(componentRows(page)).toHaveCount(1);
      let token = await beginRecompute(page);
      await (await componentMenu(page, 0)).getByRole('menuitem', { name: '複製する', exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(2);
      let dialog = await openPicker(page);
      // The picker keeps its last choices; the ordinary bars are placed with the box cleared.
      await editableBox(page).uncheck();
      for (const item of PICKER_BARS) await placeBar(page, dialog, item.product, item.lengthMm);
      await expect(componentRows(page)).toHaveCount(2 + PICKER_BARS.length);
      const placed = (await readAssemblyStats(page)).components;
      expect(placed.map(component => component.sourceKind)).toEqual(['part', 'part', 'standardPart', 'standardPart', 'standardPart']);
      expect(placed[0]?.sourceRef).toBe(placed[1]?.sourceRef);
      const ids = placed.map(component => component.id);
      await expectStockTable(page, UNMACHINED);
      expectStockCsv(await exportCsv(page, info.outputPath('stock-unmachined.csv'), app), UNMACHINED, ids);
      await closePicker(dialog);
      const assemblyPath = info.outputPath('steel-editable.pcada');
      await saveFlowFile(page, assemblyPath, app);

      // 2) Part: open the saved part file, cut it with the visible tool, save the edited file.
      await openSaveFlowFile(page, barPath, app);
      await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
      await machineOpenedBar(page, bar);
      const machinedPath = info.outputPath(`${PART_NAME}-cut.pcad`);
      const machinedRead = await readDocumentBundle(new Uint8Array(await saveFlowFile(page, machinedPath, app)), 'part');
      if (!machinedRead.ok || machinedRead.bundle.kind !== 'part') throw new Error('Machined part did not decode');
      const machined = machinedRead.bundle.document;
      // The purchased stock and its generator history stay; one transverse XY cut is appended.
      expect(machined.id).toBe(bar.id);
      expect(machined.steelStockSource).toEqual(bar.steelStockSource);
      expect(machined.solids.slice(0, bar.solids.length)).toEqual(bar.solids);
      const added = machined.solids.slice(bar.solids.length);
      expect(added.map(feature => feature.kind)).toEqual(['cut']);
      const cut = added[0];
      if (cut?.kind !== 'cut') throw new Error('Machining did not append a cut');
      expect([cut.targetFeatureId, cut.pairedWith, cut.keep, cut.suppressed]).toEqual([bar.solids.at(-1)?.id, null, 'positive', false]);
      expect(cut.plane).toMatchObject({ kind: 'workPlane', planeId: 'xy', offset: { source: String(CUT_OFFSET_MM), value: CUT_OFFSET_MM } });

      // 3) Assembly: refresh the shared source; only the two part occurrences change.
      await openSaveFlowFile(page, assemblyPath, app);
      await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
      await refreshFromFile(page, machinedPath, app);
      expect((await readAssemblyStats(page)).components.map(component => component.id)).toEqual(ids);
      dialog = await openPicker(page);
      await expectStockTable(page, MACHINED);
      const machinedCsv = await exportCsv(page, info.outputPath('stock-machined.csv'), app);
      expectStockCsv(machinedCsv, MACHINED, ids);
      await closePicker(dialog);

      // 4) Undo restores one purchased-length group; Redo brings the machined split back.
      token = await beginRecompute(page);
      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      await waitForRecompute(page, token);
      dialog = await openPicker(page);
      await expectStockTable(page, UNMACHINED);
      await closePicker(dialog);
      token = await beginRecompute(page);
      await page.getByRole('button', { name: 'やり直す', exact: true }).click();
      await waitForRecompute(page, token);
      dialog = await openPicker(page);
      await expectStockTable(page, MACHINED);
      await closePicker(dialog);

      // 5) Save and reopen: the embedded edited source survives, the CSV bytes are identical.
      const machinedAssemblyPath = info.outputPath('steel-editable-cut.pcada');
      const saved = await readDocumentBundle(await saveFlowFile(page, machinedAssemblyPath, app), 'assembly');
      if (!saved.ok || saved.bundle.kind !== 'assembly') throw new Error('Saved assembly did not decode');
      const sources = saved.bundle.document.components.map(component => component.source);
      const partRef = sources[0]?.kind === 'part' ? sources[0].partRef : undefined;
      if (partRef === undefined) throw new Error('First occurrence lost its part source');
      expect(sources[1]).toEqual(sources[0]);
      expect(saved.bundle.embeddedDocuments.get(partRef)?.document).toEqual(machined);
      await openSaveFlowFile(page, machinedAssemblyPath, app);
      expect((await readAssemblyStats(page)).components.map(component => component.id)).toEqual(ids);
      dialog = await openPicker(page);
      await expectStockTable(page, MACHINED);
      const reopenedCsv = await exportCsv(page, info.outputPath('stock-reopened.csv'), app);
      const cutRows = expectStockCsv(reopenedCsv, MACHINED, ids);
      expect(reopenedCsv.equals(machinedCsv)).toBe(true);
      await closePicker(dialog);

      // 6) The drawing made from this assembly shows the same rows, in the same order, as the CSV.
      await expectDrawingStockTable(page, cutRows);
      expect(errors).toEqual([]);
    });
  });
}


/** 同じ既存specでWebの別pageとElectronの別processを確認するための検査内契約。 */
type SteelColdReopen = (page: Page, info: TestInfo) => Promise<{
  readonly page: Page; readonly app: ElectronApplication;
}>;

async function steelAssemblySnapshot(page: Page, path: string, app: ElectronApplication | undefined) {
  const result = await readDocumentBundle(await saveFlowFile(page, path, app), 'assembly');
  if (!result.ok || result.bundle.kind !== 'assembly') throw new Error('鋼材の組立保存を読めません');
  return result.bundle.document;
}

/** 寸法50×6、長さ1000は入力値から導く。native出力を期待値へ転記しない。 */
async function expectStraightSteelNative(part: PartDocument, info: TestInfo, grade: Product['grade']): Promise<void> {
  const native = await createInspectableNativeKernelForNodeTests();
  try {
    let key: string | undefined;
    const result = await recomputePart(part, native.bridge, { onResolved: resolved => { key = resolved.steps.at(-1)?.key; } });
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
    expect(result.bodies).toHaveLength(1);
    if (key === undefined) throw new Error('実再計算の鋼材キーがありません');
    const measured = native.inspectShape(key).measure();
    await info.attach(`steel-${grade}-native`, { body: JSON.stringify(measured), contentType: 'application/json' });
    expect(measured.validity).toMatchObject({ valid: true, solidCount: 1, closed: true });
    expect(measured.meshApproximation).toBeNull();
    expect(Math.abs(measured.volume - 50 * 6 * STOCK_MM) / (50 * 6 * STOCK_MM)).toBeLessThanOrEqual(1e-9);
    if (measured.bounds === null) throw new Error('鋼材のnative境界がありません');
    expect(Math.hypot(...measured.bounds.low)).toBeLessThanOrEqual(1e-7);
    expect(Math.hypot(measured.bounds.high[0] - 50, measured.bounds.high[1] - 6,
      measured.bounds.high[2] - STOCK_MM)).toBeLessThanOrEqual(1e-7);
  } finally { native.dispose(); }
}

async function expectTwoSteelCsv(page: Page, path: string, ids: readonly string[], app?: ElectronApplication): Promise<Buffer> {
  const dialog = await openPicker(page), details = stockDetails(page);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await expectSteelStockTableHeader(details);
  await expect(details.locator('tbody tr')).toHaveCount(2);
  await expect(details.locator('tfoot td')).toHaveText(['2', '2000']);
  const bytes = await exportCsv(page, path, app), records = expectSteelStockCsv(bytes);
  const cut = records.filter(record => record[COLUMN.kind] === '切断明細');
  expect(cut).toHaveLength(2);
  for (const [index, product] of [SS400_FLAT, S45C_FLAT].entries()) {
    const row = cut.find(record => record[COLUMN.grade] === product.grade);
    if (row === undefined) throw new Error('指定鋼種のCSV行がありません');
    expect(row.slice(1, 10)).toEqual([...product.columns, '1000', '1', '1000']);
    expect(row[COLUMN.finished]).toBe('1000');
    const paths: unknown = JSON.parse(row[COLUMN.paths]);
    expect(paths).toEqual([[ids[index]]]);
    expectSteelStockCsvProvenance(row, product);
  }
  expect(records.filter(row => row[COLUMN.kind] === '集計対象外')).toHaveLength(0);
  expect(records.filter(row => row[COLUMN.kind] === '集計できた鋼材の合計')
    .map(row => [row[COLUMN.quantity], row[COLUMN.totalLength], row[COLUMN.notice]])).toEqual([['2', '2000', '']]);
  expect(records).toHaveLength(5);
  await closePicker(dialog);
  return bytes;
}

/** 旧caseを置換しない。原保存の型判別を通し、UI取消と実native・冷再開だけを補う。 */
export function registerSteelUiAcceptanceTests(test: typeof baseTest,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
  coldElectron?: SteelColdReopen): void {
  test('EX03.UI 平鋼SS400/S45Cの取消0配置・通常配置1UndoRedo・実native寸法・冷再開', async ({ page }, info) => {
    let app = appForPage(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
    else expect(page.url()).toBe('app://pointercad/index.html');
    await waitForStartupReady(page);
    let token = await beginRecompute(page);
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
    await waitForRecompute(page, token);
    const baseline = await steelAssemblySnapshot(page, info.outputPath('steel-ui-empty.pcada'), app);
    await expect(componentRows(page)).toHaveCount(0);
    const undo = () => page.getByRole('button', { name: '元に戻す', exact: true });
    await expect(undo()).toHaveAttribute('aria-disabled', 'true');
    let dialog = await openPicker(page);
    await chooseBar(dialog, SS400_FLAT, 0);
    await editableBox(page).uncheck();
    await dialog.getByRole('button', { name: '置く', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(componentRows(page)).toHaveCount(0);
    await chooseBar(dialog, S45C_FLAT, STOCK_MM);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await steelAssemblySnapshot(page, info.outputPath('steel-ui-picker-cancel.pcada'), app)).toEqual(baseline);
    await expect(undo()).toHaveAttribute('aria-disabled', 'true');

    const savedParts: { product: Product; path: string; part: PartDocument }[] = [];
    for (const product of [SS400_FLAT, S45C_FLAT]) {
      dialog = await openPicker(page); await chooseBar(dialog, product, STOCK_MM);
      const note = dialog.getByRole('status').filter({ hasText: product.columns[5] });
      for (const index of [12, 13, 14, 15]) {
        await expect(note).toContainText(product.additionalCsvColumns[index]);
      }
      await editableBox(page).check();
      const path = info.outputPath(`steel-ui-${product.grade}.pcad`);
      const bytes = await savedThrough(page, dialog.getByRole('button', { name: '部品ファイルを保存して配置へ', exact: true }), path, app);
      const read = await readDocumentBundle(new Uint8Array(bytes), 'part');
      if (!read.ok || read.bundle.kind !== 'part') throw new Error('UIで保存した鋼材を読めません');
      const part = read.bundle.document;
      expect(part.steelStockSource).toMatchObject({ kind: 'standardPart', catalog: 'flatBar', size: 'FB 50×6',
        catalogRevision: product.additionalCsvColumns[0], generatorRevision: product.additionalCsvColumns[1],
        options: { steelProduct: `${product.grade}:flatBar:FB 50×6`, materialGrade: product.grade,
          materialStandard: product.columns[1], productStandard: product.columns[2], length: '1000',
          condition: product.grade === 'SS400' ? 'hotRolled-heatTreatmentUnspecified' : 'brightBar-heatTreatmentUnspecified' } });
      savedParts.push({ product, path, part });
      const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
      await expect(placement).toBeVisible();
      await placement.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(placement).toHaveCount(0); await expect(componentRows(page)).toHaveCount(0);
      expect(await steelAssemblySnapshot(page, info.outputPath(`steel-ui-${product.grade}-cancel.pcada`), app)).toEqual(baseline);
      await expect(undo()).toHaveAttribute('aria-disabled', 'true');
    }

    let previous = baseline;
    for (const [index, product] of [SS400_FLAT, S45C_FLAT].entries()) {
      dialog = await openPicker(page); await editableBox(page).uncheck();
      await placeBar(page, dialog, product, STOCK_MM); await closePicker(dialog);
      await expect(componentRows(page)).toHaveCount(index + 1);
      const placed = await steelAssemblySnapshot(page, info.outputPath(`steel-ui-${product.grade}-placed.pcada`), app);
      token = await beginRecompute(page); await undo().click(); await waitForRecompute(page, token);
      expect(await steelAssemblySnapshot(page, info.outputPath(`steel-ui-${product.grade}-undo.pcada`), app)).toEqual(previous);
      token = await beginRecompute(page);
      await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await waitForRecompute(page, token);
      expect(await steelAssemblySnapshot(page, info.outputPath(`steel-ui-${product.grade}-redo.pcada`), app)).toEqual(placed);
      previous = placed;
    }
    expect(previous.components.map(component => component.source.kind)).toEqual(['standardPart', 'standardPart']);
    const ids = previous.components.map(component => component.id);
    const csv = await expectTwoSteelCsv(page, info.outputPath('steel-ui-before-cold.csv'), ids, app);
    const assemblyPath = info.outputPath('steel-ui-final.pcada');
    const savedAssembly = await steelAssemblySnapshot(page, assemblyPath, app);
    for (const saved of savedParts) {
      await openSaveFlowFile(page, saved.path, app);
      const name = saved.part.solids.at(-1)?.name;
      if (name === undefined) throw new Error('鋼材の実solid名がありません');
      await solidRow(page, name).click();
      await expect.poll(() => volumeOf(page), { timeout: KERNEL_TIMEOUT_MS }).toBe(50 * 6 * STOCK_MM);
      await expectStraightSteelNative(saved.part, info, saved.product.grade);
    }

    if (app === undefined) {
      const previousPage = page;
      page = await previousPage.context().newPage();
      page.on('pageerror', error => errors.push(error.message));
      await disableFilePickers(page); await page.goto('/'); await waitForStartupReady(page);
      await previousPage.close();
    } else {
      if (coldElectron === undefined) throw new Error('Electronの実process再起動が未接続です');
      const reopened = await coldElectron(page, info); page = reopened.page; app = reopened.app;
      page.on('pageerror', error => errors.push(error.message));
      expect(page.url()).toBe('app://pointercad/index.html');
    }
    await openSaveFlowFile(page, assemblyPath, app);
    await expect(componentRows(page)).toHaveCount(2);
    expect(await steelAssemblySnapshot(page, info.outputPath('steel-ui-cold.pcada'), app)).toEqual(savedAssembly);
    const coldCsv = await expectTwoSteelCsv(page, info.outputPath('steel-ui-after-cold.csv'), ids, app);
    expect(coldCsv.equals(csv)).toBe(true);
    expect(errors).toEqual([]);
  });
}
