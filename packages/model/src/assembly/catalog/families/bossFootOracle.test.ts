/**
 * 資料 1 のボス付きのベースの板の製品の行(bossFootRows.ts。1 つ目の組の読みの値)が、2 つ目の組の独立の読み(bossFootOracle.fixture.json。
 * 読みの文字のまま)と一致する事の検査(統括の決定 2026-11-18 13:4x の (1))。fixture の文字は、この検査が自分で読み解く。
 * 取付け穴は作らず印を持ち、ボスはめねじと同じ中心(2 つ目の組の読みが「同じ中心」の時だけ)、下の端と上の端は側面図の記入から決まる事、
 * 体積は板 + 板の外へ出るボスの分、質量は作っていない所の印の行の決まり(資料の値が形 × 密度より軽い向きで、7 割以上)である事も確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BOSS_FOOT_RECORDS } from './bossFootRows.js';
import { FOOT_BASE_FAMILY } from './framePartCatalog.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

/** fixture の JSON を読み、行の並びを返す(形が違えば止める)。 */
function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./bossFootOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const ALUMINUM_G_PER_CM3 = 2.68;

/** 記入のままの寸法から、起点〜終点の言葉の並びで始まる記入の数を 1 つだけ読む(無い・2 つ以上は NaN)。 */
function dimension(text: string, between: string): number {
  const found = [...text.matchAll(/([0-9]+(?:\.[0-9]+)?)\(([^()]*)\)/gu)].filter((match) => match[2]?.startsWith(between) === true);
  return found.length === 1 ? Number(found[0]?.[1]) : NaN;
}

/** 書き添えの φ(ボスの外周の言葉つき)を 1 つだけ読む。 */
function bossDiameter(text: string): number {
  const found = [...text.matchAll(/φ([0-9]+(?:\.[0-9]+)?)\(([^()]*ボス[^()]*)\)/gu)];
  return found.length === 1 ? Number(found[0]?.[1]) : NaN;
}

describe('資料 1 のボス付きのベースの板(取付け穴は作らず印。統括の決定 2026-11-18 13:4x の (1))', () => {
  it('行と fixture は 1 対 1 で、外形・板厚・ボスの径と中心・下の端と上の端・材質・質量が 2 つ目の組の文字から決まる値と同じ', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(BOSS_FOOT_RECORDS.map((record) => record.key));
    for (const record of BOSS_FOOT_RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const text = cells['記入のままの寸法'] ?? '';
      const thickness = dimension(text, '板左面〜板右面');
      const out = dimension(text, '左ボス端面〜板左面');
      const length = dimension(text, '左ボス端面〜右ボス端面');
      expect(cells['ボスの中心とめねじの中心'], record.key).toBe('同じ中心');
      expect([record.width, record.depth, record.thickness], record.key)
        .toEqual([dimension(text, '左外面〜右外面'), dimension(text, '上外面〜下外面'), thickness]);
      expect(record.bosses, record.key).toEqual([{ x: dimension(text, '左外面〜中央ねじ中心'), y: dimension(text, '中央ねじ中心〜下外面'),
        diameter: bossDiameter(text), bottom: -out, top: length - out }]);
      expect([record.page, record.material, record.massG], record.key).toEqual([Number(cells['PDF頁']),
        (cells['材質'] ?? '').includes('アルミ') ? 'aluminum' : '', Number(/^([0-9]+(?:\.[0-9]+)?)g$/u.exec(cells['質量_g'] ?? '')?.[1])]);
    }
  });

  it('取付け穴を持たず、印(取付け穴は作っていない・アジャスターのめねじ)を持ち、呼びにも「取付け穴は作っていない」とボスの径を書く', () => {
    for (const record of BOSS_FOOT_RECORDS) {
      expect([record.holes, record.simplified, record.outline], record.key).toEqual([[], ['取付け穴は作っていない', 'アジャスターのめねじ'], undefined]);
      expect(record.size, record.key).toContain('取付け穴は作っていない');
      expect(record.size, record.key).toContain(`ボス φ${String(record.bosses?.[0]?.diameter)}`);
      const row = FOOT_BASE_FAMILY.rows.find((candidate) => candidate.key === record.key);
      expect(row?.note, record.key).toBe('形は簡略(取付け穴は作っていない・アジャスターのめねじ)。質量は資料の 1 個の値');
    }
  });

  it('体積は板 + 板の外へ出るボスの分で、形が作れ、質量は資料の値(形 × 密度より軽い向きで、その 7 割以上)', () => {
    for (const record of BOSS_FOOT_RECORDS) {
      const row = FOOT_BASE_FAMILY.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      const bosses = (record.bosses ?? []).reduce((sum, boss) => sum
        + Math.PI * (boss.diameter / 2) ** 2 * (boss.top - boss.bottom - record.thickness), 0);
      const volume = record.width * record.depth * record.thickness + bosses;
      expect(FOOT_BASE_FAMILY.nominalVolume(row, {}), record.key).toBeCloseTo(volume, 9);
      expect(FOOT_BASE_FAMILY.build(row, {}), record.key).not.toBeNull();
      const computed = volume * ALUMINUM_G_PER_CM3 / 1000;
      expect(FOOT_BASE_FAMILY.nominalMassG?.(row, {}), record.key).toBe(record.massG);
      expect(record.massG ?? NaN, record.key).toBeLessThan(computed);
      expect(record.massG ?? NaN, record.key).toBeGreaterThanOrEqual(0.7 * computed);
    }
  });
});
