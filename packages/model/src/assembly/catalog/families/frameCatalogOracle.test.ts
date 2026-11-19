/**
 * 資料 1 のフレームの製品の行(frameCatalogRows.ts。1 回目の読みの値)が、全部 2 回目の独立の読み(frameCatalogOracle.fixture.json。
 * 読みの文字のまま)と 1 行ずつ一致する事の検査。fixture の文字は、この検査が自分で読み解く(行の表を作る道具の読み解きと別にする)。
 * 2 回目の読みが置かれていない間(available が false)は、製品の行が 0 である事を確かめる(照らしていない行を製品に入れない)。
 * fixture は JSON のファイルで、この検査がファイルとして読む(アプリのモジュールを持たない)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ALUMINUM_SECTION_FAMILIES, type AluminumSectionRecord } from './aluminumSections.js';
import { ALUMINUM_SECTION_RECORDS, T_SLOT_CATALOG_RECORDS } from './frameCatalogRows.js';
import { T_SLOT_OUTLINE_RECORDS } from './frameOutlineRows.js';
import { T_SLOT_CATALOG_FAMILIES, type TSlotCatalogRecord } from './tSlotFrameCatalog.js';

interface SecondReading {
  readonly available: boolean;
  readonly tSlot: readonly (readonly string[])[];
  readonly sections: readonly (readonly string[])[];
}

const isRows = (value: unknown): value is readonly (readonly string[])[] => Array.isArray(value)
  && value.every((row: unknown) => Array.isArray(row) && row.every((cell: unknown) => typeof cell === 'string'));

/** fixture の JSON を読み、形(available・tSlot・sections)を確かめる。 */
function readSecondReading(): SecondReading {
  const value: unknown = JSON.parse(readFileSync(new URL('./frameCatalogOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('available' in value) || !('tSlot' in value) || !('sections' in value)) {
    throw new Error('fixture の形が違う');
  }
  const { available, tSlot, sections } = value;
  if (typeof available !== 'boolean' || !isRows(tSlot) || !isRows(sections)) throw new Error('fixture の欄の形が違う');
  return { available, tSlot, sections };
}

const READING = readSecondReading();

/**
 * 断面性能の表に行があっても、単位質量だけは頁の箱の値を使う断面の鍵(統括の決定 2026-11-19)。表の単位質量が表の断面積 × 2.70 と 1% を超えて
 * 合わず、頁の箱(2 回目の読み)・断面積 × 2.70・参考の組立 CAD の表示の 3 つが同じ値の物。断面の値と断面積は表の値。
 */
const BOX_MASS_OVER_TABLE: ReadonlySet<string> = new Set(['s10-40x80-tbl']);

/**
 * 四隅の小さい穴の位置が参考寸法だけの断面の鍵(統括の決定 2026-11-19 の (3))。穴を作らず、簡略の印を 1 つ持つ。下の検査で、2 本目の読みに
 * 四隅の穴の記入と参考寸法の位置がある事を確かめる(穴の無い断面に印を付けない)。
 */
const NO_CORNER_HOLES: ReadonlySet<string> = new Set(['s8-30x30']);
const NO_CORNER_HOLES_MARK = '四隅の小さい穴(位置は参考寸法だけ)';

/** 括弧の外の「;」で分ける(「φ8.5×2(縦に50間隔;…)」の括弧の中は分けない)。 */
function splitOutsideParens(text: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ';' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  return [...parts, current.trim()].filter((part) => part !== '');
}

/** 2 つの印字が、粗い方の桁に丸めて同じか(5.271 と 5.27)。 */
function samePrinted(first: string, second: string): boolean {
  const places = Math.min(...[first, second].map((text) => text.split('.')[1]?.length ?? 0));
  return Number(Number(first).toFixed(places)) === Number(Number(second).toFixed(places));
}

/** 頁の箱 [Ix, Iy, Zx, Zy] と表の値が、向きの入れ替わり(Ix・Iy か Zx・Zy)だけで違う。 */
function swappedOnly(box: readonly string[], table: readonly string[]): boolean {
  const [bx = '', by = '', bzx = '', bzy = ''] = box;
  const [tx = '', ty = '', tzx = '', tzy = ''] = table;
  const same = samePrinted(bx, tx) && samePrinted(by, ty) && samePrinted(bzx, tzx) && samePrinted(bzy, tzy);
  const inertia = (samePrinted(bx, ty) && samePrinted(by, tx)) || (samePrinted(bx, tx) && samePrinted(by, ty));
  const modulus = (samePrinted(bzx, tzy) && samePrinted(bzy, tzx)) || (samePrinted(bzx, tzx) && samePrinted(bzy, tzy));
  return !same && inertia && modulus;
}

/**
 * 2 回目の読みの溝つきの 1 行を、製品の行と同じ欄に読み解く。2 回目の「溝の深さ」は、2 回目の README のとおり多くの行で「肩 + 肩の内面から溝の底まで」の
 * 合算(深さの欄の意味が「外の面から」)なので、肩を引いて溝の中の深さにする(製品の行に入れたのは、担当が頁の寸法線でこの意味を確かめた行だけ)。
 * 2 回目の担当が「肩の内面から溝の底まで」の定義で読み直した行(意味が「肩の内面から」)は、そのままの値。
 */
function readTSlot(cells: readonly string[]): Omit<TSlotCatalogRecord, 'size' | 'slot'> {
  const [key = '', figurePage = '', width = '', height = '', opening = '', shoulder = '', depth = '', depthMeaning = '', inner = '',
    facesText = '', pitch = '', holesText = '', radiusText = '', insetText = '', boxText = '', tablePage = '', ix = '', iy = '', zx = '', zy = '',
    area = '', mass = ''] = cells;
  if (depthMeaning !== '外の面から' && depthMeaning !== '肩の内面から') throw new Error(`2 回目の読みの行 ${key} の深さの欄の意味 ${depthMeaning} を読み解けない`);
  const faces = /^上([0-9]+) 下([0-9]+) 左([0-9]+) 右([0-9]+)$/u.exec(facesText);
  const tokens = splitOutsideParens(holesText);
  const center = tokens.map((token) => /^(?:中心)?φ([0-9.]+)×([0-9]+)/u.exec(token)).find((match) => match !== null);
  const corner = tokens.map((token) => /^角φ([0-9.]+)×4/u.exec(token)).find((match) => match !== null);
  const radius = /^4-R([0-9.]+)$/u.exec(radiusText.split(';')[0]?.trim() ?? '');
  const inset = /^\(([0-9.]+)\)=参考/u.exec(insetText);
  const box = /^([0-9.]+)kg\/m Ix=([0-9.]+)e4 Iy=([0-9.]+)e4 Zx=([0-9.]+)e3 Zy=([0-9.]+)e3$/u.exec(boxText);
  if (faces === null || center === undefined || radius === null || box === null) throw new Error(`2 回目の読みの行 ${key} を読み解けない`);
  const counts = faces.slice(1, 5).map(Number);
  const onTable = tablePage !== '';
  // 表に行があっても単位質量だけは頁の箱の値を使う断面(統括の決定。下の検査で、表の質量が外れ、箱の質量が断面積 × 2.70 に合う事を確かめる)。
  const boxMass = BOX_MASS_OVER_TABLE.has(key);
  const noCorner = NO_CORNER_HOLES.has(key);
  // 頁の箱と表の値が向きだけ違う断面は、断面の値を持たない(統括の決定)。
  const withheld = onTable && swappedOnly(box.slice(2, 6), [ix, iy, zx, zy]);
  const property = (fromTable: string, fromBox: string | undefined): number | null => (withheld ? null : Number(onTable ? fromTable : fromBox));
  return {
    key, figurePage: Number(figurePage), tablePage: onTable ? Number(tablePage) : null, massSource: onTable && !boxMass ? 'table' : 'box',
    width: Number(width), height: Number(height), slotPitch: pitch === '' ? Number(width) : Number(pitch),
    slotsAcross: Math.max(counts[0] ?? 0, counts[1] ?? 0) || Number(center[2]) / Math.max(counts[2] ?? 0, counts[3] ?? 0),
    faces: ['t', 'b', 'l', 'r'].filter((_, index) => (counts[index] ?? 0) > 0).join(''), slotOpening: Number(opening), shoulder: Number(shoulder),
    slotInnerWidth: Number(inner), slotDepth: depthMeaning === '外の面から' ? Number(depth) - Number(shoulder) : Number(depth),
    centerHole: Number(center[1]),
    cornerRadius: Number(radius[1]), cornerHoleDiameter: corner === undefined || noCorner ? 0 : Number(corner[1]),
    cornerHoleInset: corner === undefined || noCorner ? 0 : Number(inset?.[1] ?? NaN),
    areaMm2: onTable ? Number(area) : null, unitMassKgPerM: Number(onTable && !boxMass ? mass : box[1]), ixCm4: property(ix, box[2]),
    iyCm4: property(iy, box[3]), zxCm3: property(zx, box[4]), zyCm3: property(zy, box[5]),
    ...(noCorner ? { simplified: [NO_CORNER_HOLES_MARK] } : {}),
  };
}

/** 表の断面の値が、Ix と Iy の大小と Zx と Zy の大小で逆向き(入れ替わって見える)。 */
function propertiesLookSwapped(ix: number, iy: number, zx: number, zy: number): boolean {
  return (ix - iy) * (zx - zy) < 0;
}

/** 2 回目の読みの共通フレームの 1 行を、製品の行と同じ欄に読み解く。 */
function readSection(cells: readonly string[]): Omit<AluminumSectionRecord, 'size'> {
  const [key = '', page = '', kindText = '', dimsText = '', mass = '', ix = '', iy = '', zx = '', zy = ''] = cells;
  const pairs = new Map(dimsText.split(';').map((part): [string, string] => {
    const [name = '', value = ''] = part.split('=');
    return [name.trim(), value.trim()];
  }));
  const kinds: Readonly<Record<string, AluminumSectionRecord['kind']>> = { 'チャンネル': 'channel', '角パイプ': 'squarePipe', '丸棒': 'roundBar',
    '穴あきの丸棒': 'roundBar', 'フラットバー': 'flatBar', 'アングル': 'angle' };
  const kind = kinds[kindText];
  if (kind === undefined) throw new Error(`2 回目の読みの行 ${key} の種類 ${kindText} を読み解けない`);
  const value = (name: string): number | undefined => (pairs.has(name) ? Number(pairs.get(name)) : undefined);
  const thickness = value("t(t')") ?? value('t');
  const withheld = propertiesLookSwapped(Number(ix), Number(iy), Number(zx), Number(zy));
  const property = (text: string): number | null => (withheld ? null : Number(text));
  const common = { key, kind, page: Number(page), unitMassKgPerM: Number(mass), ixCm4: property(ix), iyCm4: property(iy), zxCm3: property(zx),
    zyCm3: property(zy) };
  if (kind === 'roundBar') {
    const hole = value('穴径');
    return { ...common, diameter: value('径') ?? NaN, ...(hole === undefined ? {} : { holeDiameter: hole }) };
  }
  if (kind === 'flatBar') return { ...common, height: value('H') ?? NaN, thickness: thickness ?? NaN };
  return { ...common, height: value('H') ?? NaN, width: value('h') ?? NaN, thickness: thickness ?? NaN };
}

describe('資料 1 のフレームの製品の行と 2 回目の独立の読みの突合せ', () => {
  it('2 回目の読みが置かれていない間は、製品の行が 0(照らしていない行を製品に入れない)', () => {
    if (READING.available) {
      expect(READING.tSlot.length + READING.sections.length).toBeGreaterThan(0);
      return;
    }
    expect([T_SLOT_CATALOG_RECORDS.length, ALUMINUM_SECTION_RECORDS.length, READING.tSlot.length, READING.sections.length]).toEqual([0, 0, 0, 0]);
  });

  it('溝つきの製品の行は、全部 2 回目の読みに同じ鍵の行があり、製品に使う欄が全部一致する', () => {
    const second = new Map(READING.tSlot.map((cells) => [cells[0] ?? '', readTSlot(cells)]));
    expect(T_SLOT_CATALOG_RECORDS.map((record) => record.key).sort()).toEqual([...second.keys()].sort());
    // 呼びと溝幅は 2 回目の読みに無い(道具が決まった規則で付けた)ので、製品の行の値をそのまま添えて、ほかの欄を照らす。
    for (const record of T_SLOT_CATALOG_RECORDS) {
      const parsed = second.get(record.key);
      expect(parsed === undefined ? undefined : { ...parsed, size: record.size, slot: record.slot }, record.key).toEqual(record);
    }
  });

  it('頁の箱の単位質量を使う断面は、表の単位質量が断面積 × 2.70 と 1% を超えて違い、箱の単位質量は 1% の内で合い、断面の値は表と箱で同じ', () => {
    const rows = new Map(READING.tSlot.map((cells) => [cells[0] ?? '', cells]));
    for (const key of BOX_MASS_OVER_TABLE) {
      const cells = rows.get(key) ?? [];
      const [, , , , , , , , , , , , , , boxText = '', tablePage = '', ix = '', iy = '', zx = '', zy = '', area = '', mass = ''] = cells;
      const box = /^([0-9.]+)kg\/m Ix=([0-9.]+)e4 Iy=([0-9.]+)e4 Zx=([0-9.]+)e3 Zy=([0-9.]+)e3$/u.exec(boxText);
      expect([tablePage !== '', box !== null], key).toEqual([true, true]);
      const byArea = Number(area) * 2.7e-3;
      expect(Math.abs(byArea - Number(mass)) / Number(mass), key).toBeGreaterThan(0.01);
      expect(Math.abs(byArea - Number(box?.[1])) / Number(box?.[1]), key).toBeLessThanOrEqual(0.01);
      expect([box?.[2], box?.[3], box?.[4], box?.[5]].map((text, index) => samePrinted(text ?? '', [ix, iy, zx, zy][index] ?? '')), key)
        .toEqual([true, true, true, true]);
      expect(T_SLOT_CATALOG_RECORDS.find((record) => record.key === key)?.massSource, key).toBe('box');
    }
  });

  it('四隅の穴を作らない断面は、2 本目の読みに四隅の穴の記入と参考寸法の位置があり、製品の行は穴なしで簡略の印を 1 つ持つ', () => {
    const rows = new Map(READING.tSlot.map((cells) => [cells[0] ?? '', cells]));
    for (const key of NO_CORNER_HOLES) {
      const cells = rows.get(key) ?? [];
      const holesText = cells[11] ?? '';
      const insetText = cells[13] ?? '';
      expect([/角φ[0-9.]+×4/u.test(holesText), /^\([0-9.]+\)=参考/u.test(insetText)], key).toEqual([true, true]);
      const record = T_SLOT_CATALOG_RECORDS.find((item) => item.key === key);
      expect([record?.cornerHoleDiameter, record?.cornerHoleInset, record?.simplified], key).toEqual([0, 0, [NO_CORNER_HOLES_MARK]]);
    }
    // 印を持つ溝つきの行は、この一覧の行だけ。
    expect(T_SLOT_CATALOG_RECORDS.filter((record) => record.simplified !== undefined).map((record) => record.key)).toEqual([...NO_CORNER_HOLES]);
  });

  it('共通フレームの製品の行は、全部 2 回目の読みに同じ鍵の行があり、寸法と表の値が全部一致する', () => {
    const second = new Map(READING.sections.map((cells) => [cells[0] ?? '', readSection(cells)]));
    expect(ALUMINUM_SECTION_RECORDS.map((record) => record.key).sort()).toEqual([...second.keys()].sort());
    for (const record of ALUMINUM_SECTION_RECORDS) {
      const parsed = second.get(record.key);
      expect(parsed === undefined ? undefined : { ...parsed, size: record.size }, record.key).toEqual(record);
    }
  });

  it('族の行は、行の表の行と同じ数・同じ鍵(溝幅ごと・種類ごとに分けただけ。外周の指定を持つ行の表を含む)', () => {
    const tSlotKeys = [T_SLOT_CATALOG_FAMILIES.s6, T_SLOT_CATALOG_FAMILIES.s8, T_SLOT_CATALOG_FAMILIES.s10].flatMap((family) => family.rows.map((row) => row.key));
    expect(tSlotKeys.sort()).toEqual([...T_SLOT_CATALOG_RECORDS, ...T_SLOT_OUTLINE_RECORDS].map((record) => record.key).sort());
    const sectionKeys = Object.values(ALUMINUM_SECTION_FAMILIES).flatMap((family) => family.rows.map((row) => row.key));
    expect(sectionKeys.sort()).toEqual(ALUMINUM_SECTION_RECORDS.map((record) => record.key).sort());
  });
});
