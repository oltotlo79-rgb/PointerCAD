// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-09 平行ピン JIS B 1354:2012 の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の parallelPin)の突合せ、長さの指定の範囲、
 * 形と体積、保存の形の検査。長さは資料に一覧が無いので式で入れる(規格の呼び長さとして名乗らない)。
 */
import { describe, expect, it } from 'vitest';

import { createCatalogRegistry } from '../registry.js';
import { buildCatalogItemPart, catalogItemRejection, createCatalogItemSource } from '../source.js';
import type { CatalogItemRow } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { PARALLEL_PIN_FAMILY } from './parallelPin.js';

const firstEvidence = (rows: readonly CatalogItemRow[]): CatalogItemRow['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const PARALLEL_PIN_ORACLE = CATALOG_ORACLES.parallelPin;
const PARALLEL_PIN_ROWS = PARALLEL_PIN_FAMILY.rows;
const PARALLEL_PIN_EVIDENCE = firstEvidence(PARALLEL_PIN_ROWS);

async function pinRegistry() {
  const registry = createCatalogRegistry([{ id: PARALLEL_PIN_FAMILY.id, group: PARALLEL_PIN_FAMILY.group,
    kindKey: PARALLEL_PIN_FAMILY.kindKey, load: () => Promise.resolve(PARALLEL_PIN_FAMILY) }]);
  await registry.ensure([PARALLEL_PIN_FAMILY.id]);
  return registry;
}

describe('M-09 平行ピン 資料の表との突合せ', () => {
  it('2012 年の表の 20 種の呼び径と面取り c が、材料ごとの行(鋼・ステンレス鋼 A1)と一致する', () => {
    expect(PARALLEL_PIN_ORACLE.rows).toHaveLength(20);
    expect(PARALLEL_PIN_ROWS).toHaveLength(40);
    for (const material of ['鋼', 'ステンレス鋼 A1']) {
      const rows = PARALLEL_PIN_ROWS.filter((row) => row.materialLabel === material);
      expect(rows.map((row) => [row.dims.diameter, row.dims.chamfer]))
        .toEqual(PARALLEL_PIN_ORACLE.rows.map(([d, c]) => [Number(d), Number(c)]));
    }
    expect(new Set(PARALLEL_PIN_ROWS.map((row) => row.densityMaterialId))).toEqual(new Set(['steel', 'stainless']));
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、行の鍵は材料の記号と呼び径で重ならない', () => {
    expect(PARALLEL_PIN_EVIDENCE.reference).toBe(PARALLEL_PIN_ORACLE.reference);
    expect(PARALLEL_PIN_EVIDENCE.title.startsWith('資料 K4-4 ')).toBe(true);
    expect(PARALLEL_PIN_EVIDENCE).not.toHaveProperty('url');
    const keys = PARALLEL_PIN_ROWS.map((row) => row.key);
    expect(new Set(keys).size).toBe(40);
    for (const row of PARALLEL_PIN_ROWS) {
      expect(row.key).toMatch(/^(St|A1)-d[0-9.]+$/u);
      expect(row.size).toBe(String(row.dims.diameter));
      expect(row.standardLabel).toBe('JIS B 1354:2012');
    }
  });

  it('族の版と長さの指定を凍結する(長さは式、資料に長さの範囲が無いので上限を置かない、既定 20)', () => {
    expect([PARALLEL_PIN_FAMILY.id, PARALLEL_PIN_FAMILY.catalogRevision, PARALLEL_PIN_FAMILY.generatorRevision])
      .toEqual(['parallel-pin', 'parallel-pin-2026-11-r1', 'pin-1']);
    expect(PARALLEL_PIN_FAMILY.options).toEqual([{ key: 'length', kind: 'lengthExpression',
      labelKey: 'catalog.mechanical.length', defaultValue: '20' }]);
    // 既定の長さ 20 は、どの呼び径でも両端の面取り 2c(最大は呼び径 50 の 16)を超える。
    expect(PARALLEL_PIN_ROWS.every((row) => 20 > 2 * (row.dims.chamfer ?? Infinity))).toBe(true);
  });

  it('長さの式で組め、体積は π(d/2)²L、名前は 呼び径×長さ(材料)', async () => {
    const registry = await pinRegistry();
    const row = PARALLEL_PIN_ROWS.find((candidate) => candidate.key === 'St-d6');
    if (row === undefined) throw new Error('St-d6');
    const source = createCatalogItemSource(PARALLEL_PIN_FAMILY, row, { length: '10*2' });
    expect(source.options).toEqual({ family: 'parallel-pin', item: 'St-d6', length: '10*2' });
    expect(catalogItemRejection(source, registry)).toBeNull();
    const part = buildCatalogItemPart(source, registry);
    expect(part?.name).toBe('平行ピン 6×10*2（鋼）');
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive']);
    expect(PARALLEL_PIN_FAMILY.nominalVolume(row, { length: '20' })).toBeCloseTo(Math.PI * 9 * 20, 9);
  });

  it('正でない・数で読めない長さは、組まずに型付きの拒否になる', async () => {
    const registry = await pinRegistry();
    const row = PARALLEL_PIN_ROWS[0];
    for (const length of ['0', '-5', 'abc']) {
      const source = createCatalogItemSource(PARALLEL_PIN_FAMILY, row, { length });
      expect(catalogItemRejection(source, registry)?.code, length).toBe('invalid-option-value');
      expect(buildCatalogItemPart(source, registry), length).toBeNull();
    }
  });

  it('両端の面取り 2c 以下の長さは、ピンとして形が成り立たないので組まない(上限は置かない)', async () => {
    const registry = await pinRegistry();
    for (const [key, tooShort, enough] of [['St-d0.6', '0.24', '0.25'], ['St-d6', '2.4', '2.5'], ['A1-d50', '16', '16.5']] as const) {
      const row = PARALLEL_PIN_ROWS.find((candidate) => candidate.key === key);
      if (row === undefined) throw new Error(key);
      const short = createCatalogItemSource(PARALLEL_PIN_FAMILY, row, { length: tooShort });
      expect(buildCatalogItemPart(short, registry), key).toBeNull();
      expect(PARALLEL_PIN_FAMILY.nominalVolume(row, { length: tooShort }), key).toBeNull();
      expect(buildCatalogItemPart(createCatalogItemSource(PARALLEL_PIN_FAMILY, row, { length: enough }), registry), key).not.toBeNull();
    }
    const long = createCatalogItemSource(PARALLEL_PIN_FAMILY, PARALLEL_PIN_ROWS[0], { length: '100000' });
    expect(catalogItemRejection(long, registry)).toBeNull();
    expect(buildCatalogItemPart(long, registry)).not.toBeNull();
  });
});
