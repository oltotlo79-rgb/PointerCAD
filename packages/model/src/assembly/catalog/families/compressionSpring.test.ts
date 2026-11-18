// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-16 圧縮コイルばね(寸法を指定して作る): 指定の範囲、形が成り立つ条件、形(今のばねのフィーチャー)と体積、保存の形の検査。
 * 表を持たない族なので、照合の fixture は無い(設計 §5.9「ばねは形の検査と範囲の外の拒否の検査にする」)。
 */
import { describe, expect, it } from 'vitest';

import type { SpringFeature } from '../../../part/types.js';
import { createCatalogRegistry } from '../registry.js';
import { buildCatalogItemPart, catalogItemRejection, createCatalogItemSource } from '../source.js';
import { compressionSpringHelix } from '../profiles/spring.js';
import type { CatalogItemRow } from '../types.js';
import { COMPRESSION_SPRING_FAMILY } from './compressionSpring.js';

const firstEvidence = (rows: readonly CatalogItemRow[]): CatalogItemRow['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const COMPRESSION_SPRING_ROWS = COMPRESSION_SPRING_FAMILY.rows;
const COMPRESSION_SPRING_EVIDENCE = firstEvidence(COMPRESSION_SPRING_ROWS);

const DEFAULTS = { wireDiameter: '2', meanDiameter: '16', freeLength: '50', totalCoils: '8' };

async function springRegistry() {
  const registry = createCatalogRegistry([{ id: COMPRESSION_SPRING_FAMILY.id, group: COMPRESSION_SPRING_FAMILY.group,
    kindKey: COMPRESSION_SPRING_FAMILY.kindKey, load: () => Promise.resolve(COMPRESSION_SPRING_FAMILY) }]);
  await registry.ensure([COMPRESSION_SPRING_FAMILY.id]);
  return registry;
}

describe('M-16 圧縮コイルばね', () => {
  it('族の版・行・指定の欄を凍結する(表を持たず、寸法は全て指定の値)', () => {
    expect([COMPRESSION_SPRING_FAMILY.id, COMPRESSION_SPRING_FAMILY.catalogRevision, COMPRESSION_SPRING_FAMILY.generatorRevision])
      .toEqual(['compression-spring', 'compression-spring-2026-11-r1', 'spring-1']);
    expect(COMPRESSION_SPRING_ROWS.map((row) => [row.key, row.size])).toEqual([['specified', '寸法指定']]);
    // 根拠の無い上限は置かない。総巻数だけ 1 以上(1 巻き未満はコイルにならない)。
    expect(COMPRESSION_SPRING_FAMILY.options.map((spec) => [spec.key, spec.kind, spec.min, spec.max, spec.defaultValue])).toEqual([
      ['wireDiameter', 'lengthExpression', undefined, undefined, '2'], ['meanDiameter', 'lengthExpression', undefined, undefined, '16'],
      ['freeLength', 'lengthExpression', undefined, undefined, '50'], ['totalCoils', 'numberExpression', 1, undefined, '8']]);
    expect(COMPRESSION_SPRING_EVIDENCE.title.startsWith('資料 K4-6 ')).toBe(true);
    expect(COMPRESSION_SPRING_EVIDENCE).not.toHaveProperty('url');
  });

  it('既定の寸法で組め、今のばねのフィーチャーの値は らせんの長さ L0 − d・ピッチ (L0 − d)/Nt・右巻き', async () => {
    const registry = await springRegistry();
    const source = createCatalogItemSource(COMPRESSION_SPRING_FAMILY, COMPRESSION_SPRING_ROWS[0]);
    expect(source.options).toEqual({ family: 'compression-spring', item: 'specified', ...DEFAULTS });
    expect(catalogItemRejection(source, registry)).toBeNull();
    const part = buildCatalogItemPart(source, registry);
    expect(part?.name).toBe('圧縮コイルばね 線径2×平均径16×自由長50×8巻');
    const spring = part?.solids.find((feature): feature is SpringFeature => feature.kind === 'spring');
    expect([spring?.length.value, spring?.pitch.value, spring?.turns.value, spring?.coilDiameter.value, spring?.wireDiameter.value])
      .toEqual([48, 6, 8, 16, 2]);
    expect([spring?.derived, spring?.handedness, spring?.axis]).toEqual(['pitch', 'right', { kind: 'world', axis: 'z' }]);
    // 体積 = 線の断面積 × 8 巻き × √((16π)² + 6²)。
    expect(COMPRESSION_SPRING_FAMILY.nominalVolume(COMPRESSION_SPRING_ROWS[0], DEFAULTS))
      .toBeCloseTo(Math.PI * 1 * 8 * Math.hypot(16 * Math.PI, 6), 9);
  });

  it('形が成り立たない組(線径 ≥ 平均径、ピッチ ≤ 線径)・正でない値・1 巻き未満は組まない', async () => {
    const registry = await springRegistry();
    expect(compressionSpringHelix({ wireDiameter: 16, meanDiameter: 16, freeLength: 50, totalCoils: 8 })).toBeNull();
    expect(compressionSpringHelix({ wireDiameter: 2, meanDiameter: 16, freeLength: 18, totalCoils: 8 })).toBeNull();
    expect(compressionSpringHelix({ wireDiameter: 2, meanDiameter: 16, freeLength: 19, totalCoils: 8 })).toEqual({ length: 17, pitch: 2.125 });
    const row = COMPRESSION_SPRING_ROWS[0];
    for (const values of [{ ...DEFAULTS, wireDiameter: '16' }, { ...DEFAULTS, freeLength: '18' }]) {
      const source = createCatalogItemSource(COMPRESSION_SPRING_FAMILY, row, values);
      expect(catalogItemRejection(source, registry)).toBeNull();
      expect(buildCatalogItemPart(source, registry)).toBeNull();
      expect(COMPRESSION_SPRING_FAMILY.nominalVolume(row, values)).toBeNull();
    }
    for (const values of [{ ...DEFAULTS, wireDiameter: '0' }, { ...DEFAULTS, totalCoils: '0.5' }, { ...DEFAULTS, meanDiameter: 'x' }]) {
      expect(catalogItemRejection(createCatalogItemSource(COMPRESSION_SPRING_FAMILY, row, values), registry)?.code)
        .toBe('invalid-option-value');
    }
  });
});
