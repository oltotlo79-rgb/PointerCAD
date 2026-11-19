/**
 * 資料 1 の溝つきフレームのうち、外周の指定を持つ行(frameOutlineRows.ts。1 つの角の大きな丸み)の検査。
 * 照らす側の読み(frameOutlineOracle.fixture.json。2 本目の読みの寸法線の文字と、断面性能の表の 2 回目の読み)を、この検査が自分で読み解く:
 * 寸法線は「数字(端 A〜端 B)」で、括弧で囲まれた数字(参考寸法)は使わない。左の外の面・下の外の面を 0 にして、面から内の点へは
 * 左・下の面から足し、右・上の面から引く。角の丸みは角の名前で当て、名前の無い数つきの記入は名前の付いていない角の数と同じ時だけ残りの角へ。
 * あわせて、族の行として形・体積・質量・断面の外形・締結に出す溝を、製品の口(族の定数)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { slottedOutlineProfile } from '../profiles/slottedOutline.js';
import type { CatalogFamily } from '../types.js';
import { T_SLOT_OUTLINE_RECORDS } from './frameOutlineRows.js';
import { T_SLOT_CATALOG_FAMILIES } from './tSlotFrameCatalog.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly figurePage: string; readonly cells: Cells; readonly table: readonly string[] }
interface Dimension { readonly value: number; readonly a: string; readonly b: string }

const isStrings = (value: unknown): value is Readonly<Record<string, string>> => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'figurePage' in value
  && 'cells' in value && 'table' in value && typeof value.key === 'string' && typeof value.figurePage === 'string' && isStrings(value.cells)
  && Array.isArray(value.table) && value.table.every((cell: unknown) => typeof cell === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./frameOutlineOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const CORNERS = ['左下', '右下', '右上', '左上'] as const;
const X_FACES: Readonly<Record<string, 'min' | 'max'>> = { 左の外の面: 'min', 右の外の面: 'max' };
const Y_FACES: Readonly<Record<string, 'min' | 'max'>> = { 下の外の面: 'min', 上の外の面: 'max' };

function rowOf(key: string): FixtureRow {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found;
}

/** 参考寸法でない寸法線(端の名前の空白は外す)。 */
function dimensionsOf(text: string | undefined): readonly Dimension[] {
  return [...(text ?? '').matchAll(/(\()?([0-9]+(?:\.[0-9]+)?)(\))?\(([^()〜]*)〜([^()]*)\)/gu)].flatMap((match): Dimension[] => {
    const [, open, value, close, a, b] = match;
    if (open !== undefined || close !== undefined || value === undefined || a === undefined || b === undefined) return [];
    return [{ value: Number(value), a: a.replace(/\s+/gu, ''), b: b.replace(/\s+/gu, '') }];
  });
}

/** 1 つの軸の点の位置(min の面 = 0。面から内の点へは min の面から足し、max の面から引く)。 */
function positions(items: readonly Dimension[], faces: Readonly<Record<string, 'min' | 'max'>>): ReadonlyMap<string, number> {
  const known = new Map<string, number>(Object.entries(faces).filter(([, side]) => side === 'min').map(([name]): [string, number] => [name, 0]));
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items) {
      for (const [here, there] of [[item.a, item.b], [item.b, item.a]] as const) {
        const at = known.get(here);
        if (at === undefined || known.has(there)) continue;
        const sign = faces[here] === 'min' || (faces[here] === undefined && faces[there] === 'max') ? 1
          : faces[here] === 'max' || (faces[here] === undefined && faces[there] === 'min') ? -1 : 0;
        if (sign === 0) continue;
        known.set(there, at + sign * item.value);
        changed = true;
      }
    }
  }
  return known;
}

/** 角ごとの丸み(左下・右下・右上・左上の順)。決まらない時は空。 */
function radiiOf(text: string | undefined): readonly number[] {
  const named = new Map<string, number>();
  const loose: (readonly [number, number])[] = [];
  for (const part of (text ?? '').split(';').filter((item) => item.trim() !== '')) {
    const match = /(?:(\d+)-)?R([0-9]+(?:\.[0-9]+)?)/u.exec(part);
    if (match === null) return [];
    const count = Number(match[1] ?? '1');
    const radius = Number(match[2]);
    const names = CORNERS.filter((name) => part.includes(name));
    if (names.length === count) for (const name of names) named.set(name, radius);
    else if (names.length === 0) loose.push([count, radius]);
    else return [];
  }
  const rest = CORNERS.filter((name) => !named.has(name));
  const [only, ...more] = loose;
  if (only !== undefined && more.length === 0 && only[0] === rest.length) for (const name of rest) named.set(name, only[1]);
  return CORNERS.every((name) => named.has(name)) ? CORNERS.map((name) => named.get(name) ?? NaN) : [];
}

/** 溝の形の 4 つの寸法線(口・部屋の幅・肩・深さ)。 */
function slotShapeOf(text: string | undefined): readonly number[] {
  const find = (test: (ends: string) => boolean): number => {
    const values = new Set(dimensionsOf(text).filter((item) => test(`${item.a}|${item.b}`)).map((item) => item.value));
    return values.size === 1 ? [...values][0] ?? NaN : NaN;
  };
  const sides = (ends: string): boolean => ends.includes('左') && ends.includes('右');
  return [find((ends) => ends.includes('口の') && sides(ends) && !ends.includes('部屋')), find((ends) => ends.includes('部屋の') && sides(ends)),
    find((ends) => ends.includes('外の面') && ends.includes('肩の内の面')), find((ends) => ends.includes('肩の内の面') && ends.includes('溝の底'))];
}

function familyOf(slot: number): CatalogFamily {
  return slot === 6 ? T_SLOT_CATALOG_FAMILIES.s6 : slot === 8 ? T_SLOT_CATALOG_FAMILIES.s8 : T_SLOT_CATALOG_FAMILIES.s10;
}

describe('資料 1 の溝つきフレームの外周の指定を持つ行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、断面の値・断面積・単位質量・頁は断面性能の表の 2 回目の読みと合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(T_SLOT_OUTLINE_RECORDS.map((record) => record.key));
    for (const record of T_SLOT_OUTLINE_RECORDS) {
      const { cells, table, figurePage } = rowOf(record.key);
      expect(JSON.stringify(cells), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      expect([record.ixCm4, record.iyCm4, record.zxCm3, record.zyCm3, record.areaMm2, record.unitMassKgPerM, record.figurePage], record.key)
        .toEqual([...table.map(Number), Number(figurePage)]);
      // 単位質量は表の丸め(小数 2 桁)の内で、断面積 × 2.70(アルミの密度)と合う。
      expect(Math.abs((record.areaMm2 ?? NaN) * 2.7 / 1000 - record.unitMassKgPerM), record.key).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });

  it('外形・角の丸み・溝の形と位置・穴が、寸法線の鎖から決まる値と合う(原点は外形の中心)', () => {
    for (const record of T_SLOT_OUTLINE_RECORDS) {
      const { cells } = rowOf(record.key);
      const items = ['外形の寸法線', '溝の位置の寸法線', '穴の記入'].flatMap((field) => dimensionsOf(cells[field]));
      const x = positions(items.filter((item) => item.a in X_FACES || item.b in X_FACES), X_FACES);
      const y = positions(items.filter((item) => item.a in Y_FACES || item.b in Y_FACES), Y_FACES);
      const width = x.get('右の外の面') ?? NaN;
      const height = y.get('上の外の面') ?? NaN;
      const counts = new Map([...(cells['面ごとの溝の数'] ?? '').matchAll(/(上|下|左|右)(\d+)/gu)].map((match): [string, number] => [match[1] ?? '', Number(match[2])]));
      const slots = [['下', 0, x, false], ['右', 1, y, false], ['上', 2, x, true], ['左', 3, y, true]] as const;
      const expectedSlots = slots.filter(([face]) => (counts.get(face) ?? 0) === 1).map(([face, edge, axis, flip]) => {
        const at = axis.get(`${face}の溝の口の中心`) ?? NaN;
        return { edge, at: flip ? (edge === 2 ? width : height) - at : at };
      });
      const diameter = Number(/φ([0-9]+(?:\.[0-9]+)?)/u.exec(cells['穴の記入'] ?? '')?.[1] ?? NaN);
      const hole = { x: (x.get('穴の中心') ?? NaN) - width / 2, y: (y.get('穴の中心') ?? NaN) - height / 2, diameter };
      const outline = record.outline;
      expect([record.width, record.height], record.key).toEqual([width, height]);
      expect(outline?.vertices, record.key).toEqual([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]);
      expect(outline?.radii, record.key).toEqual(radiiOf(cells['角の丸みの記入']));
      expect([record.slotOpening, record.slotInnerWidth, record.shoulder, record.slotDepth], record.key).toEqual(slotShapeOf(cells['溝の形の寸法線']));
      expect([outline?.slots, outline?.holes], record.key).toEqual([expectedSlots, [hole]]);
      expect([record.slot, record.centerHole], record.key).toEqual([record.slotOpening, diameter]);
    }
  });

  it('族の行は長方形の格子の行の後に並び、形・体積は外周の台本の面積 × 長さ、質量は単位質量 × 長さ、外形の箱と締結の溝は外周から', () => {
    for (const record of T_SLOT_OUTLINE_RECORDS) {
      const family = familyOf(record.slot);
      const row = family.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined || record.outline === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(family.rows.slice(-T_SLOT_OUTLINE_RECORDS.filter((item) => item.slot === record.slot).length).map((item) => item.key))
        .toContain(record.key);
      const profile = slottedOutlineProfile({ ...record.outline, slotOpening: record.slotOpening, shoulder: record.shoulder,
        slotInnerWidth: record.slotInnerWidth, slotDepth: record.slotDepth });
      const values = { length: '300' };
      expect(family.build(row, values)?.name, record.key).toBe(`アルミフレーム ${record.size}×300`);
      expect(family.nominalVolume(row, values) ?? NaN, record.key).toBeCloseTo((profile?.areaMm2 ?? NaN) * 300, 6);
      expect(family.nominalMassG?.(row, values) ?? NaN, record.key).toBeCloseTo(record.unitMassKgPerM * 300, 9);
      // 内側を埋めた簡略の形なので、外周の面積は表の断面積(実物)より小さくない。
      expect(profile?.areaMm2 ?? NaN, record.key).toBeGreaterThanOrEqual(record.areaMm2 ?? Infinity);
      expect(family.sectionBounds?.(row, values), record.key).toEqual({ minX: -record.width / 2, minY: -record.height / 2, maxX: record.width / 2,
        maxY: record.height / 2 });
      expect(family.sectionSlots?.(row, values)?.map((slot) => slot.face), record.key).toEqual(record.outline.slots.map((slot) => (slot.edge === 0 ? 'bottom'
        : slot.edge === 1 ? 'right' : slot.edge === 2 ? 'top' : 'left')));
    }
  });
});
