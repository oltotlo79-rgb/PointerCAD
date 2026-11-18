/**
 * 規格部品の選ぶ窓の「最近使った物」(K-07b): 置けた物を新しい順に 8 件まで覚え、同じ行は前の物を消して新しい指定の値にし、
 * 検索の並びに無い物は覚えない事。アプリを閉じるまでの物なので、この検査のファイルの中では前の検査の分が残る(順に確かめる)。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { standardPlacedTarget, type RecentPart } from './catalogSearch.js';
import { rememberPlacedPart, useRecentParts } from './recentStandardParts.js';
import { standardPartChoices } from './standardPartPicker.js';

function readRecent(): readonly RecentPart[] {
  let read: readonly RecentPart[] = [];
  function Probe(): null { read = useRecentParts(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return read;
}

const steel: Parameters<typeof standardPlacedTarget>[3] = { material: 'SS400', shape: null };
const washers = standardPartChoices('plainWasher');
const placed = (index: number, length = '30') => standardPlacedTarget('plainWasher', washers[index]?.key ?? '', 'annexJA', steel, length);

describe('最近使った物', () => {
  it('初めは空。置けた物を新しい順に覚え、同じ行は前の物を消して新しい長さにする', () => {
    expect(readRecent()).toEqual([]);
    rememberPlacedPart(placed(0));
    rememberPlacedPart(placed(1));
    rememberPlacedPart(placed(0, '45'));
    const recent = readRecent();
    expect(recent.map((part) => part.target)).toEqual([placed(0, '45'), placed(1)]);
    expect(recent[0]?.label).toContain(washers[0]?.size);
  });

  it('検索の並びに無い物は覚えず、9 件目からは古い物を落として 8 件にする', () => {
    const before = readRecent();
    rememberPlacedPart({ kind: 'standard', category: 'plainWasher', choiceKey: 'plainWasher:無い行', dimensionSeries: null, lengthSource: null });
    expect(readRecent()).toBe(before);
    expect(washers.length).toBeGreaterThanOrEqual(10);
    for (let index = 2; index < 10; index += 1) rememberPlacedPart(placed(index));
    const recent = readRecent();
    expect(recent).toHaveLength(8);
    expect(recent.map((part) => part.target)).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map((index) => placed(index)));
  });
});
