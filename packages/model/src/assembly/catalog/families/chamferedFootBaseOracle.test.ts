/**
 * 資料 1 の左右上の角を斜めに切った板(汎用のキャスターの板)のうち、39 回目の 2 本の読みで揃った型番の行(chamferedFootBaseRows.ts)の検査。
 * 照らす側の読み(chamferedFootBaseOracle.fixture.json。2 本目の読みの種類・板・穴・材質と質量の文字)を、この検査が自分で読み解く:
 * 外形は横・縦・厚さと、上辺の鎖(左の端〜左の斜辺の上端 a、左右の斜辺の上端の間 b)、左の短辺 s。左の斜辺は 45°(a = 縦 − s)で、
 * 右の斜辺の横の長さ(横 − a − b)が a と同じ時だけ、右は左の鏡。穴は下端から c・上端から c2 の 2 段で、横の位置は斜辺からの法線の距離 n から
 * x = y − s + n√2(右は鏡。0.001 mm に丸める)。括弧の数(参考の寸法)は計算の横の位置と 0.5 以内。
 * 質量は資料の値が形 × 密度の 10% 以内の時だけ行の値。めねじは作らず印。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { footBaseProfile } from '../profiles/framePartShapes.js';
import { BOSS_FOOT_RECORDS } from './bossFootRows.js';
import { CHAMFERED_FOOT_BASE_RECORDS } from './chamferedFootBaseRows.js';
import { EXTRA_FOOT_BASE_RECORDS } from './extraFootBaseRows.js';
import { FOOT_BASE_FAMILY } from './framePartCatalog.js';
import { FOOT_BASE_RECORDS } from './framePartRows.js';

interface FixtureRow {
  readonly key: string; readonly page: string; readonly kind: string; readonly plate: string; readonly holes: string; readonly material: string;
}

const FIELDS = ['key', 'page', 'kind', 'plate', 'holes', 'material'] as const;
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null
  && FIELDS.every((field) => typeof Object.getOwnPropertyDescriptor(value, field)?.value === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./chamferedFootBaseOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const DENSITY: Readonly<Record<string, number>> = { steel: 7.85, stainless: 7.93 };
type Point = readonly [number, number];
type Hole = readonly [number, number, number];

/** 全角を半角にして空白を除いた文字。 */
const flat = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, '');
const numberOf = (match: RegExpExecArray | null, index = 1): number => Number(match?.[index] ?? NaN);

/** 板の記入 → 横・縦・厚さ・上辺の鎖 a と b・左の短辺 s と、45° の斜め切りの記入があるか。 */
function plateOf(text: string): { readonly width: number; readonly depth: number; readonly thickness: number; readonly a: number;
  readonly b: number; readonly s: number; readonly slanted: boolean } {
  const value = flat(text);
  const top = /横([0-9]+(?:\.[0-9]+)?)\(左[^)]*\)、([0-9]+(?:\.[0-9]+)?)\(/u.exec(value);
  return { width: numberOf(/外形の横:([0-9]+(?:\.[0-9]+)?)/u.exec(value)), depth: numberOf(/外形の縦:([0-9]+(?:\.[0-9]+)?)/u.exec(value)),
    thickness: numberOf(/厚さ:([0-9]+(?:\.[0-9]+)?)/u.exec(value)), a: numberOf(top), b: numberOf(top, 2),
    s: numberOf(/縦([0-9]+(?:\.[0-9]+)?)\(下[^)]*左斜辺の下端\)/u.exec(value)), slanted: value.includes('斜め切り') && value.includes('45°') };
}

/** 穴の記入 → 数・径・下端からの c・上端からの c2・斜辺からの法線の距離 n・括弧の数(参考の寸法)。 */
function holeTextOf(text: string): { readonly count: number; readonly diameter: number; readonly low: number; readonly high: number;
  readonly normal: number; readonly references: readonly number[] } {
  const value = flat(text);
  const head = /^([0-9]+)-φ([0-9]+(?:\.[0-9]+)?)@/u.exec(value);
  return { count: numberOf(head), diameter: numberOf(head, 2), low: numberOf(/([0-9]+(?:\.[0-9]+)?)\(下端〜下穴\)/u.exec(value)),
    high: numberOf(/([0-9]+(?:\.[0-9]+)?)\(上端〜上穴\)/u.exec(value)), normal: numberOf(/([0-9]+(?:\.[0-9]+)?)\((?:各)?斜辺〜/u.exec(value)),
    references: [...value.matchAll(/\(([0-9]+(?:\.[0-9]+)?)\)/gu)].map((match) => Number(match[1])) };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** 点と、2 点を通る直線の距離。 */
function lineDistance([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  return Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / Math.hypot(bx - ax, by - ay);
}

describe('資料 1 の上の角を斜めに切った板の 39 回目の 2 本の読みで揃った型番の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、外形・穴・材質・質量・印が 2 本目の読みから決まる値と合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(CHAMFERED_FOOT_BASE_RECORDS.map((record) => record.key));
    expect(CHAMFERED_FOOT_BASE_RECORDS.length).toBeGreaterThan(0);
    for (const record of CHAMFERED_FOOT_BASE_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
      expect(JSON.stringify(row), record.key).not.toMatch(/(?<![0-9A-Za-z])[A-Z]{3}-[A-Z0-9]{2,}/u);
      const { width, depth, thickness, a, b, s, slanted } = plateOf(row.plate);
      const right = width - a - b;
      // 左の斜辺は 45°、右の斜辺の横の長さは鎖の閉じで左と同じ(右は左の鏡)。
      expect([slanted, a, right], record.key).toEqual([true, depth - s, a]);
      expect([record.width, record.depth, record.thickness], record.key).toEqual([width, depth, thickness]);
      expect(record.outline, record.key).toEqual([[0, 0], [width, 0], [width, s], [width - right, depth], [a, depth], [0, s]]);
      const { count, diameter, low, high, normal, references } = holeTextOf(row.holes);
      const left = [low, depth - high].map((y): Point => [y - s + normal * Math.SQRT2, y]);
      // 左の穴は左の斜辺から、右の穴(鏡)は右の斜辺から法線の距離 n。括弧の数は計算の横の位置と 0.5 以内。
      for (const point of left) expect(lineDistance(point, [0, s], [a, depth]), record.key).toBeCloseTo(normal, 9);
      for (const [x, y] of left) expect(lineDistance([width - x, y], [width, s], [width - right, depth]), record.key).toBeCloseTo(normal, 9);
      expect(references.length, record.key).toBeGreaterThanOrEqual(2);
      for (const reference of references) expect(left.some(([x]) => Math.abs(x - reference) <= 0.5), `${record.key} ${String(reference)}`).toBe(true);
      const holes = [...left.map(([x, y]): Hole => [round(x), y, diameter]), ...left.map(([x, y]): Hole => [round(width - x), y, diameter])]
        .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      expect([count, record.holes], record.key).toEqual([4, holes]);
      const [materialText = '', massText = ''] = flat(row.material).split(';');
      const material = /SUS|ステン/u.test(materialText) ? 'stainless' : 'steel';
      const mass = /([0-9]+(?:\.[0-9]+)?)(k?)g/u.exec(massText);
      const catalog = Number(mass?.[1] ?? NaN) * (mass?.[2] === 'k' ? 1000 : 1);
      const area = width * depth - (a + right) * (depth - s) / 2 - holes.reduce((sum, [, , size]) => sum + Math.PI * size ** 2 / 4, 0);
      const computed = area * thickness * (DENSITY[material] ?? NaN) / 1000;
      expect([record.material, record.massG, record.page, record.kind, record.simplified], record.key).toEqual([material,
        Math.abs(catalog - computed) <= 0.1 * computed ? catalog : null, Number(row.page), 'キャスターの板', ['キャスターを付けるめねじ']]);
      expect(record.size.startsWith(`キャスターの板 ${String(width)}×${String(depth)}×${String(thickness)}（上の角の斜め切り ${String(a)}・`), record.key)
        .toBe(true);
    }
  });

  it('族の行は 39 回目の長方形の板の後に並び、形ができて名前は呼び、体積は外形の多角形の面積 − 穴 × 厚さ、質量は行の値', () => {
    const start = FOOT_BASE_RECORDS.length + BOSS_FOOT_RECORDS.length + EXTRA_FOOT_BASE_RECORDS.length;
    const tail = FOOT_BASE_FAMILY.rows.slice(start);
    expect(tail.map((row) => row.key)).toEqual(CHAMFERED_FOOT_BASE_RECORDS.map((record) => record.key));
    for (const record of CHAMFERED_FOOT_BASE_RECORDS) {
      const row = tail.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      const outline = record.outline ?? [];
      const polygon = outline.reduce((sum, [x1, y1], index) => {
        const [x2, y2] = outline[(index + 1) % outline.length] ?? [x1, y1];
        return sum + (x1 * y2 - x2 * y1) / 2;
      }, 0);
      const holes = record.holes.reduce((sum, [, , size]) => sum + Math.PI * size ** 2 / 4, 0);
      expect(footBaseProfile(record)?.areaMm2 ?? NaN, record.key).toBeCloseTo(polygon - holes, 9);
      expect(FOOT_BASE_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      expect(FOOT_BASE_FAMILY.nominalVolume(row, {}) ?? NaN, record.key).toBeCloseTo((polygon - holes) * record.thickness, 9);
      expect(FOOT_BASE_FAMILY.nominalMassG?.(row, {}) ?? null, record.key).toBe(record.massG);
      expect([row.densityMaterialId, row.simplified], record.key).toEqual([record.material, record.simplified]);
    }
  });
});
