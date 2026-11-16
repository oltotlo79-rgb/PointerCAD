/**
 * K-06 (2): 鋼材の規格部品を新しく置く時に、行の鋼種が質量の材料の台帳(densityMaterials.ts)の行に対応する物だけ、部品に材質を付ける。
 * 対応は出どころのある物だけ: 台帳の行の出どころが名指しする鋼種(SS400・S45C・SSC400 → steel、SUS304TP → stainless)と、
 * 製品の規格の原案が単位質量の計算に台帳の steel と同じ密度(1 cm³ の鋼を 7.85 g)を書く鋼種(SGP・STK400・STKR400 → steel)。
 * 鋼種の無い規格部品(鋼種なしの形鋼・ボルトなど)は付けない。鋼の行の部品表の質量は前と同じで、ステンレスの行は台帳のステンレスの密度になる。
 */
import {
  buildBom, createAssemblyDocument, findDensityMaterial, massFromVolume, partKeyOf, standardPartNominalVolume,
  type AssemblyComponent, type AssemblyDocument, type SteelMaterialGrade,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitStandardPartChoice, standardPartChoices, steelPartChoices, type StandardPartCategory } from './standardPartPicker.js';

/** [鋼種, 付く材質(付けない時は null)]。今の表の全ての鋼種。 */
const GRADES: readonly (readonly [SteelMaterialGrade, string | null])[] = [
  ['SS400', 'steel'], ['S45C', 'steel'], ['SGP', 'steel'], ['STKR400', 'steel'], ['STK400', 'steel'], ['SSC400', 'steel'],
  ['SUS304TP', 'stainless'],
];

function firstSteelKey(grade: SteelMaterialGrade): string {
  const choice = steelPartChoices(grade)[0];
  if (choice === undefined) throw new Error(`no rows for ${grade}`);
  return choice.key;
}

function lastPlaced(): AssemblyComponent {
  const component = useAppStore.getState().assembly?.components.at(-1);
  if (component === undefined) throw new Error('nothing placed');
  return component;
}

function nominalVolume(component: AssemblyComponent): number | null {
  const source = component.source;
  return source.kind === 'standardPart' ? standardPartNominalVolume(source.catalog, source.size, source.options) : null;
}

/** 台本どおりの体積を、部品表が読む解決済みの体積として渡す(カーネルを使わない)。 */
function bomOf(components: readonly AssemblyComponent[]): ReturnType<typeof buildBom> {
  const assembly: AssemblyDocument = { ...createAssemblyDocument('鋼材の材質'), components: [...components] };
  const partKeys = new Map<string, string>();
  const bodies = new Map<string, readonly { readonly volume: number }[]>();
  for (const component of components) {
    const key = partKeyOf(component.source);
    partKeys.set(component.id, key);
    const volume = nominalVolume(component);
    if (volume !== null) bodies.set(key, [{ volume }]);
  }
  return buildBom(assembly, { partKeys, bodies });
}

/** 材質の欄を持たない、前と同じ形の部品。 */
function withoutMaterial(component: AssemblyComponent): AssemblyComponent {
  return { id: component.id, name: component.name, source: component.source, placement: component.placement,
    fixed: component.fixed, visible: component.visible, suppressed: component.suppressed };
}

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().openAssembly(createAssemblyDocument('鋼材の材質'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { resetTestStore(); });

describe('K-06 (2) 鋼材の規格部品の材質', () => {
  it.each(GRADES)('%s の行は、置く時の中身と置いた部品の材質が %s(null は付けない)', (grade, materialId) => {
    const key = firstSteelKey(grade);
    const committed = commitStandardPartChoice('structuralSection', key, '1000');
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.materialId).toBe(materialId ?? undefined);
    expect(useAppStore.getState().placeStandardPart('structuralSection', key, '1000', 'annexJA', 'coarse')).toBe(true);
    const component = lastPlaced();
    expect(Object.hasOwn(component, 'materialId')).toBe(materialId !== null);
    expect(component.materialId).toBe(materialId ?? undefined);
  });

  it('鋼種の無い規格部品(鋼種なしの形鋼・ボルト・ナット・軸受)は材質を付けない', () => {
    const categories: readonly StandardPartCategory[] = ['structuralSection', 'hexBolt', 'hexNut', 'deepGrooveBallBearing'];
    for (const category of categories) {
      const choice = standardPartChoices(category)[0];
      if (choice === undefined) throw new Error(`no choices for ${category}`);
      expect(choice.steelProduct).toBeUndefined();
      const committed = commitStandardPartChoice(category, choice.key, '1000');
      expect(committed.ok && committed.value.materialId).toBeUndefined();
      expect(useAppStore.getState().placeStandardPart(category, choice.key, '1000', 'annexJA', 'coarse')).toBe(true);
      expect(Object.hasOwn(lastPlaced(), 'materialId')).toBe(false);
    }
  });

  it('鋼の行の部品表の質量は材質を付けない時と同じで、ステンレスの行は台帳のステンレスの密度の質量', () => {
    for (const [grade] of GRADES) {
      useAppStore.getState().placeStandardPart('structuralSection', firstSteelKey(grade), '1000', 'annexJA', 'coarse');
    }
    const components = useAppStore.getState().assembly?.components ?? [];
    expect(components).toHaveLength(GRADES.length);
    const rows = bomOf(components);
    const before = bomOf(components.map(withoutMaterial));
    for (const [index, [, materialId]] of GRADES.entries()) {
      const row = rows[index];
      const component = components[index];
      if (row === undefined || component === undefined) throw new Error(`row ${index} is missing`);
      const volume = nominalVolume(component) ?? NaN;
      expect(volume).toBeGreaterThan(0);
      expect(row.materialId).toBe(materialId ?? 'steel');
      expect(row.massEach).toBeCloseTo(massFromVolume(volume, findDensityMaterial(row.materialId)?.density ?? NaN), 9);
      if (row.materialId === 'steel') expect(before[index]?.massEach).toBe(row.massEach);
    }
    const stainless = rows[GRADES.findIndex(([grade]) => grade === 'SUS304TP')];
    expect(stainless?.massEach).toBeGreaterThan(before[GRADES.findIndex(([grade]) => grade === 'SUS304TP')]?.massEach ?? Infinity);
  });
});
