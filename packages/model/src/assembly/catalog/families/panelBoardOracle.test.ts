/**
 * 板の族の製品の行(panelBoardRows.ts)が、照らす側の読み(panelBoardOracle.fixture.json。14 回目の 2 本目の文字。14 回目でサイズが割れた行の
 * サイズだけは、17 回目の読み直しの 2 本目の文字)と 1 行ずつ合う事の検査。
 * fixture の文字は、この検査が自分で読み解く(行の表を作る道具の読み解きと別にする): 板厚・サイズ(MAX か定尺)・面積あたりの質量(g/m² は kg/m²)・比重、
 * ベースプレートは板厚の並びと板厚ごとの A・B の範囲の上の端。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PANEL_BOARD_FIXED_FAMILY, PANEL_BOARD_ORDER_FAMILY } from './panelBoardCatalog.js';
import { PANEL_BOARD_RECORDS } from './panelBoardRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./panelBoardOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const NUMBER = /^([0-9]+(?:\.[0-9]+)?)/u;

function cellsOf(key: string): Cells {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found.cells;
}

const numberOf = (text: string | undefined): number | null => {
  const match = NUMBER.exec(text ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
};

const numbersOf = (text: string): readonly number[] => [...text.matchAll(/[0-9]+(?:\.[0-9]+)?/gu)].map((match) => Number(match[0]));

/**
 * 「MAX:2000×1000」「定尺:1120×2020」「サイズ:2000×1000」「サイズ(mm):2000×1000」→ 種類と 2 つの数(単位の語は外す。サイズの列は定尺)。
 * 17 回目の読み直しの「A範囲:~600・~900/B範囲:~450・~600」→ 注文の寸法で、上限は A・B それぞれの記入の中で最も大きい値。
 */
function sizeOf(text: string | undefined): { readonly kind: 'max' | 'fixed'; readonly size: readonly [number, number] } | null {
  const value = (text ?? '').replace('(mm)', '').replaceAll('mm', '');
  const range = /^A範囲:(.+)B範囲:(.+)$/u.exec(value);
  if (range !== null) {
    const [a, b] = [numbersOf(range[1] ?? ''), numbersOf(range[2] ?? '')];
    return a.length === 0 || b.length === 0 ? null : { kind: 'max', size: [Math.max(...a), Math.max(...b)] };
  }
  const match = /^(MAX|定尺|サイズ):([0-9.]+)[×x]([0-9.]+)$/u.exec(value);
  return match?.[1] === undefined || match[2] === undefined || match[3] === undefined ? null
    : { kind: match[1] === 'MAX' ? 'max' : 'fixed', size: [Number(match[2]), Number(match[3])] };
}

/** 面積あたりの質量(kg/m²。g/m² は 1000 で割る)。 */
function perAreaOf(text: string | undefined): number | null {
  const match = /^([0-9.]+)(kg|g)\/m[²2]/u.exec(text ?? '');
  return match?.[1] === undefined ? null : Number(match[1]) / (match[2] === 'g' ? 1000 : 1);
}

/** ベースプレートの板寸法から、板厚ごとの A・B の範囲の上の端(板厚の書き分けが無ければ '*')。 */
function plateMaxOf(text: string | undefined): ReadonlyMap<string, readonly [number, number]> {
  const value = (text ?? '').replaceAll('mm', '').replaceAll('/', '').replaceAll('()', '');
  const parts = value.includes('t=') ? value.split(';') : [value.replaceAll(';', '')];
  const found = new Map<string, readonly [number, number]>();
  for (const part of parts) {
    const match = /^(?:t=([0-9.]+))?A[:=]([0-9.]+)(?:~([0-9.]+))?B[:=]([0-9.]+)(?:~([0-9.]+))?$/u.exec(part);
    if (match === null) continue;
    found.set(match[1] ?? '*', [Number(match[3] ?? match[2]), Number(match[5] ?? match[4])]);
  }
  return found;
}

describe('板の族の製品の行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番の形の文字を持たず、行は定尺と注文の寸法の族に分かれる', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(PANEL_BOARD_RECORDS.map((record) => record.key));
    for (const row of FIXTURE) expect(JSON.stringify(row.cells), row.key).not.toMatch(/[A-Z]{2,3}-[0-9A-Z]{2,}/u);
    expect(PANEL_BOARD_FIXED_FAMILY.rows.length + PANEL_BOARD_ORDER_FAMILY.rows.length).toBe(PANEL_BOARD_RECORDS.length);
    expect(PANEL_BOARD_FIXED_FAMILY.rows.map((row) => row.key)).toEqual(PANEL_BOARD_RECORDS.filter((record) => record.fixedSize !== null)
      .map((record) => record.key));
  });

  it('パネルボードの板厚・サイズ・質量の出し方が照らす側の読みと合う', () => {
    for (const record of PANEL_BOARD_RECORDS.filter((candidate) => !candidate.key.startsWith('plate-'))) {
      const cells = cellsOf(record.key);
      const size = sizeOf(cells['サイズ']);
      expect([record.thickness, record.page], record.key).toEqual([numberOf(cells['板厚']), numberOf(cells['PDF頁'])]);
      expect([record.fixedSize, record.maxSize], record.key).toEqual(size?.kind === 'fixed' ? [[...size.size], null] : [null, size === null ? null : [...size.size]]);
      const perArea = perAreaOf(cells['面積あたりの質量']);
      expect([record.massKgPerM2, record.specificGravity], record.key).toEqual([perArea, perArea === null ? numberOf(cells['比重']) : null]);
      // 資料のサイズの列(定尺か上限かの語が無い)の値を定尺として入れた行だけ、備考に印を持つ(統括の決定 2026-11-18 14:4x)。
      const fromSizeColumn = (cells['サイズ'] ?? '').startsWith('サイズ');
      expect(record.sizeNote, record.key).toBe(fromSizeColumn ? 'サイズは資料のサイズ列の値。定尺か上限かの語は資料に無い' : undefined);
      const row = [...PANEL_BOARD_FIXED_FAMILY.rows, ...PANEL_BOARD_ORDER_FAMILY.rows].find((candidate) => candidate.key === record.key);
      expect(row?.note.endsWith('定尺か上限かの語は資料に無い') ?? false, record.key).toBe(fromSizeColumn);
    }
  });

  it('ベースプレートは板厚ごとの行で、板厚は並びの中、上限はその板厚の A・B の範囲の上の端', () => {
    for (const record of PANEL_BOARD_RECORDS.filter((candidate) => candidate.key.startsWith('plate-'))) {
      const cells = cellsOf(record.key);
      const thicknesses = (cells['板厚の並び'] ?? '').split(';').map(Number);
      const sizes = plateMaxOf(cells['板寸法']);
      const thickness = String(record.thickness);
      expect(thicknesses, record.key).toContain(record.thickness);
      expect(record.maxSize, record.key).toEqual([...(sizes.get(thickness) ?? sizes.get('*') ?? [])]);
      expect([record.fixedSize, record.massKgPerM2, record.specificGravity], record.key).toEqual([null, null, null]);
    }
  });
});
