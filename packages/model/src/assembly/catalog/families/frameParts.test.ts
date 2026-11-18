// 規格資料の出典は規格番号と一般名で照合する。
/**
 * E-04 T スロットフレーム用の汎用の部品(直角のブラケット・つなぎ板・T 溝用のナット。寸法を指定して作る): 規格の行を名乗らない事、欄、
 * 形のフィーチャーの並び、体積が式どおり、形が成り立つ条件の外を断る事、保存の形の検査。表を持たない族なので、照合の fixture は無い。
 */
import { describe, expect, it } from 'vitest';

import { METRIC_THREAD_DESIGNATIONS, threadMinorDiameter } from '../../../thread/metricThread.js';
import { createCatalogItemSource } from '../source.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { ANGLE_BRACKET_FAMILY, JOIN_PLATE_FAMILY, SLOT_NUT_FAMILY } from './frameParts.js';

const BRACKET = { legA: '40', legB: '40', bracketWidth: '20', thickness: '5', rib: '10', holeDiameter: '6', holePosition: '25' };
const PLATE = { plateLength: '80', plateWidth: '20', thickness: '5', holeDiameter: '6', holeCount: '2', holePitch: '40' };
const NUT = { thread: 'M5', flangeWidth: '16', nutLength: '16', flangeThickness: '4', neckWidth: '7', neckHeight: '2' };

function rowOf(family: CatalogFamily): CatalogItemRow {
  const row = family.rows[0];
  if (row === undefined) throw new Error(`${family.id} has no row`);
  return row;
}

const circle = (diameter: number): number => Math.PI * (diameter / 2) ** 2;

describe('E-04 T スロットフレーム用の汎用の部品', () => {
  it('3 つの族の版・欄を凍結し、行は寸法指定の 1 行だけで、規格・資料の値を名乗らない', () => {
    const families: readonly (readonly [CatalogFamily, string, string, string, Readonly<Record<string, string>>, string])[] = [
      [ANGLE_BRACKET_FAMILY, 'angle-bracket-specified', 'catalog.frame.kind.angleBracket', 'angleBracket', BRACKET, 'aluminum'],
      [JOIN_PLATE_FAMILY, 'join-plate-specified', 'catalog.frame.kind.joinPlate', 'joinPlate', PLATE, 'aluminum'],
      [SLOT_NUT_FAMILY, 'slot-nut-specified', 'catalog.frame.kind.slotNut', 'slotNut', NUT, 'steel'],
    ];
    for (const [family, id, kindKey, diagram, defaults, material] of families) {
      expect([family.id, family.group, family.kindKey, family.stock, family.diagram, family.catalogRevision])
        .toEqual([id, 'aluminumFrame', kindKey, 'count', diagram, `${id}-2026-11-r1`]);
      expect(Object.fromEntries(family.options.map((spec) => [spec.key, spec.defaultValue]))).toEqual(defaults);
      expect(family.rows.map((row) => [row.key, row.size, row.standardLabel, row.densityMaterialId, row.verification, row.verified,
        Object.keys(row.dims).length, row.evidence.reference]))
        .toEqual([['specified', '寸法指定', '寸法指定(規格の行ではない)', material, 'unverified', false, 0, '']]);
    }
    const thread = SLOT_NUT_FAMILY.options.find((spec) => spec.key === 'thread');
    expect([thread?.kind, thread?.choices]).toEqual(['choice', METRIC_THREAD_DESIGNATIONS]);
    const count = JOIN_PLATE_FAMILY.options.find((spec) => spec.key === 'holeCount');
    expect([count?.kind, count?.min]).toEqual(['numberExpression', 1]);
  });

  it('直角のブラケットは L 形(リブ込み)の押し出しから 2 つの穴を引いた形で、体積は (a·t + (b − t)·t + e²/2)·w − 2·π(dh/2)²·t', () => {
    const row = rowOf(ANGLE_BRACKET_FAMILY);
    const part = ANGLE_BRACKET_FAMILY.build(row, BRACKET);
    expect(part?.name).toBe('直角のブラケット(寸法指定) 40×40×幅20');
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'primitive', 'boolean', 'primitive', 'boolean']);
    const expected = (40 * 5 + 35 * 5 + 10 ** 2 / 2) * 20 - 2 * circle(6) * 5;
    expect(ANGLE_BRACKET_FAMILY.nominalVolume(row, BRACKET)).toBeCloseTo(expected, 9);
    const noRib = { ...BRACKET, rib: '0', holePosition: '10' };
    expect(ANGLE_BRACKET_FAMILY.nominalVolume(row, noRib)).toBeCloseTo((40 * 5 + 35 * 5) * 20 - 2 * circle(6) * 5, 9);
  });

  it('つなぎ板は長方形から n 個の穴(内の輪)を引いた押し出しで、体積は (L·W − n·π(dh/2)²)·t', () => {
    const row = rowOf(JOIN_PLATE_FAMILY);
    const part = JOIN_PLATE_FAMILY.build(row, PLATE);
    expect(part?.name).toBe('つなぎ板(寸法指定) 80×20×厚さ5');
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'extrude', 'boolean', 'extrude', 'boolean']);
    expect(JOIN_PLATE_FAMILY.nominalVolume(row, PLATE)).toBeCloseTo((80 * 20 - 2 * circle(6)) * 5, 9);
    const four = { ...PLATE, plateLength: '100', holeCount: '4', holePitch: '25' };
    expect(JOIN_PLATE_FAMILY.build(row, four)?.solids).toHaveLength(9);
    expect(JOIN_PLATE_FAMILY.nominalVolume(row, four)).toBeCloseTo((100 * 20 - 4 * circle(6)) * 5, 9);
  });

  it('T 溝用のナットはつばと首の直方体の和に通しのめねじで、体積は l·wf·tf + l·wn·hn − π(d1/2)²·(tf + hn)', () => {
    const row = rowOf(SLOT_NUT_FAMILY);
    const part = SLOT_NUT_FAMILY.build(row, NUT);
    expect(part?.name).toBe('T 溝用のナット(寸法指定) M5 16×16');
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean', 'threadHole']);
    const d1 = threadMinorDiameter(5, 0.8);
    expect(SLOT_NUT_FAMILY.nominalVolume(row, NUT)).toBeCloseTo(16 * 16 * 4 + 16 * 7 * 2 - circle(d1) * 6, 9);
    expect(createCatalogItemSource(SLOT_NUT_FAMILY, row).options).toEqual({ family: 'slot-nut-specified', item: 'specified', ...NUT });
  });

  it('形が成り立たない組は作らない', () => {
    const cases: readonly (readonly [CatalogFamily, Readonly<Record<string, string>>, readonly Readonly<Record<string, string>>[]])[] = [
      [ANGLE_BRACKET_FAMILY, BRACKET, [{ thickness: '40' }, { holeDiameter: '20' }, { holePosition: '16' }, { holePosition: '38' },
        { rib: '-1' }, { legB: 'abc' }, { bracketWidth: '0' }]],
      [JOIN_PLATE_FAMILY, PLATE, [{ holeCount: '1.5' }, { holeCount: '0' }, { holePitch: '5' }, { holePitch: '80' },
        { holeDiameter: '20' }, { thickness: '0' }]],
      [SLOT_NUT_FAMILY, NUT, [{ neckWidth: '16' }, { thread: 'M8', neckWidth: '6' }, { nutLength: '3' }, { neckHeight: '-2' }]],
    ];
    for (const [family, defaults, bads] of cases) {
      const row = rowOf(family);
      for (const bad of bads) {
        const values = { ...defaults, ...bad };
        expect(family.build(row, values)).toBeNull();
        expect(family.nominalVolume(row, values)).toBeNull();
      }
    }
  });
});
