/**
 * K-28 束 2: 鋼製管フランジ(JIS B 2220)の 5K・10K の族を、照らす側の読み(pipeFlangeOracle.fixture.json。別の発行元のねじ込み式フランジ
 * 5KF・10KF の表。接合の寸法は同じ)と突き合わせ、中心の穴が合う管(JIS G 3452)の外径である事、形と体積を確かめる。
 * 資料の番号・URL・発行元は担当の資料の記録だけに置く。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ALL_STEEL_PRODUCTS } from '../../standard/steelCatalog.js';
import { PIPE_FLANGE_FAMILIES } from './pipeFlanges.js';

type Cells = readonly string[];
interface Table { readonly columns: Cells; readonly rows: readonly Cells[] }
interface Fixture { readonly '5K': Table; readonly '10K': Table }

const isCells = (value: unknown): value is Cells => Array.isArray(value) && value.every((cell: unknown) => typeof cell === 'string');
const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && 'columns' in value && 'rows' in value
  && isCells(value.columns) && Array.isArray(value.rows) && value.rows.every(isCells);

function readFixture(): Fixture {
  const value: unknown = JSON.parse(readFileSync(new URL('./pipeFlangeOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('5K' in value) || !('10K' in value) || !isTable(value['5K']) || !isTable(value['10K'])) {
    throw new Error('fixture の形が違う');
  }
  return { '5K': value['5K'], '10K': value['10K'] };
}

const FIXTURE = readFixture();
const GRADES = [['5k', '5K'], ['10k', '10K']] as const;
const KEYS = ['outerDiameter', 'thickness', 'raisedFaceHeight', 'raisedFaceDiameter', 'boltCircleDiameter', 'holeCount', 'holeDiameter', 'boltDiameter'];

describe('K-28 束 2 の鋼製管フランジの族と 2 つ目の出どころ', () => {
  it.each(GRADES)('%s は 15A〜150A の 11 行で、外径・厚さ・座・中心円・穴の数と径・ボルトの呼びが照らす側と一致する', (grade, label) => {
    const family = PIPE_FLANGE_FAMILIES[grade];
    const expected = FIXTURE[label].rows;
    expect(family.rows).toHaveLength(11);
    expect(family.rows.map((row) => row.size)).toEqual(expected.map(([a]) => `${a ?? ''}A`));
    expect(family.rows.map((row) => KEYS.map((key) => row.dims[key])))
      .toEqual(expected.map(([, ...cells]) => cells.map((cell) => Number(cell.replace(/^M/u, '')))));
  });

  it.each(GRADES)('%s の中心の穴は合う管(JIS G 3452 の黒管)の外径、出どころは JIS の番号だけ、形は簡略で体積は台本の式', (grade, label) => {
    const family = PIPE_FLANGE_FAMILIES[grade];
    expect([family.id, family.group, family.catalogRevision, family.generatorRevision, family.stock, family.kindKey])
      .toEqual([`pipe-flange-${grade}`, 'piping', `pipe-flange-${grade}-2026-11-r1`, 'pipe-flange-1', 'count', `catalog.piping.kind.flange${label}`]);
    for (const row of family.rows) {
      const pipe = ALL_STEEL_PRODUCTS.find((product) => product.key === `SGP:steelPipe:${row.size}`);
      expect(pipe?.dimensions?.outsideDiameter).toBeDefined();
      expect(row.dims.boreDiameter).toBe(pipe?.dimensions?.outsideDiameter);
      expect([row.evidence.reference, row.standardLabel, row.densityMaterialId]).toEqual(['JIS B 2220', 'JIS B 2220', undefined]);
      expect([row.evidence.title, row.evidence.locator].every((text) => !text.includes('資料'))).toBe(true);
      expect(row.simplified?.[0]).toBe('中心の穴は合う管(JIS G 3452)の外径。差込みの隙間は作っていない(隙間の寸法は資料に無い)');
      const part = family.build(row, {});
      expect(part?.name).toBe(`フランジ ${label} ${row.size}`);
      expect(part?.solids.length).toBe(3 + 2 * (row.dims.holeCount ?? NaN));
      const area = (diameter: number): number => Math.PI * (diameter / 2) ** 2;
      const { outerDiameter = NaN, boreDiameter = NaN, holeDiameter = NaN, holeCount = NaN, thickness = NaN } = row.dims;
      expect(family.nominalVolume(row, {})).toBeCloseTo((area(outerDiameter) - area(boreDiameter) - holeCount * area(holeDiameter)) * thickness, 6);
    }
  });
});
