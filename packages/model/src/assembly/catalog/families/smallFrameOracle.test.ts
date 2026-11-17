/**
 * 資料 SF-1 の小さい溝つきフレーム・端のキャップ・ブラケット素材の製品の行(smallFrameRows.ts。1 本目の読みの値)が、2 本目の読みの文字
 * (smallFrameOracle.fixture.json。読みの文字のまま)と 1 行ずつ一致する事の検査。fixture の文字は、この検査が自分で読み解く(行の表を作る道具の
 * 読み解きと別にする): 溝の組(面・口・中の幅・肩・中の高さ・口の中心〔中心・下から N・鎖寸法 P;…;本数=n の対称の並び〕)、穴(中心間 N の対・中心)、
 * ブラケット素材の角の面の端(右の端から・上の端から)、技術データ(a×10^n)。半円溝の組と寸法の記入の無い組は、作らない溝として数えない。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BRACKET_STOCK_RECORDS, SMALL_FRAME_CAP_RECORDS, SMALL_FRAME_RECORDS } from './smallFrameRows.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly table: string; readonly cells: Cells }

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'table' in value
  && 'cells' in value && typeof value.key === 'string' && typeof value.table === 'string' && isCells(value.cells);

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./smallFrameOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows) || !value.rows.every(isRow)) {
    throw new Error('fixture の形が違う');
  }
  return value.rows;
}

const FIXTURE = readFixture();
const NUMBER = /^[0-9]+(?:\.[0-9]+)?$/u;
const FACES: Readonly<Record<string, string>> = { 上: 'top', 下: 'bottom', 左: 'left', 右: 'right' };

function cellsOf(key: string): Cells {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found.cells;
}

const numberOf = (text: string | undefined): number => (NUMBER.test((text ?? '').trim()) ? Number(text) : NaN);

/** 技術データの「a×10^n」を 10^shift で割った値。 */
function scaledOf(text: string | undefined, shift: number): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)×10\^(-?[0-9]+)$/u.exec((text ?? '').replace(/ /gu, ''));
  return match?.[1] === undefined || match[2] === undefined ? NaN : Number(match[1]) * 10 ** (Number(match[2]) - shift);
}

/** 溝の口の中心の並び(断面の中心から)。読めなければ null。 */
function positionsOf(text: string, face: string, width: number, height: number): readonly number[] | null {
  const trimmed = text.trim();
  if (trimmed === '中心') return [0];
  const from = /^(左|下)から([0-9]+(?:\.[0-9]+)?)$/u.exec(trimmed);
  if (from?.[2] !== undefined) return [Number(from[2]) - ((face === 'top' || face === 'bottom') ? width : height) / 2];
  const chain = /^鎖寸法 ([0-9.;]+)\(.*対称.*\);本数=([0-9]+)$/u.exec(trimmed);
  if (chain?.[1] === undefined || chain[2] === undefined) return null;
  const steps = chain[1].split(';').map(Number);
  const count = Number(chain[2]);
  const step = steps[0] ?? NaN;
  if (steps.length !== count - 1 || steps.some((value) => value !== step)) return null;
  return Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * step);
}

/** 溝の欄の文字 → 作る溝(寸法と位置が全部読める組だけ。半円溝と記入の無い組は数えない)の並び(比べるための文字)。 */
function slotsOf(text: string, width: number, height: number): readonly string[] {
  return text.split(' / ').flatMap((group) => {
    if (group.includes('半円溝') || group.includes('記入なし') || group.includes('△')) return [];
    const value = (key: string): number => numberOf(new RegExp(`${key}=([0-9.]+)(?:;|$)`, 'u').exec(group)?.[1]);
    const face = FACES[/面=([上下左右])/u.exec(group)?.[1] ?? ''] ?? '';
    const where = /口の中心=(.*)$/u.exec(group)?.[1] ?? '';
    const positions = positionsOf(where, face, width, height) ?? [];
    return positions.map((position) => [face, value('口の幅'), value('中の幅'), value('肩の厚さ'), value('中の高さ'), position].join('|'));
  }).sort();
}

/** 穴の欄の文字 → 穴(断面の中心から)の並び。 */
function holesOf(text: string, height: number): readonly string[] {
  if (text === 'なし' || text.startsWith('記入なし')) return [];
  const holes = new Set<string>();
  for (const group of text.split(' / ')) {
    const pair = /^φ([0-9.]+)@中心間([0-9.]+)\(対称\)・下から([0-9.]+)$/u.exec(group.trim());
    if (pair?.[1] !== undefined && pair[2] !== undefined && pair[3] !== undefined) {
      for (const sign of [-1, 1]) holes.add([Number(pair[1]), sign * Number(pair[2]) / 2, Number(pair[3]) - height / 2].join('|'));
      continue;
    }
    const middle = /^φ([0-9.]+)@中心(?:・中心)?$/u.exec(group.trim());
    if (middle?.[1] !== undefined) holes.add([Number(middle[1]), 0, 0].join('|'));
  }
  return [...holes].sort();
}

describe('資料 SF-1 の小さい溝つきフレーム・端のキャップ・ブラケット素材の製品の行と 2 本目の読み', () => {
  it('fixture の行は製品の行と同じ鍵の並びで、図の名前・型番の形の文字を持たない', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual([...SMALL_FRAME_RECORDS, ...SMALL_FRAME_CAP_RECORDS, ...BRACKET_STOCK_RECORDS].map((record) => record.key));
    for (const row of FIXTURE) expect(JSON.stringify(row), row.key).not.toMatch(/UF-|SS[0-9]|SF-15|S[0-9]{4}|M4[0-9]{4}/u);
  });

  it('小さい溝つきフレームの外形・作る溝・穴・単位質量・頁が 2 本目の文字と合う', () => {
    for (const record of SMALL_FRAME_RECORDS) {
      const cells = cellsOf(record.key);
      expect([record.width, record.height, record.unitMassKgPerM, record.page], record.key)
        .toEqual([numberOf(cells['外形の幅']), numberOf(cells['外形の高さ']), numberOf(cells['単位質量(kg/m)']), numberOf(cells['PDF頁'])]);
      const made = record.slots.map((slot) => [slot.face, slot.mouthWidth, slot.roomWidth, slot.shoulder, slot.roomHeight, slot.position].join('|')).sort();
      expect(made, record.key).toEqual(slotsOf(cells['溝'] ?? '', record.width, record.height));
      expect(record.holes.map((hole) => [hole.diameter, hole.x, hole.y].join('|')).sort(), record.key)
        .toEqual(holesOf(cells['穴'] ?? '', record.height));
    }
  });

  it('端のキャップの板の幅・高さ・厚さ・質量・頁が 2 本目の文字と合い、合うフレームは小さい溝つきフレームの行', () => {
    for (const record of SMALL_FRAME_CAP_RECORDS) {
      const cells = cellsOf(record.key);
      expect([record.width, record.height, record.thickness, record.massG, record.page], record.key).toEqual([numberOf(cells['板の幅']),
        numberOf(cells['板の高さ']), numberOf(cells['板の厚さ']), numberOf(cells['質量_g']), numberOf(cells['PDF頁'])]);
      expect(record.key).toBe(`cap-${cells['合うフレームの鍵'] ?? ''}`);
    }
  });

  it('ブラケット素材の外形・板の厚さ・角の面の端(辺の長さ − 記入)・穴・技術データが 2 本目の文字と合う', () => {
    for (const record of BRACKET_STOCK_RECORDS) {
      const cells = cellsOf(record.key);
      expect([record.height, record.width, record.verticalThickness, record.horizontalThickness, record.unitMassKgPerM], record.key)
        .toEqual([numberOf(cells['縦の辺の長さ']), numberOf(cells['横の辺の長さ']), numberOf(cells['縦の板の厚さ']), numberOf(cells['横の板の厚さ']),
          numberOf(cells['単位質量(kg/m)'])]);
      const across = /^右の端から \(([0-9.]+)\)/u.exec(cells['角の内の面の端(横の板)'] ?? '')?.[1];
      const up = /^上の端から \(([0-9.]+)\)/u.exec(cells['角の内の面の端(縦の板)'] ?? '')?.[1];
      expect([record.cornerX, record.cornerY], record.key).toEqual([record.width - Number(across), record.height - Number(up)]);
      // 穴: φ4.2 の位置は 2 本目の文字のまま。φ9 は 2 本目の読み直しで同じ中心のくぼみの壁なので、穴にしない。
      const hole = /φ4\.2@左から([0-9.]+)・下から([0-9.]+)/u.exec(cells['穴'] ?? '');
      expect(cells['φ9の矢印の先'], record.key).toBe('くぼみの壁');
      expect(record.holes, record.key).toEqual([{ diameter: 4.2, x: Number(hole?.[1]), y: Number(hole?.[2]) }]);
      const pairs = [[record.ixCm4, scaledOf(cells['Ix'], 4)], [record.iyCm4, scaledOf(cells['Iy'], 4)], [record.zxCm3, scaledOf(cells['Zx'], 3)],
        [record.zyCm3, scaledOf(cells['Zy'], 3)]] as const;
      for (const [product, witness] of pairs) expect(product, record.key).toBeCloseTo(witness, 12);
    }
  });
});
