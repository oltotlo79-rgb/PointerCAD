/**
 * 資料 2 のキャップとフットの製品の行(pipeFramePartRows.ts)が、照らす側の読み(pipeFramePartOracle.fixture.json。2 本目の読み B か、
 * Codex の試しの一致した段の文字のまま)と 1 行ずつ一致する事の検査。fixture の文字は、この検査が自分で読み解く(行の表を作る道具の読み解きと別にする)。
 * T1(記入の無い最後の段の高さ = 全体の高さ − ほかの段の高さ)は、記録の条件のある行だけ、この検査が照らす側の文字から計算し直して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { StackSegment } from '../profiles/stackedPart.js';
import type { PipeFramePartRecord } from './pipeFramePartCatalog.js';
import { PIPE_FRAME_CAP_RECORDS, PIPE_FRAME_FOOT_RECORDS } from './pipeFramePartRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells; readonly alignment: readonly (readonly string[])[]; readonly override: string }

const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && 'alignment' in value && 'override' in value && typeof value.key === 'string' && isCells(value.cells) && Array.isArray(value.alignment)
  && value.alignment.every(isStrings) && typeof value.override === 'string';

function readFixture(): Readonly<Record<'cap' | 'foot', readonly FixtureRow[]>> {
  const value: unknown = JSON.parse(readFileSync(new URL('./pipeFramePartOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('fixture の形が違う');
  const rows = (name: string): readonly FixtureRow[] => {
    const list: unknown = Object.entries(value).find(([key]) => key === name)?.[1];
    if (!Array.isArray(list) || !list.every(isRow)) throw new Error(`fixture の ${name} の形が違う`);
    return list;
  };
  return { cap: rows('cap'), foot: rows('foot') };
}

const FIXTURE = readFixture();

function numberOf(text: string | undefined): number {
  return /^[0-9]+(?:\.[0-9]+)?$/u.test(text ?? '') ? Number(text) : NaN;
}

/** 「形=円;径=39.4;高さ=15 / 形=四角;幅=43;奥行=43;高さ=3」→ 段ごとの欄。 */
function segmentsOf(text: string): readonly Readonly<Record<string, string>>[] {
  return text.split(' / ').filter((group) => group.trim() !== '').map((group) => Object.fromEntries(group.split(';')
    .filter((part) => part.includes('=')).map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)])));
}

/** 材質の文字から密度の口(一つの材料の PA → nylon・ABS → abs・アルミ → aluminum。ほかの材料・部位ごとの材料は口なし)。 */
function densityOf(text: string): string | null {
  if (/[;、]|部位|部品/u.test(text)) return null;
  if (/PA/u.test(text)) return 'nylon';
  if (/ABS/u.test(text)) return 'abs';
  return /アルミ/u.test(text) ? 'aluminum' : null;
}

function check(record: PipeFramePartRecord, row: FixtureRow): void {
  const cells = row.cells;
  const read = segmentsOf(cells['段'] ?? '');
  const t1 = row.alignment.find((item) => item[4] === 'T1');
  // 作った段は、読みの段の並びの頭からの続き(決まらない段から先は作らない)。
  expect(record.segments.length, record.key).toBeLessThanOrEqual(read.length);
  record.segments.forEach((segment: StackSegment, index) => {
    const cell = read[index] ?? {};
    const last = index === record.segments.length - 1;
    const height = last && t1 !== undefined
      ? numberOf(cells['全体の高さ']) - record.segments.slice(0, index).reduce((sum, item) => sum + item.height, 0)
      : numberOf(cell['高さ']);
    if (segment.shape === 'circle') {
      expect([cell['形'], segment.diameter, segment.height], `${record.key} 段 ${index + 1}`).toEqual(['円', numberOf(cell['径']), height]);
    } else {
      expect([cell['形'], segment.width, segment.depth, segment.height], `${record.key} 段 ${index + 1}`)
        .toEqual(['四角', numberOf(cell['幅']), numberOf(cell['奥行']), height]);
    }
    if (segment.bore !== null) expect(segment.bore, record.key).toBe(numberOf(cell['中の穴']));
  });
  if (t1 !== undefined) {
    // T1 の条件: ねじが無い(付属品は、2 本の備考が全体の高さに段を含むと書いた時か、ほかの独立の読みが一致した時だけ)。
    expect(cells['ねじ'], record.key).toBe('なし');
    expect(read[record.segments.length - 1]?.['高さ'], record.key).toBe('記入なし');
  }
  expect([record.series, record.page], record.key).toEqual([numberOf(cells['系列']), numberOf(cells['PDF頁'])]);
  expect(record.massG ?? NaN, record.key).toEqual(numberOf(cells['質量_g']));
  expect(record.densityMaterialId, record.key).toBe(densityOf(cells['材質'] ?? ''));
  const male = /^おねじ M([0-9]+(?:\.[0-9]+)?);長さ=([0-9]+(?:\.[0-9]+)?)/u.exec(cells['ねじ'] ?? '');
  expect(record.thread, record.key).toEqual(male === null ? null : { size: `M${male[1] ?? ''}`, length: Number(male[2]) });
}

describe('資料 2 のキャップとフットの照らす側の読みとの照らし', () => {
  it('fixture の行の鍵は製品の行の鍵と同じ並び', () => {
    expect(FIXTURE.cap.map((row) => row.key)).toEqual(PIPE_FRAME_CAP_RECORDS.map((record) => record.key));
    expect(FIXTURE.foot.map((row) => row.key)).toEqual(PIPE_FRAME_FOOT_RECORDS.map((record) => record.key));
  });

  it('段の形・寸法・高さ(T1 は計算し直す)・系列・頁・質量・密度の口・おねじが照らす側の文字と一致', () => {
    for (const [records, rows] of [[PIPE_FRAME_CAP_RECORDS, FIXTURE.cap], [PIPE_FRAME_FOOT_RECORDS, FIXTURE.foot]] as const) {
      records.forEach((record, index) => {
        const row = rows[index];
        if (row === undefined) throw new Error(`fixture に ${record.key} が無い`);
        check(record, row);
      });
    }
  });

  it('Codex の試しで決めた行は、根拠の文を fixture に持つ', () => {
    const overrides = [...FIXTURE.cap, ...FIXTURE.foot].filter((row) => row.override !== '').map((row) => row.override);
    expect(overrides.length).toBeGreaterThan(0);
    overrides.forEach((text) => expect(text).toMatch(/Codex/u));
  });
});
