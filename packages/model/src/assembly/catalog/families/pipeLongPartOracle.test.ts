/**
 * 資料 2 のパイプ形のフレームの系列の長物の製品の行(pipeLongPartRows.ts。40 回目の読み 2 本で一致した値。断面の外形を包む長方形 × 長さ)が、
 * 照らす側の読み(pipeLongPartOracle.fixture.json。2 本目の文字。部品の種類だけは一般の呼び)と 1 行ずつ合う事の検査(統括の決定 2026-11-20 21:2x)。
 * fixture の文字は、この検査が自分で読み解く: 断面の外形の幅と高さ(「外形の幅:30.5(…)」の頭の数)・長さの上限(切り売りの範囲の大きい方)・
 * 材質(アルミの押出材)・単位質量(kg/m)。あわせて、族の行(形・体積・質量・長さの上限・断面の性質を持たない事)を確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PIPE_LONG_PART_FAMILY } from './pipeLongPartCatalog.js';
import { PIPE_LONG_PART_RECORDS } from './pipeLongPartRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./pipeLongPartOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const NUMBER = '[0-9]+(?:\\.[0-9]+)?';

/** 「外形の幅:30.5(輪左端〜羽右面)/外形の高さ:50/…」の名前の項目の頭の数(無ければ null)。 */
function sectionValue(text: string | undefined, name: string): number | null {
  const segment = (text ?? '').split('/').find((part) => part.startsWith(`${name}:`)) ?? '';
  const match = new RegExp(`^${name}:(${NUMBER})(?:\\(|$)`, 'u').exec(segment);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** 「切り売りl=100~4000mm」→ 範囲の大きい方(無ければ null)。 */
function maxLengthOf(text: string | undefined): number | null {
  const range = new RegExp(`(${NUMBER})[~〜～](${NUMBER})`, 'u').exec(text ?? '');
  return range?.[2] === undefined ? null : Math.max(Number(range[1]), Number(range[2]));
}

/** 「アルミ押出材;0.53kg/m」→ 材料と単位質量。 */
function materialAndMassOf(text: string | undefined): readonly [string, number | null] {
  const [material = '', mass = ''] = (text ?? '').split(';');
  const unit = new RegExp(`^(${NUMBER})kg/m$`, 'u').exec(mass);
  return [material.startsWith('アルミ') ? 'aluminum' : '', unit?.[1] === undefined ? null : Number(unit[1])];
}

describe('資料 2 のパイプ形のフレームの系列の長物の製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たず、部品の種類は一般の呼び(製品の行の呼びの頭)', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(PIPE_LONG_PART_RECORDS.map((record) => record.key));
    expect(PIPE_LONG_PART_RECORDS.length).toBeGreaterThan(0);
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/(?<![0-9A-Za-z])[A-Z]{2,4}[0-9]{0,3}-[0-9A-Z]{2,}/u);
    for (const record of PIPE_LONG_PART_RECORDS) {
      const kind = FIXTURE.find((row) => row.key === record.key)?.cells['部品の種類'];
      expect([kind, record.size.startsWith(`${kind ?? '?'} `)], record.key).toEqual([record.kind, true]);
    }
  });

  it('断面の外形の幅と高さ・長さの上限・材質・単位質量・頁が照らす側の読みと合う', () => {
    for (const record of PIPE_LONG_PART_RECORDS) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      expect([sectionValue(cells['断面'], '外形の幅'), sectionValue(cells['断面'], '外形の高さ'), maxLengthOf(cells['長さ'])], record.key)
        .toEqual([record.width, record.height, record.maxLength]);
      expect([...materialAndMassOf(cells['材質と質量']), Number(cells['PDF頁'])], record.key)
        .toEqual([record.material, record.unitMassKgPerM, record.page]);
    }
  });

  it('族の行は行の表の並びで、形は断面の長方形 × 長さ、質量は単位質量 × 長さ、上限を超える長さは作らず、断面の性質を持たない', () => {
    expect(PIPE_LONG_PART_FAMILY.rows.map((row) => row.key)).toEqual(PIPE_LONG_PART_RECORDS.map((record) => record.key));
    const values = { length: '300' };
    for (const record of PIPE_LONG_PART_RECORDS) {
      const row = PIPE_LONG_PART_FAMILY.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(PIPE_LONG_PART_FAMILY.build(row, values)?.name, record.key).toBe(`${record.size}×300`);
      expect(PIPE_LONG_PART_FAMILY.nominalVolume(row, values) ?? NaN, record.key).toBeCloseTo(record.width * record.height * 300, 9);
      expect(PIPE_LONG_PART_FAMILY.nominalMassG?.(row, values) ?? null, record.key)
        .toBe(record.unitMassKgPerM === null ? null : record.unitMassKgPerM * 300);
      expect([row.dims.ixCm4, row.dims.iyCm4, row.note.endsWith('断面の性質は持たない')], record.key).toEqual([undefined, undefined, true]);
      if (record.maxLength !== null) {
        const over = { length: String(record.maxLength + 1) };
        expect([PIPE_LONG_PART_FAMILY.build(row, over), PIPE_LONG_PART_FAMILY.nominalVolume(row, over)], record.key).toEqual([null, null]);
      }
    }
  });
});
