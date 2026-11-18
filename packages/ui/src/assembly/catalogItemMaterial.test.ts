/**
 * K-06 段 1: 族の部品を置く時に、行の密度の材質(densityMaterialId)を部品の材質に付け、部品表の質量がその材質の密度で出る事。
 * 鋼の行は前と同じ質量(材質を付けない時の既定の鋼と同じ)で、材質を持たない前の部品(K-06 の前に置いた物)は、開き直しても変わらない。
 */
import {
  buildBom, createAssemblyDocument, findDensityMaterial, massFromVolume, partKeyOf, PRODUCT_CATALOG_REGISTRY,
  standardPartNominalVolume, type AssemblyComponent, type AssemblyDocument,
} from '@pointercad/model';
import { readAssemblyDocument, writeAssemblyDocument } from '@pointercad/io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitCatalogItemChoice } from './catalogFamilyChoices.js';

/** [族, 行の鍵, 指定の値, 付く材質]。鋼でない行(ゴム・ステンレス)と鋼の行。 */
const CASES: readonly (readonly [string, string, Readonly<Record<string, string>>, string])[] = [
  ['o-ring-p', 'P22.4', {}, 'rubber'],
  ['oil-seal-specified', 'specified', {}, 'rubber'],
  ['parallel-pin', 'A1-d6', { length: '20' }, 'stainless'],
  ['parallel-pin', 'St-d6', { length: '20' }, 'steel'],
  ['socket-head-cap-screw', 'M8', { length: '30' }, 'steel'],
];

function placedComponents(): readonly AssemblyComponent[] {
  const assembly = useAppStore.getState().assembly;
  if (assembly === null) throw new Error('assembly is missing');
  return assembly.components;
}

/** 部品の形の台本どおりの体積(カーネルを使わない)。 */
function nominalVolume(component: AssemblyComponent): number | null {
  const source = component.source;
  return source.kind === 'standardPart' ? standardPartNominalVolume(source.catalog, source.size, source.options) : null;
}

/** 台本どおりの体積を、部品表が読む解決済みの体積として渡す。 */
function bomOf(assembly: AssemblyDocument): ReturnType<typeof buildBom> {
  const partKeys = new Map<string, string>();
  const bodies = new Map<string, readonly { readonly volume: number }[]>();
  for (const component of assembly.components) {
    const key = partKeyOf(component.source);
    partKeys.set(component.id, key);
    const volume = nominalVolume(component);
    if (volume !== null) bodies.set(key, [{ volume }]);
  }
  return buildBom(assembly, { partKeys, bodies });
}

/** 材質の欄を持たない、K-06 の前と同じ形の部品(置いた直後の部品の欄を写す)。 */
function withoutMaterial(component: AssemblyComponent): AssemblyComponent {
  return { id: component.id, name: component.name, source: component.source, placement: component.placement,
    fixed: component.fixed, visible: component.visible, suppressed: component.suppressed };
}

const density = (materialId: string): number => findDensityMaterial(materialId)?.density ?? NaN;

beforeEach(async () => {
  resetTestStore();
  await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id));
  useAppStore.getState().openAssembly(createAssemblyDocument('族の部品の材質'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { resetTestStore(); });

describe('K-06 段 1 族の部品の材質と部品表の質量', () => {
  it.each(CASES)('%s の %s は、置く時の中身と置いた部品に行の材質 %s が付く', (family, item, values, materialId) => {
    const committed = commitCatalogItemChoice(family, item, values);
    expect(committed.ok ? committed.value.materialId : null).toBe(materialId);
    expect(useAppStore.getState().placeCatalogItem(family, item, values)).toBe(true);
    const component = placedComponents().at(-1);
    expect(component?.materialId).toBe(materialId);
    // 材質のほかの欄は、前と同じ形(置いた直後の欄)のまま。
    if (component !== undefined) expect(component).toEqual({ ...withoutMaterial(component), materialId });
  });

  it('部品表の質量は行の材質の密度で出て、鋼の行は材質を付けない時(既定の鋼)と同じ質量のまま', () => {
    for (const [family, item, values] of CASES) useAppStore.getState().placeCatalogItem(family, item, values);
    const components = placedComponents();
    const assembly: AssemblyDocument = { ...createAssemblyDocument('族の部品の材質'), components: [...components] };
    const rows = bomOf(assembly);
    expect(rows.map((row) => row.materialId)).toEqual(CASES.map(([, , , materialId]) => materialId));
    for (const [index, row] of rows.entries()) {
      const component = components[index];
      if (component === undefined) throw new Error(`component ${index} is missing`);
      const volume = nominalVolume(component);
      expect(volume).toBeGreaterThan(0);
      expect(row.massEach).toBeCloseTo(massFromVolume(volume ?? NaN, density(row.materialId)), 9);
      if (row.materialId === 'rubber') expect(row.massEach).toBeLessThan(massFromVolume(volume ?? NaN, density('steel')));
    }
    const before = bomOf({ ...assembly, components: components.map(withoutMaterial) });
    expect(before.map((row) => row.materialId)).toEqual(CASES.map(() => 'steel'));
    for (const [index, row] of rows.entries()) {
      if (row.materialId === 'steel') expect(before[index]?.massEach).toBe(row.massEach);
    }
  });

  it('材質を持たない前の部品は、開き直しても材質を付けず(既定の鋼のまま)、材質を付けた部品は保存して開き直しても同じ', () => {
    useAppStore.getState().placeCatalogItem('o-ring-p', 'P22.4', {});
    const placedNow = placedComponents()[0];
    if (placedNow === undefined) throw new Error('component is missing');
    const current: AssemblyDocument = { ...createAssemblyDocument('族の部品の材質'), components: [placedNow] };
    const old: AssemblyDocument = { ...current, components: [withoutMaterial(placedNow)] };
    const options = { savedAt: '2026-11-16T00:00:00.000Z' };
    for (const document of [old, current]) {
      const text = writeAssemblyDocument(document, options);
      const reopened = readAssemblyDocument(text);
      if (!reopened.ok) throw new Error('reopen failed');
      expect(reopened.document).toEqual(document);
      expect(writeAssemblyDocument(reopened.document, options)).toBe(text);
    }
    expect(Object.hasOwn(old.components[0] ?? {}, 'materialId')).toBe(false);
    expect(bomOf(old)[0]?.materialId).toBe('steel');
    expect(bomOf(current)[0]?.materialId).toBe('rubber');
  });

  it('密度の材質を持たない行(資料 2 の LDPE のキャップ)は、置く時の中身にも置いた部品にも材質を付けず、部品表の質量は行の 1 個の値', () => {
    const family = 'pipe-frame-cap';
    const item = 'p19-insert-cap-r19x3-r16.7x10-ldpe';
    const committed = commitCatalogItemChoice(family, item, {});
    expect(committed.ok).toBe(true);
    expect(committed.ok ? Object.hasOwn(committed.value, 'materialId') : true).toBe(false);
    expect(useAppStore.getState().placeCatalogItem(family, item, {})).toBe(true);
    const component = placedComponents().at(-1);
    expect(component === undefined ? true : Object.hasOwn(component, 'materialId')).toBe(false);
    const row = PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.find((candidate) => candidate.key === item);
    expect(row === undefined ? true : Object.hasOwn(row, 'densityMaterialId')).toBe(false);
    const assembly: AssemblyDocument = { ...createAssemblyDocument('密度の材質を持たない行'), components: [...placedComponents()] };
    // 材質を変える操作をしない限り、密度は付かない。質量は行の 1 個の値(形 × 密度にしない)。
    expect(bomOf(assembly).at(-1)?.massEach).toBe(row?.dims.massG);
  });
});
