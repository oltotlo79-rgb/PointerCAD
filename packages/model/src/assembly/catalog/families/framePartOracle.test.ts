/**
 * 資料 SF-1 のフレームの部品の製品の行(framePartRows.ts。1 回目の読みの値)が、全部 2 回目の独立の読み(framePartOracle.fixture.json。
 * 読みの文字のまま)と 1 行ずつ一致する事の検査。fixture の文字は、この検査が自分で読み解く(行の表を作る道具の読み解きと別にする)。
 * 簡略の印と導いた値(丸ナットの穴の位置・キャップの角)も、2 回目の文字から決まる通りか確かめる。
 * fixture は JSON のファイルで、この検査がファイルとして読む(アプリのモジュールを持たない)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ADJUSTER_RECORDS, ANGLE_BRACKET_RECORDS, FLAT_PLATE_RECORDS, FOOT_BASE_RECORDS, FRAME_CAP_RECORDS, ROUND_NUT_RECORDS, SHAPED_PLATE_RECORDS,
  T_SLOT_NUT_BAR_RECORDS, T_SLOT_NUT_RECORDS,
} from './framePartRows.js';

type Cells = Readonly<Record<string, string>>;
/** 穴の欄を揃えた記録の 1 つ(読みの番号・欄・揃える前の記述・揃えた後の値・決まり)。 */
type Alignment = Readonly<Record<'reader' | 'field' | 'raw' | 'value' | 'rule', string>>;
interface FixtureRow { readonly key: string; readonly cells: Cells; readonly alignment: readonly Alignment[] }
interface RawRow { readonly key: string; readonly cells: Cells; readonly alignment?: readonly Alignment[] }
type Kind = 'nut-bars' | 'nuts' | 'round-nuts' | 'caps' | 'brackets' | 'shaped-plates' | 'angle-brackets' | 'foot-bases' | 'adjusters';

const isCells = (value: unknown): value is Cells => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isAlignment = (value: unknown): value is Alignment => isCells(value)
  && ['reader', 'field', 'raw', 'value', 'rule'].every((name) => name in value);
const isRow = (value: unknown): value is RawRow => typeof value === 'object' && value !== null && 'key' in value && 'cells' in value
  && typeof value.key === 'string' && isCells(value.cells)
  && (!('alignment' in value) || (Array.isArray(value.alignment) && value.alignment.every(isAlignment)));

/** fixture の JSON を読み、種類ごとの行の並びを返す(形が違えば止める)。 */
function readFixture(): Readonly<Record<Kind, readonly FixtureRow[]>> {
  const value: unknown = JSON.parse(readFileSync(new URL('./framePartOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('fixture の形が違う');
  const rows = (kind: string): readonly FixtureRow[] => {
    const list: unknown = Object.entries(value).find(([name]) => name === kind)?.[1];
    if (!Array.isArray(list) || !list.every(isRow)) throw new Error(`fixture の ${kind} の形が違う`);
    return list.map((row: RawRow): FixtureRow => ({ key: row.key, cells: row.cells, alignment: row.alignment ?? [] }));
  };
  return { 'nut-bars': rows('nut-bars'), nuts: rows('nuts'), 'round-nuts': rows('round-nuts'), caps: rows('caps'), brackets: rows('brackets'),
    'shaped-plates': rows('shaped-plates'), 'angle-brackets': rows('angle-brackets'), 'foot-bases': rows('foot-bases'), adjusters: rows('adjusters') };
}

const FIXTURE = readFixture();

function cellsOf(kind: Kind, key: string): Cells {
  const found = FIXTURE[kind].find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${kind}/${key} が無い`);
  return found.cells;
}

/** 数の文字(括弧・△・記入なしは数として読まない)。 */
function numberOf(text: string | undefined): number {
  return /^[0-9]+(?:\.[0-9]+)?$/u.test(text ?? '') ? Number(text) : NaN;
}

/** ねじの呼び(「2-M5」の数の接頭は落とす)。 */
function threadOf(text: string | undefined): string {
  return /^(?:[0-9]+-)?(M[0-9]+(?:\.[0-9]+)?)$/u.exec((text ?? '').replace(/ /gu, ''))?.[1] ?? '';
}

/** 材質の文字の種類(ステンレス・SUS → stainless、アルミ → aluminum、PA・樹脂 → nylon、鋼・一般構造用圧延鋼材の記号 SS400 など → steel)。 */
function materialOf(text: string | undefined): string {
  const value = text ?? '';
  if (/ステンレス|SUS/u.test(value)) return 'stainless';
  if (/アルミ/u.test(value)) return 'aluminum';
  if (/PA|樹脂|ナイロン/u.test(value)) return 'nylon';
  return /鋼|(?<![A-Z])SS[0-9]{3}(?![0-9])/u.test(value) ? 'steel' : '';
}

/** 材質の文字が名指しする材料の数(部位ごとに材料の違う行の確かめ。同じ材料の別の書き方は 1 つに数える)。 */
function materialCount(text: string | undefined): number {
  const words: readonly (readonly [string, RegExp])[] = [['stainless', /ステンレス|SUS/u], ['steel', /鋼|(?<![A-Z])SS[0-9]{3}|SWCH/u],
    ['aluminum', /アルミ/u], ['pa', /PA|ナイロン/u], ['pom', /POM/u], ['pu', /PU/u], ['rubber', /ゴム|エラストマー/u]];
  return words.filter(([, pattern]) => pattern.test(text ?? '')).length;
}

/** 種類の文字の入れ方の語(「素材・」を除いた「・」区切りの語)。 */
function entryOf(text: string | undefined): string {
  return (text ?? '').replace(/^素材・/u, '');
}

describe('資料 SF-1 のフレームの部品の 2 回目の読みとの照らし', () => {
  it('fixture の行の鍵は製品の行の鍵と同じ並び', () => {
    expect(FIXTURE.brackets.map((row) => row.key)).toEqual(FLAT_PLATE_RECORDS.map((record) => record.key));
    expect(FIXTURE['nut-bars'].map((row) => row.key)).toEqual(T_SLOT_NUT_BAR_RECORDS.map((record) => record.key));
    expect(FIXTURE.nuts.map((row) => row.key)).toEqual(T_SLOT_NUT_RECORDS.map((record) => record.key));
    expect(FIXTURE['round-nuts'].map((row) => row.key)).toEqual(ROUND_NUT_RECORDS.map((record) => record.key));
    expect(FIXTURE.caps.map((row) => row.key)).toEqual(FRAME_CAP_RECORDS.map((record) => record.key));
  });

  it('ナットの素材の行は、溝幅・入れ方・材質・頭の幅・首の幅・首の高さ・全高・単位質量(g/m)が 2 回目の文字と一致', () => {
    for (const record of T_SLOT_NUT_BAR_RECORDS) {
      const cells = cellsOf('nut-bars', record.key);
      expect([record.slot, record.entry, record.material, record.page, record.headWidth, record.neckWidth, record.neckHeight, record.totalHeight,
        record.unitMassKgPerM * 1000], record.key).toEqual([numberOf(cells['合う溝幅']), entryOf(cells['種類']), materialOf(cells['材質']),
        numberOf(cells['PDF頁']), numberOf(cells['頭の幅']), numberOf(cells['首の幅']), numberOf(cells['首の高さ']), numberOf(cells['全高']),
        expect.closeTo(numberOf(cells['単位質量_g/m']), 9)]);
    }
  });

  it('ナットの行は、溝幅・入れ方・材質・質量・頭の幅・首の幅・首の高さ・全高・長さ・ねじ・ねじ穴の数が 2 回目の文字と一致', () => {
    for (const record of T_SLOT_NUT_RECORDS) {
      const cells = cellsOf('nuts', record.key);
      const lock = entryOf(cells['種類']).includes('ロック付き');
      expect([record.slot, record.entry, record.material, record.page, record.massG, record.headWidth, record.neckWidth, record.neckHeight,
        record.totalHeight, record.length, record.thread, lock ? 2 : 1], record.key).toEqual([numberOf(cells['合う溝幅']),
        entryOf(cells['種類']), materialOf(cells['材質']), numberOf(cells['PDF頁']), numberOf(cells['質量_g']), numberOf(cells['頭の幅']),
        numberOf(cells['首の幅']), numberOf(cells['首の高さ']), numberOf(cells['全高']), numberOf(cells['長さ']), threadOf(cells['ねじの呼び']),
        numberOf(cells['ねじ穴の数'])]);
    }
  });

  it('ナットの主のねじ穴は 2 回目の位置の小さい方で、中央でない行だけ holeOffset を持つ(今の中央の行は鍵を持たない)', () => {
    for (const record of T_SLOT_NUT_RECORDS) {
      const positions = (cellsOf('nuts', record.key)['ねじ穴の位置'] ?? '').split(';').map(numberOf);
      const main = Math.min(...positions);
      expect(positions.every(Number.isFinite), record.key).toBe(true);
      expect(record.holeOffset ?? record.length / 2, record.key).toBe(main);
      expect(record.holeOffset === undefined, record.key).toBe(main * 2 === record.length);
    }
  });

  it('ロック付きの止めねじの穴は、2 回目の止めねじの呼びがある行だけ開け、位置は 2 回目の位置の大きい方。ほかの行は開けない', () => {
    for (const record of T_SLOT_NUT_RECORDS) {
      const cells = cellsOf('nuts', record.key);
      const positions = (cells['ねじ穴の位置'] ?? '').split(';').map(numberOf);
      const screw = cells['止めねじの呼び'];
      if (entryOf(cells['種類']).includes('ロック付き') && screw !== undefined) {
        expect([record.setScrewThread, record.setScrewOffset], record.key).toEqual([threadOf(screw), Math.max(...positions)]);
      } else {
        expect([record.setScrewThread, record.setScrewOffset], record.key).toEqual([undefined, undefined]);
      }
    }
  });

  it('ナットの簡略の印: 頭の斜面・首の長さに、ボールとストッパーは全高まで包んだ印、止めねじの呼びが無いロック付きは穴を開けない印', () => {
    const envelope: readonly (readonly [string, string])[] = [['ボール付き', 'ボール(全高はボールの先まで。ボールは作らず包んだ)'],
      ['ストッパー付き', 'ストッパー(全高はストッパーの先まで。ストッパーは作らず包んだ)']];
    for (const record of T_SLOT_NUT_RECORDS) {
      const cells = cellsOf('nuts', record.key);
      const entry = entryOf(cells['種類']);
      const marks = envelope.filter(([word]) => entry.includes(word)).map(([, mark]) => mark);
      const noScrew = entry.includes('ロック付き') && cells['止めねじの呼び'] === undefined ? ['止めねじの穴(呼びが決まらないので開けていない)'] : [];
      // 首の長さは読みに記入が無いので、首は頭と同じ長さの簡略の形(印「首の長さ」)。
      expect(record.simplified, record.key).toEqual(['頭の斜面', '首の長さ', ...marks, ...noScrew]);
      expect(record.slotPartHeightUnknown === true, record.key).toBe(marks.length > 0);
    }
  });

  it('丸ナットの行は、溝幅・材質・質量・径・全長・ねじ・穴 2 つ・穴の間隔が一致し、端から穴までの記入が無い行は対称に置いて印を付ける', () => {
    for (const record of ROUND_NUT_RECORDS) {
      const cells = cellsOf('round-nuts', record.key);
      expect([record.slot, record.material, record.page, record.massG, record.diameter, record.length, record.thread, 2, record.holePitch],
        record.key).toEqual([numberOf(cells['合う溝幅']), materialOf(cells['材質']), numberOf(cells['PDF頁']), numberOf(cells['質量_g']),
        numberOf(cells['径']), numberOf(cells['全長']), threadOf(cells['ねじの呼び']), numberOf(cells['ねじ穴の数']), numberOf(cells['穴の間隔'])]);
      const fromEnd = numberOf(cells['端から穴まで']);
      if (Number.isNaN(fromEnd)) {
        expect([record.holeOffset, record.simplified], record.key).toEqual([(record.length - record.holePitch) / 2, ['穴の位置']]);
      } else {
        expect(record.holeOffset, record.key).toBe(fromEnd);
      }
    }
  });

  it('キャップの行は、溝幅・形・材質・質量・外形・板の厚さ(L 形は腕の幅)が一致し、角の丸みは 2 回目に 4 隅同じ半径の記入がある時だけ', () => {
    for (const record of FRAME_CAP_RECORDS) {
      const cells = cellsOf('caps', record.key);
      const arms = (cells['Lの腕の幅'] ?? '').split(';').map(numberOf);
      expect([record.slot, record.shape, record.material, record.page, record.massG, record.width, record.height, record.thickness], record.key)
        .toEqual([numberOf(cells['合う溝幅']), (cells['種類'] ?? '').replace(/ /gu, '') === 'L形' ? 'l' : 'rect', materialOf(cells['材質']),
          numberOf(cells['PDF頁']), numberOf(cells['質量_g']), numberOf(cells['外形の幅']), numberOf(cells['外形の高さ']), numberOf(cells['板の厚さ'])]);
      if (record.shape === 'l') expect(arms, record.key).toEqual([record.armWidth, record.armWidth]);
      const radius = /^4-R([0-9]+(?:\.[0-9]+)?)$/u.exec(cells['角の形'] ?? '')?.[1];
      expect(record.cornerRadius, record.key).toBe(radius === undefined ? 0 : Number(radius));
      expect(record.simplified, record.key).toEqual(record.cornerRadius > 0 ? ['取付けの脚と穴'] : ['取付けの脚と穴', '角の形']);
    }
  });

  it('平板のブラケットの行は、溝幅・材質・頁・外形・厚さ・面取り・穴の径・穴の位置の列・穴の数が照らす側の読みと一致', () => {
    for (const record of FLAT_PLATE_RECORDS) {
      const cells = cellsOf('brackets', record.key);
      const outline = (cells['外形の辺の長さ'] ?? '').split(';').map(numberOf);
      const chamfer = /^(?:4-C|C[0-9.]+\(4-C)([0-9]+(?:\.[0-9]+)?)\)?$/u.exec((cells['角の形'] ?? '').replace(/ /gu, ''))?.[1];
      expect([record.slot, record.material, record.page, record.length, record.width, record.thickness, record.holeDiameter, record.holesX,
        record.holesY, record.holesX.length * record.holesY.length], record.key).toEqual([numberOf(cells['合う溝幅']), materialOf(cells['材質']),
        numberOf(cells['PDF頁']), outline[0], outline[1], numberOf(cells['板の厚さ']), numberOf((cells['穴の径'] ?? '').replace(/\(.*\)$/u, '')),
        (cells['穴の位置_外の面から'] ?? '').split(';').map(numberOf), (cells['穴の位置_端から'] ?? '').split(';').map(numberOf),
        numberOf(cells['穴の数'])]);
      expect([outline[2], outline[3]], record.key).toEqual([outline[0], outline[1]]);
      expect(record.chamfer, record.key).toBe(chamfer === undefined ? 0 : Number(chamfer));
      if (record.massG !== null) expect(record.massG, record.key).toBe(numberOf(cells['質量_g']));
    }
  });

  it('平板の穴の欄の揃え方の記録は、2 つ以上の読みにあり、揃える前の記述から足し上げ・並べ替え・分解だけで揃えた後の値になり、製品の穴と同じ', () => {
    /** 記述の中の数の並び(括弧の注記・「鎖寸法」・「左から:」のような頭を除き、「;」「,」で区切る)。 */
    const numbersIn = (raw: string): readonly number[] => (raw.replace(/\([^)]*\)/gu, '').split(':').slice(-1)[0] ?? '').replace(/鎖寸法/gu, '')
      .split(/[;,、]/u).filter((part) => part.trim() !== '').map((part) => numberOf(part.trim()));
    for (const record of FLAT_PLATE_RECORDS) {
      const entries = FIXTURE.brackets.find((row) => row.key === record.key)?.alignment ?? [];
      for (const field of ['穴の位置_外の面から', '穴の位置_端から', '穴の径']) {
        expect(new Set(entries.filter((entry) => entry.field === field).map((entry) => entry.reader)).size, `${record.key} ${field}`)
          .toBeGreaterThanOrEqual(2);
      }
      for (const entry of entries) {
        const values = numbersIn(entry.raw);
        if (entry.field === '穴の径') {
          expect([entry.value, values[0]], record.key).toEqual([`${record.holeDiameter}・通し`, record.holeDiameter]);
          continue;
        }
        const total = entry.field === '穴の位置_外の面から' ? record.length : record.width;
        const expected = entry.field === '穴の位置_外の面から' ? record.holesX : record.holesY;
        let positions: readonly number[];
        if (entry.rule.startsWith('鎖寸法を足し上げた')) {
          const chain = /(右|上)から/u.test(entry.raw) ? [...values].reverse() : values;
          expect(chain.reduce((sum, value) => sum + value, 0), record.key).toBeCloseTo(total, 9);
          positions = chain.slice(0, -1).map((_, index) => chain.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
        } else {
          positions = values;
        }
        const aligned = [...new Set(positions)].sort((a, b) => a - b);
        expect([aligned, entry.value], `${record.key} ${entry.reader} ${entry.field}`).toEqual([expected, expected.join(';')]);
        // 端が記述に無い列は、向きを逆にしても同じ列になる(対称)時だけ揃えてよい。
        if (entry.rule.includes('端は記述に無い')) expect([...aligned].map((value) => total - value).sort((a, b) => a - b)).toEqual(aligned);
      }
    }
  });
});

/** 「左から x,下から y の組: 10,9;…」「…: 左から10,下から9;…」の穴の組(小さい順)。 */
function pairsOf(text: string | undefined): readonly (readonly [number, number])[] {
  const body = (text ?? '').split(':').slice(1).join(':');
  return body.split(';').filter((part) => part.trim() !== '').map((part): readonly [number, number] => {
    const numbers = part.match(/[0-9]+(?:\.[0-9]+)?/gu) ?? [];
    return [Number(numbers[0]), Number(numbers[1])];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** 「辺a=7,27;辺b=7,27」「辺a:7;27;辺b:7;27」の脚ごとの並び(小さい順)。 */
function legsOf(text: string | undefined): readonly (readonly number[])[] {
  const match = /^辺a[=:](.*?);?辺b[=:](.*)$/u.exec((text ?? '').replace(/ /gu, ''));
  return (match === null ? [] : [match[1] ?? '', match[2] ?? '']).map((part) => (part.match(/[0-9]+(?:\.[0-9]+)?/gu) ?? []).map(Number)
    .sort((a, b) => a - b));
}

/** 直角の輪の頂点から、頂点 0 から順の辺の長さ。 */
function sidesOf(outline: readonly (readonly [number, number])[]): readonly number[] {
  return outline.map(([x1, y1], index) => {
    const [x2, y2] = outline[(index + 1) % outline.length] ?? [x1, y1];
    return Math.abs(x2 - x1) + Math.abs(y2 - y1);
  });
}

describe('資料 SF-1 の読み直しで足した 4 族と照らす側の読み', () => {
  it('平板の L・T・十字は、辺の長さ・穴の組・径・厚さが照らす側の読みと一致し、外形は辺の長さの並びどおりの直角の輪', () => {
    for (const record of SHAPED_PLATE_RECORDS) {
      const cells = cellsOf('shaped-plates', record.key);
      expect([record.slot, record.material, record.page, record.sides, [...record.holes].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        record.holeDiameter, record.thickness], record.key).toEqual([numberOf(cells['合う溝幅']), materialOf(cells['材質']), numberOf(cells['PDF頁']),
        (cells['外形の辺の長さ'] ?? '').split(';').map(numberOf), pairsOf(cells['穴の位置_外の面から']), numberOf(cells['穴の径']),
        numberOf(cells['板の厚さ'])]);
      // 外形: 辺は縦か横だけ、辺の長さは頂点 0 から読みの並びどおり、1 つ目の辺は一番上、左下が原点。
      expect(record.outline.every(([x1, y1], index) => {
        const [x2, y2] = record.outline[(index + 1) % record.outline.length] ?? [x1, y1];
        return x1 === x2 || y1 === y2;
      }), record.key).toBe(true);
      expect(sidesOf(record.outline), record.key).toEqual(record.sides);
      expect(record.outline[0]?.[1], record.key).toBe(Math.max(...record.outline.map(([, y]) => y)));
      expect([Math.min(...record.outline.map(([x]) => x)), Math.min(...record.outline.map(([, y]) => y))], record.key).toEqual([0, 0]);
      if (record.massG !== null) expect(record.massG, record.key).toBe(numberOf(cells['質量_g']));
    }
  });

  it('L 形のブラケットは、脚の長さ・幅・厚さ・脚ごとの穴の並び・穴の数・径が照らす側の読みと一致', () => {
    for (const record of ANGLE_BRACKET_RECORDS) {
      const cells = cellsOf('angle-brackets', record.key);
      const along = legsOf(cells['穴の位置_外の面から']);
      const across = legsOf(cells['穴の位置_端から']);
      const counts = (cells['穴の数'] ?? '').replace(/\([^)]*\)/gu, '').match(/[0-9]+(?:\.[0-9]+)?/gu)?.map(Number) ?? [];
      expect([record.slot, record.material, record.page, record.legA, record.legB, record.width, record.thickness, record.holeDiameter,
        record.alongA, record.alongB, record.acrossA, record.acrossB], record.key).toEqual([numberOf(cells['合う溝幅']), materialOf(cells['材質']),
        numberOf(cells['PDF頁']), numberOf(cells['辺aの長さ']), numberOf(cells['辺bの長さ']), numberOf(cells['幅']), numberOf(cells['辺aの厚さ']),
        numberOf(cells['穴の径']), along[0], along[1], across[0], across[1]]);
      expect(counts, record.key).toEqual([record.alongA.length * record.acrossA.length, record.alongB.length * record.acrossB.length]);
      if (record.massG !== null) expect(record.massG, record.key).toBe(numberOf(cells['質量_g']));
    }
  });

  it('ベースの板は、外形・厚さと、穴ごとの位置と径が照らす側の読みと一致', () => {
    for (const record of FOOT_BASE_RECORDS) {
      const cells = cellsOf('foot-bases', record.key);
      const pairs = pairsOf(cells['取付け穴の位置']);
      const sizes = (cells['取付け穴の径'] ?? '').match(/[0-9]+(?:\.[0-9]+)?/gu)?.map(Number) ?? [];
      const expanded = sizes.length === 1 ? pairs.map(() => sizes[0] ?? NaN) : sizes;
      expect([record.material, record.page, record.width, record.depth, record.thickness], record.key).toEqual([materialOf(cells['材質']),
        numberOf(cells['PDF頁']), numberOf(cells['外形の幅']), numberOf(cells['外形の奥行']), numberOf(cells['板の厚さ'])]);
      const holes = pairs.map(([x, y], index): readonly [number, number, number] => [x, y, expanded[index] ?? NaN]);
      expect([...record.holes].sort((a, b) => a[0] - b[0] || a[1] - b[1]), record.key).toEqual(holes);
      if (record.massG !== null) expect(record.massG, record.key).toBe(numberOf(cells['質量_g']));
    }
  });

  it('アジャスターは、皿の径と厚さ・ねじの呼びと長さ・質量が照らす側の読みと一致', () => {
    for (const record of ADJUSTER_RECORDS) {
      const cells = cellsOf('adjusters', record.key);
      // ねじの長さの寸法線が六角部の上からの行は、記入のままの長さと六角部の高さを照らす(足し引きで作った長さは使わない)。
      const hexed = record.hexHeight !== undefined;
      // 部位ごとに材料の違う行('mixed')は、照らす側の材質の文字が 2 つ以上の材料を名指しし、行の材質の文字も 2 つ以上を名指しする(統括 08:1x)。
      const mixed = record.material === 'mixed';
      if (mixed) {
        expect([materialCount(cells['材質']) >= 2, materialCount(record.materialText) >= 2], record.key).toEqual([true, true]);
      }
      expect([mixed ? 'mixed' : record.material, record.page, record.padDiameter, record.padThickness, record.thread, record.threadLength,
        record.hexHeight, record.massG], record.key).toEqual([mixed ? 'mixed' : materialOf(cells['材質']), numberOf(cells['PDF頁']), numberOf(cells['皿の径']),
        numberOf(cells['皿の厚さ']), threadOf((cells['ねじの呼び'] ?? '').replace(/\([^)]*\)/gu, '').replace(/[×x][0-9.]+$/u, '')),
        numberOf(cells[hexed ? 'ねじの長さ_記入' : 'ねじの長さ']), hexed ? numberOf(cells['六角部の高さ']) : undefined, numberOf(cells['質量_g'])]);
      if (hexed) {
        expect(cells['ねじの長さの起点'], record.key).toBe('六角部の上の面');
        // 全高の記入が括弧の無い数の行は、皿 + 六角部 + ねじの長さと合う(形の高さが資料の全高と同じ)。
        const total = numberOf(cells['全高']);
        if (Number.isFinite(total)) expect(record.padThickness + (record.hexHeight ?? NaN) + record.threadLength, record.key).toBe(total);
      }
    }
  });
});
