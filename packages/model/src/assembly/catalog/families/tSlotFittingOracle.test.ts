/**
 * 資料 1 のジョイントバー・スタッド・ローレットナットの製品の行(tSlotFittingRows.ts)が、照らす側の読み(tSlotFittingOracle.fixture.json。
 * 8 回目の 2 本目の記入のままの寸法の文字と、今までの欄の読みの合う溝幅・材質)と 1 行ずつ合う事の検査。fixture の文字は、この検査が自分で読み解く
 * (行の表を作る道具の読み解きと別にする)。めねじの位置は鎖寸法の累積、スタッドのおねじの長さは張り出しの下の面からの 2 つの位置の差を、文字から確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { JOINT_BAR_RECORDS, KNURLED_NUT_RECORDS, STUD_RECORDS } from './tSlotFittingRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }
interface Dimension { readonly value: number; readonly start: string; readonly end: string }
/** 3 族の行に共通の欄(鍵・溝幅・材質・質量・頁)。 */
interface Common { readonly key: string; readonly slot: number; readonly material: string; readonly massG: number; readonly page: number }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): Readonly<Record<string, readonly FixtureRow[]>> {
  const value: unknown = JSON.parse(readFileSync(new URL('./tSlotFittingOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('fixture の形が違う');
  const result: Record<string, readonly FixtureRow[]> = {};
  for (const kind of ['joint-bars', 'studs', 'knurled-nuts']) {
    const rows: unknown = kind in value ? Object.getOwnPropertyDescriptor(value, kind)?.value : undefined;
    if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error(`fixture の ${kind} の形が違う`);
    result[kind] = rows;
  }
  return result;
}

const FIXTURE = readFixture();

function cellsOf(kind: string, key: string): Cells {
  const found = FIXTURE[kind]?.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found.cells;
}

/** 「横:…/縦:…」の向きの節から、「数字(始まり〜終わり・図)」の寸法線(図の名前と書き添えは端の語から外す)。 */
function dimensionsOf(text: string | undefined, direction: '横' | '縦'): readonly Dimension[] {
  const section = (text ?? '').split('/').find((part) => part.startsWith(`${direction}:`)) ?? '';
  return [...section.matchAll(/φ?([0-9]+(?:\.[0-9]+)?)\(([^()〜]*)〜([^()]*)\)/gu)].flatMap((match): Dimension[] => {
    const [, value, start, end] = match;
    return value === undefined || start === undefined || end === undefined ? []
      : [{ value: Number(value), start: start.split('・')[0] ?? '', end: end.split('・')[0] ?? '' }];
  });
}

function numberOf(text: string | undefined): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)g?$/u.exec(text ?? '');
  return match?.[1] === undefined ? NaN : Number(match[1]);
}

function materialOf(text: string | undefined): string {
  const value = text ?? '';
  if (/ステンレス|SUS/u.test(value)) return 'stainless';
  if (/黄銅/u.test(value)) return 'brass';
  return /鋼|S10C|SPHC/u.test(value) ? 'steel' : '';
}

const pick = (list: readonly Dimension[], test: (dimension: Dimension) => boolean): number => list.find(test)?.value ?? NaN;

describe('資料 1 のジョイントバー・スタッド・ローレットナットの製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たず、溝幅・材質・質量・頁が照らす側と合う', () => {
    const groups: readonly (readonly [string, readonly Common[]])[] = [['joint-bars', JOINT_BAR_RECORDS], ['studs', STUD_RECORDS],
      ['knurled-nuts', KNURLED_NUT_RECORDS]];
    for (const [kind, records] of groups) {
      expect(FIXTURE[kind]?.map((row) => row.key), kind).toEqual(records.map((record) => record.key));
      for (const record of records) {
        const cells = cellsOf(kind, record.key);
        expect(JSON.stringify(cells), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
        expect([record.slot, record.material, record.massG, record.page], record.key).toEqual([numberOf(cells['合う溝幅']),
          materialOf(cells['材質(欄の読み)']), numberOf(cells['質量_g']), numberOf(cells['PDF頁'])]);
        expect(materialOf(cells['材質']), record.key).toBe(record.material);
      }
    }
  });

  it('ジョイントバーの長さ・全厚・頭と首の幅と、めねじの位置(長さの端の面からの鎖寸法の累積。和が長さと合う)と呼び・数', () => {
    for (const record of JOINT_BAR_RECORDS) {
      const cells = cellsOf('joint-bars', record.key);
      const across = dimensionsOf(cells['記入のままの寸法'], '横');
      const along = dimensionsOf(cells['記入のままの寸法'], '縦');
      expect([record.length, record.thickness, record.width, record.neckWidth], record.key).toEqual([
        pick(across, (item) => item.start === '左端面' && item.end === '右端面'), pick(across, (item) => item.start.includes('頭') && item.end.includes('首')),
        pick(along, (item) => item.start.includes('頭')), pick(along, (item) => item.start.includes('首'))]);
      const chain = across.filter((item) => item.start.includes('番目') || item.end.includes('番目'));
      const offsets: number[] = [];
      let position = 0;
      for (const item of chain) {
        position += item.value;
        if (item.end.includes('番目')) offsets.push(position);
      }
      expect([offsets, position], record.key).toEqual([[...record.holeOffsets], record.length]);
      expect([cells['ねじの呼び'], Number(cells['ねじ穴の数'])], record.key).toEqual([record.thread, record.holeOffsets.length]);
    }
  });

  it('スタッドの板の幅・奥行・厚さと、おねじの長さ(張り出しの下の面から、おねじの先までと板の上の面までの差)と呼び', () => {
    for (const record of STUD_RECORDS) {
      const cells = cellsOf('studs', record.key);
      const across = dimensionsOf(cells['記入のままの寸法'], '横');
      const along = dimensionsOf(cells['記入のままの寸法'], '縦');
      const tip = pick(along, (item) => item.end.includes('先端') || item.start.includes('先端'));
      const top = pick(along, (item) => (item.start.includes('突起') || item.start.includes('張出し')) && item.end.includes('板'));
      expect([record.width, record.depth, record.plateThickness, record.threadLength, record.thread], record.key).toEqual([
        pick(across, (item) => item.start.includes('頭')), pick(along, (item) => item.start.includes('頭の上')),
        pick(along, (item) => item.start.includes('板')), tip - top, cells['ねじの呼び']]);
    }
  });

  it('ローレットナットは太い段の径と全高で包み、細い段の径を持ち、めねじの呼びが合う', () => {
    for (const record of KNURLED_NUT_RECORDS) {
      const cells = cellsOf('knurled-nuts', record.key);
      const diameters = dimensionsOf(cells['記入のままの寸法'], '横').map((item) => item.value).sort((a, b) => a - b);
      expect([record.flangeDiameter, record.diameter, record.height, record.thread], record.key).toEqual([diameters[0], diameters[1],
        dimensionsOf(cells['記入のままの寸法'], '縦')[0]?.value, cells['ねじの呼び']]);
    }
  });
});
