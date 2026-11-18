/**
 * 規格部品の選ぶ窓の寸法の表(K-07c)の元: 名前と単位を決めた鍵だけを行の順で出し、印の数・番号つきの座標・系列の番号は出さない事。
 * 今の 8 分類は行の型の欄から同じ名前の表を作り、値の無い欄は出さない事。鋼材は dimensions を持つ行だけ表を出す事。
 * 族の行の要確認と簡略の印。線図を作る部品文書は、今の指定の値が通らない時に既定の値で作る事。
 */
import { HEX_BOLT_TABLE, HEX_NUT_TABLE, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { familyFigurePart, standardFigurePart } from './dimensionTable.js';
import { standardPartChoices, structuralPartChoices } from './standardPartPicker.js';

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id)); });

function loaded(id: string) {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
  if (family === undefined) throw new Error(`族が無い: ${id}`);
  return family;
}

/** 行の dims の鍵の並びの中で、expected がこの順に現れる事。 */
function inRowOrder(rowKeys: readonly string[], expected: readonly string[]): boolean {
  const positions = expected.map((key) => rowKeys.indexOf(key));
  return positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)));
}

describe('族の行の表', () => {
  it('名前の決まった鍵だけを行の順で出し、値は行のまま、単位は鍵ごと(mm・kg/m・mm²・cm⁴・cm³)', () => {
    const family = loaded('t-slot-frame-s6');
    const row = family.rows[0];
    const part = familyFigurePart(family, row, {});
    const keys = part.rows.map((item) => item.key);
    expect(keys).toEqual(['width', 'height', 'slotPitch', 'slotOpening', 'slotInnerWidth', 'slotDepth', 'centerHole', 'cornerRadius',
      'unitMassKgPerM', 'areaMm2', 'ixCm4', 'iyCm4', 'zxCm3', 'zyCm3'].filter((key) => key in row.dims));
    expect(inRowOrder(Object.keys(row.dims), keys)).toBe(true);
    for (const item of part.rows) expect(item.value).toBe(row.dims[item.key]);
    const unit = (key: string) => part.rows.find((item) => item.key === key)?.unit;
    expect([unit('width'), unit('unitMassKgPerM'), unit('areaMm2'), unit('ixCm4'), unit('zxCm3')]).toEqual(['mm', 'kg/m', 'mm²', 'cm⁴', 'cm³']);
  });

  it('印の数(車輪の止め・旋回・取付け)と系列の番号は出さず、質量は g、接触角は度', () => {
    const caster = familyFigurePart(loaded('t-slot-caster'), loaded('t-slot-caster').rows[0], {});
    const keys = caster.rows.map((item) => item.key);
    for (const flag of ['brake', 'swivel', 'mount', 'offset', 'series']) expect(keys).not.toContain(flag);
    expect(caster.rows.find((item) => item.key === 'massG')?.unit).toBe('g');
    const bearing = familyFigurePart(loaded('angular-contact-ball-bearing'), loaded('angular-contact-ball-bearing').rows[0], {});
    expect(bearing.rows.find((item) => item.key === 'contactAngle')?.unit).toBe('°');
  });

  it('全部の族の全部の行: 番号つきの座標・溝の印を出さず、値は有限、名前の文は i18n にある', () => {
    for (const entry of PRODUCT_CATALOG_REGISTRY.entries) {
      const family = loaded(entry.id);
      for (const row of family.rows) {
        for (const item of familyFigurePart(family, row, {}).rows) {
          expect(item.key, `${family.id}/${row.key}`).not.toMatch(/^(hole|slot)\d|^slots?(Across|Top|Bottom|Left|Right|Count)$|^slot$/u);
          expect(Number.isFinite(item.value), `${family.id}/${row.key}/${item.key}`).toBe(true);
          expect(t(item.label).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('要確認の行は理由、簡略の行は簡略にした所を印に出す。鍵は族・行・指定の値で決まる', () => {
    const seal = loaded('oil-seal-specified');
    const unverified = familyFigurePart(seal, seal.rows[0], {});
    expect(unverified.marks).toEqual([{ kind: 'unverified', parts: [seal.rows[0].note] }]);
    const nut = loaded('t-slot-nut');
    const row = nut.rows.find((candidate) => (candidate.simplified ?? []).length > 0);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(familyFigurePart(nut, row, {}).marks).toContainEqual({ kind: 'simplified', parts: row.simplified });
    expect(familyFigurePart(nut, row, {}).key).toBe(familyFigurePart(nut, row, {}).key);
    expect(familyFigurePart(nut, row, { length: '20' }).key).not.toBe(familyFigurePart(nut, row, {}).key);
  });

  it('線図の部品文書: 指定の値が通らない時(打ちかけの長さ)は既定の値で作る', () => {
    const frame = loaded('t-slot-frame-s6');
    expect(familyFigurePart(frame, frame.rows[0], { length: '-' }).build()).not.toBeNull();
    expect(familyFigurePart(frame, frame.rows[0], {}).build()).not.toBeNull();
  });
});

describe('今の 8 分類と鋼材の表', () => {
  it('六角ボルト: 行の型の欄を呼び径・ピッチ・二面幅・頭の高さ・ねじ部の長さの順に出す(印は窓が出すので無し)', () => {
    const choice = standardPartChoices('hexBolt', 'annexJA').find((candidate) => candidate.size === 'M8');
    const row = HEX_BOLT_TABLE.find((candidate) => candidate.dimensionSeries === 'annexJA' && candidate.size === 'M8');
    expect(choice).toBeDefined();
    expect(row).toBeDefined();
    if (choice === undefined || row === undefined) return;
    const part = standardFigurePart('hexBolt', choice, 'annexJA', 'coarse');
    expect(part.rows.map((item) => [item.key, item.value, item.unit])).toEqual([['nominalDiameter', row.d, 'mm'], ['pitch', row.pitch, 'mm'],
      ['acrossFlats', row.s, 'mm'], ['headHeight', row.k, 'mm'], ['threadLength', row.b1, 'mm']]);
    expect(part.marks).toEqual([]);
    expect(part.build()).not.toBeNull();
  });

  it('六角ナット: 下限の値が無い行は高さ(最小)を出さない', () => {
    for (const row of HEX_NUT_TABLE) {
      const choice = standardPartChoices('hexNut', row.dimensionSeries).find((candidate) => candidate.key === `hexNut:${row.key}`);
      expect(choice).toBeDefined();
      if (choice === undefined) continue;
      const keys = standardFigurePart('hexNut', choice, row.dimensionSeries, 'coarse').rows.map((item) => item.key);
      expect(keys.includes('heightMin')).toBe(row.mMin !== null);
    }
  });

  it('鋼材: 平鋼は幅と厚さ、形鋼(dimensions を持たない行)は表を出さない', () => {
    const flat = structuralPartChoices('SS400', 'flatBar').find((candidate) => candidate.size === 'FB 50×6');
    const angle = structuralPartChoices('SS400', 'equalAngle')[0];
    expect(flat).toBeDefined();
    if (flat === undefined) return;
    expect(standardFigurePart('structuralSection', flat, 'annexJA', 'coarse').rows.map((item) => [item.key, item.value]))
      .toEqual([['width', 50], ['thickness', 6]]);
    expect(standardFigurePart('structuralSection', angle, 'annexJA', 'coarse').rows).toEqual([]);
    expect(standardFigurePart('structuralSection', angle, 'annexJA', 'coarse').build()).not.toBeNull();
  });
});
