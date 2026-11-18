// 規格資料の出典は規格番号と一般名で照合する。
/**
 * 資料 1 の共通フレームの 5 族(チャンネル・角パイプ・丸棒〔カラーを含む〕・フラットバー・アングル)の検査: 族の版と行の名乗り、
 * 実物どおりの断面(角の丸み無し)の輪の面積と断面 2 次モーメント・断面係数が式と合い、製品の行は表の Ix・Iy・Zx・Zy と
 * 印字の最後の桁の半分 + 1% の内で合う事、質量が単位質量 × 長さ、断面の外形、成り立たない寸法を断る事。
 * 製品が使う口(登録口が読む `ALUMINUM_SECTION_FAMILIES` と、族が読む行の表 `ALUMINUM_SECTION_RECORDS`)だけを通して確かめる。種類ごとの代表の行を使う。
 */
import { describe, expect, it } from 'vitest';

import type { SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import { aluminumSectionProfile, type AluminumSection } from '../profiles/aluminumSection.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { ALUMINUM_SECTION_FAMILIES, type AluminumSectionRecord } from './aluminumSections.js';
import { ALUMINUM_SECTION_RECORDS } from './frameCatalogRows.js';

/** 種類ごとの代表の行(チャンネル・角パイプ・丸棒・カラー・フラットバー・アングル)。 */
const RECORDS: readonly AluminumSectionRecord[] = ['ch-40x20x2', 'sq-40x20x2', 'd30', 'd20-h8.1', 'fb-20x5', 'an-15x20x2'].map((key) => {
  const found = ALUMINUM_SECTION_RECORDS.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`record ${key} is missing`);
  return found;
});
const FAMILIES = ALUMINUM_SECTION_FAMILIES;
const KINDS = ['channel', 'squarePipe', 'roundBar', 'flatBar', 'angle'] as const;
const values = (length: number): Readonly<Record<string, string>> => ({ length: String(length) });

interface SectionProperties { readonly area: number; readonly ix: number; readonly iy: number; readonly zx: number; readonly zy: number }

/** 線分だけの輪の面積・1 次・2 次のモーメント(原点まわり、符号つき)。 */
function polygonMoments(loop: readonly SteelProfileSegment[]): readonly [number, number, number, number, number] {
  return loop.reduce<[number, number, number, number, number]>(([a, sx, sy, ixx, iyy], segment) => {
    if (segment.kind !== 'line') throw new Error('arc in a polygon loop');
    const [x0, y0] = segment.from;
    const [x1, y1] = segment.to;
    const cross = x0 * y1 - x1 * y0;
    return [a + cross / 2, sx + (x0 + x1) * cross / 6, sy + (y0 + y1) * cross / 6, ixx + (y0 ** 2 + y0 * y1 + y1 ** 2) * cross / 12,
      iyy + (x0 ** 2 + x0 * x1 + x1 ** 2) * cross / 12];
  }, [0, 0, 0, 0, 0]);
}

/** 輪から求めた図心まわりの断面の値(丸棒は円の式)。Ix・Iy は mm⁴、Zx・Zy は mm³。 */
function propertiesOf(section: AluminumSection): SectionProperties {
  const profile = aluminumSectionProfile(section);
  if (profile === null) throw new Error('profile refused');
  if (section.kind === 'roundBar') {
    const inertia = Math.PI * (section.diameter ** 4 - section.holeDiameter ** 4) / 64;
    return { area: profile.areaMm2, ix: inertia, iy: inertia, zx: inertia / (section.diameter / 2), zy: inertia / (section.diameter / 2) };
  }
  const outer = polygonMoments(profile.segments);
  const sums = profile.holes.map(polygonMoments)
    .reduce<number[]>((total, hole) => total.map((value, index) => value - (hole[index] ?? 0)), [...outer]);
  const [area = NaN, sx = NaN, sy = NaN, ixx = NaN, iyy = NaN] = sums;
  const cx = sx / area;
  const cy = sy / area;
  const xs = profile.segments.flatMap((segment) => [segment.from[0]]);
  const ys = profile.segments.flatMap((segment) => [segment.from[1]]);
  const ix = ixx - area * cy ** 2;
  const iy = iyy - area * cx ** 2;
  return { area, ix, iy, zx: ix / Math.max(Math.max(...ys) - cy, cy - Math.min(...ys)), zy: iy / Math.max(Math.max(...xs) - cx, cx - Math.min(...xs)) };
}

function sectionOfRecord(record: AluminumSectionRecord): AluminumSection {
  if (record.kind === 'roundBar') return { kind: 'roundBar', diameter: record.diameter ?? NaN, holeDiameter: record.holeDiameter ?? 0 };
  if (record.kind === 'flatBar') return { kind: 'flatBar', height: record.height ?? NaN, thickness: record.thickness ?? NaN };
  return { kind: record.kind, height: record.height ?? NaN, width: record.width ?? NaN, thickness: record.thickness ?? NaN };
}

/** 印字の値の許す差: 最後の桁の半分 + 値の 1%。 */
function printedTolerance(value: number): number {
  const decimals = String(value).split('.')[1]?.length ?? 0;
  return 0.5 * 10 ** -decimals + 0.01 * value;
}

describe('資料 1 の共通フレームの 5 族', () => {
  it('族は種類ごとに 5 つで、版・欄・線図を凍結し、行は規格の行を名乗らず出どころは資料の番号と表の頁だけ', () => {
    // 欄は任意の留めの欄(J-01 包み 5・6。miterOption.test.ts)を除いて凍結する。
    expect(KINDS.map((kind) => FAMILIES[kind]).map((family) => [family.id, family.group, family.kindKey, family.catalogRevision,
      family.generatorRevision, family.stock, family.diagram, family.options.filter((spec) => spec.optional !== true).map((spec) => spec.key)]))
      .toEqual([
        ['aluminum-channel', 'aluminumFrame', 'catalog.frame.kind.channel', 'aluminum-channel-2026-11-r1', 'aluminum-section-1', 'linear',
          'channel', ['length']],
        ['aluminum-square-pipe', 'aluminumFrame', 'catalog.frame.kind.squarePipe', 'aluminum-square-pipe-2026-11-r1', 'aluminum-section-1',
          'linear', 'rectTube', ['length']],
        ['aluminum-round-bar', 'aluminumFrame', 'catalog.frame.kind.roundBar', 'aluminum-round-bar-2026-11-r1', 'aluminum-section-1', 'linear',
          'roundBar', ['length']],
        ['aluminum-flat-bar', 'aluminumFrame', 'catalog.frame.kind.flatBar', 'aluminum-flat-bar-2026-11-r1', 'aluminum-section-1', 'linear',
          'flatBar', ['length']],
        ['aluminum-angle', 'aluminumFrame', 'catalog.frame.kind.angle', 'aluminum-angle-2026-11-r1', 'aluminum-section-1', 'linear', 'angle',
          ['length']],
      ]);
    // 族の行は、行の表の行を種類ごとに分けた物。
    for (const kind of KINDS) {
      expect(FAMILIES[kind].rows.map((row) => row.key)).toEqual(ALUMINUM_SECTION_RECORDS.filter((item) => item.kind === kind).map((item) => item.key));
    }
    const row = FAMILIES.flatBar.rows.find((candidate) => candidate.key === 'fb-20x5');
    expect([row?.standardLabel, row?.materialLabel, row?.densityMaterialId, row?.verification, row?.verified, row?.note,
      row?.evidence.title, row?.evidence.locator, row?.evidence.reference]).toEqual(['製造元の寸法に合わせた物', 'アルミ',
      'aluminum', 'manufacturer-catalog', true, '質量は単位質量の値', '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)',
      'PDF 334 頁 共通フレームの表(寸法・単位質量・Ix・Iy・Zx・Zy)', '']);
    expect(row?.dims).toEqual({ height: 20, thickness: 5, unitMassKgPerM: 0.27, ixCm4: 0.3333, iyCm4: 0.0208, zxCm3: 0.333, zyCm3: 0.083 });
  });

  it('輪の面積・断面 2 次モーメント・断面係数は角の丸み無しの形の式と合う(縦が H、チャンネルとアングルは図心まわり)', () => {
    // チャンネル 40×20×2: Ix = 2·40³/12 + 2·[18·2³/12 + 18·2·19²]。角パイプ 40×20×2: (20·40³ − 16·36³)/12。フラットバー 20×5: 5·20³/12。
    const channel = propertiesOf({ kind: 'channel', height: 40, width: 20, thickness: 2 });
    // 面積 = H·t + 2·(B − t)·t = 80 + 72。
    expect([channel.area, channel.ix]).toEqual([152, expect.closeTo(2 * 40 ** 3 / 12 + 2 * (18 * 2 ** 3 / 12 + 18 * 2 * 19 ** 2), 6)]);
    const pipe = propertiesOf({ kind: 'squarePipe', height: 40, width: 20, thickness: 2 });
    expect([pipe.area, pipe.ix, pipe.zy]).toEqual([224, expect.closeTo((20 * 40 ** 3 - 16 * 36 ** 3) / 12, 6),
      expect.closeTo((40 * 20 ** 3 - 36 * 16 ** 3) / 12 / 10, 6)]);
    const bar = propertiesOf({ kind: 'flatBar', height: 20, thickness: 5 });
    expect([bar.area, bar.ix, bar.iy, bar.zx]).toEqual([100, expect.closeTo(5 * 20 ** 3 / 12, 9), expect.closeTo(20 * 5 ** 3 / 12, 9),
      expect.closeTo(5 * 20 ** 2 / 6, 9)]);
    // アングル 15×20×2(縦 15・横 20): 図心 y = (2·15·7.5 + 18·2·1)/66。
    const angle = propertiesOf({ kind: 'angle', height: 15, width: 20, thickness: 2 });
    const cy = (2 * 15 * 7.5 + 18 * 2 * 1) / 66;
    expect([angle.area, angle.ix]).toEqual([66, expect.closeTo(2 * 15 ** 3 / 12 + 30 * (7.5 - cy) ** 2 + 18 * 2 ** 3 / 12 + 36 * (1 - cy) ** 2, 6)]);
    const collar = aluminumSectionProfile({ kind: 'roundBar', diameter: 20, holeDiameter: 8 });
    expect([collar?.areaMm2, collar?.holes.length]).toEqual([expect.closeTo(Math.PI * (400 - 64) / 4, 9), 1]);
  });

  it('形は断面の押し出し(穴のある物は穴を引く)で、名前は呼びと長さ、体積は面積 × 長さ、質量は単位質量 × 長さ、外形は原点が中心', () => {
    for (const record of RECORDS) {
      const family: CatalogFamily = FAMILIES[record.kind];
      const row: CatalogItemRow | undefined = family.rows.find((candidate) => candidate.key === record.key);
      if (row === undefined) throw new Error(`row ${record.key} is missing`);
      const holes = record.kind === 'squarePipe' || record.holeDiameter !== undefined ? 1 : 0;
      const part = family.build(row, values(600));
      expect(part?.name).toBe(`${record.size}×600`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(holes === 1 ? ['extrude', 'extrude', 'boolean'] : ['extrude']);
      expect(family.nominalVolume(row, values(600))).toBeCloseTo(propertiesOf(sectionOfRecord(record)).area * 600, 6);
      expect(family.nominalMassG?.(row, values(600))).toBeCloseTo(record.unitMassKgPerM * 600, 9);
      const width = record.kind === 'roundBar' ? record.diameter ?? NaN : record.kind === 'flatBar' ? record.thickness ?? NaN : record.width ?? NaN;
      const height = record.kind === 'roundBar' ? record.diameter ?? NaN : record.height ?? NaN;
      expect(family.sectionBounds?.(row, values(600))).toEqual({ minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 });
      expect(family.build(row, values(0))).toBeNull();
    }
  });

  it('成り立たない寸法(厚さが外形に収まらない・穴が外径以上・0)は形を作らない', () => {
    const bads: readonly AluminumSection[] = [{ kind: 'channel', height: 4, width: 20, thickness: 2 }, { kind: 'channel', height: 40, width: 2, thickness: 2 },
      { kind: 'squarePipe', height: 40, width: 4, thickness: 2 }, { kind: 'angle', height: 2, width: 20, thickness: 2 },
      { kind: 'roundBar', diameter: 10, holeDiameter: 10 }, { kind: 'flatBar', height: 0, thickness: 5 }, { kind: 'roundBar', diameter: 10, holeDiameter: -1 }];
    for (const bad of bads) expect(aluminumSectionProfile(bad)).toBeNull();
  });

  it('製品の行(2 回の読みが一致した行)は、全部で形が作れ、表の Ix・Iy・Zx・Zy が形から計算した値と印字の最後の桁の半分 + 1% の内で合う', () => {
    for (const kind of KINDS) {
      const family = ALUMINUM_SECTION_FAMILIES[kind];
      expect(new Set(family.rows.map((row) => row.key)).size).toBe(family.rows.length);
      for (const row of family.rows) {
        const dims = row.dims;
        const section: AluminumSection = kind === 'roundBar' ? { kind, diameter: dims.diameter ?? NaN, holeDiameter: dims.holeDiameter ?? 0 }
          : kind === 'flatBar' ? { kind, height: dims.height ?? NaN, thickness: dims.thickness ?? NaN }
            : { kind, height: dims.height ?? NaN, width: dims.width ?? NaN, thickness: dims.thickness ?? NaN };
        const computed = propertiesOf(section);
        expect(Math.abs(computed.area * 2.7e-3 - (dims.unitMassKgPerM ?? NaN)), `${row.key} mass`)
          .toBeLessThanOrEqual(printedTolerance(dims.unitMassKgPerM ?? NaN));
        const pairs = [['ixCm4', computed.ix / 1e4], ['iyCm4', computed.iy / 1e4], ['zxCm3', computed.zx / 1e3], ['zyCm3', computed.zy / 1e3]] as const;
        // 表の向きが入れ替わって見える行は断面の値を持たない(4 つとも無く、note にその旨)。
        if (dims.ixCm4 === undefined) {
          expect(pairs.map(([name]) => dims[name]), row.key).toEqual([undefined, undefined, undefined, undefined]);
          expect(row.note, row.key).toContain('断面の値は資料の表で向きが入れ替わって見えるので持たない');
          continue;
        }
        for (const [name, value] of pairs) {
          const printed = dims[name] ?? NaN;
          expect(Math.abs(value - printed), `${row.key} ${name}`).toBeLessThanOrEqual(printedTolerance(printed));
        }
      }
    }
  });
});
