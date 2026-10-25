/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * EX02: the steel stock (cut) list of the standard-part picker, placed and exported only through the real UI.
 * Five bars over two sections: flat bar FB 50×6 in SS400 1000 mm twice (identical stock), SS400 1500 mm (same
 * product, other length) and S45C 1000 mm (same size and length, other material), plus one SS400 round bar φ16
 * 1200 mm (another section). The expected CSV rows are computed below from this fixture and the catalog facts of
 * steelCatalog.ts flat()/round(), written as literals; nothing is taken from the exporter.
 */

/** One catalog product: picker values (grade, shape value, size label) and the CSV product columns 1..6. */
interface Product {
  readonly grade: 'SS400' | 'S45C';
  readonly shape: 'flatBar' | 'roundBar';
  readonly size: string;
  /** 鋼種, 材料規格, 寸法・製品規格, 断面形状, 呼び寸法, 供給条件 as written in the catalog and ja i18n. */
  readonly columns: readonly string[];
}
const SS400_FLAT: Product = { grade: 'SS400', shape: 'flatBar', size: 'FB 50×6',
  columns: ['SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', '平鋼', 'FB 50×6', '熱間圧延材・熱処理条件未指定'] };
const S45C_FLAT: Product = { grade: 'S45C', shape: 'flatBar', size: 'FB 50×6',
  columns: ['S45C', 'JIS G 4051', 'JIS G 3123', '平鋼', 'FB 50×6', 'みがき棒鋼・加工方法と熱処理条件未指定'] };
const SS400_ROUND: Product = { grade: 'SS400', shape: 'roundBar', size: 'φ16',
  columns: ['SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法', '丸鋼', 'φ16', '熱間圧延材・熱処理条件未指定'] };

const FIXTURE: readonly { readonly product: Product; readonly lengthMm: number }[] = [
  { product: SS400_FLAT, lengthMm: 1000 }, { product: SS400_FLAT, lengthMm: 1000 },
  { product: SS400_FLAT, lengthMm: 1500 }, { product: S45C_FLAT, lengthMm: 1000 },
  { product: SS400_ROUND, lengthMm: 1200 },
];
/** Column order of serializeSteelStockCsv (steelStockCsvExport.ts lines 42-49), as ja labels. */
const HEADER = ['集計区分', '鋼種', '材料規格', '寸法・製品規格', '断面形状', '呼び寸法', '供給条件', '素材購入長 (mm)',
  '数量', '総延長 (mm)', '配置の階層（ID）', '対象範囲・除外理由', '部分組立の参照', '完成長 (mm)'];
const COLUMN = { kind: 0, stockLength: 7, quantity: 8, totalLength: 9, paths: 10, notice: 11, finished: 13 } as const;

/** Independent expectation: group the fixture by product and length; a directly placed bar keeps its stock length. */
function expectedCutRows(): string[][] {
  const groups = new Map<string, { product: Product; lengthMm: number; quantity: number }>();
  for (const item of FIXTURE) {
    const key = `${item.product.grade}:${item.product.shape}:${item.product.size}:${String(item.lengthMm)}`;
    const current = groups.get(key);
    groups.set(key, { product: item.product, lengthMm: item.lengthMm, quantity: (current?.quantity ?? 0) + 1 });
  }
  return [...groups.values()].map(row => ['切断明細', ...row.product.columns, String(row.lengthMm),
    String(row.quantity), String(row.lengthMm * row.quantity), String(row.lengthMm)]);
}
const EXPECTED_TOTAL_QUANTITY = FIXTURE.length;
const EXPECTED_TOTAL_LENGTH = FIXTURE.reduce((sum, item) => sum + item.lengthMm, 0);

/** RFC 4180 reader used only by this check (quoted fields, doubled quotes, CRLF records). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\r' && text[index + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; index += 1; }
    else field += char;
  }
  expect(field === '' && row.length === 0, 'CSV ends with CRLF').toBe(true);
  return rows;
}

function picker(page: Page): Locator {
  return page.getByRole('dialog', { name: '規格部品を置く', exact: true });
}
/*
 * Scoped relative locators. A `has` filter queries its inner locator INSIDE each outer element, so the inner locator
 * is built from the page (relative), never chained from the dialog: an inner `dialog.locator(...)` requires a second
 * dialog inside the label and matched nothing (host145 run 20261019-005830: the 種類 select was never found).
 * Choice lists are found by their accessible name, the wrapping label text (combobox "種類", "鋼種", ...).
 */
function choice(dialog: Locator, label: string): Locator {
  return dialog.getByRole('combobox', { name: label, exact: true });
}
function field(dialog: Locator, label: string): Locator {
  return dialog.locator('label.pcad-field').filter({
    has: dialog.page().locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`, 'u') }),
  });
}
function stockDetails(dialog: Locator): Locator {
  return dialog.locator('details').filter({ has: dialog.page().locator('summary', { hasText: '鋼材切断リスト' }) });
}

async function openPicker(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, '組む', '規格部品');
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await choice(dialog, '種類').selectOption('structuralSection');
  await expect(choice(dialog, '鋼種')).toBeVisible();
  return dialog;
}

async function placeBar(page: Page, dialog: Locator, product: Product, lengthMm: number): Promise<void> {
  await choice(dialog, '鋼種').selectOption(product.grade);
  await choice(dialog, '断面形状').selectOption(product.shape);
  // Option values are standardPartPicker.ts steelChoice keys: `steel:${grade}:${catalog}:${size}`.
  await choice(dialog, '呼び寸法').selectOption(`steel:${product.grade}:${product.shape}:${product.size}`);
  await field(dialog, '長さ').locator('input').fill(String(lengthMm));
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '置く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
}

/** Opens the cut list and saves its CSV through the real button; web download or Electron save dialog. */
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

/** Checks one exported CSV against the fixture; returns the occurrence ids per cut row in file order. */
async function expectStockCsv(page: Page, bytes: Buffer): Promise<string[][]> {
  expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString('utf8');
  expect(text.replaceAll('\r\n', '').includes('\n'), 'only CRLF line breaks').toBe(false);
  // Path cells contain quotes and commas; they must be quoted with doubled quotes, not split.
  expect(text).toMatch(/,"\[\[""/u);
  const rows = parseCsv(text);
  expect(rows.every(row => row.length === HEADER.length), 'every record has 14 fields').toBe(true);
  expect(rows[0]).toEqual(HEADER);
  expect(rows[1]?.[COLUMN.kind]).toBe('対象範囲');
  const cut = rows.filter(row => row[COLUMN.kind] === '切断明細');
  const summary = (row: readonly string[]): string[] => [...row.slice(0, COLUMN.paths), row[COLUMN.finished] ?? ''];
  const expected = expectedCutRows();
  expect(cut.map(summary).sort()).toEqual(expected.sort());
  // Two sections and two grades are present as distinct rows.
  expect(new Set(cut.map(row => row[4])), 'sections').toEqual(new Set(['平鋼', '丸鋼']));
  expect(new Set(cut.map(row => row[1])), 'grades').toEqual(new Set(['SS400', 'S45C']));
  const total = rows.filter(row => row[COLUMN.kind] === '集計できた鋼材の合計');
  expect(total).toHaveLength(1);
  expect([total[0]?.[COLUMN.quantity], total[0]?.[COLUMN.totalLength], total[0]?.[COLUMN.notice]])
    .toEqual([String(EXPECTED_TOTAL_QUANTITY), String(EXPECTED_TOTAL_LENGTH), '']);
  expect(rows.filter(row => row[COLUMN.kind] === '集計対象外')).toHaveLength(0);
  expect(rows).toHaveLength(2 + expected.length + 1);
  // Every placed bar appears in exactly one cut row, with as many occurrence paths as its quantity.
  const placed = (await readAssemblyStats(page)).components.filter(component => component.sourceKind === 'standardPart');
  expect(placed).toHaveLength(FIXTURE.length);
  const idsPerRow = cut.map(row => {
    const paths: unknown = JSON.parse(row[COLUMN.paths] ?? '');
    const ids: string[] = [];
    if (Array.isArray(paths)) {
      for (const path of paths) {
        // Directly placed bars are top-level occurrences: each path is exactly one component id.
        if (Array.isArray(path) && path.length === 1 && typeof path[0] === 'string') ids.push(path[0]);
      }
    }
    expect(Array.isArray(paths) && ids.length === paths.length, 'occurrence paths are single-id lists').toBe(true);
    expect(ids).toHaveLength(Number(row[COLUMN.quantity]));
    return ids;
  });
  expect(idsPerRow.flat().sort()).toEqual(placed.map(component => component.id).sort());
  return idsPerRow;
}

/** The on-screen table shows the same groups and totals before any export. */
async function expectStockTable(dialog: Locator): Promise<void> {
  const details = stockDetails(dialog);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await expect(details.locator('tbody tr')).toHaveCount(expectedCutRows().length);
  await expect(details.locator('tfoot td')).toHaveText([String(EXPECTED_TOTAL_QUANTITY), String(EXPECTED_TOTAL_LENGTH)]);
}

export function registerSteelStockCsvTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('EX02 鋼材切断リストのCSV', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('平鋼と丸鋼・同じ鋼材の繰返し・長さ違い・鋼種違いを画面から置き、CSVの数量・総延長・断面・鋼種を確かめ、保存と開き直しでも同じCSVになる', async ({ page }, info: TestInfo) => {
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
      const start = await beginRecompute(page);
      await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
      await waitForRecompute(page, start);
      await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');

      const dialog = await openPicker(page);
      for (const item of FIXTURE) await placeBar(page, dialog, item.product, item.lengthMm);
      await expectStockTable(dialog);
      const first = await exportCsv(page, dialog, info.outputPath('steel-stock-list.csv'), app);
      const ids = await expectStockCsv(page, first);

      // Save the assembly, reopen it from disk, and export again: same component ids in the same row order, same bytes.
      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const savedPath = info.outputPath('steel-stock.pcada');
      await saveFlowFile(page, savedPath, app);
      await openSaveFlowFile(page, savedPath, app);
      const reopened = await openPicker(page);
      await expectStockTable(reopened);
      const second = await exportCsv(page, reopened, info.outputPath('steel-stock-list-reopened.csv'), app);
      expect(await expectStockCsv(page, second)).toEqual(ids);
      expect(second.equals(first)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}
