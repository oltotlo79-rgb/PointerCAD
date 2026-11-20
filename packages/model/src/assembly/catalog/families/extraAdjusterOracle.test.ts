/**
 * 資料 1 のアジャスターのうち、39 回目の 2 本の読みで揃った型番の行(extraAdjusterRows.ts)の検査。
 * 照らす側の読み(extraAdjusterOracle.fixture.json。2 本目の読みの寸法・種類・材質・質量の文字)を、この検査が自分で読み解く:
 * ねじの呼び・皿の径・ねじの長さ(ℓ・ℓ1、フットはナットの上から軸の先まで)は記入のまま、皿と六角部の高さが分かれた記入は
 * 皿の厚さ = 皿の高さ・六角部 = 下のナットの高さ、底から下のナットの上までの記入は皿の厚さ = その値(六角部なし)、
 * どちらも無い行は皿の厚さ = 全高 − ねじの長さ。全高・ℓ2 の記入がある行は、皿の厚さ + 六角部 + ねじの長さ と合う。
 * あわせて、族の行としての並び・形・体積・質量・材質・印を、製品の口(族の定数)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { adjusterVolume } from '../profiles/framePartShapes.js';
import { EXTRA_ADJUSTER_RECORDS } from './extraAdjusterRows.js';
import { ADJUSTER_FAMILY } from './framePartCatalog.js';
import { ADJUSTER_RECORDS } from './framePartRows.js';

interface FixtureRow {
  readonly key: string; readonly page: string; readonly kind: string; readonly dimensions: string; readonly material: string;
  readonly mass: string;
}

const FIELDS = ['key', 'page', 'kind', 'dimensions', 'material', 'mass'] as const;
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null
  && FIELDS.every((field) => typeof Object.getOwnPropertyDescriptor(value, field)?.value === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./extraAdjusterOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const HEX_MARK = '六角部(対辺の記入が無いので、ねじの径の円柱で表した)';
const MERGED_MARK = '底部と六角部(高さの内訳の記入が無いので、皿の径の円柱 1 つで表した)';
const DERIVED_MARK = '底部と六角部(全高 − ねじの長さの高さで、皿の径の円柱 1 つで表した)';
const RUBBER_MARK = 'ゴムの敷き物(皿の高さに含めて、皿の円柱で表した)';

/** 寸法の欄「名前:値;名前:値」の 1 つの名前の値の最初の数(無ければ undefined)。 */
function dimension(row: FixtureRow, name: string): number | undefined {
  const item = row.dimensions.split(';').find((part) => part.split(':')[0]?.trim() === name);
  const match = /[0-9]+(?:\.[0-9]+)?/u.exec(item?.split(':').slice(1).join(':') ?? '');
  return match === null ? undefined : Number(match[0]);
}

interface Expected {
  readonly thread: string; readonly padDiameter: number; readonly padThickness: number; readonly threadLength: number;
  readonly hexHeight: number | undefined; readonly massG: number; readonly material: string; readonly simplified: readonly string[];
  readonly checks: readonly (readonly [number, number])[];
}

/** 2 本目の読みから、行の値を作る。 */
function expected(row: FixtureRow): Expected {
  const thread = /M[0-9]+/u.exec(row.dimensions.split(';').find((part) => part.startsWith('ねじ:')) ?? '')?.[0] ?? '';
  const padDiameter = dimension(row, '皿径') ?? dimension(row, '座径') ?? NaN;
  const threadLength = dimension(row, 'ℓ1') ?? dimension(row, 'ℓ') ?? dimension(row, 'ナット上〜軸先') ?? NaN;
  const padHeight = dimension(row, '皿高さ');
  const nut = dimension(row, '下ナット高さ');
  const base = dimension(row, '底〜下ナット上');
  const total = dimension(row, '全高');
  const rubber = row.material.includes('ゴム');
  // 皿と六角部の高さが分かれた記入の時だけ六角部を持つ。分かれていなければ、底からの記入か、全高 − ねじの長さ。
  const hexHeight = padHeight !== undefined ? nut : undefined;
  const padThickness = padHeight !== undefined && hexHeight !== undefined ? padHeight : base ?? ((total ?? NaN) - threadLength);
  const marks = hexHeight !== undefined ? [HEX_MARK, ...(rubber ? [RUBBER_MARK] : [])] : [base !== undefined ? MERGED_MARK : DERIVED_MARK];
  const stack = padThickness + (hexHeight ?? 0) + threadLength;
  const ends = [total, dimension(row, 'ℓ2')].filter((end): end is number => end !== undefined);
  return {
    thread, padDiameter, padThickness, threadLength, hexHeight,
    massG: Number(row.mass.replace(/[^0-9.]/gu, '')),
    material: rubber || row.material.includes('PA') ? 'mixed' : /SUS304|ステン/u.test(row.material) ? 'stainless' : 'steel',
    simplified: ['ねじの山', ...marks], checks: ends.map((end) => [end, stack] as const),
  };
}

describe('資料 1 のアジャスターの 39 回目の 2 本の読みで揃った型番の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、ねじ・皿・六角部・質量・材質・印が 2 本目の読みから決まる値と合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(EXTRA_ADJUSTER_RECORDS.map((record) => record.key));
    expect(EXTRA_ADJUSTER_RECORDS.length).toBeGreaterThan(0);
    for (const record of EXTRA_ADJUSTER_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
      expect(JSON.stringify(row), record.key).not.toMatch(/[A-Z]{3}-[A-Z0-9]{2,}/u);
      const want = expected(row);
      expect([record.thread, record.padDiameter, record.padThickness, record.threadLength, record.hexHeight, record.massG, record.material,
        record.simplified, record.page, record.slot], record.key).toEqual([want.thread, want.padDiameter, want.padThickness,
        want.threadLength, want.hexHeight, want.massG, want.material, want.simplified, Number(row.page), 0]);
      // 全高・ℓ2 の記入は、皿の厚さ + 六角部 + ねじの長さ と合う(形が 1 つに閉じる事の確かめ)。
      for (const [end, stack] of want.checks) expect(stack, record.key).toBe(end);
      expect(record.key.startsWith(`${record.thread.toLowerCase()}-d${record.padDiameter}-l${record.threadLength}-`), record.key).toBe(true);
      expect(record.size.startsWith(`アジャスター ${record.thread} 皿 φ${record.padDiameter}（ねじの長さ ${record.threadLength}・`), record.key).toBe(true);
    }
  });

  it('族の行は今の行の後に並び、形ができて名前は呼び、体積は皿 + 六角部 + ねじの円柱、質量は資料の値、材質は部位ごとの文字か材料の密度', () => {
    const tail = ADJUSTER_FAMILY.rows.slice(ADJUSTER_RECORDS.length);
    expect(tail.map((row) => row.key)).toEqual(EXTRA_ADJUSTER_RECORDS.map((record) => record.key));
    for (const record of EXTRA_ADJUSTER_RECORDS) {
      const row = tail.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(ADJUSTER_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      expect(ADJUSTER_FAMILY.nominalVolume(row, {}) ?? NaN, record.key).toBeCloseTo(adjusterVolume(record) ?? NaN, 9);
      expect(ADJUSTER_FAMILY.nominalMassG?.(row, {}), record.key).toBe(record.massG);
      expect(row.simplified, record.key).toEqual(record.simplified);
      if (record.material === 'mixed') {
        expect([row.densityMaterialId, row.materialLabel], record.key).toEqual([undefined, record.materialText]);
        expect(record.materialText?.length ?? 0, record.key).toBeGreaterThan(0);
      } else {
        expect([row.densityMaterialId, row.materialLabel], record.key)
          .toEqual([record.material, record.material === 'stainless' ? 'ステンレス' : '鋼']);
      }
    }
  });
});
