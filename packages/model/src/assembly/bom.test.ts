import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { buildBom, bomPartName, type BomResolvedData } from './bom.js';
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
