// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-20 巻きブシュ(内径 3〜28)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の wrappedBush)の突合せ、
 * 寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogItemRow } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { WRAPPED_BUSH_FAMILY } from './wrappedBush.js';

const firstEvidence = (rows: readonly CatalogItemRow[]): CatalogItemRow['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const WRAPPED_BUSH_ORACLE = CATALOG_ORACLES.wrappedBush;
const WRAPPED_BUSH_ROWS = WRAPPED_BUSH_FAMILY.rows;
const WRAPPED_BUSH_EVIDENCE = firstEvidence(WRAPPED_BUSH_ROWS);

describe('M-20 巻きブシュ 資料の表との突合せ', () => {
  it('資料の 22 種の内径ごとに、外径・肉厚・作れる長さが製品の行と一致する(116 組)', () => {
    expect(WRAPPED_BUSH_ORACLE.rows).toHaveLength(22);
    expect(WRAPPED_BUSH_ROWS).toHaveLength(WRAPPED_BUSH_ORACLE.rows.reduce((sum, row) => sum + row[3].length, 0));
    expect(WRAPPED_BUSH_ROWS).toHaveLength(116);
    for (const [d, D, wall, lengths] of WRAPPED_BUSH_ORACLE.rows) {
      const rows = WRAPPED_BUSH_ROWS.filter((row) => row.dims.innerDiameter === d);
      expect(rows.map((row) => row.dims.length)).toEqual([...lengths]);
      expect(rows.every((row) => row.dims.outerDiameter === D && row.dims.wallThickness === Number(wall))).toBe(true);
    }
    expect(new Set(WRAPPED_BUSH_ROWS.map((row) => row.dims.innerDiameter)).size).toBe(22);
  });

  it('外径は 内径 + 2 × 肉厚(資料の 3 つの欄が互いに合う)', () => {
    for (const row of WRAPPED_BUSH_ROWS) {
      expect(row.dims.outerDiameter).toBe(row.dims.innerDiameter + 2 * row.dims.wallThickness);
    }
  });

  it('出どころは資料の 資料の番号 と頁を持ち、全ての行が同じ出どころを指す', () => {
    expect(WRAPPED_BUSH_EVIDENCE.reference).toBe(WRAPPED_BUSH_ORACLE.reference);
    expect(WRAPPED_BUSH_EVIDENCE.locator).toContain(`PDF ${WRAPPED_BUSH_ORACLE.page} 頁`);
    // 出どころの欄は資料の番号・SHA・頁だけ(URL と発行元は製品に書かない)。
    expect(WRAPPED_BUSH_EVIDENCE.title.startsWith('資料 K4-3 ')).toBe(true);
    expect(WRAPPED_BUSH_EVIDENCE).not.toHaveProperty('url');
    expect(WRAPPED_BUSH_ROWS.every((row) => row.evidence === WRAPPED_BUSH_EVIDENCE
      && row.verification === 'manufacturer-catalog' && row.verified && row.note === '')).toBe(true);
  });

  it('行の鍵は内径と長さ、呼びは 内径×外径×長さ で表し(系列名を持たない)、重ならない', () => {
    const keys = WRAPPED_BUSH_ROWS.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 4)).toEqual(['d3-L3', 'd3-L4', 'd3-L5', 'd3-L6']);
    const row = WRAPPED_BUSH_ROWS.find((candidate) => candidate.key === 'd15-L8');
    expect(row?.size).toBe('15×17×8');
    for (const item of WRAPPED_BUSH_ROWS) {
      expect(item.key).toMatch(/^d[0-9]+-L[0-9]+$/u);
      expect(item.size).toMatch(/^[0-9]+×[0-9]+×[0-9]+$/u);
      expect(WRAPPED_BUSH_FAMILY.partName(item, {})).toMatch(/^巻きブシュ 内径[0-9]+×外径[0-9]+×長さ[0-9]+$/u);
    }
    expect(row === undefined ? '' : WRAPPED_BUSH_FAMILY.partName(row, {})).toBe('巻きブシュ 内径15×外径17×長さ8');
  });

  it('族の版の文字列と指定を凍結する(保存されるので版の中で変えない)', () => {
    expect([WRAPPED_BUSH_FAMILY.id, WRAPPED_BUSH_FAMILY.catalogRevision, WRAPPED_BUSH_FAMILY.generatorRevision])
      .toEqual(['wrapped-bush', 'wrapped-bush-2026-11-r1', 'bush-1']);
    expect(WRAPPED_BUSH_FAMILY.options).toEqual([]);
    expect([WRAPPED_BUSH_FAMILY.group, WRAPPED_BUSH_FAMILY.stock, WRAPPED_BUSH_FAMILY.diagram])
      .toEqual(['mechanical', 'count', 'bush']);
  });

  it('形は管(外の円柱 − 内の円柱)で、体積は π/4 (D² − d²) L', () => {
    for (const row of WRAPPED_BUSH_ROWS) {
      const part = WRAPPED_BUSH_FAMILY.build(row, {});
      expect(part?.name).toBe(WRAPPED_BUSH_FAMILY.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      const { innerDiameter: d, outerDiameter: D, length: L } = row.dims;
      expect(WRAPPED_BUSH_FAMILY.nominalVolume(row, {})).toBeCloseTo(Math.PI / 4 * (D ** 2 - d ** 2) * L, 9);
    }
    // 内径 15・外径 17・長さ 8: π/4 (289 − 225) 8 = 128π。
    const row = WRAPPED_BUSH_ROWS.find((candidate) => candidate.key === 'd15-L8');
    expect(row === undefined ? null : WRAPPED_BUSH_FAMILY.nominalVolume(row, {})).toBeCloseTo(128 * Math.PI, 9);
  });
});
