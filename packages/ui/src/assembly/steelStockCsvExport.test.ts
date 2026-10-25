import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SteelStandardEditionNote } from './StandardPartPickerPanel.js';
import { buildSteelStockList, createAssemblyDocument, createStandardPartSource,
  buildStandardPartFromSource, DEFAULT_COMPONENT_PLACEMENT, EMPTY_PART_LIBRARY, STEEL_PRODUCTS, steelProductOptions, steelProducts,
  type AssemblyComponent, type ComponentSource, type SteelMaterialGrade, type SteelSectionCatalog } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrowserFileGateway } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { exportSteelStockCsv, serializeSteelStockCsv } from './steelStockCsvExport.js';
import { commitStandardPartChoice, steelPartChoices, steelPartDimensionGroups,
  steelPartChoiceAtDimension } from './standardPartPicker.js';

/** The original 14 columns keep their positions; 12 provenance columns follow them. */
const ORIGINAL_COLUMNS = 26;
const COLUMNS = ORIGINAL_COLUMNS + 4;
const P = 14;

function component(id: string, source: ComponentSource): AssemblyComponent {
  return { id, name: id, source, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false, visible: true, suppressed: false };
}
function steelSource() {
  const product = steelProducts('SS400', 'roundBar')[0];
  return createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '500*2' });
}
function productSource(grade: SteelMaterialGrade, catalog: SteelSectionCatalog, size: string,
  key = `${grade}:${catalog}:${size}`) {
  const product = steelProducts(grade, catalog).find((row) => row.key === key && row.size === size);
  if (product === undefined) throw new Error(`Missing steel fixture ${grade} ${size}`);
  return createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Independent CSV reader in the test handles escaped quotes and multiline fields. */
function csvRows(bytes: Uint8Array): string[][] {
  const text = new TextDecoder().decode(bytes);
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(value); value = ''; }
    else if (!quoted && ch === '\r' && text[index + 1] === '\n') {
      row.push(value); rows.push(row); row = []; value = ''; index += 1;
    } else value += ch;
  }
  expect(quoted).toBe(false);
  expect(value).toBe('');
  expect(row).toEqual([]);
  return rows;
}
function exported(...sources: ComponentSource[]): string[][] {
  const root = { ...createAssemblyDocument('Root'), components: sources.map((source, index) => component(`c${index}`, source)) };
  return csvRows(serializeSteelStockCsv(buildSteelStockList(root)));
}
function cutRows(rows: string[][]): string[][] {
  return rows.filter((row) => row[0] === t('assembly.steel.csv.cut'));
}

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().openAssembly({ ...createAssemblyDocument('Steel CSV'),
    components: [component('bar', steelSource())] });
  useAppStore.getState().openStandardPartPicker();
});

describe('two-stage SS400 selection CSV compatibility', () => {
  it('exports the two-stage choice in 30 columns and retains every old flat output exactly', () => {
    const old = [[6, 50], [9, 50], [12, 50], [6, 100], [9, 100]] as const;
    const sources = old.map(([thickness, width]) => productSource('SS400', 'flatBar', `FB ${width}×${thickness}`));
    const before = cutRows(exported(...sources));
    const choices = steelPartChoices('SS400', 'flatBar');
    const first = steelPartChoiceAtDimension(choices, 'steel:SS400:flatBar:FB 50×6', '28');
    expect(first?.key).toBe('steel:SS400:flatBar:FB 50×28');
    const width = steelPartDimensionGroups(choices)?.groups.find((group) => group.value === 28)?.choices
      .find((choice) => choice.key === 'steel:SS400:flatBar:FB 100×28');
    if (width === undefined) throw new Error('Missing second-stage CSV choice');
    const committed = commitStandardPartChoice('structuralSection', width.key, '1000');
    if (!committed.ok) throw new Error('Second-stage CSV commit failed');
    const rows = exported(...sources, committed.value.source,
      productSource('SS400', 'roundBar', 'φ5.5'));
    expect(rows.every((row) => row.length === 30)).toBe(true);
    const cuts = cutRows(rows);
    expect(cuts).toHaveLength(7);
    expect(cuts.filter((row) => row[3] === '王子製鉄 公表断面寸法')).toEqual(before);
    const addedFlat = cuts.find((row) => row[5] === 'FB 100×28');
    const addedRound = cuts.find((row) => row[5] === 'φ5.5');
    if (addedFlat === undefined || addedRound === undefined) throw new Error('Missing added CSV rows');
    expect(addedFlat.slice(1, 9)).toEqual(['SS400', 'JIS G 3101', 'JIS G 3194', t('assembly.steel.flatBar'),
      'FB 100×28', t('assembly.steel.hotRolled'), '1000', '1']);
    expect(addedFlat[P + 7]).toBe('07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea');
    expect(addedRound.slice(1, 4)).toEqual(['SS400', 'JIS G 3101', 'JIS G 3191']);
    expect(addedRound[P + 7]).toBe('8ea886730b59558553d49f395e7ada43c093210c51e00e3080c08f2163c0e313');
    expect(addedRound[P + 5]).toContain('9 mm未満はバーインコイル');
    expect(addedFlat.slice(26)).toEqual(['JIS G 3101:2024', '原案で確認', 'JIS G 3194:2024', '原案で確認']);
    expect(addedRound.slice(26)).toEqual(['JIS G 3101:2024', '原案で確認', 'JIS G 3191:2022', '原案で確認']);
  });
});

describe('steel stock CSV report', () => {
  it('exports black and white SGP as separate stock groups with condition text and the same 30 columns', () => {
    const rows = exported(productSource('SGP', 'steelPipe', '100A'),
      productSource('SGP', 'steelPipe', '100A', 'SGP:steelPipe:100A:whitePipe-zincCoated'));
    expect(rows.every((row) => row.length === 30)).toBe(true);
    const cuts = cutRows(rows);
    expect(cuts).toHaveLength(2);
    expect(cuts.map((row) => row[6]).sort()).toEqual([t('assembly.steel.blackPipe'), t('assembly.steel.whitePipe')].sort());
    for (const row of cuts) {
      expect(row.slice(1, 4)).toEqual(['SGP', 'JIS G 3452', 'JIS G 3452']);
      expect(row[5]).toBe('100A');
      expect(row[7]).toBe('1000');
      expect(row[8]).toBe('1');
      expect(row.slice(26)).toEqual(['JIS G 3452:2026', '原案で確認', 'JIS G 3452:2026', '原案で確認']);
    }
  });
  it('exports hot rounds and flats separately from bright products at the same sizes', () => {
    const rows = cutRows(exported(
      productSource('S45C', 'roundBar', 'φ25'),
      productSource('S45C', 'roundBar', 'φ25', 'S45C:roundBar:φ25:hotRolled'),
      productSource('S45C', 'flatBar', 'FB 50×6'),
      productSource('S45C', 'flatBar', 'FB 50×6', 'S45C:flatBar:FB 50×6:hotRolled'),
    ));
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row[8])).toEqual(['1', '1', '1', '1']);
    const hot = rows.filter((row) => row[6] === t('assembly.steel.hotRolled'));
    const bright = rows.filter((row) => row[6] === t('assembly.steel.brightBar'));
    expect(hot).toHaveLength(2);
    expect(bright).toHaveLength(2);
    expect(hot.map((row) => row[3])).toEqual(['JIS G 4051', 'JIS G 3194']);
    expect(bright.map((row) => row[3])).toEqual(['JIS G 3123', 'JIS G 3123']);
    expect(hot[0][P + 5]).toContain('表3');
    expect(hot[0][P + 7]).toBe('158ac7b25b0c1cda41ae5cdf68cfe37530b73f1288b9cacf62c2d45584664245');
    expect(hot[1][P + 11]).toContain('JIS G 3194');
    expect(hot[1][P + 11]).toContain('表1');
    expect(hot.every((row) => row.length === 30)).toBe(true);
  });

  it('exports nested repeated quantities, exact paths, scope, totals and omitted grades', () => {
    const child = { ...createAssemblyDocument('Child'), components: [
      component('bar/one', steelSource()),
      component('old', createStandardPartSource('equalAngle', 'L 50×50×6', { length: '200' })),
    ] };
    const root = { ...createAssemblyDocument('Root'), components: [
      component('left', { kind: 'subAssembly', assemblyRef: 'child' }),
      component('right', { kind: 'subAssembly', assemblyRef: 'child' }),
    ] };
    const bytes = serializeSteelStockCsv(buildSteelStockList(root, new Map([['child', child]])));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = csvRows(bytes);
    expect(rows.every(row => row.length === COLUMNS)).toBe(true);
    expect(rows[1][11]).toBe(t('assembly.steel.stockScope'));
    expect(rows[2].slice(1, 4)).toEqual(['SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法']);
    expect(rows[2].slice(7, 10)).toEqual(['1000', '2', '2000']);
    expect(JSON.parse(rows[2][10])).toEqual([['left', 'bar/one'], ['right', 'bar/one']]);
    expect(rows[3].slice(8, 10)).toEqual(['2', '2000']);
    expect(rows[3][11]).toBe(t('assembly.steel.stockPartial'));
    expect(rows.slice(4).map(row => [JSON.parse(row[10]) as unknown, row[11]]))
      .toEqual([[['left', 'old'], t('assembly.steel.omittedMaterial')], [['right', 'old'], t('assembly.steel.omittedMaterial')]]);
  });

  it.each(['=1+2', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1', '\n=1', ' =1', String.fromCharCode(0xfeff) + '=1', String.fromCharCode(0x200b) + '=1',
    '＝1', '＋1', '－1', '＠1', '−1', "'=1", 'text:=1', '=SUM(1,2)"\r\n=3'])(
    'keeps unsafe reference %j as visible text within one CSV cell', (reference) => {
      const root = { ...createAssemblyDocument('Root'), components: [
        component('id,"with\nlines', { kind: 'subAssembly', assemblyRef: reference }),
      ] };
      const rows = csvRows(serializeSteelStockCsv(buildSteelStockList(root)));
      expect(rows).toHaveLength(4);
      expect(rows.every(row => row.length === COLUMNS)).toBe(true);
      expect(rows[3][12]).toBe(`text:${reference}`);
      expect(JSON.parse(rows[3][10])).toEqual(['id,"with\nlines']);
      expect(rows[3][11]).toBe(t('assembly.steel.omittedMissing'));
      // An omitted occurrence never receives catalog evidence.
      expect(rows[3].slice(P)).toEqual(Array.from({ length: COLUMNS - P }, () => ''));
    });

  it('allows an empty report while explicitly retaining the scope and zero totals', () => {
    const rows = csvRows(serializeSteelStockCsv(buildSteelStockList(createAssemblyDocument('Empty'))));
    expect(rows).toHaveLength(3);
    expect(rows[2].slice(8, 10)).toEqual(['0', '0']);
    expect(rows[2][11]).toBe('');
  });
});

describe('steel CSV source and geometry provenance', () => {
  it('appends clear Japanese provenance headings after the unchanged original columns', () => {
    const header = exported()[0];
    expect(header).toHaveLength(COLUMNS);
    expect(header[0]).toBe(t('assembly.steel.csv.kind'));
    expect(header[13]).toBe(`${t('assembly.steel.finishedLength')} (mm)`);
    expect(header.slice(P, ORIGINAL_COLUMNS)).toEqual(['カタログの版', '形状生成の版', '形状の解釈', '寸法の出典', '寸法の出典の版',
      '寸法の出典の掲載箇所', '寸法の出典のURL', '寸法の出典のSHA-256（取得時のファイル）', '出典の取得日',
      '断面形状の出典', '鋼種分類の出典', '寸法・製品規格の出典']);
  });

  it('keeps a saved legacy simplified H section distinguishable and never gives it the current profile evidence', () => {
    const current = productSource('SS400', 'hBeam', 'H 150×150×7×10');
    const legacy = { ...current, generatorRevision: '2-steel-1' };
    // Saved-part compatibility: the legacy source still builds with its unchanged saved options.
    expect(buildStandardPartFromSource(legacy)).not.toBeNull();
    const rows = cutRows(exported(current, legacy));
    expect(rows).toHaveLength(2);
    const byGenerator = new Map(rows.map((row) => [row[P + 1], row]));
    const now = byGenerator.get('3-steel-profile-1');
    const old = byGenerator.get('2-steel-1');
    if (now === undefined || old === undefined) throw new Error('Missing current or legacy row');
    for (const row of [now, old]) {
      expect(row.slice(1, 6)).toEqual(['SS400', 'JIS G 3101', 'JIS G 3192', t('assembly.steel.hBeam'), 'H 150×150×7×10']);
      expect(row[P]).toBe('jp-steel-2026-10-10-r1');
      expect(row.slice(P + 3, P + 9)).toEqual(['大和工業グループ 会社案内', '2025.12', 'PDF p4 製品規格 / p6 H形鋼標準寸法表',
        'https://www.yamatokogyo.co.jp/steel/en/catalog/pdf/company-brochureA3.pdf',
        '69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22', '2026-10-10']);
      expect(row[P + 10]).toBe('寸法の出典と同じ資料');
      expect(row[P + 11]).toContain('PDF p9 H形鋼の形状・寸法の許容差表：JIS G 3192');
    }
    expect(now[P + 2]).toBe('出典の断面形状（資料の角のRなどを反映）');
    expect(now[P + 9]).toContain('PDF p3（冊子p3/4）広幅H形鋼');
    expect(now[P + 9]).toContain('SHA-256 69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22');
    expect(old[P + 2]).toBe('旧版の簡略断面（保存時の形のまま。出典の断面形状ではない）');
    expect(old[P + 9]).toBe('なし（この形状は出典の断面形状を使わない）');
    expect(old.join('\n')).not.toContain('PDF p3（冊子p3/4）');
  });

  it('shows an unprinted producer edition explicitly and associates S45C grade and JIS G 3123 sources', () => {
    const rows = cutRows(exported(productSource('S45C', 'roundBar', 'φ25'), productSource('SS400', 'roundBar', 'φ25')));
    const carbon = rows.find((row) => row[1] === 'S45C');
    const ss = rows.find((row) => row[1] === 'SS400');
    if (carbon === undefined || ss === undefined) throw new Error('Missing round bar rows');
    expect(carbon.slice(2, 4)).toEqual(['JIS G 4051', 'JIS G 3123']);
    expect(carbon.slice(P + 2, P + 9)).toEqual(['呼び寸法による単純な形状', '太平鋼材工業 みがき丸鋼サイズ表', '資料に版の記載なし',
      'PDF p1 S45C（黄色印）の径20・25・30行', 'https://taiheikouzai.co.jp/assets/pdf/marukou.pdf',
      'a52cd2467606af4ba52bcc2aa14bc30cb70d7855071e3ee66f1c38193edc07ce', '2026-10-10']);
    expect(carbon[P + 9]).toBe('なし（この形状は出典の断面形状を使わない）');
    expect(carbon[P + 10]).toContain('合同製鐵 構造用棒鋼 ｜ 資料に版の記載なし ｜ PDF p5 機械構造用炭素鋼鋼材（JIS G4051）S45C行');
    expect(carbon[P + 10]).toContain('SHA-256 f19cd3ea52561f00bf43149748d4b924227f06e59ede71fe42bb0680612b2b70');
    expect(carbon[P + 11]).toContain('公差表（JIS G 3123）');
    expect(carbon[P + 11]).toContain('https://taiheikouzai.co.jp/product.html?id=lineup');
    expect(carbon[P + 11]).toContain('SHA-256 63430ac1b24c555dbe09796a706cdfd75b77e12c727fe064e5d4db63917480eb');
    // A printed edition is exported as printed; no edition is inferred for the other rows.
    expect(ss.slice(P + 3, P + 5)).toEqual(['日本製鉄 建設用資材ハンドブック 大阪製鐵 一般構造用丸鋼', '2025年9月改訂版']);
    expect(ss.slice(P + 10, ORIGINAL_COLUMNS)).toEqual(['寸法の出典と同じ資料', '寸法の出典と同じ資料']);
  });

  it.each([
    ['equalAngle', 'L 50×50×6', 'PDF p11（冊子p9）', 'PDF p26（冊子p24）'],
    ['channel', '[ 100×50×5×7.5', 'PDF p14（冊子p12）', 'PDF p26（冊子p24）'],
  ] as const)('%s %s cites the JFE profile page and the JFE JIS G 3192 page separately', (catalog, size, profilePage, standardPage) => {
    const [row] = cutRows(exported(productSource('SS400', catalog, size)));
    expect(row[P + 3]).toBe('大阪製鐵 製品カタログ');
    expect(row[P + 4]).toBe('資料に版の記載なし');
    expect(row[P + 9]).toContain(profilePage);
    expect(row[P + 9]).toContain('SHA-256 031d35df73d5681c7ad7cb721eea4838e80624c9ca7092a69c8e83641c5d65de');
    expect(row[P + 11]).toContain(standardPage);
    expect(row[P + 11]).toContain('JIS G 3192');
  });

  it('keeps SGP as its own grade with its pipe source and no section or separate standard source', () => {
    const [row] = cutRows(exported(productSource('SGP', 'steelPipe', '15A')));
    expect(row.slice(1, 4)).toEqual(['SGP', 'JIS G 3452', 'JIS G 3452']);
    expect(row.slice(P + 2, P + 4)).toEqual(['呼び寸法による単純な形状', 'JFEスチール 配管用鋼管']);
    expect(row[P + 7]).toBe('e0790c1900aa6eedeb7c51dc18916c7c506c02765550e8a5a2ca642b7096d0be');
    expect(row.slice(P + 9, ORIGINAL_COLUMNS)).toEqual(['なし（この形状は出典の断面形状を使わない）', '寸法の出典と同じ資料', '寸法の出典と同じ資料']);
  });

  it('exports every catalog product as one well-formed row with a pinned dimensional source', () => {
    const pinned = new Set(['07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea',
      '8ea886730b59558553d49f395e7ada43c093210c51e00e3080c08f2163c0e313',
      'ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa',
      '158ac7b25b0c1cda41ae5cdf68cfe37530b73f1288b9cacf62c2d45584664245',
      '6921b44fe26e066498d5e4257067cdc5e1f5aca6f7e307481095a658f8ddf109',
      '69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22', '50b0a027712a8a0991f52b33896309c3c3f4f83ec3c3704d54eaecb76a87ac3b',
      '5e9fbba2c98ccadfaf0f88497af97664393234e4da8b5bb23606997909ef542c', 'a52cd2467606af4ba52bcc2aa14bc30cb70d7855071e3ee66f1c38193edc07ce',
      'f45feea1ccb83dbc1706ee7241f97accc92473b139b463c38f7155f22893dd87', 'e0790c1900aa6eedeb7c51dc18916c7c506c02765550e8a5a2ca642b7096d0be']);
    const rows = exported(...STEEL_PRODUCTS.map((row) => productSource(row.materialGrade, row.catalog, row.size, row.key)));
    expect(rows.every((row) => row.length === COLUMNS)).toBe(true);
    const cuts = cutRows(rows);
    expect(cuts).toHaveLength(459);
    for (const row of cuts) {
      expect(pinned.has(row[P + 7]), row[5]).toBe(true);
      expect(row[P + 6], row[5]).toMatch(/^https:\/\//u);
      // Catalog constants need no spreadsheet-text prefix; nothing in the evidence cells was rewritten.
      expect(row.slice(P).some((value) => value.startsWith('text:')), row[5]).toBe(false);
    }
  });

  it('omits stale or incompatible saved steel metadata without attaching any evidence', () => {
    const valid = productSource('S45C', 'roundBar', 'φ25');
    const rows = exported(
      { ...valid, generatorRevision: 'future' },
      { ...valid, options: { ...valid.options, materialGrade: 'SS400' } },
      { ...valid, catalogRevision: 'jp-steel-2026-01-01-r0' },
      createStandardPartSource('equalAngle', 'L 50×50×6', { length: '200' }),
    );
    expect(cutRows(rows)).toEqual([]);
    const omitted = rows.filter((row) => row[0] === t('assembly.steel.csv.omitted'));
    expect(omitted.map((row) => row[11])).toEqual([t('assembly.steel.omittedUnknown'), t('assembly.steel.omittedUnknown'),
      t('assembly.steel.omittedUnknown'), t('assembly.steel.omittedMaterial')]);
    for (const row of omitted) expect(row.slice(P)).toEqual(Array.from({ length: COLUMNS - P }, () => ''));
  });
});

function fixture(stage: 'picker' | 'create' | 'write' | 'close') {
  const gate = deferred<void>(), entered = deferred<void>();
  const calls: string[] = [];
  const writes: Uint8Array[] = [];
  const pause = async (name: typeof stage): Promise<void> => {
    calls.push(name);
    if (name === stage) { entered.resolve(); await gate.promise; }
  };
  const writable = { write: async (bytes: Uint8Array) => { writes.push(bytes); await pause('write'); },
    close: async () => pause('close'), abort: () => { calls.push('abort'); return Promise.resolve(); } };
  const handle = { name: 'steel-stock-list.csv', createWritable: async () => { await pause('create'); return writable; } };
  const picker = vi.fn(async () => { await pause('picker'); return handle; });
  const clear = vi.fn();
  const gateway = { ...createBrowserFileGateway({ showSaveFilePicker: picker }), clearSaveTarget: clear };
  useAppStore.setState({ fileGateway: gateway });
  const state = useAppStore.getState();
  if (state.assembly === null) throw new Error('Missing assembly fixture');
  const attempt = { pending: { current: null as AbortController | null }, assembly: state.assembly,
    library: state.assemblyLibrary, busy: vi.fn(), error: vi.fn(), status: vi.fn() };
  return { gate, entered, calls, writes, picker, clear, attempt };
}

describe('actual CSV save gateway and assembly ownership', () => {
  it('saves CSV bytes through the existing picker without changing CAD target or undo state', async () => {
    const f = fixture('picker');
    const before = useAppStore.getState();
    const saving = exportSteelStockCsv(f.attempt);
    await f.entered.promise;
    expect(f.picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'steel-stock-list.csv' }));
    f.gate.resolve();
    await saving;
    expect(f.calls).toEqual(['picker', 'create', 'write', 'close']);
    expect(csvRows(f.writes[0])[2].slice(7, 10)).toEqual(['1000', '1', '1000']);
    expect(f.attempt.status).toHaveBeenLastCalledWith(t('assembly.steel.csv.saved'));
    expect(f.clear).not.toHaveBeenCalled();
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(useAppStore.getState().savedAssembly).toBe(before.savedAssembly);
  });

  for (const stage of ['picker', 'create', 'write', 'close'] as const) {
    for (const loss of ['assembly', 'library', 'session', 'pickerClose', 'unmount', 'gateway'] as const) {
      it(`${loss} during ${stage} cancels further work and prevents stale success`, async () => {
        const f = fixture(stage);
        const saving = exportSteelStockCsv(f.attempt);
        await f.entered.promise;
        const controller = f.attempt.pending.current;
        if (loss === 'assembly') useAppStore.setState({ assembly: { ...f.attempt.assembly } });
        else if (loss === 'library') useAppStore.setState({ assemblyLibrary: { ...EMPTY_PART_LIBRARY } });
        else if (loss === 'session') useAppStore.setState({ activeDocumentId: 'another-session' });
        else if (loss === 'pickerClose') useAppStore.getState().closeStandardPartPicker();
        else if (loss === 'gateway') useAppStore.setState({ fileGateway: createBrowserFileGateway({}) });
        else { f.attempt.pending.current = null; controller?.abort(); }
        expect(controller?.signal.aborted).toBe(true);
        f.gate.resolve();
        await saving;
        expect(f.attempt.status.mock.calls).toEqual([['']]);
        expect(f.attempt.error.mock.calls).toEqual([['']]);
        expect(f.attempt.busy.mock.calls).toEqual(loss === 'unmount' ? [[true]] : [[true], [false]]);
        expect(f.calls).toEqual(stage === 'picker' ? ['picker'] : stage === 'create'
          ? ['picker', 'create', 'abort'] : stage === 'write'
            ? ['picker', 'create', 'write', 'abort'] : ['picker', 'create', 'write', 'close']);
      });
    }
  }

  it('double activation opens one picker; cancellation allows retry before the old picker finishes', async () => {
    const f = fixture('picker');
    const old = exportSteelStockCsv(f.attempt);
    await f.entered.promise;
    await exportSteelStockCsv(f.attempt);
    expect(f.calls).toEqual(['picker']);
    f.attempt.pending.current?.abort();
    const retry = exportSteelStockCsv(f.attempt);
    f.gate.resolve();
    await old;
    await retry;
    expect(f.calls).toEqual(['picker', 'picker', 'create', 'write', 'close']);
    expect(f.attempt.status.mock.calls).toEqual([[''], [''], [t('assembly.steel.csv.saved')]]);
  });

  it('reports current disk errors and permits retry; late disk errors cannot overwrite a new session', async () => {
    const f = fixture('write');
    const saving = exportSteelStockCsv(f.attempt);
    await f.entered.promise;
    f.gate.reject(new Error('disk full'));
    await saving;
    expect(f.attempt.error).toHaveBeenLastCalledWith('disk full');
    expect(f.attempt.pending.current).toBeNull();
    const fresh = fixture('write');
    const late = exportSteelStockCsv(fresh.attempt);
    await fresh.entered.promise;
    useAppStore.setState({ assembly: { ...fresh.attempt.assembly } });
    fresh.gate.reject(new Error('late disk error'));
    await late;
    expect(fresh.attempt.error.mock.calls).toEqual([['']]);
    expect(fresh.attempt.status.mock.calls).toEqual([['']]);
  });

  it('reports user cancellation as cancellation rather than success', async () => {
    const f = fixture('picker');
    const gateway = { ...useAppStore.getState().fileGateway, saveFileAs: vi.fn(() => Promise.resolve(false)) };
    useAppStore.setState({ fileGateway: gateway });
    await exportSteelStockCsv(f.attempt);
    expect(gateway.saveFileAs).toHaveBeenCalledOnce();
    expect(f.attempt.status).toHaveBeenLastCalledWith(t('assembly.steel.csv.cancelled'));
  });
});

describe('saved steel part CSV source parity', () => {
  it('uses the same purchased/finished row data after a library edit and restored snapshot', () => {
    const part = buildStandardPartFromSource(steelSource());
    if (part === null) throw new Error('Missing steel fixture');
    const root = { ...createAssemblyDocument('Root'), components: [component('steel', { kind: 'part', partRef: 'steel' })] };
    const stock = buildSteelStockList(root, new Map(), new Map([['steel', part]]));
    const row = csvRows(serializeSteelStockCsv(stock))[2];
    expect(row[7]).toBe(String(stock.rows[0].lengthMm));
    expect(row[13]).toBe(String(stock.rows[0].finishedLengthMm));
    // The embedded part's saved steel source keeps the same revisions and dimensional source in the report.
    expect(row.slice(P, P + 2)).toEqual(['jp-steel-2026-10-10-r1', '3-steel-profile-1']);
    expect(row[P + 7]).toBe('5e9fbba2c98ccadfaf0f88497af97664393234e4da8b5bb23606997909ef542c');
    const edited = { ...part, solids: [] };
    const after = buildSteelStockList(root, new Map(), new Map([['steel', edited]]));
    const changedRow = csvRows(serializeSteelStockCsv(after))[2];
    expect(changedRow[7]).toBe('1000');
    expect(changedRow[13]).toBe(t('assembly.steel.finishedUnknown'));
    expect(csvRows(serializeSteelStockCsv(buildSteelStockList(root, new Map(), new Map([['steel', part]]))))[2]).toEqual(row);
  });
});

/** Expected display values are transcribed from EX-03 sources, independently of STEEL_STANDARDS. */
function expectedStandardEditions(grade: SteelMaterialGrade, catalog: SteelSectionCatalog, key = ''): readonly string[] {
  if (key.endsWith(':hotRolled')) return ['JIS G 4051:2026', '原案で確認',
    catalog === 'roundBar' ? 'JIS G 4051:2026' : 'JIS G 3194:2024', '原案で確認'];
  if (grade === 'SGP') return ['JIS G 3452:2026', '原案で確認', 'JIS G 3452:2026', '原案で確認'];
  if (grade === 'S45C') return ['JIS G 4051:2026', '原案で確認', 'JIS G 3123:2004', '未確認'];
  return ['JIS G 3101:2024', '原案で確認', catalog === 'flatBar' ? 'JIS G 3194:2024'
    : catalog === 'roundBar' ? 'JIS G 3191:2022' : 'JIS G 3192:2024', '原案で確認'];
}

describe('steel standard edition picker notes', () => {
  it.each(STEEL_PRODUCTS)('$key renders both standard editions and the ledger verification level', (product) => {
    const html = renderToStaticMarkup(createElement(SteelStandardEditionNote, { standardEdition: product.standardEdition }));
    const [material, materialStatus, dimensions, dimensionsStatus] = expectedStandardEditions(product.materialGrade, product.catalog, product.key);
    expect(html).toContain(`材料規格の版 ${material} / ${materialStatus}`);
    expect(html).toContain(`寸法規格の版 ${dimensions} / ${dimensionsStatus}`);
    expect(html).not.toContain('確認済み');
    expect(html).toContain('未確認');
    // The full ledger caveat, including the absence of the final standard text, remains visible.
    expect(html).toContain(product.standardEdition.material.verificationNote);
    expect(html).toContain(product.standardEdition.dimensions.verificationNote);
  });

  it('renders a copied unverified dimension standard as unverified instead of upgrading it to draft or final confirmation', () => {
    const product = STEEL_PRODUCTS[0];
    const standardEdition = { ...product.standardEdition, dimensions: {
      ...product.standardEdition.dimensions, verification: 'unverified' as const,
    } };
    const html = renderToStaticMarkup(createElement(SteelStandardEditionNote, { standardEdition }));
    expect(html).toContain('材料規格の版 JIS G 3101:2024 / 原案で確認');
    expect(html).toContain('寸法規格の版 JIS G 3194:2024 / 未確認');
    expect(html).not.toContain('寸法規格の版 JIS G 3194:2024 / 原案で確認');
    expect(html).not.toContain('規格票で確認');
    expect(html).not.toContain('確認済み');
    expect(product.standardEdition.dimensions.verification).toBe('draft');
  });
});

describe('steel standard edition CSV columns', () => {
  it('appends four standard edition and verification columns after the unchanged 26 headings', () => {
    expect(exported()[0].slice(26)).toEqual(['材料規格の版', '材料規格の確認の程度', '寸法規格の版', '寸法規格の確認の程度']);
    expect(exported()[0]).toHaveLength(30);
  });

  it.each(STEEL_PRODUCTS)('$key exports both standard editions and verification states', (product) => {
    const [row] = cutRows(exported(productSource(product.materialGrade, product.catalog, product.size, product.key)));
    expect(row.slice(26)).toEqual(expectedStandardEditions(product.materialGrade, product.catalog, product.key));
    expect(row).toHaveLength(30);
    expect(row[14]).toBe('jp-steel-2026-10-10-r1');
  });

  it('leaves standard edition cells empty on scope, totals and omitted occurrences', () => {
    const rows = exported(createStandardPartSource('equalAngle', 'L 50×50×6', { length: '200' }));
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) expect(row.slice(26)).toEqual(['', '', '', '']);
  });

  it('retains the same standard editions for current and saved legacy geometry without changing saved options', () => {
    const current = productSource('SS400', 'hBeam', 'H 150×150×7×10');
    const legacy = { ...current, generatorRevision: '2-steel-1' };
    const rows = cutRows(exported(current, legacy));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.slice(26)).toEqual(['JIS G 3101:2024', '原案で確認', 'JIS G 3192:2024', '原案で確認']);
    expect(Object.keys(current.options)).toEqual(['steelProduct', 'materialGrade', 'materialStandard',
      'productStandard', 'condition', 'evidence', 'length']);
  });
});
