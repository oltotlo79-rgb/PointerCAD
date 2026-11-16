/**
 * 資料 SF-1 のフレームの族(溝幅ごとの 3 族・形材の 5 族)の、選ぶ画面の行の文字と説明の 1 行。
 * 寸法の線図はまだ描かない(後の包み)ので、足した線図の種類 flatBar・roundBar は図なしの扱い(行の文字は呼び、説明は長さの欄の 1 行)になる事を確かめる。
 */
import { PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { catalogFamilyEntries, catalogRowLabel, familyHintKey, familyKindKey } from './catalogFamilyChoices.js';

const T_SLOT = ['t-slot-frame-s6', 't-slot-frame-s8', 't-slot-frame-s10'];
const SECTIONS = ['aluminum-channel', 'aluminum-square-pipe', 'aluminum-round-bar', 'aluminum-flat-bar', 'aluminum-angle'];

describe('資料 SF-1 のフレームの族の選ぶ画面の文字', () => {
  it('8 族はアルミフレームの分類に並び、種類の名前は i18n にあり、内部の鍵を出さない', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure([...T_SLOT, ...SECTIONS]);
    const entries = catalogFamilyEntries('aluminumFrame').filter((entry) => [...T_SLOT, ...SECTIONS].includes(entry.id));
    expect(entries.map((entry) => entry.id)).toEqual([...T_SLOT, ...SECTIONS]);
    for (const entry of entries) {
      expect(familyKindKey(entry.kindKey)).toBe(entry.kindKey);
      expect(t(familyKindKey(entry.kindKey))).not.toBe(entry.kindKey);
    }
  });

  it('溝つきの行は呼び・溝の口・中の幅・単位質量を出し、説明は製造元の寸法に合わせた系列の 1 行', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(T_SLOT);
    for (const id of T_SLOT) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe('catalog.frame.series.hint');
      for (const row of family.rows) {
        expect(catalogRowLabel(family, row)).toBe(t('catalog.frame.row.series').replace('{size}', row.size)
          .replace('{opening}', String(row.dims.slotOpening)).replace('{inner}', String(row.dims.slotInnerWidth))
          .replace('{mass}', String(row.dims.unitMassKgPerM)));
      }
    }
  });

  it('形材の行は呼びだけを出し(線図の種類 flatBar・roundBar も図なしで落ちない)、説明は長さを自由に入れる 1 行', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(SECTIONS);
    for (const id of SECTIONS) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe('catalog.mechanical.freeLengthPlain');
      expect(family.rows.length).toBeGreaterThan(0);
      for (const row of family.rows) expect(catalogRowLabel(family, row)).toBe(row.size);
    }
    expect(SECTIONS.map((id) => PRODUCT_CATALOG_REGISTRY.loaded(id)?.diagram)).toEqual(['channel', 'rectTube', 'roundBar', 'flatBar', 'angle']);
  });
});
