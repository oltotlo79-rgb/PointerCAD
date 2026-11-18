/**
 * 資料 SF-1 の小さい溝つきフレーム・端のキャップ・ブラケット素材の 3 族の検査: 族の版と欄、行の名乗りと出どころ、形の押し出しと名前、
 * 体積は面積 × 長さ(キャップは面積 × 厚さ)、質量は単位質量 × 長さ(キャップは資料の 1 個の値)、作った溝だけを行が持つ事、簡略の印、全部の行で形が作れる事。
 * 製品が使う口(族の定数と行の表)だけを通して確かめる。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { T_SLOT_CATALOG_RECORDS } from './frameCatalogRows.js';
import { BRACKET_STOCK_FAMILY, SMALL_FRAME_CAP_FAMILY, SMALL_T_SLOT_FRAME_FAMILY, type SmallFrameRecord } from './smallFrameCatalog.js';
import { BRACKET_STOCK_RECORDS, SMALL_FRAME_CAP_RECORDS, SMALL_FRAME_RECORDS } from './smallFrameRows.js';

const FAMILIES = [SMALL_T_SLOT_FRAME_FAMILY, SMALL_FRAME_CAP_FAMILY, BRACKET_STOCK_FAMILY] as const;
const values = (length: number): Readonly<Record<string, string>> => ({ length: String(length) });
const NOT_MADE = '（寸法の記入が無いため作っていない）';
const SYMMETRIC = '溝と穴の横の位置は図に記入が無いので、幅の中央に対して対称に置いた';

function rowOf(family: CatalogFamily, key: string): CatalogItemRow {
  const row = family.rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`row ${key} is missing`);
  return row;
}

describe('資料 SF-1 の小さい溝つきフレーム・端のキャップ・ブラケット素材', () => {
  // 小さい溝つきフレームは 14 行(左右の形が 2 本の読みとも違って見えた 2 品目は入れない。統括 2026-11-18 02:2x)。
  it('族は 3 つで、版・欄・線図・数え方を凍結し、行の数は 14・6・2、行は規格の行を名乗らない', () => {
    expect(FAMILIES.map((family) => [family.id, family.group, family.kindKey, family.catalogRevision, family.generatorRevision, family.stock,
      family.diagram, family.options.filter((spec) => spec.optional !== true).map((spec) => spec.key), family.rows.length])).toEqual([
      ['t-slot-frame-small', 'aluminumFrame', 'catalog.frame.kind.smallFrame', 't-slot-frame-small-2026-11-r1', 'small-frame-1', 'linear', 'smallFrame',
        ['length'], 14],
      ['t-slot-frame-cap-small', 'aluminumFrame', 'catalog.frame.kind.smallFrameCap', 't-slot-frame-cap-small-2026-11-r1', 'small-frame-1', 'count',
        'smallFrameCap', [], 6],
      ['bracket-stock', 'aluminumFrame', 'catalog.frame.kind.bracketStock', 'bracket-stock-2026-11-r1', 'small-frame-1', 'linear', 'bracketStock',
        ['length'], 2],
    ]);
    expect(SMALL_T_SLOT_FRAME_FAMILY.rows.map((row) => row.key)).toEqual(SMALL_FRAME_RECORDS.map((record) => record.key));
    expect(SMALL_FRAME_CAP_FAMILY.rows.map((row) => row.key)).toEqual(SMALL_FRAME_CAP_RECORDS.map((record) => record.key));
    expect(BRACKET_STOCK_FAMILY.rows.map((row) => row.key)).toEqual(BRACKET_STOCK_RECORDS.map((record) => record.key));
    for (const family of FAMILIES) {
      expect(new Set(family.rows.map((row) => row.size)).size).toBe(family.rows.length);
      for (const row of family.rows) {
        expect([row.standardLabel, row.verification, row.verified, row.evidence.sha256, row.evidence.url], row.key)
          .toEqual(['製造元の寸法に合わせた物', 'manufacturer-catalog', true, '', '']);
        expect(row.evidence.locator, row.key).toMatch(/^PDF 33[789] 頁 /);
        expect(row.size + row.key, row.key).not.toMatch(/[A-Z]{2,}-?[0-9]|UF|SS[0-9]/);
        expect(row.simplified?.length ?? 0, row.key).toBeGreaterThan(0);
      }
    }
  });

  it('小さい溝つきフレームの行は作った溝だけを番号つきの欄で持ち、作っていない溝は印に出す(作った溝の数 = 行の溝の数)', () => {
    for (const record of SMALL_FRAME_RECORDS) {
      const row = rowOf(SMALL_T_SLOT_FRAME_FAMILY, record.key);
      expect(row.dims.slotCount, record.key).toBe(record.slots.length);
      expect(row.dims.holeCount, record.key).toBe(record.holes.length);
      record.slots.forEach((slot, index) => {
        expect([row.dims[`slot${index}Mouth`], row.dims[`slot${index}Room`], row.dims[`slot${index}Position`]], record.key)
          .toEqual([slot.mouthWidth, slot.roomWidth, slot.position]);
      });
      const notMade = record.simplified.filter((mark) => mark.endsWith(NOT_MADE));
      expect(notMade.every((mark) => /^(上|下)の面の溝|^(左|右)の端の溝/.test(mark)), record.key).toBe(true);
    }
    // 幅の広い 180 の物は、上の 4 本と左の 1 本だけを作り、下の面と右の端の溝は印(統括 18:2x)。
    const wide = SMALL_FRAME_RECORDS.find((record) => record.width === 180);
    expect(wide?.slots.map((slot) => slot.face)).toEqual(['top', 'top', 'top', 'top', 'left']);
    expect(wide?.simplified).toEqual(expect.arrayContaining([`下の面の溝${NOT_MADE}`, `右の端の溝${NOT_MADE}`]));
  });

  it('溝と横の穴の位置の記入が図に無い 7 行は、上下の面の溝と穴を幅の中央に対して対称に置き、そのことを印に出す(統括 2026-11-18 00:2x・02:2x)', () => {
    const marked = SMALL_FRAME_RECORDS.filter((record) => record.simplified.includes(SYMMETRIC));
    expect(marked.map((record) => record.key)).toEqual(['small-20x10-t6', 'small-30x15-t8', 'small-20x15-l6-r6', 'small-40x15-l6-r6-t8',
      'small-50x20-l6-r6-t10', 'small-180x15-l6-t10', 'small-120x15-b8-l6-t8']);
    for (const record of marked) {
      // 上下の面の溝は、同じ面・同じ大きさで位置の符号を変えた溝が必ずある(位置 0 は自分自身)。
      for (const slot of record.slots.filter((candidate) => candidate.face === 'top' || candidate.face === 'bottom')) {
        expect(record.slots.some((other) => other.face === slot.face && other.mouthWidth === slot.mouthWidth && other.roomWidth === slot.roomWidth
          && other.position === -slot.position), `${record.key} ${slot.face} ${slot.position}`).toBe(true);
      }
      // 穴は、同じ径・同じ高さで横の位置の符号を変えた穴が必ずある。
      for (const hole of record.holes) {
        expect(record.holes.some((other) => other.diameter === hole.diameter && other.y === hole.y && other.x === -hole.x),
          `${record.key} ${hole.x}`).toBe(true);
      }
      // 印は選ぶ画面の行の簡略の欄にそのまま出る。
      expect(rowOf(SMALL_T_SLOT_FRAME_FAMILY, record.key).simplified, record.key).toContain(SYMMETRIC);
    }
  });

  it('形は断面の押し出しで名前は呼びと長さ、体積は面積 × 長さ、質量は単位質量 × 長さ(長さを持つ 2 族)。全部の行で形が作れる', () => {
    for (const family of [SMALL_T_SLOT_FRAME_FAMILY, BRACKET_STOCK_FAMILY]) {
      for (const row of family.rows) {
        const part = family.build(row, values(600));
        expect(part?.name, row.key).toBe(`${row.size}×600`);
        const holes = row.dims.holeCount ?? 0;
        expect(part?.solids.map((feature) => feature.kind), row.key).toEqual(['extrude', ...Array.from({ length: holes }, () => ['extrude', 'boolean']).flat()]);
        expect(family.nominalMassG?.(row, values(600)), row.key).toBeCloseTo((row.dims.unitMassKgPerM ?? NaN) * 600, 9);
        expect(family.nominalVolume(row, values(600)), row.key).toBeGreaterThan(0);
        expect(family.build(row, values(0)), row.key).toBeNull();
      }
    }
    // 16×8.5 の上の溝 1 本: 面積 = 136 − 6 × 2 − (12 + 4) ÷ 2 × 4 = 92。
    const small = rowOf(SMALL_T_SLOT_FRAME_FAMILY, 'small-16x8.5-t6');
    expect(SMALL_T_SLOT_FRAME_FAMILY.nominalVolume(small, values(600))).toBeCloseTo(92 * 600, 6);
    expect(SMALL_T_SLOT_FRAME_FAMILY.sectionBounds?.(small, values(600))).toEqual({ minX: -8, minY: -4.25, maxX: 8, maxY: 4.25 });
    // ブラケット素材 51.4: 面積 = L(51.4 × 9.4 + 9.4 × 42)+ 角の三角(22 × 22 ÷ 2)− 穴 φ4.2。
    const bracket = rowOf(BRACKET_STOCK_FAMILY, 'bracket-stock-51.4x51.4');
    expect(BRACKET_STOCK_FAMILY.nominalVolume(bracket, values(600)))
      .toBeCloseTo((51.4 * 9.4 + 9.4 * 42 + 242 - Math.PI * 4.2 ** 2 / 4) * 600, 6);
  });

  it('端のキャップは板だけの形で、体積は板の面積 × 厚さ、質量は資料の 1 個の値、印は取付けの脚と穴', () => {
    for (const record of SMALL_FRAME_CAP_RECORDS) {
      const row = rowOf(SMALL_FRAME_CAP_FAMILY, record.key);
      expect(SMALL_FRAME_CAP_FAMILY.build(row, {})?.name).toBe(record.size);
      expect(SMALL_FRAME_CAP_FAMILY.nominalVolume(row, {})).toBeCloseTo(record.width * record.height * record.thickness, 9);
      expect(SMALL_FRAME_CAP_FAMILY.nominalMassG?.(row, {})).toBe(record.massG);
      expect([row.densityMaterialId, row.simplified]).toEqual(['nylon', ['取付けの脚と穴']]);
    }
    // キャップの合うフレームは、小さい溝つきフレームの行の鍵(呼びにフレームの外形と溝の面を出す)。
    for (const record of SMALL_FRAME_CAP_RECORDS) {
      expect(SMALL_FRAME_RECORDS.some((frame) => record.key === `cap-${frame.key}`), record.key).toBe(true);
    }
  });
});

// 下書き(統括の決定 2026-11-18 07:2x。型 FrameSectionSlot.nominalWidth・CatalogItemRow.simplifiedKinds が入った後に、--slot-info で作った行の表で流す)。
describe('小さい溝つきフレームの締結に出す溝(溝ごとの呼び・行の呼び・印の鍵)', () => {
  const ORDER = ['top', 'left', 'bottom', 'right'];
  // 1 冊目の標準のフレームの溝の組(口・中の幅・肩・深さ → 呼び)を、検査が自分で行の表から作る(道具の決め方と別に照らす)。
  const STANDARD = new Map<string, Set<number>>();
  for (const record of T_SLOT_CATALOG_RECORDS) {
    const key = [record.slotOpening, record.slotInnerWidth, record.shoulder, record.slotDepth].join('/');
    STANDARD.set(key, new Set([...(STANDARD.get(key) ?? []), record.slot]));
  }
  // 標準の組に当たる溝は呼びの数、当たらない溝は null(溝はあるが、溝用のナットの溝幅が決まらない。統括 2026-11-18 10:0x)。
  const nominalOf = (slot: SmallFrameRecord['slots'][number]): number | null => {
    const hit = STANDARD.get([slot.mouthWidth, slot.roomWidth, slot.shoulder, slot.roomHeight].join('/'));
    return hit?.size === 1 ? [...hit][0] ?? null : null;
  };

  it('溝の呼びは、溝の 4 つの寸法が標準の溝と同じ組の溝は数、ほかの溝は null。行の呼びは溝が全部同じ数の呼びの行だけが持つ', () => {
    for (const record of SMALL_FRAME_RECORDS) {
      expect(record.slots.map((slot) => slot.nominalWidth), record.key).toEqual(record.slots.map(nominalOf));
      const nominals = new Set(record.slots.map(nominalOf));
      const uniform = record.slots.length > 0 && !nominals.has(null) && nominals.size === 1;
      expect(rowOf(SMALL_T_SLOT_FRAME_FAMILY, record.key).dims.slotWidth, record.key).toBe(uniform ? [...nominals][0] : undefined);
    }
  });

  it('締結に出す溝は作った溝の全部で、面の順(上・左・下・右)・外の面の上の口の中心・向き・口・肩・深さ・呼び(数か null)が行の値と同じ', () => {
    for (const record of SMALL_FRAME_RECORDS) {
      const slots = SMALL_T_SLOT_FRAME_FAMILY.sectionSlots?.(rowOf(SMALL_T_SLOT_FRAME_FAMILY, record.key), values(600)) ?? [];
      const expected = record.slots;
      expect(slots.length, record.key).toBe(expected.length);
      expect(slots.map((slot) => ORDER.indexOf(slot.face)), record.key).toEqual([...slots.map((slot) => ORDER.indexOf(slot.face))].sort((a, b) => a - b));
      for (const slot of slots) {
        const along = slot.face === 'top' || slot.face === 'bottom' ? slot.center[0] : slot.center[1];
        const source = expected.find((candidate) => candidate.face === slot.face && candidate.position === along);
        expect(source, `${record.key} ${slot.face} ${along}`).toBeDefined();
        expect([slot.opening, slot.shoulder, slot.slotDepth, slot.nominalWidth, slot.roomSimplified], record.key)
          .toEqual([source?.mouthWidth, source?.shoulder, source?.roomHeight, source?.nominalWidth, true]);
        const outer = { top: [along, record.height / 2], bottom: [along, -record.height / 2], left: [-record.width / 2, along],
          right: [record.width / 2, along] }[slot.face];
        expect(slot.center, record.key).toEqual(outer);
      }
    }
    // 代表: 30×10 は上の口 6(呼び 6)と、左右の口 4.5(標準に同じ組が無いので呼び null)。40×15 は上の口 8 と左右の口 6 を溝ごとの呼びで出す。
    const narrow = SMALL_T_SLOT_FRAME_FAMILY.sectionSlots?.(rowOf(SMALL_T_SLOT_FRAME_FAMILY, 'small-30x10-l4.5-r4.5-t6'), values(600)) ?? [];
    expect(narrow.map((slot) => [slot.face, slot.nominalWidth])).toEqual([['top', 6], ['left', null], ['right', null]]);
    const mixed = SMALL_T_SLOT_FRAME_FAMILY.sectionSlots?.(rowOf(SMALL_T_SLOT_FRAME_FAMILY, 'small-40x15-l6-r6-t8'), values(600)) ?? [];
    expect(mixed.map((slot) => [slot.face, slot.nominalWidth])).toEqual([['top', 8], ['left', 6], ['right', 6]]);
  });

  it('印の鍵 slotPositionSymmetric は、対称に置いた印の文を持つ行と同じ並びで、選ぶ画面の行にそのまま渡る', () => {
    const byText = SMALL_FRAME_RECORDS.filter((record) => record.simplified.includes(SYMMETRIC)).map((record) => record.key);
    const byKind = SMALL_FRAME_RECORDS.filter((record) => record.simplifiedKinds?.includes('slotPositionSymmetric') === true).map((record) => record.key);
    expect(byKind).toEqual(byText);
    for (const key of byKind) expect(rowOf(SMALL_T_SLOT_FRAME_FAMILY, key).simplifiedKinds).toEqual(['slotPositionSymmetric']);
  });
});
