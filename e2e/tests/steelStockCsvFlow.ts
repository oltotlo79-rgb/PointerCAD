/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { chooseSteelFlatBar50x6 } from './steelPickerFlow.js';

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
  '数量', '総延長 (mm)', '配置の階層（ID）', '対象範囲・除外理由', '部分組立の参照', '完成長 (mm)',
  'カタログの版', '形状生成の版', '形状の解釈', '寸法の出典', '寸法の出典の版', '寸法の出典の掲載箇所',
  '寸法の出典のURL', '寸法の出典のSHA-256（取得時のファイル）', '出典の取得日', '断面形状の出典', '鋼種分類の出典',
  '寸法・製品規格の出典', '材料規格の版', '材料規格の確認の程度', '寸法規格の版', '寸法規格の確認の程度'];
const COLUMN = { kind: 0, stockLength: 7, quantity: 8, totalLength: 9, paths: 10, notice: 11, finished: 13 } as const;

// Literal provenance comes from steelCatalog.ts and the independent steelStockCsvExport.test.ts expectations.
const NOMINAL_PROVENANCE = ['jp-steel-2026-10-10-r1', '3-steel-profile-1', '呼び寸法による単純な形状'] as const;
const NO_PROFILE = 'なし（この形状は出典の断面形状を使わない）';
const SAME_SOURCE = '寸法の出典と同じ資料';
const GRADE_SOURCE = '合同製鐵 構造用棒鋼 ｜ 資料に版の記載なし ｜ PDF p5 機械構造用炭素鋼鋼材（JIS G4051）S45C行（鋼種分類のみ） ｜ https://www.godo-steel.co.jp/seihin/pdf/The_structural_bars_of_Godo_Steel_20221116.pdf ｜ SHA-256 f19cd3ea52561f00bf43149748d4b924227f06e59ede71fe42bb0680612b2b70 ｜ 出典の取得日 2026-10-10';
const STANDARD_SOURCE = '太平鋼材工業 製品情報 公差表 ｜ 資料に版の記載なし ｜ 公差表（JIS G 3123）、適用形状 丸・平 ｜ https://taiheikouzai.co.jp/product.html?id=lineup ｜ SHA-256 63430ac1b24c555dbe09796a706cdfd75b77e12c727fe064e5d4db63917480eb ｜ 出典の取得日 2026-10-10';
const PROVENANCE: Readonly<Record<string, readonly string[]>> = {
  'SS400:平鋼': [...NOMINAL_PROVENANCE, '日本製鉄 建設用資材ハンドブック 王子製鉄 平鋼', '2025年9月改訂版',
    'PDF p1 規格 / p2 標準断面寸法 / p4 製造寸法', 'https://www.nipponsteel.com/product/construction/handbook/pdf/3-52.pdf',
    '50b0a027712a8a0991f52b33896309c3c3f4f83ec3c3704d54eaecb76a87ac3b', '2026-10-10',
    NO_PROFILE, SAME_SOURCE, SAME_SOURCE, 'JIS G 3101:2024', '原案で確認', 'JIS G 3194:2024', '原案で確認'],
  'S45C:平鋼': [...NOMINAL_PROVENANCE, '太平鋼材工業 みがき平鋼サイズ表', '資料に版の記載なし',
    'PDF p1 S45C（黄色印）、幅50×厚6・9・12 mmの交点', 'https://taiheikouzai.co.jp/assets/pdf/hirakou.pdf',
    'f45feea1ccb83dbc1706ee7241f97accc92473b139b463c38f7155f22893dd87', '2026-10-10',
    NO_PROFILE, GRADE_SOURCE, STANDARD_SOURCE, 'JIS G 4051:2026', '原案で確認', 'JIS G 3123:2004', '未確認'],
  'SS400:丸鋼': [...NOMINAL_PROVENANCE, '日本製鉄 建設用資材ハンドブック 大阪製鐵 一般構造用丸鋼', '2025年9月改訂版',
    'PDF p1 SS400標準断面寸法・標準長さ', 'https://www.nipponsteel.com/product/construction/handbook/pdf/5-33.pdf',
    '5e9fbba2c98ccadfaf0f88497af97664393234e4da8b5bb23606997909ef542c', '2026-10-10',
    NO_PROFILE, SAME_SOURCE, SAME_SOURCE, 'JIS G 3101:2024', '原案で確認', 'JIS G 3191:2022', '原案で確認'],
};

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
  if (product.shape === 'flatBar') {
    // SS400/S45C flat bars exceed 100 choices, so the picker shows 厚さ then 幅 (steelPartDimensionGroups); the
    // full 呼び寸法 list is inside the closed 全サイズから選ぶ details. Same visible helper as the other steel flows.
    const condition = product.columns[5];
    if (condition === undefined) throw new Error('Steel flat bar fixture is missing its condition column');
    await chooseSteelFlatBar50x6(dialog, { grade: product.grade, size: product.size, condition });
  } else {
    await choice(dialog, '鋼種').selectOption(product.grade);
    await choice(dialog, '断面形状').selectOption(product.shape);
    // SS400 round bars stay under 100 choices: one 呼び寸法 list whose option values are standardPartPicker.ts
    // steelChoice keys `steel:${grade}:${catalog}:${size}`.
    await choice(dialog, '呼び寸法').selectOption(`steel:${product.grade}:${product.shape}:${product.size}`);
  }
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
  expect(rows.every(row => row.length === HEADER.length), `every record has ${HEADER.length} fields`).toBe(true);
  expect(rows[0]).toEqual(HEADER);
  expect(rows[1]?.[COLUMN.kind]).toBe('対象範囲');
  const cut = rows.filter(row => row[COLUMN.kind] === '切断明細');
  const summary = (row: readonly string[]): string[] => [...row.slice(0, COLUMN.paths), row[COLUMN.finished] ?? ''];
  const expected = expectedCutRows();
  expect(cut.map(summary).sort()).toEqual(expected.sort());
  for (const row of cut) {
    const provenance = PROVENANCE[`${row[1]}:${row[4]}`];
    expect(provenance, 'each fixture product has an independent provenance expectation').toBeDefined();
    expect(row.slice(14)).toEqual(provenance);
  }
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

    test('r2 の角形鋼管・一般構造用炭素鋼鋼管・不等辺山形鋼・I形鋼を画面から置き、切断リストのCSVに名前・規格・版が出て、保存と開き直しでも同じCSVになる', async ({ page }, info: TestInfo) => {
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
      for (const item of R2_FIXTURE) await placeR2Section(page, dialog, item.product, item.lengthMm);
      const details = stockDetails(dialog);
      if (await details.getAttribute('open') === null) await details.locator('summary').click();
      await expect(details.locator('tbody tr')).toHaveCount(R2_EXPECTED_ROWS.length);
      const first = await exportCsv(page, dialog, info.outputPath('steel-r2-stock-list.csv'), app);
      expectR2StockCsv(first);

      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const savedPath = info.outputPath('steel-r2-stock.pcada');
      await saveFlowFile(page, savedPath, app);
      await openSaveFlowFile(page, savedPath, app);
      const reopened = await openPicker(page);
      const second = await exportCsv(page, reopened, info.outputPath('steel-r2-stock-list-reopened.csv'), app);
      expectR2StockCsv(second);
      expect(second.equals(first)).toBe(true);
      expect(errors).toEqual([]);
    });

    test('r2 に足した軽量形鋼・CT形鋼・配管用ステンレス鋼鋼管を画面から置き、切断リストのCSVに名前・規格・版が出て、保存と開き直しでも同じCSVになる', async ({ page }, info: TestInfo) => {
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
      for (const item of R2_ADDED_FIXTURE) await placeR2Section(page, dialog, item.product, item.lengthMm);
      const details = stockDetails(dialog);
      if (await details.getAttribute('open') === null) await details.locator('summary').click();
      await expect(details.locator('tbody tr')).toHaveCount(R2_ADDED_EXPECTED_ROWS.length);
      const first = await exportCsv(page, dialog, info.outputPath('steel-r2-added-stock-list.csv'), app);
      expectR2RowsCsv(first, R2_ADDED_EXPECTED_ROWS, ['3', '4500']);

      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const savedPath = info.outputPath('steel-r2-added-stock.pcada');
      await saveFlowFile(page, savedPath, app);
      await openSaveFlowFile(page, savedPath, app);
      const reopened = await openPicker(page);
      const second = await exportCsv(page, reopened, info.outputPath('steel-r2-added-stock-list-reopened.csv'), app);
      expectR2RowsCsv(second, R2_ADDED_EXPECTED_ROWS, ['3', '4500']);
      expect(second.equals(first)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}

/*
 * r2（2026-11-14）の 4 断面。値は steelRows/*.ts の資料の行と ja の文言（assembly.json）から書き写した文字で、
 * 書き出しの結果から作らない。角形鋼管は同じ鋼材・同じ長さを 2 本置き、1 行・数量 2 にまとまる事も確かめる。
 */
interface R2Product {
  readonly grade: 'STKR400' | 'STK400' | 'SS400' | 'SSC400' | 'SUS304TP';
  readonly shape: 'rectTube' | 'steelPipe' | 'unequalAngle' | 'iBeam' | 'lipChannel' | 'ctSection';
  readonly size: string;
  /** 断面形状の選択肢の表示。 */
  readonly shapeLabel: string;
  /** 鋼種, 材料規格, 寸法・製品規格, 断面形状, 呼び寸法, 供給条件。 */
  readonly columns: readonly string[];
}
const R2_RECT: R2Product = { grade: 'STKR400', shape: 'rectTube', size: '□ 100×100×3.2', shapeLabel: '角形鋼管',
  columns: ['STKR400', 'JIS G 3466', 'JIS G 3466', '角形鋼管', '□ 100×100×3.2',
    '一般構造用角形鋼管・製造のまま（製造方法・熱処理・めっきは未指定）・管端は指定が無ければプレンエンド'] };
const R2_PIPE: R2Product = { grade: 'STK400', shape: 'steelPipe', size: 'φ48.6×2.3', shapeLabel: '一般構造用炭素鋼鋼管',
  columns: ['STK400', 'JIS G 3444', 'JIS G 3444', '一般構造用炭素鋼鋼管', 'φ48.6×2.3',
    '一般構造用炭素鋼鋼管・製管方法と仕上げ方法は未指定・管端は指定が無ければプレンエンド'] };
const R2_ANGLE: R2Product = { grade: 'SS400', shape: 'unequalAngle', size: 'L 100×75×7', shapeLabel: '不等辺山形鋼（L）',
  columns: ['SS400', 'JIS G 3101', 'JIS G 3192', '不等辺山形鋼（L）', 'L 100×75×7', '熱間圧延材・熱処理条件未指定'] };
const R2_BEAM: R2Product = { grade: 'SS400', shape: 'iBeam', size: 'I 200×100×7×10', shapeLabel: 'I形鋼',
  columns: ['SS400', 'JIS G 3101', 'JIS G 3192', 'I形鋼', 'I 200×100×7×10', '熱間圧延材・熱処理条件未指定'] };
const R2_FIXTURE: readonly { readonly product: R2Product; readonly lengthMm: number }[] = [
  { product: R2_RECT, lengthMm: 1000 }, { product: R2_RECT, lengthMm: 1000 }, { product: R2_PIPE, lengthMm: 1500 },
  { product: R2_ANGLE, lengthMm: 1200 }, { product: R2_BEAM, lengthMm: 2000 },
];
const R2_EXPECTED_ROWS: readonly (readonly string[])[] = [
  ['切断明細', ...R2_RECT.columns, '1000', '2', '2000', '1000'],
  ['切断明細', ...R2_PIPE.columns, '1500', '1', '1500', '1500'],
  ['切断明細', ...R2_ANGLE.columns, '1200', '1', '1200', '1200'],
  ['切断明細', ...R2_BEAM.columns, '2000', '1', '2000', '2000'],
];

/* r2 に 2026-11-15 に足した 3 断面（軽量形鋼の代表のリップ溝形鋼・CT 形鋼・SUS304TP の鋼管）。書き写し方は上と同じ。 */
const R2_LIP: R2Product = { grade: 'SSC400', shape: 'lipChannel', size: 'C 100×50×20×2.3', shapeLabel: 'リップ溝形鋼',
  columns: ['SSC400', 'JIS G 3350', 'JIS G 3350', 'リップ溝形鋼', 'C 100×50×20×2.3',
    '一般構造用軽量形鋼・鋼板又は鋼帯から冷間成形（素材の鋼板の種類・めっきは未指定）'] };
const R2_CT: R2Product = { grade: 'SS400', shape: 'ctSection', size: 'CT 100×200×8×12', shapeLabel: 'CT形鋼',
  columns: ['SS400', 'JIS G 3101', 'JIS G 3192', 'CT形鋼', 'CT 100×200×8×12', '熱間圧延材・熱処理条件未指定'] };
const R2_SUS: R2Product = { grade: 'SUS304TP', shape: 'steelPipe', size: '25A×Sch10S', shapeLabel: '配管用ステンレス鋼鋼管',
  columns: ['SUS304TP', 'JIS G 3459', 'JIS G 3459', '配管用ステンレス鋼鋼管', '25A×Sch10S',
    '配管用ステンレス鋼鋼管・製管方法と仕上方法は未指定・固溶化熱処理と酸洗・管端は指定が無ければプレンエンド'] };
const R2_ADDED_FIXTURE: readonly { readonly product: R2Product; readonly lengthMm: number }[] = [
  { product: R2_LIP, lengthMm: 1000 }, { product: R2_CT, lengthMm: 1500 }, { product: R2_SUS, lengthMm: 2000 },
];
const R2_ADDED_EXPECTED_ROWS: readonly (readonly string[])[] = [
  ['切断明細', ...R2_LIP.columns, '1000', '1', '1000', '1000'],
  ['切断明細', ...R2_CT.columns, '1500', '1', '1500', '1500'],
  ['切断明細', ...R2_SUS.columns, '2000', '1', '2000', '2000'],
];

async function placeR2Section(page: Page, dialog: Locator, product: R2Product, lengthMm: number): Promise<void> {
  await choice(dialog, '鋼種').selectOption(product.grade);
  await expect(choice(dialog, '断面形状').locator(`option[value="${product.shape}"]`)).toHaveText(product.shapeLabel);
  await choice(dialog, '断面形状').selectOption(product.shape);
  // 鋼管では欄の中に外径と肉厚の注記が出て、選択肢の欄の名前が「呼び寸法 外径 … mm」になるので、欄の見出しで探す。
  await field(dialog, '呼び寸法').locator('select').selectOption(`steel:${product.grade}:${product.shape}:${product.size}`);
  await field(dialog, '長さ').locator('input').fill(String(lengthMm));
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '置く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
}

/** 切断明細の行が独立の期待と一致し、どの行も r2 の表の版と形状生成の版を持つ。 */
function expectR2StockCsv(bytes: Buffer): void {
  expectR2RowsCsv(bytes, R2_EXPECTED_ROWS, ['5', '6700']);
}

/** 切断明細の行が期待の行と一致し、r2 の版を持ち、合計の本数・長さが期待どおりで、集計対象外が無い。 */
function expectR2RowsCsv(bytes: Buffer, expected: readonly (readonly string[])[], total: readonly [string, string]): void {
  expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
  const rows = parseCsv(bytes.subarray(3).toString('utf8'));
  expect(rows[0]).toEqual(HEADER);
  const cut = rows.filter(row => row[COLUMN.kind] === '切断明細');
  expect(cut.map(row => [...row.slice(0, COLUMN.paths), row[COLUMN.finished] ?? '']).sort())
    .toEqual(expected.map(row => [...row]).sort());
  expect(cut.map(row => [row[14], row[15]])).toEqual(cut.map(() => ['jp-steel-2026-11-14-r2', '3-steel-profile-1']));
  const sums = rows.filter(row => row[COLUMN.kind] === '集計できた鋼材の合計');
  expect([sums[0]?.[COLUMN.quantity], sums[0]?.[COLUMN.totalLength]]).toEqual([...total]);
  expect(rows.filter(row => row[COLUMN.kind] === '集計対象外')).toHaveLength(0);
}
