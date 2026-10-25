import { expect, type Locator } from '@playwright/test';

/** Independent snapshots, transcribed from steelCatalog.ts (flat/brightFlat/carbonGrade/brightBar),
 * steelStandards.ts and ja/assembly.json. Do not import the exporter or its catalog constants here.
 * The manufacturer's published sizes are distinct from verification of a final JIS standard.
 */
export interface SteelStockProductExpectation {
  readonly grade: 'SS400' | 'S45C';
  readonly size: 'FB 50×6';
  /** CSV columns 1..6: grade, material/product standards, shape, size and supply condition. */
  readonly columns: readonly string[];
  /** CSV columns 14..29, including both saved revisions and all evidence/standard edition cells. */
  readonly additionalCsvColumns: readonly string[];
}

// steelCatalog.ts:9..11, 101..107, 226..240; steelStandards.ts:36..46, 82..93.
export const SS400_FLAT: SteelStockProductExpectation = {
  grade: 'SS400', size: 'FB 50×6',
  columns: ['SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', '平鋼', 'FB 50×6', '熱間圧延材・熱処理条件未指定'],
  additionalCsvColumns: [
    'jp-steel-2026-10-10-r1', '3-steel-profile-1', '呼び寸法による単純な形状',
    '日本製鉄 建設用資材ハンドブック 王子製鉄 平鋼', '2025年9月改訂版',
    'PDF p1 規格 / p2 標準断面寸法 / p4 製造寸法',
    'https://www.nipponsteel.com/product/construction/handbook/pdf/3-52.pdf',
    '50b0a027712a8a0991f52b33896309c3c3f4f83ec3c3704d54eaecb76a87ac3b', '2026-10-10',
    'なし（この形状は出典の断面形状を使わない）',
    '寸法の出典と同じ資料', '寸法の出典と同じ資料',
    'JIS G 3101:2024', '原案で確認', 'JIS G 3194:2024', '原案で確認',
  ],
};

// steelCatalog.ts:123..136, 172..178, 226..240; steelStandards.ts:47..55, 129..140.
export const S45C_FLAT: SteelStockProductExpectation = {
  grade: 'S45C', size: 'FB 50×6',
  columns: ['S45C', 'JIS G 4051', 'JIS G 3123', '平鋼', 'FB 50×6', 'みがき棒鋼・加工方法と熱処理条件未指定'],
  additionalCsvColumns: [
    'jp-steel-2026-10-10-r1', '3-steel-profile-1', '呼び寸法による単純な形状',
    '太平鋼材工業 みがき平鋼サイズ表', '資料に版の記載なし',
    'PDF p1 S45C（黄色印）、幅50×厚6・9・12 mmの交点',
    'https://taiheikouzai.co.jp/assets/pdf/hirakou.pdf',
    'f45feea1ccb83dbc1706ee7241f97accc92473b139b463c38f7155f22893dd87', '2026-10-10',
    'なし（この形状は出典の断面形状を使わない）',
    '合同製鐵 構造用棒鋼 ｜ 資料に版の記載なし ｜ PDF p5 機械構造用炭素鋼鋼材（JIS G4051）S45C行（鋼種分類のみ）'
      + ' ｜ https://www.godo-steel.co.jp/seihin/pdf/The_structural_bars_of_Godo_Steel_20221116.pdf'
      + ' ｜ SHA-256 f19cd3ea52561f00bf43149748d4b924227f06e59ede71fe42bb0680612b2b70 ｜ 出典の取得日 2026-10-10',
    '太平鋼材工業 製品情報 公差表 ｜ 資料に版の記載なし ｜ 公差表（JIS G 3123）、適用形状 丸・平'
      + ' ｜ https://taiheikouzai.co.jp/product.html?id=lineup'
      + ' ｜ SHA-256 63430ac1b24c555dbe09796a706cdfd75b77e12c727fe064e5d4db63917480eb ｜ 出典の取得日 2026-10-10',
    'JIS G 4051:2026', '原案で確認', 'JIS G 3123:2004', '未確認',
  ],
};

/** Display names: ja/assembly.json:437..443, 465..480, 482..510; order: steelStockCsvExport.ts:94..103. */
const CSV_HEADER = [
  '集計区分', '鋼種', '材料規格', '寸法・製品規格', '断面形状', '呼び寸法', '供給条件', '素材購入長 (mm)',
  '数量', '総延長 (mm)', '配置の階層（ID）', '対象範囲・除外理由', '部分組立の参照', '完成長 (mm)',
  'カタログの版', '形状生成の版', '形状の解釈', '寸法の出典', '寸法の出典の版', '寸法の出典の掲載箇所',
  '寸法の出典のURL', '寸法の出典のSHA-256（取得時のファイル）', '出典の取得日', '断面形状の出典',
  '鋼種分類の出典', '寸法・製品規格の出典', '材料規格の版', '材料規格の確認の程度', '寸法規格の版', '寸法規格の確認の程度',
];
const TABLE_HEADER = ['鋼種', '呼び寸法', '素材購入長 (mm)', '完成長 (mm)', '数量', '総延長 (mm)', 'カタログの版', '形状生成の版'];

/** RFC 4180 reader independent of the serializer (quoted fields, doubled quotes, CRLF records). */
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
  expect(!quoted && field === '' && row.length === 0, 'CSV ends with CRLF outside a quoted field').toBe(true);
  return rows;
}

/** All rows, including scope and totals, must retain the entire report schema. */
export function expectSteelStockCsv(bytes: Buffer): string[][] {
  expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
  const records = parseCsv(bytes.subarray(3).toString('utf8'));
  expect(CSV_HEADER).toHaveLength(30);
  expect(records[0], 'all 30 named CSV columns').toEqual(CSV_HEADER);
  for (const [index, record] of records.entries()) {
    expect(record, `CSV record ${index} has 30 fields`).toHaveLength(30);
    if (index > 0 && record[0] !== '切断明細') {
      expect(record.slice(14), `non-cut record ${index} has no product evidence`).toEqual(Array<string>(16).fill(''));
    }
  }
  return records;
}

/** Exact text equality also preserves CSV formula protection; no trimming or prefix removal. */
export function expectSteelStockCsvProvenance(record: readonly string[], product: SteelStockProductExpectation): void {
  expect(record).toHaveLength(30);
  expect(product.additionalCsvColumns).toHaveLength(16);
  expect(record.slice(14), `${product.grade} revisions, evidence and standard verification`).toEqual(product.additionalCsvColumns);
}

/** StandardPartPickerPanel.tsx:394..407: six original columns followed by exactly two revisions. */
export async function expectSteelStockTableHeader(details: Locator): Promise<void> {
  await expect(details.locator('thead th'), 'all 8 named table columns').toHaveText(TABLE_HEADER);
  await expect(details.locator('thead th')).toHaveCount(8);
}

export function expectSteelStockTableRevisions(cells: readonly string[], product: SteelStockProductExpectation): void {
  expect(cells, 'table row has 8 cells').toHaveLength(8);
  expect(cells.slice(6), `${product.grade} table catalog/generator revisions`).toEqual(product.additionalCsvColumns.slice(0, 2));
}
