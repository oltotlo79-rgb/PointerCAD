/**
 * 資料 1 の長方形の板(アジャスタプレート・アジャスタキャスタープレート)のうち、39 回目の 2 本の読みで揃った型番の行(extraFootBaseRows.ts)の検査。
 * 照らす側の読み(extraFootBaseOracle.fixture.json。2 本目の読みの種類・板・穴・材質と質量の文字)を、この検査が自分で読み解く:
 * 板の横・縦・厚さは記入のまま。穴は組ごとの「数-径@横: 鎖/縦: 鎖」で、鎖は括弧の外の数を端から足し上げ、向こうの端に届く数は外す。
 * 1 つの穴の組は基準の穴、基準の穴のある型番の数の多い組は、基準の列と同じ数を外した横の位置が基準の行の上、基準の行と同じ数を外した
 * 縦の位置が基準の列の上の穴。2 つの群に分かれた組は、横は群ごとの列、縦は「…群 2 段」の順に端から当てる。
 * 質量は、資料の質量が長方形の板 × 密度の 7 割以上(今のベースの板の行の決まり)で、10% 以内の時だけ行の値。めねじは作らず印。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { footBaseProfile } from '../profiles/framePartShapes.js';
import { BOSS_FOOT_RECORDS } from './bossFootRows.js';
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
  const value: unknown = JSON.parse(readFileSync(new URL('./extraFootBaseOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const DENSITY: Readonly<Record<string, number>> = { steel: 7.85, stainless: 7.93 };
type Hole = readonly [number, number, number];

/** 括弧の外の数(鎖の値)。 */
function chain(text: string): readonly number[] {
  return [...text.replace(/\([^()]*\)/gu, ' ').matchAll(/[0-9]+(?:\.[0-9]+)?/gu)].map((match) => Number(match[0]));
}

/** 鎖を端から足し上げた位置(向こうの端に届く最後の数は外す)。 */
function positions(values: readonly number[], total: number): readonly number[] {
  const found: number[] = [];
  let at = 0;
  for (const value of values) {
    at += value;
    found.push(at);
  }
  return found.length > 0 && Math.abs((found.at(-1) ?? NaN) - total) < 1e-6 ? found.slice(0, -1) : found;
}

/** 縦の鎖が上の端から始まるか。 */
const fromTop = (text: string): boolean => text.includes('上端から') || text.startsWith('上端') || text.includes('(上端');

/** 「横:14、20(左端〜左側群の2列)、96、60(左端〜右側群の2列)」→ 群の左右と列の位置。 */
function sideGroups(across: string, width: number): readonly (readonly [string, readonly number[]])[] {
  return [...across.matchAll(/((?:[0-9]+(?:\.[0-9]+)?、?)+)\([^()]*?(左|右)(?:上|下)?側?群[^()]*\)/gu)]
    .map((match) => [match[2] ?? '', positions(chain(match[1] ?? ''), width)] as const);
}

/** 2 本目の読みの穴の記入 → 穴(左下からの x・y・径。並べ替えた物)。読めない時は空。 */
function holesOf(text: string, width: number, depth: number): readonly Hole[] {
  const holes: Hole[] = [];
  let reference: readonly [number, number] | undefined;
  for (const group of text.replace(/\s+/gu, '').split(';')) {
    const head = /^(?:([0-9]+)-)?φ([0-9]+(?:\.[0-9]+)?)(?:\([^()]*\))?@/u.exec(group);
    if (head === null) return [];
    const count = Number(head[1] ?? 1);
    const diameter = Number(head[2]);
    const [acrossText = '', up = ''] = group.slice(head[0].length).split('/縦:');
    const across = acrossText.replace(/^横:/u, '');
    const top = fromTop(up);
    const groups = sideGroups(across, width);
    if (count === 1 && groups.length === 0) {
      const [x = NaN] = chain(across);
      const [y = NaN] = chain(up);
      reference = [x, top ? depth - y : y];
      holes.push([reference[0], reference[1], diameter]);
      continue;
    }
    const rows = positions(chain(up), depth).map((value) => (top ? depth - value : value));
    if (groups.length > 0) {
      // 「…(下端から右下群2段、左上群2段の順)」: 端から順に段を群へ当てる。
      const ordered = [...rows].sort((a, b) => (top ? b - a : a - b));
      let at = 0;
      for (const match of up.matchAll(/(左|右)(?:上|下)?群([0-9]+)段/gu)) {
        const columns = groups.find(([side]) => side === match[1])?.[1] ?? [];
        const taken = ordered.slice(at, at + Number(match[2]));
        at += Number(match[2]);
        for (const y of taken) for (const x of columns) holes.push([x, y, diameter]);
      }
      continue;
    }
    const columns = positions(chain(across), width);
    const base = reference;
    if (base !== undefined && columns.includes(base[0]) && rows.includes(base[1])) {
      for (const x of columns) if (x !== base[0]) holes.push([x, base[1], diameter]);
      for (const y of rows) if (y !== base[1]) holes.push([base[0], y, diameter]);
    } else {
      for (const x of columns) for (const y of rows) holes.push([x, y, diameter]);
    }
  }
  return [...holes].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** 「外形の横:166(…)/外形の縦:125(…)/厚さ:9(…)/外形の形:長方形」→ 横・縦・厚さ。 */
function plateOf(text: string): readonly number[] {
  const value = text.replace(/\s+/gu, '');
  return ['外形の横', '外形の縦', '厚さ'].map((name) => Number(new RegExp(`${name}:([0-9]+(?:\\.[0-9]+)?)`, 'u').exec(value)?.[1] ?? NaN));
}

describe('資料 1 の長方形の板の 39 回目の 2 本の読みで揃った型番の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、板・穴・材質・質量・印が 2 本目の読みから決まる値と合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(EXTRA_FOOT_BASE_RECORDS.map((record) => record.key));
    expect(EXTRA_FOOT_BASE_RECORDS.length).toBeGreaterThan(0);
    for (const record of EXTRA_FOOT_BASE_RECORDS) {
      const row = FIXTURE.find((item) => item.key === record.key);
      if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
      expect(JSON.stringify(row), record.key).not.toMatch(/(?<![0-9A-Za-z])[A-Z]{3}-[A-Z0-9]{2,}/u);
      const [width = NaN, depth = NaN, thickness = NaN] = plateOf(row.plate);
      expect([record.width, record.depth, record.thickness, row.plate.includes('長方形')], record.key).toEqual([width, depth, thickness, true]);
      const holes = holesOf(row.holes, width, depth);
      expect(record.holes, record.key).toEqual(holes);
      const [materialText = '', massText = ''] = row.material.split(';');
      const material = /SUS|ステン/u.test(materialText) ? 'stainless' : 'steel';
      const mass = /([0-9]+(?:\.[0-9]+)?)(k?)g/u.exec(massText);
      const catalog = Number(mass?.[1] ?? NaN) * (mass?.[2] === 'k' ? 1000 : 1);
      const computed = (width * depth - holes.reduce((sum, [, , size]) => sum + Math.PI * size ** 2 / 4, 0)) * thickness * (DENSITY[material] ?? NaN) / 1000;
      // 資料の質量は長方形の板 × 密度の 7 割以上(今の決まり)。10% 以内の時だけ行の質量。
      expect(catalog >= 0.7 * computed, record.key).toBe(true);
      expect([record.material, record.massG, record.page, record.kind, record.simplified], record.key).toEqual([material,
        Math.abs(catalog - computed) <= 0.1 * computed ? catalog : null, Number(row.page), 'アジャスターベース', ['アジャスターのめねじ']]);
      expect(record.size.startsWith(`アジャスターベース${row.kind.includes('キャスタープレート') ? '（キャスターも付けられる板）' : ''} `), record.key).toBe(true);
    }
  });

  it('族の行はボス付きの板の後に並び、形ができて名前は呼び、体積は板の面積 × 厚さ、質量は行の値(無い行は持たない)', () => {
    const start = FOOT_BASE_RECORDS.length + BOSS_FOOT_RECORDS.length;
    const tail = FOOT_BASE_FAMILY.rows.slice(start, start + EXTRA_FOOT_BASE_RECORDS.length);
    expect(tail.map((row) => row.key)).toEqual(EXTRA_FOOT_BASE_RECORDS.map((record) => record.key));
    for (const record of EXTRA_FOOT_BASE_RECORDS) {
      const row = tail.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(FOOT_BASE_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      expect(FOOT_BASE_FAMILY.nominalVolume(row, {}) ?? NaN, record.key).toBeCloseTo((footBaseProfile(record)?.areaMm2 ?? NaN) * record.thickness, 9);
      expect(FOOT_BASE_FAMILY.nominalMassG?.(row, {}) ?? null, record.key).toBe(record.massG);
      expect([row.densityMaterialId, row.simplified], record.key).toEqual([record.material, record.simplified]);
    }
  });
});
