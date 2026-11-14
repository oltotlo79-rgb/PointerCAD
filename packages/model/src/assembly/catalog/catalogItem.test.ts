/**
 * 族の部品の保存の形と登録口(K0 の検査 (b) の model 側。設計 §5.2・§5.3)。
 *
 * 検査に要る最小の族は、このファイルの中だけに置く(製品の登録口 `PRODUCT_CATALOG_REGISTRY` には入れない)。
 * 製品の登録口は K0 では族を 1 つも持たないので、製品の道(`standardPartRejection` ほか)では「知らない種類」の
 * 型付きの拒否だけを確かめ、族を知っている時の組み立ては検査の登録口で確かめる。
 */
import { describe, expect, it } from 'vitest';

import { createEmptyPartDocument } from '../../part/createPartDocument.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument, STANDARD_CATALOG_IDS } from '../createAssemblyDocument.js';
import { resolveAssembly, type StandardPartSource } from '../resolveAssembly.js';
import {
  buildStandardPart, buildStandardPartFromSource, buildStandardPartFromSourceWithReason, createStandardPartSource,
  standardPartNominalVolume, standardPartRejection,
} from '../standard/buildStandardPart.js';
import { createCatalogRegistry, PRODUCT_CATALOG_REGISTRY } from './registry.js';
import { CATALOG_ITEM_REJECTION_TEMPLATES, type CatalogItemRejectionCode } from './rejection.js';
import {
  buildCatalogItemPart, catalogItemNominalVolume, catalogItemRejection, catalogItemSourceFromOptions,
  createCatalogItemSource,
} from './source.js';
import type { CatalogFamily, CatalogFamilyEntry, CatalogItemRow } from './types.js';

const EVIDENCE = {
  title: '検査用の資料', edition: null, url: 'https://example.invalid/test-pin.pdf', locator: '表1',
  sha256: '0000000000000000000000000000000000000000000000000000000000000000', fetchedDate: '2026-11-14',
} as const;
const ROWS: readonly CatalogItemRow[] = [
  { key: 'test-pin:d2', size: '2', standardLabel: 'JIS B 1354', densityMaterialId: 'steel', dims: { d: 2 },
    evidence: EVIDENCE, verification: 'draft', verified: true, note: '' },
  { key: 'test-pin:d3', size: '3', standardLabel: 'JIS B 1354', densityMaterialId: 'steel', dims: { d: 3 },
    evidence: EVIDENCE, verification: 'draft', verified: false, note: '要確認' },
];
const FAMILY: CatalogFamily = {
  id: 'test-parallel-pin', group: 'mechanical', kindKey: 'catalog.test.parallelPin',
  catalogRevision: 'test-pin-r1', generatorRevision: 'test-pin-1',
  options: [
    { key: 'length', kind: 'lengthExpression', labelKey: 'catalog.test.length', min: 1, max: 100, defaultValue: '10' },
    { key: 'finish', kind: 'choice', labelKey: 'catalog.test.finish', choices: ['plain', 'coated'], defaultValue: 'plain' },
  ],
  stock: 'count', diagram: 'pin', rows: ROWS,
  build: (row, values) => ({ ...createEmptyPartDocument(), name: `平行ピン ${row.size}×${values.length}` }),
  nominalVolume: (row, values) => Math.PI * ((row.dims.d ?? 0) / 2) ** 2 * Number(values.length),
  partName: (row, values) => `平行ピン ${row.size}×${values.length}`,
};

function entryFor(family: CatalogFamily, onLoad: () => void = () => undefined): CatalogFamilyEntry {
  return { id: family.id, group: family.group, kindKey: family.kindKey,
    load: () => { onLoad(); return Promise.resolve(family); } };
}

async function loadedRegistry() {
  const registry = createCatalogRegistry([entryFor(FAMILY)]);
  await registry.ensure([FAMILY.id]);
  return registry;
}

const SAVED = createCatalogItemSource(FAMILY, ROWS[0], { length: '12' });
const IDENTIFIERS = /catalogItem|family|item|length|finish|extra|size|test-pin|test-parallel-pin/u;

describe('K0 (b) 族の部品の保存の形', () => {
  it('catalog は catalogItem の 1 値で、options は族・行の鍵と族の指定だけ(形・寸法・出どころ・材質は保存しない)', () => {
    expect(JSON.stringify(SAVED)).toBe('{"kind":"standardPart","catalog":"catalogItem","size":"2","options":'
      + '{"family":"test-parallel-pin","item":"test-pin:d2","length":"12","finish":"plain"},'
      + '"catalogRevision":"test-pin-r1","generatorRevision":"test-pin-1"}');
    for (const derived of ['JIS B 1354', 'steel', EVIDENCE.url, EVIDENCE.sha256, '"d"']) {
      expect(JSON.stringify(SAVED)).not.toContain(derived);
    }
    expect(STANDARD_CATALOG_IDS).toContain('catalogItem');
    expect(STANDARD_CATALOG_IDS.filter((id) => id === 'catalogItem')).toHaveLength(1);
  });

  it('既定の値は保存の時に必ず書き出し、指定の外の鍵は書かない', () => {
    expect(createCatalogItemSource(FAMILY, ROWS[1], { stray: 'x' }).options)
      .toEqual({ family: 'test-parallel-pin', item: 'test-pin:d3', length: '10', finish: 'plain' });
  });

  it('読み込んだ族なら組めて、名前・体積は族の台本から導く', async () => {
    const registry = await loadedRegistry();
    expect(catalogItemRejection(SAVED, registry)).toBeNull();
    expect(buildCatalogItemPart(SAVED, registry)?.name).toBe('平行ピン 2×12');
    expect(catalogItemNominalVolume('2', SAVED.options, registry)).toBeCloseTo(Math.PI * 12, 12);
    expect(catalogItemSourceFromOptions('2', { family: FAMILY.id, item: 'test-pin:d2', length: '12' }, registry)).toEqual(SAVED);
  });
});

describe('K0 (b) 知らない族・読めない保存は黙って消さず、型付きの拒否にする', () => {
  const cases: readonly { readonly name: string; readonly code: CatalogItemRejectionCode; readonly fields?: readonly string[];
    readonly source: StandardPartSource }[] = [
    { name: '知らない族', code: 'unknown-family', source: { ...SAVED, options: { ...SAVED.options, family: 'future-family' } } },
    { name: '族の鍵が無い', code: 'unknown-family', source: { ...SAVED, options: { item: 'test-pin:d2', length: '12', finish: 'plain' } } },
    { name: '表の版が違う', code: 'unsupported-catalog-revision', source: { ...SAVED, catalogRevision: 'test-pin-r2' } },
    { name: '形の台本の版が違う', code: 'unsupported-generator-revision', source: { ...SAVED, generatorRevision: 'test-pin-2' } },
    { name: '知らない行', code: 'unknown-item', source: { ...SAVED, options: { ...SAVED.options, item: 'test-pin:d99' } } },
    { name: '余計な鍵', code: 'saved-fields-mismatch', fields: ['extra'], source: { ...SAVED, options: { ...SAVED.options, extra: '1' } } },
    { name: '欠けた鍵', code: 'saved-fields-mismatch', fields: ['finish'],
      source: { ...SAVED, options: { family: FAMILY.id, item: 'test-pin:d2', length: '12' } } },
    { name: '呼びの食い違い', code: 'saved-fields-mismatch', fields: ['size'], source: { ...SAVED, size: '3' } },
    { name: '長さが 0', code: 'invalid-option-value', fields: ['length'], source: { ...SAVED, options: { ...SAVED.options, length: '0' } } },
    { name: '長さが上限の外', code: 'invalid-option-value', fields: ['length'],
      source: { ...SAVED, options: { ...SAVED.options, length: '101' } } },
    { name: '長さが数でない', code: 'invalid-option-value', fields: ['length'],
      source: { ...SAVED, options: { ...SAVED.options, length: 'abc' } } },
    { name: '選択肢の外', code: 'invalid-option-value', fields: ['finish'], source: { ...SAVED, options: { ...SAVED.options, finish: 'gold' } } },
  ];

  it.each(cases)('$name: $code の理由を返し、組まない', async (test) => {
    const registry = await loadedRegistry();
    const before = structuredClone(test.source);
    const rejection = catalogItemRejection(test.source, registry);
    expect(rejection?.code).toBe(test.code);
    expect(rejection?.messageKey).toBe(`catalog.rejection.${test.code}`);
    expect(rejection?.fields).toEqual(test.fields ?? []);
    expect(rejection?.basis).toEqual([]);
    expect(rejection?.message).not.toMatch(IDENTIFIERS);
    expect(rejection?.message).toBe(CATALOG_ITEM_REJECTION_TEMPLATES[test.code].split('{count}').join(String((test.fields ?? []).length)));
    expect(buildCatalogItemPart(test.source, registry)).toBeNull();
    expect(test.source).toEqual(before);
  });

  it('読み込みの前は「読み込み中」、読み込んだ後は組める(表は必要な時だけ読む)', async () => {
    let loads = 0;
    const registry = createCatalogRegistry([entryFor(FAMILY, () => { loads += 1; })]);
    expect(loads).toBe(0);
    expect(registry.entries.map((entry) => entry.id)).toEqual([FAMILY.id]);
    expect(catalogItemRejection(SAVED, registry)?.code).toBe('family-not-loaded');
    expect(buildCatalogItemPart(SAVED, registry)).toBeNull();
    await Promise.all([registry.ensure([FAMILY.id, FAMILY.id, 'not-registered']), registry.ensure([FAMILY.id])]);
    expect(loads).toBe(1);
    expect(registry.loaded(FAMILY.id)).toBe(FAMILY);
    expect(registry.loaded('not-registered')).toBeUndefined();
    expect(catalogItemRejection(SAVED, registry)).toBeNull();
    await registry.ensure([FAMILY.id]);
    expect(loads).toBe(1);
  });
});

describe('K0 (b) 登録口は族の定義の誤りを断る', () => {
  it('同じ id の族を 2 回登録しない', () => {
    expect(() => createCatalogRegistry([entryFor(FAMILY), entryFor(FAMILY)])).toThrow(/重なって/u);
  });

  it.each([
    { name: '保存の形の鍵を族の指定に使う', family: { ...FAMILY, options: [{ ...FAMILY.options[0], key: 'family' }] } },
    { name: '行の鍵が重なる', family: { ...FAMILY, rows: [ROWS[0], ROWS[0]] } },
    { name: '既定の値が選択肢に無い', family: { ...FAMILY, options: [{ ...FAMILY.options[1], defaultValue: 'gold' }] } },
    { name: '版が空', family: { ...FAMILY, catalogRevision: ' ' } },
  ])('$name', async ({ family }) => {
    const registry = createCatalogRegistry([{ ...entryFor(FAMILY), load: () => Promise.resolve(family) }]);
    await expect(registry.ensure([FAMILY.id])).rejects.toThrow(/定義に誤り/u);
    expect(registry.loaded(FAMILY.id)).toBeUndefined();
  });

  it('入口と族の id が食い違う族を読まず、失敗の後は読み直せる', async () => {
    let attempt = 0;
    const registry = createCatalogRegistry([{ ...entryFor(FAMILY), load: () => {
      attempt += 1;
      return attempt === 1 ? Promise.resolve({ ...FAMILY, id: 'other' }) : Promise.resolve(FAMILY);
    } }]);
    await expect(registry.ensure([FAMILY.id])).rejects.toThrow(/定義に誤り/u);
    await registry.ensure([FAMILY.id]);
    expect(registry.loaded(FAMILY.id)).toBe(FAMILY);
  });
});

describe('K0 (b) 製品の道: 既存の 3 系統の道を変えず、族の部品だけを登録口へ回す', () => {
  const unknown: StandardPartSource = { ...SAVED, options: { ...SAVED.options, family: 'future-family' } };

  it('K0 の製品の登録口は族を 1 つも持たない(新しい規格の行を入れない)', () => {
    expect(PRODUCT_CATALOG_REGISTRY.entries).toEqual([]);
  });

  it('知らない族は standardPartRejection・組み立て・理由つきの組み立てで同じ型付きの拒否になる', () => {
    const rejection = standardPartRejection(unknown);
    expect(rejection?.code).toBe('unknown-family');
    expect(rejection?.messageKey).toBe('catalog.rejection.unknown-family');
    expect(rejection?.message).toBe(CATALOG_ITEM_REJECTION_TEMPLATES['unknown-family']);
    expect(buildStandardPartFromSource(unknown)).toBeNull();
    expect(buildStandardPartFromSourceWithReason(unknown)).toEqual({ document: null, rejection });
  });

  it('鋼材の指定や鋼材の版を持つ族の部品も、鋼材の確かめに入らず族の理由で断る', () => {
    const steelLike: StandardPartSource = { ...unknown, catalogRevision: 'jp-steel-2026-10-10-r1',
      generatorRevision: '3-steel-profile-1', options: { ...unknown.options, materialGrade: 'SS400' } };
    expect(standardPartRejection(steelLike)?.messageKey).toBe('catalog.rejection.unknown-family');
    expect(buildStandardPartFromSource(steelLike)).toBeNull();
  });

  it('アセンブリを解くと部品は作らずに理由を出し、保存の形は変えない', () => {
    const document = createAssemblyDocument('族の部品');
    const assembly = addComponent(document, createComponentFor(document, unknown));
    const before = structuredClone(assembly);
    const resolved = resolveAssembly(assembly, { standardPart: buildStandardPartFromSource });
    expect(resolved.parts.size).toBe(0);
    expect(resolved.errors.map((error) => error.message)).toEqual([CATALOG_ITEM_REJECTION_TEMPLATES['unknown-family']]);
    expect(assembly).toEqual(before);
  });

  it('呼びと options だけの生成口は、族が無ければ版の無い形を返し、組めず体積も出さない', () => {
    const source = createStandardPartSource('catalogItem', '2', { family: 'future-family', item: 'x', length: '12' });
    expect(source).toEqual({ kind: 'standardPart', catalog: 'catalogItem', size: '2',
      options: { family: 'future-family', item: 'x', length: '12' }, catalogRevision: '', generatorRevision: '' });
    expect(standardPartRejection(source)?.code).toBe('unknown-family');
    expect(buildStandardPart('catalogItem', '2', source.options)).toBeNull();
    expect(standardPartNominalVolume('catalogItem', '2', source.options)).toBeNull();
  });

  it('全ての拒否の文は利用者の言葉で、保存の形の識別子を含まない', () => {
    for (const template of Object.values(CATALOG_ITEM_REJECTION_TEMPLATES)) {
      expect(template).not.toMatch(IDENTIFIERS);
      expect(template.trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(CATALOG_ITEM_REJECTION_TEMPLATES).sort()).toEqual([
      'family-not-loaded', 'invalid-option-value', 'saved-fields-mismatch', 'unknown-family', 'unknown-item',
      'unsupported-catalog-revision', 'unsupported-generator-revision',
    ]);
  });
});
