/**
 * 族: 資料 1(アルミ構造材の総合カタログ)の共通フレームの表(PDF 334〜336 頁)で寸法が確認できるアルミの形材
 * (チャンネル・角パイプ・丸棒〔穴のあいたカラーを含む〕・フラットバー・アングルの 5 族。統括の決定 2026-11-16)。製造元の名前・型番は書かない。
 *
 * 行は、資料の 2 回の独立の読みが一致した物だけ(行の表 `frameCatalogRows.ts` は道具が生成し、検査が 2 回目の読みの fixture と 1 行ずつ照らす)。
 * 形は表の寸法で作る実物どおりの断面(角の丸みは表に記入が無く、表の値も角の丸み無しの形と合う。`profiles/aluminumSection.ts`)。
 * 質量は行の単位質量 × 長さ(`nominalMassG`。表の値)。Ix・Iy・Zx・Zy は表の値を持つ(表示と記録用)。
 */
import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredMassLength, miteredSectionVolume } from '../miterOption.js';
import { aluminumSectionBounds, aluminumSectionProfile, type AluminumSection } from '../profiles/aluminumSection.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { ALUMINUM_SECTION_RECORDS } from './frameCatalogRows.js';

type SectionKind = AluminumSection['kind'];

/** 行の表の 1 行(道具が生成する。数は資料の印字のまま。Ix・Iy は cm⁴、Zx・Zy は cm³)。種類で使う寸法の欄が違う。 */
export interface AluminumSectionRecord {
  readonly key: string;
  readonly size: string;
  readonly kind: SectionKind;
  /** 表の PDF の頁。 */
  readonly page: number;
  readonly height?: number;
  readonly width?: number;
  readonly thickness?: number;
  readonly diameter?: number;
  readonly holeDiameter?: number;
  readonly unitMassKgPerM: number;
  /** 断面の値。表の値が寸法から計算した値と向きだけ入れ替わって見える行は null(持たない)。 */
  readonly ixCm4: number | null;
  readonly iyCm4: number | null;
  readonly zxCm3: number | null;
  readonly zyCm3: number | null;
  /** 断面の値を、資料の表の値ではなく寸法から計算した値にした行だけ true(表の値が計算と合わない行。利用者の回答 2026-11-19)。 */
  readonly propertiesFromDimensions?: true;
}

/** 種類ごとの族の id・種類の名前の鍵・線図。 */
const KINDS: Readonly<Record<SectionKind, { readonly id: string; readonly kindKey: string; readonly diagram: CatalogFamily['diagram'] }>> = {
  channel: { id: 'aluminum-channel', kindKey: 'catalog.frame.kind.channel', diagram: 'channel' },
  squarePipe: { id: 'aluminum-square-pipe', kindKey: 'catalog.frame.kind.squarePipe', diagram: 'rectTube' },
  roundBar: { id: 'aluminum-round-bar', kindKey: 'catalog.frame.kind.roundBar', diagram: 'roundBar' },
  flatBar: { id: 'aluminum-flat-bar', kindKey: 'catalog.frame.kind.flatBar', diagram: 'flatBar' },
  angle: { id: 'aluminum-angle', kindKey: 'catalog.frame.kind.angle', diagram: 'angle' },
};

function rowOf(record: AluminumSectionRecord): CatalogItemRow {
  const values: Readonly<Record<string, number | null | undefined>> = { height: record.height, width: record.width, thickness: record.thickness,
    diameter: record.diameter, holeDiameter: record.holeDiameter, unitMassKgPerM: record.unitMassKgPerM, ixCm4: record.ixCm4,
    iyCm4: record.iyCm4, zxCm3: record.zxCm3, zyCm3: record.zyCm3 };
  const dims = Object.fromEntries(Object.entries(values)
    .flatMap(([key, value]): (readonly [string, number])[] => (value === null || value === undefined ? [] : [[key, value]])));
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: 'アルミ',
    densityMaterialId: 'aluminum',
    dims,
    evidence: { title: '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', edition: null,
      locator: `PDF ${record.page} 頁 共通フレームの表(寸法・単位質量・Ix・Iy・Zx・Zy)`, reference: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: record.ixCm4 === null ? '質量は単位質量の値。断面の値は資料の表で向きが入れ替わって見えるので持たない'
      : record.propertiesFromDimensions === true ? '質量は単位質量の値。断面の値は資料の表と合わないので、寸法から計算した値(表の値と違う)'
        : '質量は単位質量の値',
  };
}

function sectionOf(kind: SectionKind, row: CatalogItemRow): AluminumSection {
  const value = (key: string): number => row.dims[key] ?? NaN;
  if (kind === 'roundBar') return { kind, diameter: value('diameter'), holeDiameter: row.dims.holeDiameter ?? 0 };
  if (kind === 'flatBar') return { kind, height: value('height'), thickness: value('thickness') };
  return { kind, height: value('height'), width: value('width'), thickness: value('thickness') };
}

function partName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `${row.size}×${lengthText(values)}`;
}

function familyOf(kind: SectionKind, rows: readonly CatalogItemRow[]): CatalogFamily {
  const { id, kindKey, diagram } = KINDS[kind];
  return {
    id,
    group: 'aluminumFrame',
    kindKey,
    catalogRevision: `${id}-2026-11-r1`,
    generatorRevision: 'aluminum-section-1',
    // 留めの欄は一括配置の留めの角だけが書く任意の欄(J-01 包み 5・6。miterOption.ts)。
    options: [lengthOptionSpec('1000'), ...MITER_OPTION_SPECS],
    stock: 'linear',
    diagram,
    rows,
    build: (row, values) => {
      const profile = aluminumSectionProfile(sectionOf(kind, row));
      const length = lengthOf(values);
      if (profile === null || length === null || !(length.value > 0)) return null;
      const document = buildMiteredSection(profile, length, aluminumSectionBounds(sectionOf(kind, row)), values);
      return document === null ? null : withName(document, partName(row, values));
    },
    nominalVolume: (row, values) => {
      const profile = aluminumSectionProfile(sectionOf(kind, row));
      const length = lengthOf(values)?.value ?? NaN;
      return profile === null || !(length > 0) ? null
        : miteredSectionVolume(profile, aluminumSectionBounds(sectionOf(kind, row)), values, length);
    },
    // 単位質量(kg/m)× 長さ(mm)= 質量(g)。留めの部材の長さは、留めを引いた後の体積 ÷ 断面積(miterOption.ts)。
    nominalMassG: (row, values) => {
      const length = lengthOf(values)?.value ?? NaN;
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      const massLength = length > 0 ? miteredMassLength(aluminumSectionProfile(sectionOf(kind, row)),
        aluminumSectionBounds(sectionOf(kind, row)), values, length) : null;
      return massLength !== null && unitMass > 0 ? unitMass * massLength : null;
    },
    sectionBounds: (row) => aluminumSectionBounds(sectionOf(kind, row)),
    partName,
  };
}

/** 行の表から種類ごとの 5 族を作る。 */
function aluminumSectionFamilies(records: readonly AluminumSectionRecord[]): Readonly<Record<SectionKind, CatalogFamily>> {
  const of = (kind: SectionKind): CatalogFamily => familyOf(kind, records.filter((record) => record.kind === kind).map(rowOf));
  return { channel: of('channel'), squarePipe: of('squarePipe'), roundBar: of('roundBar'), flatBar: of('flatBar'), angle: of('angle') };
}

export const ALUMINUM_SECTION_FAMILIES = aluminumSectionFamilies(ALUMINUM_SECTION_RECORDS);
