// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-15 両角平行キー(JIS B 1301-1996 新 JIS)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の parallelKey)の
 * 突合せ、長さの決まりと形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { PARALLEL_KEY_FAMILY } from './parallelKey.js';

const ORACLE = CATALOG_ORACLES.parallelKey;
const ROWS = PARALLEL_KEY_FAMILY.rows;

describe('M-15 両角平行キー 資料の表との突合せ', () => {
  it('資料の 32 行と製品の 32 行は、呼び(b×h)も b・h も一致する', () => {
    expect(ORACLE.rows).toHaveLength(32);
    expect(ROWS.map((row) => [row.size, row.dims.width, row.dims.height]))
      .toEqual(ORACLE.rows.map(([size, b, h]) => [size, Number(b), Number(h)]));
    for (const row of ROWS) expect(row.key).toBe(row.size.replace('×', 'x'));
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版と長さの指定を凍結し、形は直方体で体積は b × h × ℓ', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.reference).toBe(ORACLE.reference);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-7 ')).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    expect([PARALLEL_KEY_FAMILY.id, PARALLEL_KEY_FAMILY.catalogRevision, PARALLEL_KEY_FAMILY.generatorRevision])
      .toEqual(['parallel-key-square', 'parallel-key-2026-11-r1', 'key-1']);
    expect(PARALLEL_KEY_FAMILY.options).toEqual([{ key: 'length', kind: 'lengthExpression', labelKey: 'catalog.mechanical.length',
      defaultValue: '20' }]);
    for (const row of ROWS) {
      const part = PARALLEL_KEY_FAMILY.build(row, { length: '5*6' });
      expect(part?.name).toBe(`平行キー 両角 ${row.size}×5*6`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive']);
      const { width: b, height: h } = row.dims;
      expect(PARALLEL_KEY_FAMILY.nominalVolume(row, { length: '30' })).toBeCloseTo(b * h * 30, 9);
      expect(PARALLEL_KEY_FAMILY.build(row, { length: '0' })).toBeNull();
    }
  });
});
