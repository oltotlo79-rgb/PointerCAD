/**
 * 資料 1 の平らな L 形のアングルブラケットのうち、立つ脚の穴を作らない行(extraAngleBracketRows.ts)の検査。
 * 照らす側の読み(extraAngleBracketOracle.fixture.json。2 本目の読みの寸法線の文字・頁の見出しの溝幅・材質・質量)を、この検査が自分で読み解く:
 * 脚の長さ・高さ・幅・立つ脚の厚さは記入のまま、寝た脚の穴の「立つ脚の外面から」の位置は脚の長さ − 自由端面から穴まで、
 * 幅の向きは左の端からの鎖の足し上げ(和が幅と合う)。立つ脚の穴は幅の向きの位置の記入が無いので作らない。
 * あわせて、族の行としての形・体積・質量・印・呼びを、製品の口(族の定数)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { angleBracketCatalogVolume } from '../profiles/framePartShapes.js';
import { D_BRACKET_RECORDS } from './dBracketRows.js';
import { EXTRA_ANGLE_BRACKET_RECORDS } from './extraAngleBracketRows.js';
import { ANGLE_BRACKET_CATALOG_FAMILY } from './framePartCatalog.js';
import { ANGLE_BRACKET_RECORDS } from './framePartRows.js';
import { HARD_BRACKET_RECORDS } from './hardBracketRows.js';

interface FixtureRow {
  readonly key: string; readonly page: string; readonly slotHeading: string; readonly dimensions: string; readonly material: string;
  readonly mass: string;
  /** 付属品・突起だけが違う本体の行: 同じ外形のもとの行の鍵と、作っていない物の印。 */
  readonly baseKey?: string; readonly mark?: string;
}
interface Callout { readonly value: number; readonly a: string; readonly b: string }

const FIELDS = ['key', 'page', 'slotHeading', 'dimensions', 'material', 'mass'] as const;
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null
  && FIELDS.every((field) => typeof Object.getOwnPropertyDescriptor(value, field)?.value === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./extraAngleBracketOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const NO_HOLE_MARK = '立つ脚の穴(幅の向きの位置の記入が無いので作っていない)';
const THICK_MARK = '寝た脚の厚さは記入が無いので、立つ脚の厚さで作った';

/** 寸法線「数字(端 A〜端 B)」(端の名前の空白は外す)。 */
function callouts(text: string): readonly Callout[] {
  return [...text.matchAll(/(?<![0-9.])([0-9]+(?:\.[0-9]+)?)\(([^()〜]*)〜([^()]*)\)/gu)].map((match) => ({
    value: Number(match[1]), a: (match[2] ?? '').replace(/\s+/gu, ''), b: (match[3] ?? '').replace(/\s+/gu, '') }));
}

/** 端の名前の組で 1 つに決まる寸法線の値(決まらない時は NaN)。 */
function one(items: readonly Callout[], test: (a: string, b: string) => boolean): number {
  const values = [...new Set(items.filter((item) => test(item.a, item.b)).map((item) => item.value))];
  return values.length === 1 ? values[0] ?? NaN : NaN;
}

const free = (name: string): boolean => name.includes('前端面') || name.includes('自由端面');

/** 2 本目の読みから、行の値(脚・高さ・幅・厚さ・穴の径・寝た脚の穴の位置)を作る。 */
function expected(row: FixtureRow): Readonly<Record<string, number | readonly number[]>> {
  const items = callouts(row.dimensions);
  const legA = one(items, (a, b) => free(a) && a.includes('寝た脚') && b.includes('立つ脚') && b.includes('外面'));
  const toHole = one(items, (a, b) => free(a) && b.includes('穴'));
  const chain = callouts((row.dimensions.split('鎖')[1] ?? '').split(/ \/ |。/u)[0] ?? '').map((item) => item.value);
  return {
    legA, legB: one(items, (a, b) => a.includes('寝た脚') && a.includes('下') && b.includes('立つ脚の上端')),
    width: one(items, (a, b) => !(a + b).includes('穴') && a.includes('左') && b.includes('右') && !(a + b).includes('厚さ')),
    thickness: one(items, (a) => a.includes('立つ脚の内面')),
    holeDiameter: Number(/\d+-φ([0-9.]+)/u.exec(row.dimensions)?.[1] ?? NaN),
    alongA: [legA - toHole], acrossA: chain.slice(0, -1).map((_, index) => chain.slice(0, index + 1).reduce((sum, value) => sum + value, 0)),
    chainSum: chain.reduce((sum, value) => sum + value, 0),
  };
}

const VARIANT_KEYS = new Set(FIXTURE.filter((row) => row.baseKey !== undefined).map((row) => row.key));
const PLAIN_RECORDS = EXTRA_ANGLE_BRACKET_RECORDS.filter((record) => !VARIANT_KEYS.has(record.key));
const VARIANT_RECORDS = EXTRA_ANGLE_BRACKET_RECORDS.filter((record) => VARIANT_KEYS.has(record.key));

describe('資料 1 の平らな L 形のアングルブラケットの立つ脚の穴を作らない行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、寸法・穴・溝幅・材質・質量が 2 本目の読みから決まる値と合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(EXTRA_ANGLE_BRACKET_RECORDS.map((record) => record.key));
    expect(PLAIN_RECORDS.length).toBeGreaterThan(0);
    for (const record of PLAIN_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
      expect(JSON.stringify(row), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      const value = expected(row);
      expect([value.chainSum, record.width], record.key).toEqual([value.width, value.width]);
      expect([record.legA, record.legB, record.thickness, record.holeDiameter, record.alongA, record.acrossA], record.key)
        .toEqual([value.legA, value.legB, value.thickness, value.holeDiameter, value.alongA, value.acrossA]);
      expect([record.slot, record.page, record.massG, record.material, record.ribbed], record.key).toEqual([Number(row.slotHeading), Number(row.page),
        Number(row.mass.replace(/[^0-9.]/gu, '')), row.material.includes('アルミ') ? 'aluminum' : '', false]);
      expect([record.alongB, record.acrossB, record.simplified], record.key).toEqual([[], [], [NO_HOLE_MARK, THICK_MARK]]);
    }
  });

  it('族の行はダイカストの本体の行の後に並び、寝た脚の穴だけの形ができ、体積は L の断面 − 寝た脚の穴、質量は資料の値で形 × 密度より軽い', () => {
    const start = ANGLE_BRACKET_RECORDS.length + HARD_BRACKET_RECORDS.length + D_BRACKET_RECORDS.length;
    const tail = ANGLE_BRACKET_CATALOG_FAMILY.rows.slice(start, start + EXTRA_ANGLE_BRACKET_RECORDS.length);
    expect(tail.map((row) => row.key)).toEqual(EXTRA_ANGLE_BRACKET_RECORDS.map((record) => record.key));
    for (const record of PLAIN_RECORDS) {
      const row = tail.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      const holes = record.alongA.length * record.acrossA.length;
      const volume = (record.legA + record.legB - record.thickness) * record.thickness * record.width
        - holes * Math.PI * (record.holeDiameter / 2) ** 2 * record.thickness;
      expect([ANGLE_BRACKET_CATALOG_FAMILY.nominalVolume(row, {}) ?? NaN, angleBracketCatalogVolume(record) ?? NaN], record.key)
        .toEqual([expect.closeTo(volume, 9), expect.closeTo(volume, 9)]);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.nominalMassG?.(row, {}), record.key).toBe(record.massG);
      // 作っていない立つ脚の穴の分だけ、資料の質量は形 × 密度(アルミ 2.68)より軽い(10% 以内)。
      const shapeMass = volume * 2.68 / 1000;
      expect([(record.massG ?? NaN) < shapeMass, (shapeMass - (record.massG ?? NaN)) / (record.massG ?? NaN) <= 0.1], record.key).toEqual([true, true]);
      expect([row.size.includes('立つ脚の穴なし'), record.key.includes('-ha')], record.key).toEqual([true, true]);
    }
  });

  it('付属品・突起だけが違う本体の行は、もとの行と同じ形(脚・高さは 2 本目の読みの全体の記入と合う)で、質量は資料の値、印を 1 つ足す', () => {
    expect(VARIANT_RECORDS.length).toBe(4);
    for (const record of VARIANT_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      const base = ANGLE_BRACKET_RECORDS.find((item) => item.key === row?.baseKey);
      if (row === undefined || base === undefined) throw new Error(`もとの行が無い: ${record.key}`);
      const overall = callouts(row.dimensions);
      // 脚は「寝た脚 …〜立つ脚の外面(背面)」、高さは「寝た脚 …〜立つ脚の上端」(9 回目と 38 回目の 2 本目の書き方の両方)。
      expect([one(overall, (a, b) => a.includes('寝た脚') && b.includes('立つ脚') && (b.includes('外面') || b.includes('背面'))),
        one(overall, (a, b) => a.includes('寝た脚') && b.includes('立つ脚') && b.includes('上端'))], record.key).toEqual([base.legA, base.legB]);
      expect({ ...record, key: base.key, size: base.size, page: base.page, massG: base.massG, simplified: base.simplified }, record.key).toEqual(base);
      expect(record.key.startsWith(`${base.key}-`) && record.size.startsWith(base.size.slice(0, base.size.indexOf('）'))), record.key).toBe(true);
      expect([record.massG, record.page, record.simplified], record.key).toEqual([Number(row.mass.replace(/[^0-9.]/gu, '')), Number(row.page),
        [...base.simplified, row.mark]]);
      const familyRow = ANGLE_BRACKET_CATALOG_FAMILY.rows.find((candidate) => candidate.key === record.key);
      const baseRow = ANGLE_BRACKET_CATALOG_FAMILY.rows.find((candidate) => candidate.key === base.key);
      if (familyRow === undefined || baseRow === undefined) throw new Error(`族に ${record.key} か ${base.key} が無い`);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.nominalVolume(familyRow, {}), record.key).toBe(ANGLE_BRACKET_CATALOG_FAMILY.nominalVolume(baseRow, {}));
      expect(ANGLE_BRACKET_CATALOG_FAMILY.nominalMassG?.(familyRow, {}), record.key).toBe(record.massG);
    }
  });
});
