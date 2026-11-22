// 規格資料の出典は規格番号と一般名で照合する。
/**
 * K-06 段 2 の土台: 長さを持つ族('linear')の部品を、鋼材の切断の一覧の中で別の並び(catalogRows)に束ねる事。
 * 製品にはまだ 'linear' の族が無いので、検査の中だけで作る族(登録口も検査の中で作る)で確かめる。
 * 鋼材の行・合計・理由の行は、族の部品があっても無くても同じ。'count' の族・読み込んでいない族・確かめに通らない保存・抑制した部品は数えない。
 */
import { describe, expect, it } from 'vitest';

import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import { massFromVolume } from '../../measure/massProperties.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { createStandardPartSource } from '../standard/buildStandardPart.js';
import { steelProductOptions, steelProducts } from '../standard/steelCatalog.js';
import { buildSteelStockList } from '../standard/steelStockList.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource } from '../types.js';
import { lengthOf, lengthOptionSpec } from './lengthOption.js';
import { createCatalogRegistry } from './registry.js';
import { createCatalogItemSource } from './source.js';
import type { CatalogFamily, CatalogItemRow } from './types.js';

const EVIDENCE = { title: '検査だけの族', edition: null, locator: '', reference: '' } as const;
/** 行 a20 の前の呼び(材料の表示などを直した行の、前に保存したファイルの呼び)。 */
const FORMER_SIZE = '□20 前の呼び';

function row(key: string, side: number, densityMaterialId: string | null, materialLabel?: string): CatalogItemRow {
  return { key, size: `□${side}`, standardLabel: '検査', ...(densityMaterialId === null ? {} : { densityMaterialId }), dims: { side },
    evidence: EVIDENCE, verification: 'unverified', verified: false, note: '', ...(materialLabel === undefined ? {} : { materialLabel }) };
}

/** 角棒の族(長さ × 一辺² の体積)。stock だけを変えて 'linear' と 'count' の 2 つを作る。 */
function family(id: string, stock: CatalogFamily['stock']): CatalogFamily {
  return {
    id, group: 'mechanical', kindKey: `catalog.test.${id}`, catalogRevision: `${id}-r1`, generatorRevision: 'test-bar-1',
    options: [lengthOptionSpec('1000')], stock, diagram: 'key',
    rows: [{ ...row('a20', 20, 'aluminum', 'アルミ'), formerSizes: [FORMER_SIZE] }, row('s10', 10, 'steel'), row('p15', 15, null, '樹脂(LDPE)')],
    build: () => null,
    nominalVolume: (item, values) => ((item.dims.side ?? NaN) ** 2) * (lengthOf(values)?.value ?? NaN),
    partName: (item, values) => `角棒 ${item.size}×${values.length ?? ''}`,
  };
}

const LINEAR = family('test-linear-bar', 'linear');
const COUNT = family('test-count-bar', 'count');
const NOT_LOADED_ID = 'test-not-loaded-bar';

async function registry() {
  const entries = [LINEAR, COUNT, family(NOT_LOADED_ID, 'linear')].map((item) => ({ id: item.id, group: item.group,
    kindKey: item.kindKey, load: () => Promise.resolve(item) }));
  const created = createCatalogRegistry(entries);
  await created.ensure([LINEAR.id, COUNT.id]);
  return created;
}

function placed(id: string, source: ComponentSource, suppressed = false): AssemblyComponent {
  return { id, name: id, source, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed };
}

function itemSource(owner: CatalogFamily, key: string, length: string): StandardPartSource {
  const item = owner.rows.find((candidate) => candidate.key === key);
  if (item === undefined) throw new Error(`row ${key} is missing`);
  return createCatalogItemSource(owner, item, { length });
}

function steelSource(): ComponentSource {
  const product = steelProducts('SS400', 'roundBar').find((candidate) => candidate.size === 'φ25');
  if (product === undefined) throw new Error('steel fixture is missing');
  return createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
}

const assemblyOf = (components: readonly AssemblyComponent[]): AssemblyDocument =>
  ({ ...createAssemblyDocument('切断の一覧の族の行'), components: [...components] });

describe('K-06 段 2 長さを持つ族の部品の切断の一覧の行', () => {
  it('同じ族・版・行・長さを 1 行に束ね、本数・合計の長さ・行の材質の密度の質量を出す', async () => {
    const assembly = assemblyOf([
      placed('a', itemSource(LINEAR, 'a20', '1500')), placed('b', itemSource(LINEAR, 'a20', '1500')),
      placed('c', itemSource(LINEAR, 'a20', '2000')), placed('d', itemSource(LINEAR, 's10', '1500')),
    ]);
    const list = buildSteelStockList(assembly, new Map(), new Map(), await registry());
    const aluminum = findDensityMaterial('aluminum')?.density ?? NaN;
    const steel = findDensityMaterial('steel')?.density ?? NaN;
    expect(list.catalogRows.map((item) => [item.familyId, item.itemKey, item.size, item.materialLabel, item.densityMaterialId,
      item.lengthMm, item.quantity, item.totalLengthMm, item.componentIds, item.occurrencePaths])).toEqual([
      ['test-linear-bar', 'a20', '□20', 'アルミ', 'aluminum', 1500, 2, 3000, ['a', 'b'], [['a'], ['b']]],
      ['test-linear-bar', 'a20', '□20', 'アルミ', 'aluminum', 2000, 1, 2000, ['c'], [['c']]],
      ['test-linear-bar', 's10', '□10', null, 'steel', 1500, 1, 1500, ['d'], [['d']]],
    ]);
    const [first, second, third] = list.catalogRows;
    expect(first?.massEachG).toBeCloseTo(massFromVolume(20 * 20 * 1500, aluminum), 9);
    expect(first?.massTotalG).toBeCloseTo(2 * massFromVolume(20 * 20 * 1500, aluminum), 9);
    expect(second?.massEachG).toBeCloseTo(massFromVolume(20 * 20 * 2000, aluminum), 9);
    expect(third?.massEachG).toBeCloseTo(massFromVolume(10 * 10 * 1500, steel), 9);
    expect([first?.kindKey, first?.catalogRevision, first?.generatorRevision])
      .toEqual(['catalog.test.test-linear-bar', 'test-linear-bar-r1', 'test-bar-1']);
    // 族の部品は鋼材の行・合計・理由に入らない。
    expect([list.rows, list.totalQuantity, list.totalLengthMm, list.issues, list.unresolvedComponentIds]).toEqual([[], 0, 0, [], []]);
  });

  it("'count' の族・読み込んでいない族・確かめに通らない保存・抑制した部品は数えず、鋼材の行と合計と理由は族の部品が無い時と同じ", async () => {
    const loaded = await registry();
    const notLoaded: ComponentSource = { ...itemSource(LINEAR, 'a20', '1500'),
      options: { family: NOT_LOADED_ID, item: 'a20', length: '1500' } };
    const badLength: ComponentSource = { ...itemSource(LINEAR, 'a20', '1500'), options: { family: LINEAR.id, item: 'a20', length: '0' } };
    const withFamilies = assemblyOf([
      placed('steel-1', steelSource()), placed('count', itemSource(COUNT, 'a20', '1500')), placed('not-loaded', notLoaded),
      placed('bad', badLength), placed('suppressed', itemSource(LINEAR, 'a20', '1500'), true), placed('steel-2', steelSource()),
    ]);
    const steelOnly = assemblyOf([placed('steel-1', steelSource()), placed('steel-2', steelSource())]);
    const list = buildSteelStockList(withFamilies, new Map(), new Map(), loaded);
    const expected = buildSteelStockList(steelOnly, new Map(), new Map(), loaded);
    expect(list.catalogRows).toEqual([]);
    expect(expected.catalogRows).toEqual([]);
    expect({ ...list, catalogRows: [] }).toEqual(expected);
    expect(list.rows.map((item) => [item.quantity, item.totalLengthMm])).toEqual([[2, 2000]]);
  });

  it('前の呼び(formerSizes)で保存した部品は、行の今の呼びの部品と同じ 1 行に束ね、今の呼びでも前の呼びでもない呼びの部品は数えない', async () => {
    const saved = itemSource(LINEAR, 'a20', '1500');
    const assembly = assemblyOf([placed('now', saved), placed('former', { ...saved, size: FORMER_SIZE }),
      placed('other', { ...saved, size: '□20 無い呼び' })]);
    const list = buildSteelStockList(assembly, new Map(), new Map(), await registry());
    expect(list.catalogRows.map((item) => [item.itemKey, item.size, item.lengthMm, item.quantity, item.componentIds]))
      .toEqual([['a20', '□20', 1500, 2, ['now', 'former']]]);
  });

  it('密度の材質を持たない行は、密度を引かず、材質の id は null、単位質量も無ければ 1 本の質量は出さない(体積 × 密度で作らない)', async () => {
    const list = buildSteelStockList(assemblyOf([placed('p', itemSource(LINEAR, 'p15', '1200'))]), new Map(), new Map(), await registry());
    expect(list.catalogRows.map((item) => [item.itemKey, item.materialLabel, item.densityMaterialId, item.lengthMm, item.quantity,
      item.massEachG])).toEqual([['p15', '樹脂(LDPE)', null, 1200, 1, null]]);
  });

  it('登録口を渡さない時は製品の登録口を使い、鋼材だけの文書の族の行は空で、鋼材の行は前と同じ', () => {
    const assembly = assemblyOf([placed('steel', steelSource())]);
    const list = buildSteelStockList(assembly);
    expect(list.catalogRows).toEqual([]);
    expect(list.rows).toHaveLength(1);
  });
});
