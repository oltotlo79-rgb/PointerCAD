/**
 * 規格部品の選ぶ窓の検索(K-07a)の並びと照合と、選び直した後の窓の値。並びは製品の表(今の 8 分類・鋼材・登録口の族)から作る。
 */
import { ALL_STEEL_PRODUCTS, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { familyPickerCategory, listedRows } from './catalogFamilyChoices.js';
import {
  defaultLengthSource, pickerJumpState, pickerSearchEntries, recentPartOf, searchPickerEntries, STANDARD_PART_CATEGORY_LABELS, standardPlacedTarget,
} from './catalogSearch.js';
import { STANDARD_PART_CATEGORIES, standardPartChoices, structuralPartChoices } from './standardPartPicker.js';

const search = (query: string, limit?: number) => searchPickerEntries(pickerSearchEntries(), query, limit);
const m10Bolt = (series: 'annexJA' | 'main') => standardPartChoices('hexBolt', series).find((choice) => choice.size === 'M10');

describe('検索の並びと照合', () => {
  it('今の 8 分類の名前の鍵を全部持つ', () => {
    expect(Object.keys(STANDARD_PART_CATEGORY_LABELS).sort()).toEqual([...STANDARD_PART_CATEGORIES].sort());
  });

  it('言葉を全部含む行だけを返し、言葉と同じ呼びの行を先に、あとは並びの順(六角ボルトの附属書JA の M10 が 1 件目)', () => {
    const found = search('六角ボルト M10');
    const annex = m10Bolt('annexJA'), main = m10Bolt('main');
    expect(annex).toBeDefined();
    expect(found.entries[0]?.target).toEqual({ kind: 'standard', category: 'hexBolt', choiceKey: annex?.key, dimensionSeries: 'annexJA', lengthSource: null });
    expect(found.entries[1]?.target).toEqual({ kind: 'standard', category: 'hexBolt', choiceKey: main?.key, dimensionSeries: 'main', lengthSource: null });
    expect(found.entries[0]?.label).toBe(`${t('assembly.standardPart.hexBolt')} M10`);
    expect(found.entries[0]?.detail).toBe(t('assembly.standardPart.dimensionSeries.annexJA'));
    for (const candidate of found.entries) {
      expect(candidate.text).toContain('六角ボルト');
      expect(candidate.text).toContain('m10');
    }
    expect(found.entries.every((candidate) => !candidate.text.includes('六角穴付きボルト'))).toBe(true);
  });

  it('全角と半角・大文字と小文字・続く空白・「×」と「x」を揃えて比べる', () => {
    expect(search('Ｍ１０　　六角ボルト').entries[0]?.target).toEqual(search('六角ボルト m10').entries[0]?.target);
    const flat = ALL_STEEL_PRODUCTS.find((row) => row.key === 'SS400:flatBar:FB 100×28');
    expect(flat).toBeDefined();
    const found = search('fb 100x28 ss400');
    expect(found.entries.map((candidate) => candidate.target)).toContainEqual(
      { kind: 'steel', material: 'SS400', shape: 'flatBar', choiceKey: 'steel:SS400:flatBar:FB 100×28', lengthSource: null });
  });

  it('鋼種を持たない今までの形鋼の行は、鋼種未指定として選び直す', () => {
    const legacy = structuralPartChoices('unspecified')[0];
    const found = search(`鋼種未指定 ${legacy.size}`);
    expect(found.entries.map((candidate) => candidate.target)).toContainEqual(
      { kind: 'steel', material: 'unspecified', shape: null, choiceKey: legacy.key, lengthSource: null });
  });

  it('言葉が無い・空白だけの時は空。上限を超えた分は数だけ返す', () => {
    expect(search('')).toEqual({ entries: [], more: 0 });
    expect(search('   ')).toEqual({ entries: [], more: 0 });
    const all = search('M', 100000);
    expect(all.more).toBe(0);
    const limited = search('M', 5);
    expect(limited.entries).toEqual(all.entries.slice(0, 5));
    expect(limited.more).toBe(all.entries.length - 5);
    expect(search('当てはまらない言葉 zzz')).toEqual({ entries: [], more: 0 });
  });

  it('族の行は族の表を読んだ後だけ並び、選ぶと族の分類・族・行へ選び直す', async () => {
    const before = pickerSearchEntries();
    expect(search('カムフォロア').entries).toEqual([]);
    await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id));
    expect(pickerSearchEntries()).not.toBe(before);
    expect(pickerSearchEntries()).toBe(pickerSearchEntries());
    const family = PRODUCT_CATALOG_REGISTRY.loaded('cam-follower-stud-metric');
    expect(family).toBeDefined();
    const found = search('カムフォロア');
    expect(found.entries.length).toBeGreaterThan(1);
    expect(found.entries[0]?.target).toEqual({ kind: 'family', group: 'mechanical',
      start: { familyId: 'cam-follower-stud-metric', material: '', itemKey: family?.rows[0]?.key, values: {} } });
    expect(found.entries[0]?.label.startsWith(t('catalog.mechanical.kind.camFollower'))).toBe(true);
  });

  it('選ぶ窓に出さない行(listed: false)は検索の行と呼びの欄の行に無く、代わりに出す行は同じ族の出す行で同じ呼び。前の呼びは今の呼びと違う', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id));
    const keys = new Set(pickerSearchEntries().map((candidate) => candidate.key));
    let unlisted = 0;
    for (const familyEntry of PRODUCT_CATALOG_REGISTRY.entries) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(familyEntry.id);
      if (family === undefined) throw new Error(`族 ${familyEntry.id} を読めない`);
      const searchable = familyPickerCategory(family.group) !== null;
      for (const row of family.rows) {
        const listed = row.listed !== false;
        expect([keys.has(`${family.id}|${row.key}`), listedRows(family).includes(row)], `${family.id}|${row.key}`).toEqual([searchable && listed, listed]);
        if (row.listedAs !== undefined) {
          const shown = family.rows.find((candidate) => candidate.key === row.listedAs);
          expect([row.listed, shown?.listed, shown?.size], row.key).toEqual([false, undefined, row.size]);
        }
        expect(row.formerSizes ?? [], row.key).not.toContain(row.size);
        if (!listed) unlisted += 1;
      }
    }
    expect(unlisted).toBeGreaterThan(0);
  });
});

describe('選び直した後の窓の値', () => {
  const current: Parameters<typeof pickerJumpState>[1] = { category: 'hexNut', choiceKey: 'hexNut:x', lengthSource: '45', dimensionSeries: 'annexJA' };

  it('分類が替わる時だけ長さの欄を初めの値に戻し、寸法系は行の物にする', () => {
    expect(pickerJumpState({ kind: 'standard', category: 'hexBolt', choiceKey: 'hexBolt:y', dimensionSeries: 'main', lengthSource: null }, current))
      .toEqual({ category: 'hexBolt', choiceKey: 'hexBolt:y', lengthSource: '30', dimensionSeries: 'main', steel: null, family: null });
    expect(pickerJumpState({ kind: 'standard', category: 'hexNut', choiceKey: 'hexNut:z', dimensionSeries: null, lengthSource: null }, current))
      .toEqual({ ...current, choiceKey: 'hexNut:z', steel: null, family: null });
  });

  it('鋼材は形鋼の分類・長さ 1000 と材質・断面、族は族の分類と族の窓の初めの値(呼びの鍵は今のまま)', () => {
    expect(pickerJumpState({ kind: 'steel', material: 'SS400', shape: 'flatBar', choiceKey: 'steel:k', lengthSource: null }, current)).toEqual({
      category: 'structuralSection', choiceKey: 'steel:k', lengthSource: '1000', dimensionSeries: 'annexJA',
      steel: { material: 'SS400', shape: 'flatBar' }, family: null });
    const start = { familyId: 'f', material: '', itemKey: 'r', values: { length: '500' } };
    expect(pickerJumpState({ kind: 'family', group: 'mechanical', start }, current))
      .toEqual({ ...current, category: 'mechanical', lengthSource: '30', steel: null, family: start });
    expect(defaultLengthSource('structuralSection')).toBe('1000');
    expect(defaultLengthSource('aluminumFrame')).toBe('30');
  });

  it('最近使った物の長さの欄の値は、分類が替わってもその値を戻す(K-07b)', () => {
    expect(pickerJumpState({ kind: 'steel', material: 'SS400', shape: 'flatBar', choiceKey: 'steel:k', lengthSource: '2400' }, current).lengthSource)
      .toBe('2400');
    expect(pickerJumpState({ kind: 'standard', category: 'hexNut', choiceKey: 'hexNut:z', dimensionSeries: null, lengthSource: '12' }, current)
      .lengthSource).toBe('12');
  });
});

describe('最近使った物の 1 件(K-07b)', () => {
  it('置けた物の選び直す先を、窓の値から作る(寸法系は寸法系を選べる分類だけ、鋼種未指定の行は断面を持たない)', () => {
    const steel: Parameters<typeof standardPlacedTarget>[3] = { material: 'SS400', shape: 'flatBar' };
    expect(standardPlacedTarget('hexBolt', 'hexBolt:k', 'main', steel, '30'))
      .toEqual({ kind: 'standard', category: 'hexBolt', choiceKey: 'hexBolt:k', dimensionSeries: 'main', lengthSource: '30' });
    expect(standardPlacedTarget('plainWasher', 'plainWasher:k', 'main', steel, '30'))
      .toEqual({ kind: 'standard', category: 'plainWasher', choiceKey: 'plainWasher:k', dimensionSeries: null, lengthSource: '30' });
    expect(standardPlacedTarget('structuralSection', 'steel:k', 'annexJA', steel, '1500'))
      .toEqual({ kind: 'steel', material: 'SS400', shape: 'flatBar', choiceKey: 'steel:k', lengthSource: '1500' });
    expect(standardPlacedTarget('structuralSection', 'equalAngle:k', 'annexJA', { material: 'unspecified', shape: 'flatBar' }, '1500'))
      .toEqual({ kind: 'steel', material: 'unspecified', shape: null, choiceKey: 'equalAngle:k', lengthSource: '1500' });
  });

  it('検索の行と同じ名前と添え書きを持ち、選び直す先は置いた時の値のまま。並びに無い物は null', () => {
    const annex = m10Bolt('annexJA');
    if (annex === undefined) throw new Error('M10 の六角ボルトの行がありません。');
    const target = standardPlacedTarget('hexBolt', annex.key, 'annexJA', { material: 'SS400', shape: null }, '45');
    const part = recentPartOf(target);
    const row = search('六角ボルト M10').entries[0];
    expect(part).toEqual({ key: row?.key, label: row?.label, detail: row?.detail, target });
    expect(recentPartOf({ kind: 'standard', category: 'hexBolt', choiceKey: 'hexBolt:無い行', dimensionSeries: 'annexJA', lengthSource: null })).toBeNull();
    expect(recentPartOf({ kind: 'family', group: 'mechanical', start: { familyId: '無い族', material: '', itemKey: 'x', values: {} } })).toBeNull();
  });
});
