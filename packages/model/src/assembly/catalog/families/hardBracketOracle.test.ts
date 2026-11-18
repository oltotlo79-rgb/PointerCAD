/**
 * 資料 1 のリブつきの L 形のブラケットのうち、寝た脚の穴を作らない行(hardBracketRows.ts。統括の決定 2026-11-18 08:4x の (B))の検査。
 * 照らす側の読み(hardBracketOracle.fixture.json。2 つ目の組の、9 回目の記入のままの寸法・材質・質量と 10 回目の合う溝幅・寝た脚の穴の幅の中心線)を、
 * この検査が自分で読み解く(行の表を作る道具の読み解きと別にする): 脚の長さ・幅・寝た脚の厚さは外の面から外の面まで、立つ脚の穴の高さは
 * 寝た脚の下の面からの鎖の累積、幅の向きは立つ脚の幅の左の端の面からの鎖の累積(右の端の面に着く時は和が幅と合う)か、右の端の面からの全体 − 値。
 * あわせて、族の行としての形・体積・質量(資料の値が形 × 密度より軽い)・印・呼びを、製品の口(族の定数)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { angleBracketCatalogVolume } from '../profiles/framePartShapes.js';
import { ANGLE_BRACKET_CATALOG_FAMILY } from './framePartCatalog.js';
import { ANGLE_BRACKET_RECORDS } from './framePartRows.js';
import { HARD_BRACKET_RECORDS } from './hardBracketRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }
interface Dimension { readonly value: number; readonly start: string; readonly end: string }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./hardBracketOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const BOTTOM = ['寝た脚下面', '寝た脚底面'];
const TOP = ['立つ脚上端面', '立つ脚上端'];
const NO_HOLE_MARK = '寝た脚の穴(幅の向きの位置の記入が無いので作っていない)';
const THICK_MARK = '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った';

function cellsOf(key: string): Cells {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found.cells;
}

/** 「横:…/縦:…」の最初の向きの節(表の図)から、「数字(始まり〜終わり)」の寸法線。 */
function dimensionsOf(text: string | undefined, direction: '横' | '縦'): readonly Dimension[] {
  const section = (text ?? '').split('/').find((part) => part.startsWith(`${direction}:`)) ?? '';
  return [...section.matchAll(/([0-9]+(?:\.[0-9]+)?)\(([^()〜]*)〜([^()]*)\)/gu)].flatMap((match): Dimension[] => {
    const [, value, start, end] = match;
    return value === undefined || start === undefined || end === undefined ? [] : [{ value: Number(value), start, end }];
  });
}

const ends = (item: Dimension): readonly string[] => [item.start, item.end];
const single = (values: readonly number[]): number => (new Set(values).size === 1 ? values[0] ?? NaN : NaN);
/** 脚の名前の「立つ脚」「立つ脚の」を外した点の名前(2 度目の書き方で省く読みがある)。 */
const pointName = (name: string): string => name.replace(/^立つ脚の?/u, '');

/** 外の面 start から隣り合う点へ寸法線をたどった累積の位置。たどれる点は usable が真の物だけ。 */
function walk(items: readonly Dimension[], start: readonly string[], usable: (name: string) => boolean): number[] {
  const used = new Set<number>();
  const found: number[] = [];
  let current: string | null = null;
  let position = 0;
  for (;;) {
    const index = items.findIndex((item, at) => !used.has(at) && ends(item).some((here, side) => {
      const there = side === 0 ? item.end : item.start;
      return (current === null ? start.includes(here) : pointName(here) === pointName(current)) && usable(there);
    }));
    const item = items[index];
    if (item === undefined) return found;
    used.add(index);
    // 型を書く(current を次の回に入れ直すので、書かないと初期化の式から型が決まらない。TS7022)。
    const there: string = (current === null ? start.includes(item.start) : pointName(item.start) === pointName(current)) ? item.end : item.start;
    position += item.value;
    found.push(position);
    current = there;
  }
}

describe('資料 1 のリブつきの L 形のブラケットの、寝た脚の穴を作らない行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、溝幅・材質・質量・頁が照らす側と合い、寝た脚の幅の中心線は引かれていると読まれていない', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(HARD_BRACKET_RECORDS.map((record) => record.key));
    for (const record of HARD_BRACKET_RECORDS) {
      const cells = cellsOf(record.key);
      expect(JSON.stringify(cells), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      expect([record.slot, record.massG, record.page], record.key).toEqual([Number(cells['合う溝幅']),
        Number(/^([0-9.]+)g$/u.exec(cells['質量_g'] ?? '')?.[1] ?? NaN), Number(cells['PDF頁'])]);
      expect([record.material, cells['材質']?.includes('アルミ')], record.key).toEqual(['aluminum', true]);
      expect(cells['寝た脚の穴の幅の中心線'], record.key).not.toBe('引かれていて、寝た脚の幅の中心線');
      expect([record.alongA, record.acrossA, record.ribbed], record.key).toEqual([[], [], true]);
    }
  });

  it('2 つの脚の長さ・幅・寝た脚の厚さ・穴の径と、立つ脚の穴の高さと幅の向きの位置が、記入のままの寸法線から決まる値と合う', () => {
    for (const record of HARD_BRACKET_RECORDS) {
      const text = cellsOf(record.key)['記入のままの寸法'];
      const across = dimensionsOf(text, '横');
      const along = dimensionsOf(text, '縦');
      const plain = (item: Dimension): boolean => !/穴|突起|帯/u.test(item.start + item.end);
      const legB = (item: Dimension): boolean => ends(item).some((name) => BOTTOM.includes(name)) && ends(item).some((name) => TOP.includes(name));
      expect([
        single(across.filter((item) => plain(item) && ends(item).includes('立つ脚外面') && ends(item).some((name) => name.includes('寝た脚先')))
          .map((item) => item.value)),
        single(along.filter(legB).map((item) => item.value)),
        single(across.filter((item) => plain(item) && item.start.includes('左端') && item.end.includes('右端')).map((item) => item.value)),
        single(along.filter((item) => plain(item) && !legB(item) && /上面/u.test(item.start + item.end)
          && /(下|底)面/u.test((item.start + item.end).split('上面').join(''))).map((item) => item.value)),
        Number(/[0-9]+-φ([0-9.]+)\([^()]*穴/u.exec(text ?? '')?.[1] ?? NaN),
      ], record.key).toEqual([record.legA, record.legB, record.width, record.thickness, record.holeDiameter]);
      const alongB = walk(along, BOTTOM, (name) => name.includes('穴') && !/側面|抜き|寝た脚|突起/u.test(name));
      const widthItems = across.filter((item) => !/寝た脚|外面|突起|帯|側面/u.test(item.start + item.end));
      const left = widthItems.flatMap(ends).filter((name) => name.includes('左端') && !name.includes('穴'));
      const chain = walk(widthItems, left, (name) => name.includes('穴'));
      const toRight = widthItems.filter((item) => item.end.includes('右端') && item.start.includes('穴'));
      const acrossB = chain.length > 0 ? chain : toRight.map((item) => record.width - item.value);
      // 鎖の最後の穴から右の端の面までの寸法線があれば、和が幅と合う。
      const last = (chain[chain.length - 1] ?? NaN) + (toRight[toRight.length - 1]?.value ?? NaN);
      if (chain.length > 0 && toRight.length > 0) expect(last, record.key).toBe(record.width);
      expect([alongB, acrossB], record.key).toEqual([[...record.alongB], [...record.acrossB]]);
    }
  });

  it('族の行は両脚の穴の決まった行の後に並び、立つ脚の穴だけの形ができ、体積は L の断面 − 立つ脚の穴、質量は形 × 密度より軽い資料の値', () => {
    const tail = ANGLE_BRACKET_CATALOG_FAMILY.rows.slice(ANGLE_BRACKET_RECORDS.length);
    expect(tail.map((row) => row.key)).toEqual(HARD_BRACKET_RECORDS.map((record) => record.key));
    for (const record of HARD_BRACKET_RECORDS) {
      const row = tail.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      const holes = record.alongB.length * record.acrossB.length;
      const volume = (record.legA + record.legB - record.thickness) * record.thickness * record.width
        - holes * Math.PI * (record.holeDiameter / 2) ** 2 * record.thickness;
      expect([ANGLE_BRACKET_CATALOG_FAMILY.nominalVolume(row, {}) ?? NaN, angleBracketCatalogVolume(record) ?? NaN], record.key)
        .toEqual([expect.closeTo(volume, 9), expect.closeTo(volume, 9)]);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.nominalMassG?.(row, {}), record.key).toBe(record.massG);
      expect(record.massG ?? NaN, record.key).toBeLessThan(volume * 2.68 / 1000);
      // 印は選ぶ画面の行の文字に出る(寝た脚の穴を作っていない事と、立つ脚の厚さの置き方を先に)。呼びにも「寝た脚の穴なし」を出す(部品表の名前)。
      expect([row.simplified?.slice(0, 2), row.size.includes('寝た脚の穴なし'), record.key.includes('-hb')], record.key)
        .toEqual([[NO_HOLE_MARK, THICK_MARK], true, true]);
    }
  });
});
