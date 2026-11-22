/**
 * 資料 2 のパイプ形のフレームの系列の長物の製品の行(pipeLongPartRows.ts。40 回目の読み 2 本で一致した値。断面の外形を包む長方形 × 長さ)が、
 * 照らす側の読み(pipeLongPartOracle.fixture.json。2 本目の文字。部品の種類だけは一般の呼び)と 1 行ずつ合う事の検査(統括の決定 2026-11-20 21:2x)。
 * fixture の文字は、この検査が自分で読み解く: 断面の外形の幅と高さ(「外形の幅:30.5(…)」の頭の数)・長さの上限(切り売りの範囲の大きい方)・
 * 材質(アルミの押出材。52a 回目の樹脂の長物は樹脂の語で、部品表の材質の文字「樹脂」)・単位質量(kg/m。g/m と、定尺の長物の定尺 1 本の質量
 * 〔g/本・g/定尺mm〕は直す)・長さの上限(切り売りの範囲の大きい方か定尺)・頁(資料に載らない品は空で null)・道具の画面の値の寸法(資料に記入が無く、参考にした組立用の道具の
 * 画面の値で入れた寸法。行の valueSource)。あわせて、族の行(形・体積・質量・長さの上限・断面の性質を持たない事)を確かめる。
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

/** 「切り売りl=100~4000mm」→ 範囲の大きい方、「定尺L=2000mm」→ 定尺(どちらも無ければ null)。 */
function maxLengthOf(text: string | undefined): number | null {
  const range = new RegExp(`(${NUMBER})[~〜～](${NUMBER})`, 'u').exec(text ?? '');
  if (range?.[2] !== undefined) return Math.max(Number(range[1]), Number(range[2]));
  return stockOf(text);
}

/** 「定尺L=2000mm」→ 定尺の長さ(定尺の記入でなければ null)。 */
function stockOf(text: string | undefined): number | null {
  const stock = new RegExp(`^定尺[Ll]=(${NUMBER})mm$`, 'u').exec(text ?? '');
  return stock?.[1] === undefined ? null : Number(stock[1]);
}

/** 「PDF頁」の文字 → 頁(資料に載らない品の空の文字は null)。 */
function pageOf(text: string | undefined): number | null {
  return text === undefined || text === '' ? null : Number(text);
}

/** 「道具の画面の値」の文字(「外形の幅・単位質量」)→ 行の寸法の鍵の並び(無ければ空)。名前の分からない語は「?」のまま残して合わなくする。 */
const SCREEN_NAMES: Readonly<Record<string, string>> = { 外形の幅: 'width', 外形の高さ: 'height', 単位質量: 'unitMassKgPerM' };
function screenFieldsOf(text: string | undefined): readonly string[] {
  return text === undefined || text === '' ? [] : text.split('・').map((name) => SCREEN_NAMES[name] ?? `?${name}`);
}

/** 定尺 1 本の質量から単位質量を直した行の、単位質量の出し方の文。 */
const PIECE_MASS_NOTE = '質量は資料の定尺 1 本の質量 ÷ 定尺の単位質量 × 長さ';

/** 材質の記入の頭が樹脂の語の物(52a 回目の樹脂の長物)。行は密度の無い 'mixed' で、部品表の材質の文字は「樹脂」。 */
const RESIN = /^(?:導電)?(?:低密度|高密度)?(?:PP|PE|PVC|PA|POM|ABS|樹脂)$/u;

/**
 * 「アルミ押出材;0.53kg/m」「PP;83g/m」→ 材料と単位質量(kg/m)。定尺の長物の「PP;176g/本」「PP;94g/2000mm」は定尺 1 本の質量で、
 * 定尺(stock)で割った値(定尺でなければ null)。
 */
function materialAndMassOf(text: string | undefined, stock: number | null): readonly [string, number | null] {
  const [material = '', mass = ''] = (text ?? '').split(';');
  const kind = material.startsWith('アルミ') ? 'aluminum' : RESIN.test(material) ? 'mixed' : '';
  const perLength = new RegExp(`^(${NUMBER})(k?)g/m$`, 'u').exec(mass);
  if (perLength?.[1] !== undefined) return [kind, perLength[2] === 'k' ? Number(perLength[1]) : Number(perLength[1]) / 1000];
  const piece = new RegExp(`^(${NUMBER})g/(?:本|(${NUMBER})mm)$`, 'u').exec(mass);
  const pieceLength = piece?.[2] === undefined ? stock : Number(piece[2]);
  return [kind, piece?.[1] === undefined || stock === null || pieceLength !== stock ? null : Number(piece[1]) / stock];
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

  it('断面の外形の幅と高さ・長さの上限・材質・単位質量・頁・道具の画面の値の寸法が照らす側の読みと合う', () => {
    // 長さを範囲で選ぶつなぎの行(長さの下限を持つ行)は、照らす側の欄の形が違うので下の検査で照らす。
    for (const record of PIPE_LONG_PART_RECORDS.filter((item) => item.minLength === undefined)) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      expect([sectionValue(cells['断面'], '外形の幅'), sectionValue(cells['断面'], '外形の高さ'), maxLengthOf(cells['長さ'])], record.key)
        .toEqual([record.width, record.height, record.maxLength]);
      const stock = stockOf(cells['長さ']);
      expect([...materialAndMassOf(cells['材質と質量'], stock), pageOf(cells['PDF頁'])], record.key)
        .toEqual([record.material, record.unitMassKgPerM, record.page]);
      // 樹脂の行だけ部品表の材質の文字「樹脂」を持ち、定尺 1 本の質量から直した行だけ、その出し方の文を持つ(資料に載らない品は別の文)。
      const pieceMass = /g\/(?:本|[0-9.]+mm)$/u.test(cells['材質と質量'] ?? '');
      expect([record.materialText ?? null, record.massNote === PIECE_MASS_NOTE], record.key)
        .toEqual([record.material === 'mixed' ? '樹脂' : null, pieceMass]);
      const fields = screenFieldsOf(cells['道具の画面の値']);
      expect(record.valueSource, record.key).toEqual(fields.length === 0 ? undefined : { kind: 'toolScreen', fields });
    }
    // 資料に載らない品(頁が null)は、全部の値が道具の画面の値。
    for (const record of PIPE_LONG_PART_RECORDS.filter((item) => item.page === null)) {
      expect(record.valueSource, record.key).toEqual({ kind: 'toolScreen', fields: ['width', 'height', 'unitMassKgPerM'] });
    }
  });

  it('長さを範囲で選ぶつなぎの行: 断面の横と縦・長さの下限と上限は全体の記入の数、材質は 2 つの部位(アルミ・樹脂)、質量なし、動く仕組みの印、範囲の外の長さは作らない', () => {
    const ranged = PIPE_LONG_PART_RECORDS.filter((item) => item.minLength !== undefined);
    expect(ranged.map((record) => record.key)).toEqual(['b2-long-hinge-connector-28x28', 'b2-long-slide-connector-28x28']);
    for (const record of ranged) {
      const cells = FIXTURE.find((row) => row.key === record.key)?.cells ?? {};
      const text = cells['全体の記入'] ?? '';
      const across = new RegExp(`横:\\s*(${NUMBER})\\(`, 'u').exec(text)?.[1];
      const up = new RegExp(`縦:\\s*(${NUMBER})\\(`, 'u').exec(text)?.[1];
      const span = new RegExp(`(${NUMBER})\\s*[~〜～]\\s*(${NUMBER})`, 'u').exec(text.split('奥行')[1] ?? '');
      expect([Number(across), Number(up), Number(span?.[1]), Number(span?.[2])], record.key)
        .toEqual([record.width, record.height, record.minLength, record.maxLength]);
      const [material = '', mass = ''] = (cells['材質と質量'] ?? '').split(';');
      expect([material.includes('アルミ') && material.includes('POM'), mass, record.material, record.materialText, record.unitMassKgPerM,
        pageOf(cells['PDF頁']), record.page], record.key).toEqual([true, '記入なし', 'mixed', 'アルミ・樹脂', null, record.page, record.page]);
      expect(record.simplified, record.key).toContain('動く仕組みは作っていない');
      const row = PIPE_LONG_PART_FAMILY.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`族に ${record.key} が無い`);
      const short = { length: String((record.minLength ?? NaN) - 1) };
      expect([PIPE_LONG_PART_FAMILY.build(row, short), PIPE_LONG_PART_FAMILY.nominalVolume(row, short), row.dims.minLength], record.key)
        .toEqual([null, null, record.minLength]);
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
      expect(row.valueSource, record.key).toEqual(record.valueSource);
      if (record.maxLength !== null) {
        const over = { length: String(record.maxLength + 1) };
        expect([PIPE_LONG_PART_FAMILY.build(row, over), PIPE_LONG_PART_FAMILY.nominalVolume(row, over)], record.key).toEqual([null, null]);
      }
    }
  });
});
