/**
 * 資料 2 のパイプ形のフレームの製品の行(pipeFrameRows.ts。一致した読みの 1 つ目の値)が、全部、一致した読みの 2 つ目の文字
 * (pipeFrameOracle.fixture.json。読みの文字のまま)と 1 行ずつ一致する事の検査。fixture の文字は、この検査が自分で読み解く
 * (行の表を作る道具の読み解きと別にする)。2 本つなぎの 1 本の高さ(外形の高さ − 中心の間)と、溝つきの鎖寸法の足し上げも、文字から確かめる。
 * fixture は JSON のファイルで、この検査がファイルとして読む(アプリのモジュールを持たない)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { PipeFrameRecord } from './pipeFrameCatalog.js';
import { PIPE_FRAME_RECORDS } from './pipeFrameRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

/** fixture の JSON を読み、行の並びを返す(形が違えば止める)。 */
function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./pipeFrameOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows) || !value.rows.every(isRow)) {
    throw new Error('fixture の形が違う');
  }
  return value.rows;
}

const FIXTURE = readFixture();

/** 寸法の文字(頭の φ は落とす。△・括弧・記入なしは数として読まない → null)。 */
function dimensionOf(text: string | undefined): number | null {
  const match = /^[φΦ]?([0-9]+(?:\.[0-9]+)?)$/u.exec((text ?? '').replace(/ /gu, ''));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** 技術データの「a×10^n」を 10^shift で割った値(読めなければ NaN)。 */
function scaledOf(text: string | undefined, shift: number): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)×10\^(-?[0-9]+)$/u.exec((text ?? '').replace(/ /gu, ''));
  return match?.[1] === undefined || match[2] === undefined ? NaN : Number(match[1]) * 10 ** (Number(match[2]) - shift);
}

function cellsOf(key: string): Cells {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found.cells;
}

const SOLID_INSIDE = '内側の形（中実で作った）';
const SLOT_NOT_MADE = '下の面の溝（溝底の位置が四角の簡略の形で決まらないため作っていない）';

describe('資料 2 のパイプ形のフレームの製品の行と 2 つ目の読み', () => {
  it('製品の行と fixture の行は同じ鍵の並びで、型番の形の文字を持たない', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(PIPE_FRAME_RECORDS.map((record) => record.key));
    for (const row of FIXTURE) expect(JSON.stringify(row), row.key).not.toMatch(/[A-Z]{2,}-[0-9]/u);
  });

  it('外形・外周の円・内径・単位質量・Ix・Iy・Zx・Zy・頁・系列が 2 つ目の読みの文字と合う(内側を中実で作った行は内径を持たない)', () => {
    for (const record of PIPE_FRAME_RECORDS) {
      const cells = cellsOf(record.key);
      // 羽つきの行の外形は、リングの所の寸法(外形の幅・高さの欄は羽を含む)。
      const fin = record.finTop !== null;
      expect([record.width, record.height], record.key).toEqual(fin
        ? [dimensionOf(cells['外形の幅(リングの所)']), dimensionOf(cells['外形の高さ(リングの所)'])]
        : [dimensionOf(cells['外形の幅']), dimensionOf(cells['外形の高さ'])]);
      // 外周の円の径は 1 本の行と、外形の幅の記入が無い 2 本つなぎが形に使う。溝つきは記入なし。
      expect(record.outerDiameter, record.key).toBe(record.kind === 'slotted' || (record.kind === 'twin' && record.width !== null) ? null
        : dimensionOf(cells['外周の円の径']));
      if (record.kind === 'slotted') expect(dimensionOf(cells['外周の円の径']), record.key).toBeNull();
      const solid = record.simplified.includes(SOLID_INSIDE);
      expect(record.innerDiameter, record.key).toBe(solid ? null : dimensionOf(cells['内径']));
      if (!solid) expect(record.innerDiameter, record.key).not.toBeNull();
      expect(record.unitMassKgPerM, record.key).toBe(dimensionOf(cells['単位質量_kg/m']));
      const pairs: readonly (readonly [keyof Pick<PipeFrameRecord, 'ixCm4' | 'iyCm4' | 'zxCm3' | 'zyCm3'>, string, number])[] = [
        ['ixCm4', 'Ix', 4], ['iyCm4', 'Iy', 4], ['zxCm3', 'Zx', 3], ['zyCm3', 'Zy', 3]];
      for (const [name, column, shift] of pairs) {
        expect(record[name], `${record.key} ${name}`).toBeCloseTo(scaledOf(cells[column], shift), 12);
      }
      expect([record.page, record.series], record.key).toEqual([dimensionOf(cells['PDF頁']), dimensionOf(cells['系列'])]);
    }
  });

  it('溝つきは 1 つの下向きの溝が中心にあり、口・中の幅と、肩の厚さ・中の高さ(鎖寸法の 2 つ。1 つ目は肩の厚さ)が文字と合う', () => {
    const slotted = PIPE_FRAME_RECORDS.filter((record) => record.kind === 'slotted');
    expect(slotted.map((record) => record.key)).toEqual(['slotted-28', 'slotted-19', 'slotted-43']);
    for (const record of slotted) {
      const cells = cellsOf(record.key);
      const chain = (cells['スロットの深さの鎖寸法'] ?? '').split(';').map(dimensionOf);
      expect([cells['スロットの数'], cells['スロットの位置']], record.key).toEqual(['1;下', '中心']);
      expect([chain.length, chain[0]], record.key).toEqual([2, dimensionOf(cells['スロットの肩の厚さ'])]);
      // 溝を作らない行(溝底の位置が決まらない)は、肩の厚さ・中の高さを持たない。
      const made = !record.simplified.includes(SLOT_NOT_MADE);
      expect([record.mouthWidth, record.roomWidth, record.shoulder, record.roomHeight], record.key).toEqual([dimensionOf(cells['スロットの口の幅']),
        dimensionOf(cells['スロットの中の幅']), made ? dimensionOf(cells['スロットの肩の厚さ']) : null, made ? chain[1] : null]);
    }
  });

  it('溝底が外形の横の中心線に重なると 2 つの読みが書いた 19 の行は、肩の厚さ + 中の高さ が 外形の高さ ÷ 2 に届かないので溝を作らない(§6-2 の (f)。統括 2026-11-18 02:2x)', () => {
    const record = PIPE_FRAME_RECORDS.find((candidate) => candidate.key === 'slotted-19');
    const cells = cellsOf('slotted-19');
    const chain = (cells['スロットの深さの鎖寸法'] ?? '').split(';').map(dimensionOf);
    const half = (dimensionOf(cells['外形の高さ']) ?? NaN) / 2;
    // 肩 2 + 中 4 = 6 と、中心線 15 ÷ 2 = 7.5 は 1.5 違う(溝の口の外の面が四角の下の面の 1.5 上になり、四角の簡略の形では閉じない)。
    expect([(chain[0] ?? NaN) + (chain[1] ?? NaN), half]).toEqual([6, 7.5]);
    expect(record?.simplified).toContain(SLOT_NOT_MADE);
    expect(record?.simplified).toContain('外周の円弧');
    expect([record?.shoulder, record?.roomHeight]).toEqual([null, null]);
    // ほかの溝つきの行は溝を作る。
    expect(PIPE_FRAME_RECORDS.filter((candidate) => candidate.simplified.includes(SLOT_NOT_MADE)).map((candidate) => candidate.key)).toEqual(['slotted-19']);
  });

  it('2 本つなぎは中心の間・仕切りの幅が文字と合い、1 本の高さ(外形の高さ − 中心の間)が外形の幅(記入が無ければ外周の円の径)と同じ', () => {
    const twins = PIPE_FRAME_RECORDS.filter((record) => record.kind === 'twin');
    expect(twins).toHaveLength(10);
    for (const record of twins) {
      const cells = cellsOf(record.key);
      expect([record.pitch, record.webWidth], record.key).toEqual([dimensionOf(cells['中心の間']), dimensionOf(cells['仕切りの幅'])]);
      expect(cells['スロットの欄'], record.key).toBe('なし');
      const across = dimensionOf(cells['外形の幅']) ?? dimensionOf(cells['外周の円の径']);
      expect((dimensionOf(cells['外形の高さ']) ?? NaN) - (dimensionOf(cells['中心の間']) ?? NaN), record.key).toBe(across);
    }
  });

  it('羽つきは 1 行で、羽の厚さと羽の先(羽の先までの高さ − リングの所の高さ ÷ 2)が文字と合い、羽は上へ 1 枚', () => {
    const fins = PIPE_FRAME_RECORDS.filter((record) => record.finTop !== null || record.finThickness !== null);
    expect(fins.map((record) => record.key)).toEqual(['pipe-28-fin']);
    for (const record of fins) {
      const cells = cellsOf(record.key);
      expect(cells['羽の向き'], record.key).toBe('上');
      expect(cells['外形の幅(羽の先まで)'], record.key).toBe('なし');
      expect(record.finThickness, record.key).toBe(dimensionOf(cells['羽の厚さ']));
      expect(record.finTop, record.key).toBe((dimensionOf(cells['外形の高さ(羽の先まで)']) ?? NaN) - (dimensionOf(cells['外形の高さ(リングの所)']) ?? NaN) / 2);
    }
  });
});
