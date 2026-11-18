// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-30 オイルシール(寸法を指定して作る汎用の形): 規格の行を名乗らない事、指定の欄、形が成り立つ条件、形と体積、保存の形の検査。
 * 表を持たない族なので、照合の fixture は無い。
 */
import { describe, expect, it } from 'vitest';

import { createCatalogItemSource } from '../source.js';
import { OIL_SEAL_FAMILY } from './oilSeal.js';

const ROWS = OIL_SEAL_FAMILY.rows;
const DEFAULTS = { innerDiameter: '30', outerDiameter: '50', width: '10' };
const ring = (inner: number, outer: number, width: number): number => Math.PI * ((outer / 2) ** 2 - (inner / 2) ** 2) * width;

describe('M-30 オイルシール(寸法指定)', () => {
  it('族の版と指定の欄を凍結し、行は寸法指定の 1 行だけで、規格・資料の値を名乗らない', () => {
    expect([OIL_SEAL_FAMILY.id, OIL_SEAL_FAMILY.kindKey, OIL_SEAL_FAMILY.catalogRevision, OIL_SEAL_FAMILY.generatorRevision,
      OIL_SEAL_FAMILY.diagram]).toEqual(['oil-seal-specified', 'catalog.mechanical.kind.oilSeal', 'oil-seal-specified-2026-11-r1',
      'bush-1', 'sealRing']);
    expect(OIL_SEAL_FAMILY.options.map((spec) => [spec.key, spec.kind, spec.min, spec.max, spec.defaultValue])).toEqual([
      ['innerDiameter', 'lengthExpression', undefined, undefined, '30'], ['outerDiameter', 'lengthExpression', undefined, undefined, '50'],
      ['width', 'lengthExpression', undefined, undefined, '10']]);
    expect(ROWS.map((row) => [row.key, row.size, row.standardLabel, row.verification, row.verified, Object.keys(row.dims).length]))
      .toEqual([['specified', '寸法指定', '寸法指定(規格の行ではない)', 'unverified', false, 0]]);
    const evidence = ROWS[0]?.evidence;
    expect(evidence?.reference).toBe('');
    expect(evidence?.title).toContain('規格の値を使わない');
  });

  it('形は内径・外径・幅の輪で、体積は π/4 (D² − d²) b、名前に寸法を入れる', () => {
    const row = ROWS[0];
    if (row === undefined) throw new Error('row is missing');
    const part = OIL_SEAL_FAMILY.build(row, DEFAULTS);
    expect(part?.name).toBe('オイルシール(寸法指定) 内径30×外径50×幅10');
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
    expect(OIL_SEAL_FAMILY.nominalVolume(row, DEFAULTS)).toBeCloseTo(ring(30, 50, 10), 9);
    const values = { innerDiameter: '12.5', outerDiameter: '20*2', width: '7' };
    expect(OIL_SEAL_FAMILY.nominalVolume(row, values)).toBeCloseTo(ring(12.5, 40, 7), 9);
    expect(createCatalogItemSource(OIL_SEAL_FAMILY, row).options).toEqual({ family: 'oil-seal-specified', item: 'specified',
      ...DEFAULTS });
  });

  it('内径が外径以上、どれかが 0 以下、式として読めない値は作らない', () => {
    const row = ROWS[0];
    if (row === undefined) throw new Error('row is missing');
    const bads: readonly Readonly<Record<string, string>>[] = [{ innerDiameter: '50' }, { innerDiameter: '60' }, { width: '0' },
      { outerDiameter: '-5' }, { width: 'abc' }];
    for (const bad of bads) {
      const values = { ...DEFAULTS, ...bad };
      expect(OIL_SEAL_FAMILY.build(row, values)).toBeNull();
      expect(OIL_SEAL_FAMILY.nominalVolume(row, values)).toBeNull();
    }
  });
});
