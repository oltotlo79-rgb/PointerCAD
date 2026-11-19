/**
 * 資料 1 のダイカストのリブつきの L 形のブラケットの本体の行(dBracketRows.ts。寝た脚の穴を作らない形。統括の決定 2026-11-18 08:4x の (B) と同じ形)の検査。
 * 照らす側の読み(dBracketOracle.fixture.json。2 本目の読みの文字と、立つ脚の穴の記入の書き方)を、この検査が自分で読み解く:
 * 脚の長さ・幅・寝た脚の厚さは記入のまま、立つ脚の穴の高さは寝た脚の底の面からの単独の値・鎖の累積・下の穴を起点にした値・穴ごとの値、
 * 幅の向きは幅の端から端まで届く鎖(和が幅と合う)か、幅の端からの単独の値。合う溝幅は、2 本の読みで一致した物だけ(読み待ちの行は入れない)。
 * あわせて、族の行としての形・体積・質量・印・呼びを、製品の口(族の定数)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { angleBracketCatalogVolume } from '../profiles/framePartShapes.js';
import { D_BRACKET_RECORDS } from './dBracketRows.js';
import { ANGLE_BRACKET_CATALOG_FAMILY } from './framePartCatalog.js';
import { ANGLE_BRACKET_RECORDS } from './framePartRows.js';
import { HARD_BRACKET_RECORDS } from './hardBracketRows.js';

type Cells = Readonly<Record<string, string>>;
interface Slot { readonly value: string; readonly state: string }
interface Rules { readonly '立つ脚の穴の高さ': string; readonly '立つ脚の穴の幅の向き': string }
interface FixtureRow { readonly key: string; readonly cells: Cells; readonly slot: Slot; readonly rules: Rules }

const isStrings = (value: unknown): value is Readonly<Record<string, string>> => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isSlot = (value: unknown): value is Slot => isStrings(value) && 'value' in value && 'state' in value;
const isRules = (value: unknown): value is Rules => isStrings(value) && '立つ脚の穴の高さ' in value && '立つ脚の穴の幅の向き' in value;
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && 'slot' in value && 'rules' in value && typeof value.key === 'string' && isStrings(value.cells) && isSlot(value.slot) && isRules(value.rules);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./dBracketOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const NO_HOLE_MARK = '寝た脚の穴(幅の向きの位置の記入が無いので作っていない)';
const THICK_MARK = '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った';
const AGREED = '2 本で一致';

function rowOf(key: string): FixtureRow {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found;
}

const numbersOf = (text: string | undefined): number[] => [...(text ?? '').matchAll(/[0-9]+(?:\.[0-9]+)?/gu)].map((match) => Number(match[0]));
const single = (text: string | undefined): number => (/^\s*[0-9]+(?:\.[0-9]+)?\s*$/u.test(text ?? '') ? Number(text) : NaN);

/** 穴の位置_外の面からの、立つ脚の部分(「寝た脚/立つ脚」か「寝た脚;立つ脚」の 1 穴ずつ)。 */
function legBPart(text: string | undefined): string {
  const value = text ?? '';
  if (value.includes('/')) return value.split('/')[1] ?? '';
  const parts = value.split(';');
  return parts.length === 2 ? parts[1] ?? '' : '';
}

/**
 * 寸法線を「数字(端〜端)」で 1 本ずつ書いた読みの、立つ脚(辺 b)の部分: 寝た脚の外の面(角の外の面)から穴の中心へ、穴から穴へとたどった累積。
 * 終わりの端の面までの寸法線は、和が脚の長さと合う事だけを確かめる。
 */
function chainOf(text: string | undefined, legB: number): number[] {
  const value = (text ?? '').replace(/\s+/gu, '');
  const items = [...value.slice(Math.max(value.indexOf('辺b'), 0)).matchAll(/(?<![0-9.])([0-9]+(?:\.[0-9]+)?)\(([^()〜]*)〜([^()]*)\)/gu)]
    .map((match): readonly [number, string, string] => [Number(match[1]), match[2] ?? '', match[3] ?? '']);
  const known = new Map<string, number>();
  for (let round = 0; round < items.length; round += 1) {
    for (const [length, a, b] of items) {
      if (b.includes('端面') || known.has(b)) continue;
      if (a.includes('外の面') && !a.includes('端')) known.set(b, length);
      else if (known.has(a)) known.set(b, (known.get(a) ?? NaN) + length);
    }
  }
  const ends = items.filter(([, a, b]) => known.has(a) && b.includes('端面')).map(([length, a]) => (known.get(a) ?? NaN) + length);
  return ends.every((end) => end === legB) ? [...new Set(known.values())].sort((x, y) => x - y) : [];
}

/** 立つ脚の穴の高さ(寝た脚の底の面から)を、記入の書き方で読み解く。 */
function alongOf(text: string | undefined, rule: string, legB: number): number[] {
  if (rule === 'dim-chain') return chainOf(text, legB);
  const values = numbersOf(legBPart(text));
  if (rule === 'single') return values.length === 1 ? values : [];
  if (rule === 'chain') return values.map((_, index) => values.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
  if (rule === 'baseline') return [values[0] ?? NaN, ...values.slice(1).map((value) => (values[0] ?? NaN) + value)].sort((a, b) => a - b);
  if (rule === 'perhole') return [...values].sort((a, b) => a - b);
  return [];
}

/** 立つ脚の穴の幅の向きの位置を、記入の書き方で読み解く(鎖は和が幅と合う時だけ)。 */
function acrossOf(text: string | undefined, rule: string, width: number): number[] {
  const values = numbersOf(text);
  if (rule === 'single-from-end') return values.length === 1 ? values : [];
  if (rule !== 'chain-end-to-end' || values.reduce((sum, value) => sum + value, 0) !== width) return [];
  return values.slice(0, -1).map((_, index) => values.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
}

describe('資料 1 のダイカストのリブつきの L 形のブラケットの本体の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、溝幅は 2 本の読みで一致した値、質量・材質・頁は照らす側と合い、寝た脚の穴は無い', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(D_BRACKET_RECORDS.map((record) => record.key));
    for (const record of D_BRACKET_RECORDS) {
      const { cells, slot } = rowOf(record.key);
      expect(JSON.stringify(cells), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      // 合う溝幅は読みで決まった物だけ(読み待ちの行は作業ツリーへ入れない)。
      expect([slot.state, Number(slot.value)], record.key).toEqual([AGREED, record.slot]);
      expect([record.massG, record.page], record.key).toEqual([Number(/^([0-9.]+)g$/u.exec(cells['質量_g'] ?? '')?.[1] ?? NaN),
        Number(cells['PDF頁'])]);
      expect([record.material, cells['材質']?.includes('アルミ')], record.key).toEqual(['aluminum', true]);
      expect([record.alongA, record.acrossA, record.ribbed], record.key).toEqual([[], [], true]);
    }
  });

  it('脚の長さ・幅・寝た脚の厚さ・立つ脚の穴の径と、立つ脚の穴の高さと幅の向きの位置が、記入と書き方から決まる値と合う', () => {
    for (const record of D_BRACKET_RECORDS) {
      const { cells, rules } = rowOf(record.key);
      const diameters = numbersOf(cells['穴の径']);
      expect([single(cells['辺aの長さ']), single(cells['辺bの長さ']), single(cells['幅']), single(cells['辺aの厚さ']), cells['辺bの厚さ'],
        diameters.length === 2 ? diameters[1] : single(cells['穴の径'])], record.key)
        .toEqual([record.legA, record.legB, record.width, record.thickness, '記入なし', record.holeDiameter]);
      const along = alongOf(cells['穴の位置_外の面から'], rules['立つ脚の穴の高さ'], record.legB);
      const across = acrossOf(cells['穴の位置_端から'], rules['立つ脚の穴の幅の向き'], record.width);
      expect([along, across], record.key).toEqual([[...record.alongB], [...record.acrossB]]);
      expect(along.length * across.length, record.key).toBe(numbersOf(cells['穴の数'])[1]);
      const r = record.holeDiameter / 2;
      expect(along.every((y) => record.thickness < y - r && y + r < record.legB) && across.every((z) => r < z && z < record.width - r), record.key)
        .toBe(true);
    }
  });

  it('族の行は寝た脚の穴を作らない行の後に並び、立つ脚の穴だけの形ができ、体積は L の断面 − 立つ脚の穴、質量は資料の値', () => {
    const start = ANGLE_BRACKET_RECORDS.length + HARD_BRACKET_RECORDS.length;
    // この行の表の後に、立つ脚の穴を作らない平らな L 形の行(extraAngleBracketRows.ts)が続くので、この表の行の数だけを切り出す。
    const tail = ANGLE_BRACKET_CATALOG_FAMILY.rows.slice(start, start + D_BRACKET_RECORDS.length);
    expect(tail.map((row) => row.key)).toEqual(D_BRACKET_RECORDS.map((record) => record.key));
    for (const record of D_BRACKET_RECORDS) {
      const row = tail.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      const holes = record.alongB.length * record.acrossB.length;
      const volume = (record.legA + record.legB - record.thickness) * record.thickness * record.width
        - holes * Math.PI * (record.holeDiameter / 2) ** 2 * record.thickness;
      expect([ANGLE_BRACKET_CATALOG_FAMILY.nominalVolume(row, {}) ?? NaN, angleBracketCatalogVolume(record) ?? NaN], record.key)
        .toEqual([expect.closeTo(volume, 9), expect.closeTo(volume, 9)]);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.nominalMassG?.(row, {}), record.key).toBe(record.massG);
      // 印は選ぶ画面の行の文字に出る(寝た脚の穴を作っていない事と、立つ脚の厚さの置き方を先に)。呼びにも「寝た脚の穴なし」を出す(部品表の名前)。
      expect([row.simplified?.slice(0, 3), row.size.includes('寝た脚の穴なし'), record.key.includes('-hb')], record.key)
        .toEqual([[NO_HOLE_MARK, THICK_MARK, 'リブ'], true, true]);
    }
  });
});
