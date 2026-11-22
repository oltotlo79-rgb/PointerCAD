import { describe, expect, it, vi } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { buildBom, bomPartName, type BomResolvedData } from './bom.js';
import { PRODUCT_CATALOG_REGISTRY } from './catalog/registry.js';
import { createStandardPartSource } from './standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument, BomSortKey, ComponentSource } from './types.js';

function component(
  id: string,
  name: string,
  source: ComponentSource = { kind: 'part', partRef: 'part-a' },
  extra: Partial<Pick<AssemblyComponent, 'visible' | 'suppressed' | 'materialId'>> = {},
): AssemblyComponent {
  return {
    id,
    name,
    source,
    placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false,
    visible: extra.visible ?? true,
    suppressed: extra.suppressed ?? false,
    ...(extra.materialId === undefined ? {} : { materialId: extra.materialId }),
  };
}

function assembly(...components: readonly AssemblyComponent[]): AssemblyDocument {
  return { ...createAssemblyDocument('組立'), components };
}

function resolved(
  volumes: Readonly<Record<string, number>> = { 'part-a': 8000 },
  partKeys: Readonly<Record<string, string>> = {},
): BomResolvedData {
  return {
    partKeys: new Map(Object.entries(partKeys)),
    bodies: new Map(Object.entries(volumes).map(([key, volume]) => [key, [{ volume }]])),
  };
}

function withSort(document: AssemblyDocument, sortBy: BomSortKey): AssemblyDocument {
  return { ...document, bom: { ...document.bom, sortBy } };
}

describe('buildBom', () => {
  it('同じ部品3個と別部品2個を2行へ集計する', () => {
    const document = assembly(
      component('a1', 'A:1'), component('a2', 'A:2'), component('a3', 'A:3'),
      component('b1', 'B:1', { kind: 'part', partRef: 'part-b' }),
      component('b2', 'B:2', { kind: 'part', partRef: 'part-b' }),
    );
    const rows = buildBom(document, resolved({ 'part-a': 1, 'part-b': 2 }));
    expect(rows.map((row) => [row.name, row.quantity])).toEqual([['A', 3], ['B', 2]]);
  });

  it('番号は木に最初に現れた順で1から付ける', () => {
    const rows = buildBom(assembly(
      component('b', 'B:1', { kind: 'part', partRef: 'part-b' }), component('a', 'A:1'),
    ), resolved({ 'part-a': 1, 'part-b': 1 }));
    expect(rows.map((row) => row.number)).toEqual([1, 2]);
  });

  it('同じ規格部品5個は1行になる', () => {
    const source: ComponentSource = {
      kind: 'standardPart', catalog: 'hexBolt', size: 'M8', options: { length: '30' },
      catalogRevision: 'r1', generatorRevision: 'g1',
    };
    const document = assembly(...Array.from({ length: 5 }, (_, index) =>
      component(`bolt-${String(index)}`, `六角ボルト M8×30:${String(index + 1)}`, source)));
    expect(buildBom(document, resolved({}))).toHaveLength(1);
    expect(buildBom(document, resolved({}))[0]?.quantity).toBe(5);
  });

  it('規格部品の呼び寸法が違えば別行になる', () => {
    const source = (size: string): ComponentSource => ({
      kind: 'standardPart', catalog: 'hexBolt', size, options: { length: '30' },
      catalogRevision: 'r1', generatorRevision: 'g1',
    });
    expect(buildBom(assembly(
      component('m8', 'M8', source('M8')), component('m10', 'M10', source('M10')),
    ), resolved({}))).toHaveLength(2);
  });

  it('規格表または生成台本の改訂が違えば別行になる', () => {
    const source = (catalogRevision: string): ComponentSource => ({
      kind: 'standardPart', catalog: 'hexBolt', size: 'M8', options: { length: '30' },
      catalogRevision, generatorRevision: 'g1',
    });
    expect(buildBom(assembly(
      component('old', '旧', source('r1')), component('new', '新', source('r2')),
    ), resolved({}))).toHaveLength(2);
  });

  it('20mm角の鋼の箱は62.8gになる', () => {
    expect(buildBom(assembly(component('a', '箱:1')), resolved())[0]?.massEach).toBeCloseTo(62.8, 9);
  });

  it('同じ鋼の箱3個は合計188.4gになる', () => {
    const row = buildBom(assembly(
      component('a1', '箱:1'), component('a2', '箱:2'), component('a3', '箱:3'),
    ), resolved())[0];
    expect(row?.massTotal).toBeCloseTo(188.4, 9);
  });

  it('複数ボディの体積を合計する', () => {
    const data: BomResolvedData = {
      partKeys: new Map(), bodies: new Map([['part-a', [{ volume: 3000 }, { volume: 5000 }]]]),
    };
    expect(buildBom(assembly(component('a', '箱:1')), data)[0]?.massEach).toBeCloseTo(62.8, 9);
  });

  it('体積が得られない部品の質量はnullで投げない', () => {
    const row = buildBom(assembly(component('a', '不明:1')), resolved({}))[0];
    expect(row?.massEach).toBeNull();
    expect(row?.massTotal).toBeNull();
  });

  it('壊れた体積または未知の材質の質量はnullにする', () => {
    const badVolume = buildBom(assembly(component('a', '不明:1')), resolved({ 'part-a': -1 }));
    const badMaterial = buildBom(assembly(component('b', '不明:1', undefined, { materialId: 'unknown' })), resolved());
    expect(badVolume[0]?.massEach).toBeNull();
    expect(badMaterial[0]?.massEach).toBeNull();
  });

  it('抑制した部品は数えない', () => {
    expect(buildBom(assembly(component('a', 'A:1', undefined, { suppressed: true })), resolved())).toEqual([]);
  });

  it('非表示の部品も数える', () => {
    expect(buildBom(assembly(component('a', 'A:1', undefined, { visible: false })), resolved())[0]?.quantity).toBe(1);
  });

  it('材質が違えば同じ部品でも別行にする', () => {
    const rows = buildBom(assembly(
      component('steel', 'A:1'), component('aluminum', 'A:2', undefined, { materialId: 'aluminum' }),
    ), resolved());
    expect(rows.map((row) => row.materialId)).toEqual(['steel', 'aluminum']);
  });

  it('行キーは安定したbom接頭辞つきで並べ替えても変わらない', () => {
    const document = assembly(component('a', 'A:1'));
    const before = buildBom(document, resolved())[0]?.rowKey;
    const after = buildBom(withSort(document, 'name'), resolved())[0]?.rowKey;
    expect(before).toMatch(/^bom:/u);
    expect(after).toBe(before);
  });

  it('対応する部品IDと全出現経路を保持する', () => {
    const row = buildBom(assembly(component('a1', 'A:1'), component('a2', 'A:2')), resolved())[0];
    expect(row?.componentIds).toEqual(['a1', 'a2']);
    expect(row?.occurrencePath).toEqual(['a1']);
    expect(row?.occurrencePaths).toEqual([['a1'], ['a2']]);
  });

  it('サブアセンブリは既定では1行として数える', () => {
    const sub = component('sub', '歯車箱:1', { kind: 'subAssembly', assemblyRef: 'sub-1' });
    expect(buildBom(assembly(sub), resolved({}))[0]?.name).toBe('歯車箱');
  });

  it('展開するとサブアセンブリ自身を除き中の部品を階層経路つきで数える', () => {
    const child = assembly(component('shaft', '軸:1'));
    const root = assembly(component('sub', '歯車箱:1', { kind: 'subAssembly', assemblyRef: 'sub-1' }));
    const data: BomResolvedData = {
      ...resolved({}),
      subAssemblies: new Map([['sub-1', { assembly: child, resolved: resolved({ 'part-a': 1000 }) }]]),
    };
    const rows = buildBom(root, data, { ...root.bom, expandSubAssemblies: true });
    expect(rows.map((row) => row.name)).toEqual(['軸']);
    expect(rows[0]?.occurrencePath).toEqual(['sub', 'shaft']);
  });

  it('名前・数量・質量順は同値なら元番号で決定的に並ぶ', () => {
    const document = assembly(
      component('b', 'B:1', { kind: 'part', partRef: 'part-b' }),
      component('a', 'A:1', { kind: 'part', partRef: 'part-a' }),
      component('a2', 'A:2', { kind: 'part', partRef: 'part-a' }),
    );
    const data = resolved({ 'part-a': 2, 'part-b': 1 });
    expect(buildBom(withSort(document, 'name'), data).map((row) => row.name)).toEqual(['A', 'B']);
    expect(buildBom(withSort(document, 'quantity'), data).map((row) => row.name)).toEqual(['B', 'A']);
    expect(buildBom(withSort(document, 'mass'), data).map((row) => row.name)).toEqual(['B', 'A']);
    expect(buildBom(document, data)).toEqual(buildBom(document, data));
  });
});

describe('bomPartName', () => {
  it('既定の末尾採番だけを落とす', () => {
    expect(bomPartName(component('a', 'ブラケット:12'))).toBe('ブラケット');
    expect(bomPartName(component('a', 'ブラケット:A'))).toBe('ブラケット:A');
  });
});

describe('部品表の材質の欄に出す族の行の材質の表示(統括の決定 2026-11-17 22:5x の (d))', () => {
  const source = (family: string, item: string, size: string): ComponentSource => createStandardPartSource('catalogItem', size, { family, item });
  const LDPE = 'p19-insert-cap-r19x3-r16.7x10-ldpe';
  const NYLON = 'p28-cap-r30x7-r23.6x16-pa';

  async function rowOf(item: string): Promise<{ readonly size: string; readonly massG: number }> {
    await PRODUCT_CATALOG_REGISTRY.ensure(['pipe-frame-cap']);
    const row = PRODUCT_CATALOG_REGISTRY.loaded('pipe-frame-cap')?.rows.find((candidate) => candidate.key === item);
    if (row === undefined) throw new Error(`行 ${item} が無い`);
    return { size: row.size, massG: row.dims.massG ?? NaN };
  }

  it('材質の無い部品で、行が密度の材質を持たない時だけ、行の材質の表示を持つ(材質の id・行の鍵・質量は今までどおり)', async () => {
    const ldpe = await rowOf(LDPE);
    const [row] = buildBom(assembly(component('c', 'キャップ', source('pipe-frame-cap', LDPE, ldpe.size))), resolved({}));
    expect([row?.materialId, row?.materialName, row?.catalogMaterialLabel, row?.massEach]).toEqual(['steel', 'steel', '樹脂(LDPE)', ldpe.massG]);
  });

  it('部品に材質が有る時・行が密度の材質を持つ時・族の部品でない時は、行の材質の表示を持たない(出力は前と同じ形)', async () => {
    const ldpe = await rowOf(LDPE);
    const nylon = await rowOf(NYLON);
    const rows = buildBom(assembly(
      component('a', 'キャップ A', source('pipe-frame-cap', LDPE, ldpe.size), { materialId: 'abs' }),
      component('b', 'キャップ B', source('pipe-frame-cap', NYLON, nylon.size)),
      component('p', '板'),
    ), resolved());
    expect(rows.map((row) => [row.name, row.materialId, Object.hasOwn(row, 'catalogMaterialLabel')])).toEqual([
      ['キャップ A', 'abs', false], ['キャップ B', 'steel', false], ['板', 'steel', false],
    ]);
  });
});

describe('前の呼び(行の formerSizes)で保存した族の部品の部品表', () => {
  it('前の呼びの部品 1 つと今の呼びの部品 1 つは、今の呼びの名前で数量 2 の 1 行になり、保存の呼びは書き換えない', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['movable-part-box']);
    const row = PRODUCT_CATALOG_REGISTRY.loaded('movable-part-box')?.rows.find((candidate) => candidate.formerSizes !== undefined);
    const former = row?.formerSizes?.[0];
    if (row === undefined || former === undefined) throw new Error('前の呼びを持つ行が無い');
    const saved = createStandardPartSource('catalogItem', row.size, { family: 'movable-part-box', item: row.key });
    const document = assembly(component('old', `${former}:1`, { ...saved, size: former }), component('new', `${row.size}:1`, saved));
    const rows = buildBom(document, resolved({}));
    expect(rows.map((item) => [item.name, item.quantity, item.componentIds, item.massEach])).toEqual([[row.size, 2, ['old', 'new'], row.dims.massG]]);
    expect(document.components.map((item) => item.source.kind === 'standardPart' ? item.source.size : '')).toEqual([former, row.size]);
  });

  it('同じ族の部品が 1 個でも 6 個でも、行の確かめ(登録口の族の引き)の回数は同じで、結果の行は数量のほかは同じ', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['movable-part-box']);
    const row = PRODUCT_CATALOG_REGISTRY.loaded('movable-part-box')?.rows[0];
    if (row === undefined) throw new Error('可動の部品の行が無い');
    const saved = createStandardPartSource('catalogItem', row.size, { family: 'movable-part-box', item: row.key });
    const counted = (count: number) => {
      const spy = vi.spyOn(PRODUCT_CATALOG_REGISTRY, 'entry');
      try {
        const rows = buildBom(assembly(...Array.from({ length: count }, (_, index) => component(`c${index}`, `${row.size}:${index + 1}`, saved))), resolved({}));
        return { calls: spy.mock.calls.length, rows };
      } finally {
        spy.mockRestore();
      }
    };
    const one = counted(1), six = counted(6);
    expect(six.calls).toBe(one.calls);
    expect(six.rows.map((item) => ({ ...item, quantity: 0, massTotal: 0, componentIds: [], occurrencePaths: [] })))
      .toEqual(one.rows.map((item) => ({ ...item, quantity: 0, massTotal: 0, componentIds: [], occurrencePaths: [] })));
    expect(six.rows.map((item) => [item.quantity, item.componentIds.length])).toEqual([[6, 6]]);
  });
});
