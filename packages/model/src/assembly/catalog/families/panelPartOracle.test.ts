/**
 * パネル扉の部品とパネル用のフレームの製品の行(panelPartRows.ts。17 回目の読み 2 本で一致した値)が、照らす側の読み
 * (panelPartOracle.fixture.json。17 回目の 2 本目の文字)と 1 行ずつ合う事の検査。fixture の文字は、この検査が自分で読み解く:
 * 部品は全体の記入の 3 つの数(横の数に幅、縦の数に高さ、残りが奥行)・材質の語・1 個の質量、フレームは断面の記入の横と縦の最も大きい数・単位質量。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PANEL_COVER_FRAME_RECORDS, PANEL_PART_RECORDS } from './panelPartRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): { readonly parts: readonly FixtureRow[]; readonly frames: readonly FixtureRow[] } {
  const value: unknown = JSON.parse(readFileSync(new URL('./panelPartOracle.fixture.json', import.meta.url), 'utf8'));
  const list = (name: string): readonly FixtureRow[] => {
    const rows: unknown = typeof value === 'object' && value !== null && name in value ? Object.entries(value).find(([key]) => key === name)?.[1]
      : undefined;
    if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error(`fixture の ${name} の形が違う`);
    return rows;
  };
  return { parts: list('parts'), frames: list('frames') };
}

const FIXTURE = readFixture();

/** 「横:23.8(…)/縦:20(…);30.5(…)」→ 向きごとの数(括弧の参考寸法・φ・「なし」は外す)。 */
function directions(text: string | undefined): ReadonlyMap<string, readonly number[]> {
  const found = new Map<string, readonly number[]>();
  for (const segment of (text ?? '').split('/')) {
    const [name, body] = segment.split(':');
    if (name === undefined || body === undefined) continue;
    found.set(name, body.split(';').flatMap((item) => {
      const match = /^([0-9]+(?:\.[0-9]+)?)\(/u.exec(item);
      return match?.[1] === undefined ? [] : [Number(match[1])];
    }));
  }
  return found;
}

const sorted = (values: readonly number[]): readonly number[] => [...values].sort((a, b) => a - b);
const MATERIAL_WORDS: readonly (readonly [string, string])[] = [['アルミ', 'aluminum'], ['ステンレス', 'stainless'], ['鉄', 'steel'], ['鋼', 'steel']];
const LABELS: Readonly<Record<string, string>> = { aluminum: 'アルミ', stainless: 'ステンレス', steel: '鉄' };

/** 材質の記入の材料の語(記入の中の順、同じ材料は 1 つ)。 */
function materialsOf(text: string | undefined): readonly string[] {
  const value = text ?? '';
  const first = new Map<string, number>();
  for (const [word, material] of MATERIAL_WORDS) {
    const position = value.indexOf(word);
    if (position >= 0) first.set(material, Math.min(position, first.get(material) ?? position));
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([material]) => material);
}

describe('パネル扉の部品とパネル用のフレームの製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たない', () => {
    expect(FIXTURE.parts.map((row) => row.key)).toEqual(PANEL_PART_RECORDS.map((record) => record.key));
    expect(FIXTURE.frames.map((row) => row.key)).toEqual(PANEL_COVER_FRAME_RECORDS.map((record) => record.key));
    for (const row of [...FIXTURE.parts, ...FIXTURE.frames]) expect(JSON.stringify(row.cells), row.key).not.toMatch(/[A-Z]{2,3}-[0-9A-Z]{2,}/u);
  });

  it('部品の箱の 3 つの寸法・材質・質量・頁が照らす側の読みと合う(幅は横の数、高さは縦の数、奥行は残りの数)', () => {
    for (const record of PANEL_PART_RECORDS) {
      const cells = FIXTURE.parts.find((row) => row.key === record.key)?.cells ?? {};
      const found = directions(cells['全体の記入']);
      const every = [...found.values()].flat();
      expect(sorted(every), record.key).toEqual(sorted([record.width, record.depth, record.height]));
      expect(found.get('横') ?? [], record.key).toContain(record.width);
      expect(found.get('縦') ?? [], record.key).toContain(record.height);
      const materials = materialsOf(cells['材質']);
      expect(record.material === 'mixed' ? record.materialText : record.material, record.key)
        .toBe(record.material === 'mixed' ? materials.map((material) => LABELS[material]).join('・') : materials[0]);
      expect([record.massG, record.page], record.key).toEqual([Number(/^([0-9.]+)g$/u.exec(cells['質量_g'] ?? '')?.[1]), Number(cells['PDF頁'])]);
      // 部品の種類は一般の呼び(資料の品名でない。統括の決定 2026-11-18 14:4x の (3))で、製品の行の呼びの頭と同じ。
      expect(record.size.startsWith(`${cells['部品の種類'] ?? '?'} `), record.key).toBe(true);
      expect(cells['部品の種類']?.startsWith(record.kind), record.key).toBe(true);
    }
  });

  it('フレームの断面の外形(横と縦の最も大きい数)・単位質量・頁が照らす側の読みと合い、材質はアルミ', () => {
    for (const record of PANEL_COVER_FRAME_RECORDS) {
      const cells = FIXTURE.frames.find((row) => row.key === record.key)?.cells ?? {};
      const found = directions(cells['断面の記入のままの寸法']);
      expect([Math.max(...(found.get('横') ?? [])), Math.max(...(found.get('縦') ?? []))], record.key).toEqual([record.width, record.height]);
      expect([record.unitMassKgPerM, record.page], record.key).toEqual([Number(/^([0-9.]+)kg\/m$/u.exec(cells['単位質量'] ?? '')?.[1]),
        Number(cells['PDF頁'])]);
      expect(materialsOf(cells['材質']), record.key).toEqual(['aluminum']);
    }
  });
});
