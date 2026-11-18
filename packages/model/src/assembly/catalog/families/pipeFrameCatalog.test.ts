// 規格資料の出典は規格番号と一般名で照合する。
/**
 * 資料 2 のパイプ形のフレームの 3 族(1 本・溝つき・2 本つなぎ)の検査: 族の版と欄、行の名乗りと出どころ、形(包む形)の押し出しと名前、
 * 体積は面積 × 長さ・質量は単位質量 × 長さ、外形、包む形の面積 × 密度が単位質量(実物の断面)を下回らない事、簡略の印と内側の扱い。
 * 製品が使う口(登録口が読む `PIPE_FRAME_FAMILIES` と、族が読む行の表 `PIPE_FRAME_RECORDS`)だけを通して確かめる。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogItemRow } from '../types.js';
import { PIPE_FRAME_FAMILIES } from './pipeFrameCatalog.js';
import { PIPE_FRAME_RECORDS } from './pipeFrameRows.js';

const KINDS = ['single', 'slotted', 'twin'] as const;
const values = (length: number): Readonly<Record<string, string>> => ({ length: String(length) });
const SOLID_INSIDE = '内側の形（中実で作った）';

function rowOf(kind: (typeof KINDS)[number], key: string): CatalogItemRow {
  const row = PIPE_FRAME_FAMILIES[kind].rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`row ${key} is missing`);
  return row;
}

describe('資料 2 のパイプ形のフレームの 3 族', () => {
  it('族は種類ごとに 3 つで、版・欄・線図を凍結し、行は規格の行を名乗らず出どころは資料の番号と図の頁だけ', () => {
    // 欄は任意の留めの欄(miterOption.test.ts)を除いて凍結する。
    expect(KINDS.map((kind) => PIPE_FRAME_FAMILIES[kind]).map((family) => [family.id, family.group, family.kindKey, family.catalogRevision,
      family.generatorRevision, family.stock, family.diagram, family.options.filter((spec) => spec.optional !== true).map((spec) => spec.key)]))
      .toEqual([
        ['pipe-frame', 'aluminumFrame', 'catalog.frame.kind.pipeFrame', 'pipe-frame-2026-11-r1', 'pipe-frame-1', 'linear', 'pipeFrame', ['length']],
        ['pipe-frame-slotted', 'aluminumFrame', 'catalog.frame.kind.pipeFrameSlotted', 'pipe-frame-slotted-2026-11-r1', 'pipe-frame-1', 'linear',
          'pipeFrameSlotted', ['length']],
        ['pipe-frame-twin', 'aluminumFrame', 'catalog.frame.kind.pipeFrameTwin', 'pipe-frame-twin-2026-11-r1', 'pipe-frame-1', 'linear',
          'pipeFrameTwin', ['length']],
      ]);
    expect(KINDS.map((kind) => PIPE_FRAME_FAMILIES[kind].rows.length)).toEqual([18, 3, 10]);
    for (const kind of KINDS) {
      expect(PIPE_FRAME_FAMILIES[kind].rows.map((row) => row.key)).toEqual(PIPE_FRAME_RECORDS.filter((item) => item.kind === kind).map((item) => item.key));
    }
    const row = rowOf('single', 'pipe-28-standard');
    expect([row.size, row.standardLabel, row.materialLabel, row.densityMaterialId, row.verification, row.verified, row.simplified, row.note,
      row.evidence.title, row.evidence.locator, row.evidence.reference]).toEqual(['外径の呼び 28・標準', '製造元の寸法に合わせた物',
      'アルミ', 'aluminum', 'manufacturer-catalog', true, ['外周の溝'],
      '形は簡略(外周の溝)。質量は単位質量の値。Ix・Iy・Zx・Zy は資料の値で、簡略の形から出す値とは違う',
      '資料 2 パイプ形のフレームの総合カタログ(製造元の寸法に合わせた物)', 'PDF 56 頁 断面の図と技術データ(寸法・単位質量・Ix・Iy・Zx・Zy)', '']);
    expect(row.dims).toEqual({ series: 28, width: 28, height: 28, outerDiameter: 29.4, innerDiameter: 23, unitMassKgPerM: 0.37, ixCm4: 1.16,
      iyCm4: 1.16, zxCm3: 0.83, zyCm3: 0.83 });
  });

  it('呼びは族の中で重ならず、型番の形の文字を持たず、どの行も入れていない所の印を持つ(包む形)', () => {
    for (const kind of KINDS) {
      const rows = PIPE_FRAME_FAMILIES[kind].rows;
      expect(new Set(rows.map((row) => row.size)).size).toBe(rows.length);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
      for (const row of rows) {
        expect(row.size, row.key).toMatch(/^外径の呼び (19|28|43|53)・/);
        expect(row.size + row.key, row.key).not.toMatch(/[A-Z]{2,}-?[0-9]/);
        expect(row.simplified?.length ?? 0, row.key).toBeGreaterThan(0);
      }
    }
  });

  it('内側を中実で作った行は内径の円を持たず、印にその旨を出す(厚肉のポケットの外接の径・記入の無い内径は抜かない)', () => {
    for (const kind of KINDS) {
      for (const row of PIPE_FRAME_FAMILIES[kind].rows) {
        expect(row.dims.innerDiameter === undefined, row.key).toBe(row.simplified?.includes(SOLID_INSIDE) ?? false);
      }
    }
    expect(rowOf('single', 'pipe-28-thick').dims.innerDiameter).toBeUndefined();
    expect(rowOf('single', 'pipe-43-thick').simplified).toContain(SOLID_INSIDE);
  });

  it('形は断面の押し出し(内径の円は穴として引く)で、名前は呼びと長さ、体積は面積 × 長さ、質量は単位質量 × 長さ', () => {
    const cases = [
      { kind: 'single', key: 'pipe-28-standard', solids: ['extrude', 'extrude', 'boolean'],
        area: Math.PI * 14.7 ** 2 - 4 * (14.7 ** 2 * Math.acos(14 / 14.7) - 14 * Math.sqrt(14.7 ** 2 - 14 ** 2)) - Math.PI * 11.5 ** 2,
        bounds: { minX: -14, minY: -14, maxX: 14, maxY: 14 } },
      { kind: 'single', key: 'pipe-19-standard', solids: ['extrude'], area: Math.PI * 9.5 ** 2, bounds: { minX: -9.5, minY: -9.5, maxX: 9.5, maxY: 9.5 } },
      { kind: 'slotted', key: 'slotted-28', solids: ['extrude'], area: 28 * 24 - 10 * 6 - 20 * 7, bounds: { minX: -14, minY: -12, maxX: 14, maxY: 12 } },
      // 溝底の位置が四角の簡略の形で決まらない 19 の行は、溝を作らない 19 × 15 の四角(統括の決定 2026-11-18 02:2x)。
      { kind: 'slotted', key: 'slotted-19', solids: ['extrude'], area: 19 * 15, bounds: { minX: -9.5, minY: -7.5, maxX: 9.5, maxY: 7.5 } },
      { kind: 'twin', key: 'twin-28-37', solids: ['extrude', 'extrude', 'boolean', 'extrude', 'boolean'],
        area: 2 * 28 * 28 + 2 * 9 - 2 * Math.PI * 11.5 ** 2, bounds: { minX: -14, minY: -32.5, maxX: 14, maxY: 32.5 } },
      { kind: 'single', key: 'pipe-28-fin', solids: ['extrude', 'extrude', 'boolean'], area: 28 * 28 + 1.9 * 21 - Math.PI * 11.5 ** 2,
        bounds: { minX: -14, minY: -14, maxX: 14, maxY: 35 } },
    ] as const;
    for (const { kind, key, solids, area, bounds } of cases) {
      const family = PIPE_FRAME_FAMILIES[kind];
      const row = rowOf(kind, key);
      const part = family.build(row, values(600));
      expect(part?.name).toBe(`${row.size}×600`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(solids);
      expect(family.nominalVolume(row, values(600))).toBeCloseTo(area * 600, 6);
      expect(family.nominalMassG?.(row, values(600))).toBeCloseTo((row.dims.unitMassKgPerM ?? NaN) * 600, 9);
      expect(family.sectionBounds?.(row, values(600))).toEqual(bounds);
      expect(family.build(row, values(0))).toBeNull();
    }
  });

  it('全部の行で形が作れ、包む形の面積 × アルミの密度は単位質量(実物の断面)を下回らない(印字の最後の桁の半分まで)', () => {
    for (const kind of KINDS) {
      const family = PIPE_FRAME_FAMILIES[kind];
      for (const row of family.rows) {
        const volume = family.nominalVolume(row, values(1000));
        expect(family.build(row, values(1000)), row.key).not.toBeNull();
        // 1000 mm の体積(mm³)× 2.7e-3 g/mm³ = g、単位質量(kg/m)× 1 m = kg → × 1000 g。印字の最後の桁の半分は 0.005 kg/m = 5 g。
        const envelopeMass = (volume ?? NaN) * 2.7e-3;
        const catalogMass = (row.dims.unitMassKgPerM ?? NaN) * 1000;
        expect(Number.isFinite(envelopeMass), row.key).toBe(true);
        expect(envelopeMass, row.key).toBeGreaterThanOrEqual(catalogMass - 5);
      }
    }
  });
});

// 下書き(統括の決定 2026-11-18 07:2x。型 FrameSectionSlot.nominalWidth が入った後に、--slot-info で作った行の表で流す)。
describe('溝つきのパイプ形のフレームの締結に出す溝', () => {
  it('溝を作る 2 行は下の面の中心の 1 本(口・肩・深さ・呼び 10)を出し、溝を作らない 19 の行は溝なし、ほかの 2 族は溝を出さない', () => {
    const family = PIPE_FRAME_FAMILIES.slotted;
    for (const [key, height] of [['slotted-28', 24], ['slotted-43', 39]] as const) {
      const row = rowOf('slotted', key);
      expect(row.dims.slotWidth, key).toBe(10);
      expect(family.sectionSlots?.(row, values(600)), key).toEqual([{ face: 'bottom', center: [0, -height / 2], inward: [0, 1], across: [1, 0],
        opening: row.dims.mouthWidth, shoulder: row.dims.shoulder, slotDepth: row.dims.roomHeight, roomSimplified: true, nominalWidth: 10 }]);
    }
    const plain = rowOf('slotted', 'slotted-19');
    expect([plain.dims.slotWidth, family.sectionSlots?.(plain, values(600))]).toEqual([undefined, []]);
    // ほかの 2 族は溝を出す口を持たない(口を呼んでも何も返らない)。
    expect([PIPE_FRAME_FAMILIES.single, PIPE_FRAME_FAMILIES.twin].map((other) => other.sectionSlots?.(other.rows[0] ?? plain, values(600))))
      .toEqual([undefined, undefined]);
  });
});
