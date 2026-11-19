/**
 * 資料 1 のブロック形のブラケットの行(blockBracketRows.ts)の検査。照らす側の読み(blockBracketOracle.fixture.json。2 本目の読みの形の種類・
 * 寸法線の文字・頁の見出しの溝幅・材質・質量)を、この検査が自分で読み解く: 外形と前の穴の高さは記入のまま、上の穴の前の面からの位置は
 * 奥行 − 奥の面から、左の端からの位置は 幅 − 右の端から(前の穴が左の端から書かれた時はそのまま)、穴ごとの径と座ぐりは穴ごとの記入。
 * 2 つの穴に 1 つの記入(「2-φ…(上面穴と手前の端面穴…)」)の行は、38 回目の 2 本目の読みの座ぐりの当て先(counterboreTarget)が「両方」である事も確かめる。
 * あわせて、族の定数・形・体積(式)・質量を、製品の口(族)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BLOCK_BRACKET_FAMILY } from './blockBracketCatalog.js';
import { BLOCK_BRACKET_RECORDS } from './blockBracketRows.js';

interface FixtureRow {
  readonly key: string; readonly page: string; readonly slotHeading: string; readonly counterboreTarget: string; readonly shape: string;
  readonly dimensions: string; readonly material: string; readonly mass: string;
}
interface Callout { readonly value: number; readonly a: string; readonly b: string }

const FIELDS = ['key', 'page', 'slotHeading', 'counterboreTarget', 'shape', 'dimensions', 'material', 'mass'] as const;
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null
  && FIELDS.every((field) => typeof Object.getOwnPropertyDescriptor(value, field)?.value === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./blockBracketOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();

function callouts(text: string): readonly Callout[] {
  return [...text.matchAll(/(?<![0-9.])([0-9]+(?:\.[0-9]+)?)\(([^()〜]*)〜([^()]*)\)/gu)].map((match) => ({
    value: Number(match[1]), a: (match[2] ?? '').replace(/\s+/gu, ''), b: (match[3] ?? '').replace(/\s+/gu, '') }));
}

function one(items: readonly Callout[], test: (a: string, b: string) => boolean): number {
  const values = [...new Set(items.filter((item) => test(item.a, item.b)).map((item) => item.value))];
  return values.length === 1 ? values[0] ?? NaN : NaN;
}

const frontHole = (name: string): boolean => name.includes('正面穴') || name.includes('端面穴');

const HOLE_CALLOUT = /φ([0-9.]+),\s*([0-9.]+)\s*深ザグリ深[さサ]?\s*([0-9.]+)\(([^()]*)\)/gu;

/** 穴ごとの「φ通し,座ぐり深ザグリ深さ(どの穴)」の記入(2 つの穴に当たる 1 つの記入は、どちらの穴でも同じ値)。 */
function holeSpec(text: string, test: (name: string) => boolean): readonly number[] {
  const found = [...text.matchAll(HOLE_CALLOUT)].filter((match) => test(match[4] ?? ''));
  return found.length === 1 ? [Number(found[0]?.[1]), Number(found[0]?.[2]), Number(found[0]?.[3])] : [];
}

/** 1 つの記入が上の穴と前の穴の両方を挙げているか。 */
const sharedCallout = (text: string): boolean => [...text.matchAll(HOLE_CALLOUT)]
  .some((match) => (match[4] ?? '').includes('上面穴') && frontHole(match[4] ?? ''));

/** 前の穴の左の端からの位置(右の端からの記入なら 幅 − 値)。 */
function frontAcross(items: readonly Callout[], width: number): number {
  const right = one(items, (a, b) => frontHole(a) && b.includes('右'));
  return Number.isNaN(right) ? one(items, (a, b) => a.includes('左') && frontHole(b)) : width - right;
}

describe('資料 1 のブロック形のブラケットの行と照らす側の読み', () => {
  it('族の定数: アルミフレームの分類・版 r1・数で数える部品・選ぶ欄なし', () => {
    expect([BLOCK_BRACKET_FAMILY.id, BLOCK_BRACKET_FAMILY.group, BLOCK_BRACKET_FAMILY.kindKey, BLOCK_BRACKET_FAMILY.catalogRevision,
      BLOCK_BRACKET_FAMILY.diagram, BLOCK_BRACKET_FAMILY.stock, BLOCK_BRACKET_FAMILY.options]).toEqual(['t-slot-block-bracket', 'aluminumFrame',
      'catalog.frame.kind.blockBracket', 't-slot-block-bracket-2026-11-r1', 'blockBracket', 'count', []]);
    expect(BLOCK_BRACKET_FAMILY.rows.map((row) => row.key)).toEqual(BLOCK_BRACKET_RECORDS.map((record) => record.key));
  });

  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、外形・穴・座ぐり・溝幅・材質・質量が 2 本目の読みから決まる値と合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(BLOCK_BRACKET_RECORDS.map((record) => record.key));
    expect(BLOCK_BRACKET_RECORDS.length).toBeGreaterThan(0);
    for (const record of BLOCK_BRACKET_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
      expect(JSON.stringify(row), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      const items = callouts(row.dimensions);
      const depth = one(items, (a, b) => (a.includes('前端') || a.includes('手前')) && (b.includes('後端') || b.includes('奥端')) && !a.includes('中心'));
      const width = one(items, (a, b) => a.includes('左') && b.includes('右') && !(a + b).includes('中心'));
      const height = one(items, (a, b) => a.includes('下') && b.includes('上面') && !(a + b).includes('穴') && !(a + b).includes('中心'));
      const top = holeSpec(row.dimensions, (name) => name.includes('上面穴'));
      const front = holeSpec(row.dimensions, frontHole);
      expect([record.width, record.depth, record.height], record.key).toEqual([width, depth, height]);
      expect(record.holes, record.key).toEqual([
        { face: 'top', u: width - one(items, (a, b) => a.includes('上面穴') && b.includes('右')),
          v: depth - one(items, (a, b) => a.includes('上面穴') && (b.includes('後端') || b.includes('奥端'))), diameter: top[0],
          counterbore: { diameter: top[1], depth: top[2] } },
        { face: 'front', u: frontAcross(items, width), v: one(items, (a, b) => a.includes('下') && frontHole(b)),
          diameter: front[0], counterbore: { diameter: front[1], depth: front[2] } },
      ]);
      expect(row.counterboreTarget, record.key).toBe(sharedCallout(row.dimensions) ? '両方' : '-');
      expect([row.shape, record.slot, record.page, record.massG, record.material], record.key).toEqual(['座ぐり穴の入るブロック形',
        Number(row.slotHeading), Number(row.page), Number(row.mass.replace(/[^0-9.]/gu, '')), row.material.includes('アルミ') ? 'aluminum' : '']);
    }
  });

  it('形ができ、体積は 直方体 − 座ぐりと通しの円柱 + 互いに貫く座ぐりの重なり、質量は資料の値で形 × 密度と 10% 以内', () => {
    for (const record of BLOCK_BRACKET_RECORDS) {
      const row = BLOCK_BRACKET_FAMILY.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(BLOCK_BRACKET_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      const lengths = { top: record.height, front: record.depth } as const;
      const removed = record.holes.reduce((sum, hole) => {
        const bore = hole.counterbore ?? { diameter: hole.diameter, depth: 0 };
        const length = hole.face === 'top' ? lengths.top : lengths.front;
        return sum + Math.PI * (bore.diameter / 2) ** 2 * bore.depth + Math.PI * (hole.diameter / 2) ** 2 * (length - bore.depth);
      }, 0);
      const r = (record.holes[0]?.counterbore?.diameter ?? NaN) / 2;
      const volume = record.width * record.depth * record.height - removed + (16 / 3) * r ** 3;
      expect(BLOCK_BRACKET_FAMILY.nominalVolume(row, {}) ?? NaN, record.key).toBeCloseTo(volume, 9);
      expect(BLOCK_BRACKET_FAMILY.nominalMassG?.(row, {}), record.key).toBe(record.massG);
      expect(Math.abs(volume * 2.68 / 1000 - record.massG) / record.massG, record.key).toBeLessThanOrEqual(0.1);
    }
  });
});
