/**
 * 資料 1 の溝つきフレームのうち、外周の指定を持つ行(frameOutlineRows.ts。1 つの角の大きな丸みと L 形)の検査。L 形は、溝の口の中心の
 * 外の面からの記入が無いので各腕の幅の中央に置いた印つきの簡略の形(利用者の回答 2026-11-18 11:2x の (6))で、別の検査で照らす。
 * 照らす側の読み(frameOutlineOracle.fixture.json。2 本目の読みの寸法線の文字と、断面性能の表の 2 回目の読み)を、この検査が自分で読み解く:
 * 寸法線は「数字(端 A〜端 B)」で、括弧で囲まれた数字(参考寸法)は使わない。左の外の面・下の外の面を 0 にして、面から内の点へは
 * 左・下の面から足し、右・上の面から引く。角の丸みは角の名前で当て、名前の無い数つきの記入は名前の付いていない角の数と同じ時だけ残りの角へ。
 * あわせて、族の行として形・体積・質量・断面の外形・締結に出す溝を、製品の口(族の定数)を通して確かめる。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { slottedOutlineProfile } from '../profiles/slottedOutline.js';
import type { CatalogFamily } from '../types.js';
import { T_SLOT_OUTLINE_RECORDS } from './frameOutlineRows.js';
import { T_SLOT_CATALOG_FAMILIES } from './tSlotFrameCatalog.js';

type Cells = Readonly<Record<string, string>>;
interface FixtureRow { readonly key: string; readonly figurePage: string; readonly cells: Cells; readonly table: readonly string[] }
interface Dimension { readonly value: number; readonly a: string; readonly b: string }

const isStrings = (value: unknown): value is Readonly<Record<string, string>> => typeof value === 'object' && value !== null
  && Object.values(value).every((cell: unknown) => typeof cell === 'string');
const isRow = (value: unknown): value is FixtureRow => typeof value === 'object' && value !== null && 'key' in value && 'figurePage' in value
  && 'cells' in value && 'table' in value && typeof value.key === 'string' && typeof value.figurePage === 'string' && isStrings(value.cells)
  && Array.isArray(value.table) && value.table.every((cell: unknown) => typeof cell === 'string');

function readFixture(): readonly FixtureRow[] {
  const value: unknown = JSON.parse(readFileSync(new URL('./frameOutlineOracle.fixture.json', import.meta.url), 'utf8'));
  const rows: unknown = typeof value === 'object' && value !== null && 'rows' in value ? value.rows : undefined;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error('fixture の形が違う');
  return rows;
}

const FIXTURE = readFixture();
const CORNERS = ['左下', '右下', '右上', '左上'] as const;
const X_FACES: Readonly<Record<string, 'min' | 'max'>> = { 左の外の面: 'min', 右の外の面: 'max' };
const Y_FACES: Readonly<Record<string, 'min' | 'max'>> = { 下の外の面: 'min', 上の外の面: 'max' };

function rowOf(key: string): FixtureRow {
  const found = FIXTURE.find((row) => row.key === key);
  if (found === undefined) throw new Error(`fixture に ${key} が無い`);
  return found;
}

/** 参考寸法でない寸法線(端の名前の空白は外す)。 */
function dimensionsOf(text: string | undefined): readonly Dimension[] {
  return [...(text ?? '').matchAll(/(\()?([0-9]+(?:\.[0-9]+)?)(\))?\(([^()〜]*)〜([^()]*)\)/gu)].flatMap((match): Dimension[] => {
    const [, open, value, close, a, b] = match;
    if (open !== undefined || close !== undefined || value === undefined || a === undefined || b === undefined) return [];
    return [{ value: Number(value), a: a.replace(/\s+/gu, ''), b: b.replace(/\s+/gu, '') }];
  });
}

/** 1 つの軸の点の位置(min の面 = 0。面から内の点へは min の面から足し、max の面から引く)。 */
function positions(items: readonly Dimension[], faces: Readonly<Record<string, 'min' | 'max'>>): ReadonlyMap<string, number> {
  const known = new Map<string, number>(Object.entries(faces).filter(([, side]) => side === 'min').map(([name]): [string, number] => [name, 0]));
  // 内の点の進む向き(min の面から来た点は +1、max の面から来た点は -1)。内の点から内の点へは、書かれた順(端 A → 端 B)に同じ向きへ進む。
  const direction = new Map<string, number>();
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items) {
      for (const [here, there] of [[item.a, item.b], [item.b, item.a]] as const) {
        const at = known.get(here);
        if (at === undefined || known.has(there)) continue;
        const inner = faces[here] === undefined && faces[there] === undefined;
        const sign = faces[here] === 'min' || (faces[here] === undefined && faces[there] === 'max') ? 1
          : faces[here] === 'max' || (faces[here] === undefined && faces[there] === 'min') ? -1
            : inner && here === item.a ? direction.get(here) ?? 0 : 0;
        if (sign === 0) continue;
        known.set(there, at + sign * item.value);
        direction.set(there, sign);
        changed = true;
      }
    }
  }
  return known;
}

/** 角ごとの丸み(左下・右下・右上・左上の順)。決まらない時は空。 */
function radiiOf(text: string | undefined): readonly number[] {
  const named = new Map<string, number>();
  const loose: (readonly [number, number])[] = [];
  for (const part of (text ?? '').split(';').filter((item) => item.trim() !== '')) {
    const match = /(?:(\d+)-)?R([0-9]+(?:\.[0-9]+)?)/u.exec(part);
    if (match === null) return [];
    const count = Number(match[1] ?? '1');
    const radius = Number(match[2]);
    const names = CORNERS.filter((name) => part.includes(name));
    if (names.length === count) for (const name of names) named.set(name, radius);
    else if (names.length === 0) loose.push([count, radius]);
    else return [];
  }
  const rest = CORNERS.filter((name) => !named.has(name));
  const [only, ...more] = loose;
  if (only !== undefined && more.length === 0 && only[0] === rest.length) for (const name of rest) named.set(name, only[1]);
  return CORNERS.every((name) => named.has(name)) ? CORNERS.map((name) => named.get(name) ?? NaN) : [];
}

/** 溝の形の 4 つの寸法線(口・部屋の幅・肩・深さ)。 */
function slotShapeOf(text: string | undefined): readonly number[] {
  const find = (test: (ends: string) => boolean): number => {
    const values = new Set(dimensionsOf(text).filter((item) => test(`${item.a}|${item.b}`)).map((item) => item.value));
    return values.size === 1 ? [...values][0] ?? NaN : NaN;
  };
  const sides = (ends: string): boolean => ends.includes('左') && ends.includes('右');
  return [find((ends) => ends.includes('口の') && sides(ends) && !ends.includes('部屋')), find((ends) => ends.includes('部屋の') && sides(ends)),
    find((ends) => ends.includes('外の面') && ends.includes('肩の内の面')), find((ends) => ends.includes('肩の内の面') && ends.includes('溝の底'))];
}

/** L 形の欄の寸法線(端の名前の中の括弧〔腕の内の面(縦)〕と、前の書き添え〔「横:」「左上溝の口:」など〕を許す。参考寸法は使わない)。 */
function lDimensionsOf(text: string | undefined): readonly Dimension[] {
  return (text ?? '').split(/;| \/ |。/u).flatMap((part): Dimension[] => {
    const match = /^(?:[^:()]*:\s*)?(\()?([0-9]+(?:\.[0-9]+)?)(\))?\((.*)\)$/u.exec(part.trim());
    const ends = match?.[4]?.split('〜') ?? [];
    if (match === null || match[1] !== undefined || match[3] !== undefined || ends.length !== 2) return [];
    return [{ value: Number(match[2]), a: (ends[0] ?? '').replace(/\s+/gu, ''), b: (ends[1] ?? '').replace(/\s+/gu, '') }];
  });
}

/** 端の名前の組で決まる寸法線の値(1 つに決まらない時は NaN)。 */
function lValueOf(items: readonly Dimension[], test: (a: string, b: string) => boolean): number {
  const values = new Set(items.filter((item) => test(item.a, item.b) || test(item.b, item.a)).map((item) => item.value));
  return values.size === 1 ? [...values][0] ?? NaN : NaN;
}

/** 溝の形の 4 つの寸法線(左右の面の溝の縦の寸法線も当てる。部屋の幅は「部屋の」か肩の裏側の面どうし「肩裏側」)。 */
function slotShapeAnyAxisOf(text: string | undefined): readonly number[] {
  const find = (test: (ends: string) => boolean): number => {
    const values = new Set(dimensionsOf(text).filter((item) => test(`${item.a}|${item.b}`)).map((item) => item.value));
    return values.size === 1 ? [...values][0] ?? NaN : NaN;
  };
  const pair = (ends: string): boolean => (ends.includes('左') && ends.includes('右')) || (ends.includes('上') && ends.includes('下'));
  return [find((ends) => ends.includes('口の') && pair(ends) && !ends.includes('部屋')),
    find((ends) => (ends.includes('部屋の') || ends.includes('肩裏側')) && pair(ends)),
    find((ends) => ends.includes('外の面') && ends.includes('肩の内の面')), find((ends) => ends.includes('肩の内の面') && ends.includes('溝の底'))];
}

/** 「/」で分けた部分のうち「横:」「縦:」を持つ部分の、その後の寸法線(書かれた順)。 */
function axisParts(text: string | undefined): Readonly<Record<'横' | '縦', readonly Dimension[]>> {
  const found: Record<'横' | '縦', Dimension[]> = { 横: [], 縦: [] };
  for (const part of (text ?? '').split('/')) {
    for (const axis of ['横', '縦'] as const) {
      const at = part.indexOf(`${axis}:`);
      if (at >= 0) found[axis].push(...dimensionsOf(part.slice(at + axis.length + 1)));
    }
  }
  return found;
}

/** 間の並びを面の中央に置いた点の位置(外形の中心が 0。並びが前後で同じ時だけで、違えば空)。 */
function centeredPoints(gaps: readonly number[]): readonly number[] {
  if (gaps.join() !== [...gaps].reverse().join()) return [];
  const start = -gaps.reduce((sum, gap) => sum + gap, 0) / 2;
  return gaps.reduce<number[]>((points, gap) => [...points, (points.at(-1) ?? start) + gap], [start]);
}

const SYMMETRIC ='溝と穴の横の位置は図に記入が無いので、幅の中央に対して対称に置いた';
const NO_HOLES = '穴（外の面からの位置の記入が無いので作っていない）';
/** L 形の外周の辺(下・右・腕の内の横の面・腕の内の縦の面・上・左)の、締結に出す面の名前(内向きの法線から)。 */
const L_FACES = ['bottom', 'right', 'top', 'right', 'top', 'left'] as const;
const L_COUNT_NAMES = ['下', '右', '腕の内(横)', '腕の内(縦)', '上', '左'] as const;
const centered = (record: (typeof T_SLOT_OUTLINE_RECORDS)[number]): boolean => record.simplifiedKinds?.includes('slotPositionSymmetric') === true;
/** 寸法線の鎖だけで決まる行・溝を中央に置いた 1 つの角の大きな丸みの行(溝は下と右)・4 つの面の溝を中央に置いた長方形の行・L 形の行。 */
const RECT_RECORDS = T_SLOT_OUTLINE_RECORDS.filter((record) => record.armWidth === undefined && !centered(record));
const R_CENTERED_RECORDS = T_SLOT_OUTLINE_RECORDS.filter((record) => record.armWidth === undefined && centered(record) && record.faces === 'br');
const GRID_CENTERED_RECORDS = T_SLOT_OUTLINE_RECORDS.filter((record) => record.armWidth === undefined && centered(record) && record.faces === 'tblr');
const L_RECORDS = T_SLOT_OUTLINE_RECORDS.filter((record) => record.armWidth !== undefined);

function familyOf(slot: number): CatalogFamily {
  return slot === 6 ? T_SLOT_CATALOG_FAMILIES.s6 : slot === 8 ? T_SLOT_CATALOG_FAMILIES.s8 : T_SLOT_CATALOG_FAMILIES.s10;
}

describe('資料 1 の溝つきフレームの外周の指定を持つ行と照らす側の読み', () => {
  it('製品の行と fixture は同じ鍵の並びで、型番を持たず、断面の値・断面積・単位質量・頁は断面性能の表の 2 回目の読みと合う', () => {
    expect(FIXTURE.map((row) => row.key)).toEqual(T_SLOT_OUTLINE_RECORDS.map((record) => record.key));
    for (const record of T_SLOT_OUTLINE_RECORDS) {
      const { cells, table, figurePage } = rowOf(record.key);
      expect(JSON.stringify(cells), record.key).not.toMatch(/[A-Z]{3}-[0-9]/u);
      // 断面積が資料に無い行(照らす側の読みの断面積が「記入なし」。図の頁の枠の値)は、断面積を持たず、単位質量の出どころは頁の箱。
      const noArea = table[4] === '記入なし';
      expect([record.ixCm4, record.iyCm4, record.zxCm3, record.zyCm3, record.areaMm2, record.unitMassKgPerM, record.figurePage], record.key)
        .toEqual([...table.map((cell) => (cell === '記入なし' ? null : Number(cell))), Number(figurePage)]);
      expect(record.massSource, record.key).toBe(noArea ? 'box' : 'table');
      // 単位質量は表の丸め(小数 2 桁)の内で、断面積 × 2.70(アルミの密度)と合う(断面積の無い行は検算しない)。
      if (!noArea) expect(Math.abs((record.areaMm2 ?? NaN) * 2.7 / 1000 - record.unitMassKgPerM), record.key).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });

  it('外形・角の丸み・溝の形と位置・穴が、寸法線の鎖から決まる値と合う(原点は外形の中心)', () => {
    expect(RECT_RECORDS.length).toBeGreaterThan(0);
    for (const record of RECT_RECORDS) {
      const { cells } = rowOf(record.key);
      const items = ['外形の寸法線', '溝の位置の寸法線', '穴の記入'].flatMap((field) => dimensionsOf(cells[field]));
      const isFace = (name: string): boolean => name in X_FACES || name in Y_FACES;
      // 内の点どうしの寸法線(鎖の続き)は両方の軸に渡す(始まりの点が分かっている軸でだけ使われる)。
      const inner = items.filter((item) => !isFace(item.a) && !isFace(item.b));
      const x = positions([...items.filter((item) => item.a in X_FACES || item.b in X_FACES), ...inner], X_FACES);
      const y = positions([...items.filter((item) => item.a in Y_FACES || item.b in Y_FACES), ...inner], Y_FACES);
      const width = x.get('右の外の面') ?? NaN;
      const height = y.get('上の外の面') ?? NaN;
      const counts = new Map([...(cells['面ごとの溝の数'] ?? '').matchAll(/(上|下|左|右)(\d+)/gu)].map((match): [string, number] => [match[1] ?? '', Number(match[2])]));
      const slots = [['下', 0, x, false], ['右', 1, y, false], ['上', 2, x, true], ['左', 3, y, true]] as const;
      // 面の溝の口の中心の点: 名前が面の字で始まり「溝」「口」「中心」を持つ点(面ごとの溝の数と同じ数だけ決まる事)。
      const expectedSlots = slots.flatMap(([face, edge, axis, flip]) => {
        const values = [...new Set([...axis.entries()].filter(([name]) => name.startsWith(face) && name.includes('溝') && name.includes('口')
          && name.includes('中心') && !isFace(name)).map(([, value]) => value))].sort((a, b) => a - b);
        expect(values.length, `${record.key} ${face}`).toBe(counts.get(face) ?? 0);
        return values.map((at) => ({ edge, at: flip ? (edge === 2 ? width : height) - at : at }));
      }).sort((p, q) => p.edge - q.edge || p.at - q.at);
      const diameter = Number(/φ([0-9]+(?:\.[0-9]+)?)/u.exec(cells['穴の記入'] ?? '')?.[1] ?? NaN);
      const hole = { x: (x.get('穴の中心') ?? NaN) - width / 2, y: (y.get('穴の中心') ?? NaN) - height / 2, diameter };
      const outline = record.outline;
      expect([record.width, record.height], record.key).toEqual([width, height]);
      expect(outline?.vertices, record.key).toEqual([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]);
      expect(outline?.radii, record.key).toEqual(radiiOf(cells['角の丸みの記入']));
      expect([record.slotOpening, record.slotInnerWidth, record.shoulder, record.slotDepth], record.key).toEqual(slotShapeOf(cells['溝の形の寸法線']));
      expect([outline?.slots, outline?.holes], record.key).toEqual([expectedSlots, [hole]]);
      expect([record.slot, record.centerHole], record.key).toEqual([record.slotOpening, diameter]);
    }
  });

  it('溝の位置の記入が無い 1 つの角の大きな丸みの行: 溝は面の幅の中央(印つき)、穴は溝の口の中心を通る縦と横の軸の交点(外形の中心)', () => {
    expect(R_CENTERED_RECORDS.map((record) => record.key)).toEqual(['s10-40x40-r32', 's10-45x45-r35']);
    for (const record of R_CENTERED_RECORDS) {
      const { cells } = rowOf(record.key);
      const outer = dimensionsOf(cells['外形の寸法線']);
      const x = positions(outer.filter((item) => item.a in X_FACES || item.b in X_FACES), X_FACES);
      const y = positions(outer.filter((item) => item.a in Y_FACES || item.b in Y_FACES), Y_FACES);
      const [width, height] = [x.get('右の外の面') ?? NaN, y.get('上の外の面') ?? NaN];
      const counts = [...(cells['面ごとの溝の数'] ?? '').matchAll(/(上|下|左|右)(\d+)/gu)].map((match) => `${match[1] ?? ''}${match[2] ?? ''}`);
      const note = cells['溝と穴の位置の備考'] ?? '';
      // 中央に置く根拠: 溝と穴に面からの寸法線が無く、2 本目の読みの備考が、下の溝の口の中心は縦の軸・右の溝の口の中心は横の軸の上、穴は軸の交点と書く。
      expect([dimensionsOf(cells['溝の位置の寸法線']).length, dimensionsOf(cells['穴の記入']).length], record.key).toEqual([0, 0]);
      expect([note.includes('下溝口中心はY軸'), note.includes('右溝口中心はX軸'), note.includes('交点')], record.key).toEqual([true, true, true]);
      expect(counts, record.key).toEqual(['上0', '下1', '左0', '右1']);
      const diameter = Number(/φ([0-9]+(?:\.[0-9]+)?)/u.exec(cells['穴の記入'] ?? '')?.[1] ?? NaN);
      expect([record.width, record.height, record.faces, record.centerHole], record.key).toEqual([width, height, 'br', diameter]);
      expect(record.outline?.vertices, record.key).toEqual([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2],
        [-width / 2, height / 2]]);
      expect(record.outline?.radii, record.key).toEqual(radiiOf(cells['角の丸みの記入']));
      expect([record.slotOpening, record.slotInnerWidth, record.shoulder, record.slotDepth], record.key).toEqual(slotShapeOf(cells['溝の形の寸法線']));
      expect([record.outline?.slots, record.outline?.holes], record.key).toEqual([[{ edge: 0, at: width / 2 }, { edge: 1, at: height / 2 }],
        [{ x: 0, y: 0, diameter }]]);
      expect([record.slot, record.simplified, record.simplifiedKinds], record.key).toEqual([record.slotOpening, [SYMMETRIC], ['slotPositionSymmetric']]);
    }
  });

  it('L 形の行: 外形・腕・角・溝の形は読みの値で、溝の口の中心は面からの記入が無いので各腕の幅の中央(印つき)、穴は作らない(印つき)', () => {
    expect(L_RECORDS.map((record) => record.key)).toEqual(['s6-l40x40-a20', 's8-l60x60-a30', 's10-l80x80-a40', 's10-l90x90-a45']);
    for (const record of L_RECORDS) {
      const { cells } = rowOf(record.key);
      const outer = lDimensionsOf(cells['外形の寸法線']);
      const both = (left: string, right: string): ((a: string, b: string) => boolean) => (a, b) => a === left && b === right;
      const [width, height] = [lValueOf(outer, both('左の外の面', '右の外の面')), lValueOf(outer, both('下の外の面', '上の外の面'))];
      const [arm, armY] = [lValueOf(outer, both('左の外の面', '腕の内の面(縦)')), lValueOf(outer, both('下の外の面', '腕の内の面(横)'))];
      const radius = /(\d+)-R([0-9]+(?:\.[0-9]+)?)/u.exec(cells['角の丸みの記入'] ?? '');
      const shape = lDimensionsOf(cells['溝の形の寸法線']);
      const opening = lValueOf(shape, (a) => a.includes('口の') && !a.includes('部屋'));
      const inner = lValueOf(shape, (a) => a.includes('部屋の'));
      const shoulder = lValueOf(shape, (a, b) => a.includes('外の面') && b.includes('肩の内の面'));
      const depth = lValueOf(shape, (a, b) => a.includes('肩の内の面') && b.includes('溝の底'));
      const middle = lValueOf(shape, (a, b) => a.includes('溝の底') && b.includes('溝の底') && !a.includes('肩') && !b.includes('肩'));
      const positions = lDimensionsOf(cells['溝の位置の寸法線']);
      const pitches = [...new Set(positions.map((item) => item.value))];
      const counts = new Map([...(cells['面ごとの溝の数'] ?? '').matchAll(/(腕の内\((?:縦|横)\)|上|下|左|右)(\d+)/gu)]
        .map((match): [string, number] => [match[1] ?? '', Number(match[2])]));
      // 中央に置く根拠: 溝の口の中心にも穴の中心にも、外の面からの(参考でない)寸法線が無い。
      const fromFace = (items: readonly Dimension[]): boolean => items.some((item) => `${item.a}|${item.b}`.includes('外の面')
        && (`${item.a}|${item.b}`.includes('中心')));
      expect([fromFace(positions), fromFace(lDimensionsOf(cells['穴の記入']))], record.key).toEqual([false, false]);
      expect([radius?.[1], arm, pitches.length, 2 * (shoulder + depth) + middle], record.key).toEqual(['5', armY, 1, arm]);
      const r = Number(radius?.[2]);
      const pitch = pitches[0] ?? NaN;
      const [w2, h2] = [width / 2, height / 2];
      expect([record.width, record.height, record.armWidth, record.cornerRadius, record.slotPitch, record.faces], record.key)
        .toEqual([width, height, arm, r, pitch, 'tblr']);
      expect([record.slot, record.slotOpening, record.slotInnerWidth, record.shoulder, record.slotDepth], record.key)
        .toEqual([opening, opening, inner, shoulder, depth]);
      expect(record.outline?.vertices, record.key).toEqual([[-w2, -h2], [w2, -h2], [w2, -h2 + arm], [-w2 + arm, -h2 + arm], [-w2 + arm, h2], [-w2, h2]]);
      expect(record.outline?.radii, record.key).toEqual([r, r, r, 0, r, r]);
      const x0 = arm / 2;
      const expected = [{ edge: 0, at: x0 }, { edge: 0, at: x0 + pitch }, { edge: 1, at: x0 }, { edge: 2, at: width - (x0 + pitch) },
        { edge: 3, at: x0 + pitch - arm }, { edge: 4, at: arm - x0 }, { edge: 5, at: height - (x0 + pitch) }, { edge: 5, at: height - x0 }];
      expect(record.outline?.slots, record.key).toEqual(expected);
      expect(L_COUNT_NAMES.map((name) => counts.get(name)), record.key)
        .toEqual(L_COUNT_NAMES.map((_, edge) => expected.filter((slot) => slot.edge === edge).length));
      expect([record.outline?.holes, record.centerHole, record.simplified, record.simplifiedKinds], record.key)
        .toEqual([[], 0, [SYMMETRIC, NO_HOLES], ['slotPositionSymmetric']]);
    }
  });

  it('溝の間隔が個別の長方形の行(4 つの面に溝): 溝と穴の並びは読みの間のまま、外の面からの記入が無いので面の中央に置く(印つき)', () => {
    expect(GRID_CENTERED_RECORDS.map((record) => record.key)).toEqual(['s6-40x60-t2s3', 's8-50x100-t2s4', 's10-45x60-t1s1']);
    for (const record of GRID_CENTERED_RECORDS) {
      const { cells } = rowOf(record.key);
      const outer = dimensionsOf(cells['外形の寸法線']);
      const x = positions(outer.filter((item) => item.a in X_FACES || item.b in X_FACES), X_FACES);
      const y = positions(outer.filter((item) => item.a in Y_FACES || item.b in Y_FACES), Y_FACES);
      const [width, height] = [x.get('右の外の面') ?? NaN, y.get('上の外の面') ?? NaN];
      const counts = new Map([...(cells['面ごとの溝の数'] ?? '').matchAll(/(上|下|左|右)(\d+)/gu)].map((match): [string, number] => [match[1] ?? '', Number(match[2])]));
      const [top, side] = [counts.get('上') ?? NaN, counts.get('左') ?? NaN];
      const [slotParts, holeParts] = [axisParts(cells['溝の位置の寸法線']), axisParts(cells['穴の記入'])];
      // 中央に置く根拠: 溝と穴の寸法線に外の面に届く物が無い。上と下・左と右の溝の数は同じで、溝の間は 1 つの面ぶんだけ書かれている。
      const all = [...slotParts.横, ...slotParts.縦, ...holeParts.横, ...holeParts.縦];
      expect([all.some((item) => `${item.a}|${item.b}`.includes('外の面')), counts.get('下'), counts.get('右'), slotParts.横.length, slotParts.縦.length],
        record.key).toEqual([false, top, side, top - 1, side - 1]);
      const [xs, ys] = [centeredPoints(slotParts.横.map((item) => item.value)), centeredPoints(slotParts.縦.map((item) => item.value))];
      const expectedSlots = [...xs.map((at) => ({ edge: 0, at: width / 2 + at })), ...ys.map((at) => ({ edge: 1, at: height / 2 + at })),
        ...xs.map((at) => ({ edge: 2, at: width / 2 - at })), ...ys.map((at) => ({ edge: 3, at: height / 2 - at }))]
        .sort((p, q) => p.edge - q.edge || p.at - q.at);
      // 穴: 「数-φ径」。横と縦の並びの点(最初の端 A と各端 B)のうち、名前に「穴」を持つ点が列と段(中心線 X などは数えない)。
      // 数の無い「φ径」が 1 つで位置の寸法線が無い穴は、外形の中心の穴(行の centerHole もその径)。
      const hole = /(\d+)-φ([0-9]+(?:\.[0-9]+)?)/u.exec(cells['穴の記入'] ?? '');
      const single = /φ([0-9]+(?:\.[0-9]+)?)/u.exec(cells['穴の記入'] ?? '');
      const central = hole === null && single !== null && holeParts.横.length === 0 && holeParts.縦.length === 0;
      const lineOf = (items: readonly Dimension[]): readonly number[] => {
        const names = [items[0]?.a ?? '', ...items.map((item) => item.b)];
        return centeredPoints(items.map((item) => item.value)).filter((_, index) => names[index]?.includes('穴') === true);
      };
      const lines: readonly [readonly number[], readonly number[], number] = central ? [[0], [0], Number(single?.[1])]
        : [lineOf(holeParts.横), lineOf(holeParts.縦), Number(hole?.[2])];
      const [columns, rows, diameter] = lines;
      const expectedHoles = columns.flatMap((hx) => rows.map((hy) => ({ x: hx, y: hy, diameter }))).sort((p, q) => p.x - q.x || p.y - q.y);
      expect([columns.length * rows.length, record.width, record.height, record.faces, record.slotsAcross, record.centerHole], record.key)
        .toEqual([central ? 1 : Number(hole?.[1]), width, height, 'tblr', top, central ? diameter : 0]);
      expect(record.outline?.vertices, record.key).toEqual([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2],
        [-width / 2, height / 2]]);
      expect(record.outline?.radii, record.key).toEqual(radiiOf(cells['角の丸みの記入']));
      expect([record.slotOpening, record.slotInnerWidth, record.shoulder, record.slotDepth], record.key)
        .toEqual(slotShapeAnyAxisOf(cells['溝の形の寸法線']));
      // 溝の間の欄は、2 本の面の溝の口の中心の間(各面 1 本の行は外形の幅。R 形の行と同じ)。
      expect([record.outline?.slots, record.outline?.holes, record.slotPitch], record.key)
        .toEqual([expectedSlots, expectedHoles, xs.length > 1 ? (xs[1] ?? NaN) - (xs[0] ?? NaN) : width]);
      expect([record.slot, record.simplified, record.simplifiedKinds], record.key).toEqual([record.slotOpening, [SYMMETRIC], ['slotPositionSymmetric']]);
    }
  });

  it('族の行は長方形の格子の行の後に並び、形・体積は外周の台本の面積 × 長さ、質量は単位質量 × 長さ、外形の箱と締結の溝は外周から', () => {
    for (const record of T_SLOT_OUTLINE_RECORDS) {
      const family = familyOf(record.slot);
      const row = family.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined || record.outline === undefined) throw new Error(`族に ${record.key} が無い`);
      expect(family.rows.slice(-T_SLOT_OUTLINE_RECORDS.filter((item) => item.slot === record.slot).length).map((item) => item.key))
        .toContain(record.key);
      const profile = slottedOutlineProfile({ ...record.outline, slotOpening: record.slotOpening, shoulder: record.shoulder,
        slotInnerWidth: record.slotInnerWidth, slotDepth: record.slotDepth });
      const values = { length: '300' };
      expect(family.build(row, values)?.name, record.key).toBe(`アルミフレーム ${record.size}×300`);
      expect(family.nominalVolume(row, values) ?? NaN, record.key).toBeCloseTo((profile?.areaMm2 ?? NaN) * 300, 6);
      expect(family.nominalMassG?.(row, values) ?? NaN, record.key).toBeCloseTo(record.unitMassKgPerM * 300, 9);
      // 内側を埋めた簡略の形なので、外周の面積は表の断面積(実物)より小さくない(断面積が資料に無い行は確かめない)。
      if (record.areaMm2 !== null) expect(profile?.areaMm2 ?? NaN, record.key).toBeGreaterThanOrEqual(record.areaMm2);
      expect(family.sectionBounds?.(row, values), record.key).toEqual({ minX: -record.width / 2, minY: -record.height / 2, maxX: record.width / 2,
        maxY: record.height / 2 });
      // 面の名前は内向きの法線から: 長方形は辺 0〜3 が下・右・上・左、L 形は L_FACES(腕の内の横の面は上へ、縦の面は右へ開く面)。
      expect(family.sectionSlots?.(row, values)?.map((slot) => slot.face), record.key).toEqual(record.outline.slots.map((slot) => (
        record.armWidth !== undefined ? L_FACES[slot.edge] : slot.edge === 0 ? 'bottom' : slot.edge === 1 ? 'right' : slot.edge === 2 ? 'top' : 'left')));
    }
  });
});
