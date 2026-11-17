/**
 * 族: 資料 GF-2(2 冊目の総合カタログ)のパイプ形のフレーム(外径の呼び 19・28・43・53 の系列)で寸法が確認できる物
 * (1 本・溝つき・2 本つなぎの 3 族。統括の決定 2026-11-17 13:1x・13:4x)。製造元の名前・型番は書かない。
 *
 * 行は、資料の独立の読み(1 回目の 2 本と読み直しの 2 本)のうち 2 つ以上が一致した物だけ(行の表 `pipeFrameRows.ts` は道具が生成し、
 * 検査が一致した読みの 2 つ目の文字の fixture と 1 行ずつ照らす)。色だけ違う型番は 1 行にまとめ、色は持たない(1 冊目のフレームと同じ扱い)。
 * 形は記入のある寸法だけで作る包む形(`profiles/pipeFrameSection.ts`)。入れていない所は行の簡略の印に出す。
 * 質量は行の単位質量 × 長さ(`nominalMassG`。資料の値)。Ix・Iy・Zx・Zy は資料の値を行に持つ(形から出す値とは違う)。
 */
import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredMassLength, miteredSectionVolume } from '../miterOption.js';
import { pipeFrameBounds, pipeFrameProfile, type PipeFrameSection } from '../profiles/pipeFrameSection.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { PIPE_FRAME_RECORDS } from './pipeFrameRows.js';

type PipeFrameKind = PipeFrameSection['kind'];

/** 行の表の 1 行(道具が生成する。数は資料の記入のまま。Ix・Iy は cm⁴、Zx・Zy は cm³)。記入の無い寸法・形に使わない寸法は null。 */
export interface PipeFrameRecord {
  readonly key: string;
  readonly size: string;
  readonly kind: PipeFrameKind;
  /** 外径の呼び(系列)。 */
  readonly series: number;
  /** 断面の図の PDF の頁。 */
  readonly page: number;
  readonly width: number | null;
  readonly height: number | null;
  /** 外周の円の径(1 本と、外形の幅の記入が無い 2 本つなぎ)。 */
  readonly outerDiameter: number | null;
  /** 羽の厚さと、中心から羽の先までの高さ(羽つきの 1 本だけ。羽は輪の右の面と同じ面で上へ伸びる)。 */
  readonly finThickness: number | null;
  readonly finTop: number | null;
  /** 抜く内径の円(内側が円の穴の行だけ。厚肉のポケットの外接の径は持たない)。 */
  readonly innerDiameter: number | null;
  readonly mouthWidth: number | null;
  readonly roomWidth: number | null;
  /** 溝つきの肩の厚さと中の高さ。溝底の位置が読みで決まらない行は両方 null(溝を作らず、簡略の印に出す)。 */
  readonly shoulder: number | null;
  readonly roomHeight: number | null;
  readonly pitch: number | null;
  readonly webWidth: number | null;
  readonly unitMassKgPerM: number;
  readonly ixCm4: number | null;
  readonly iyCm4: number | null;
  readonly zxCm3: number | null;
  readonly zyCm3: number | null;
  /** 形に入れていない所(記入の無い所)。 */
  readonly simplified: readonly string[];
}

/** 種類ごとの族の id・種類の名前の鍵・線図。 */
const KINDS: Readonly<Record<PipeFrameKind, { readonly id: string; readonly kindKey: string; readonly diagram: CatalogFamily['diagram'] }>> = {
  single: { id: 'pipe-frame', kindKey: 'catalog.frame.kind.pipeFrame', diagram: 'pipeFrame' },
  slotted: { id: 'pipe-frame-slotted', kindKey: 'catalog.frame.kind.pipeFrameSlotted', diagram: 'pipeFrameSlotted' },
  twin: { id: 'pipe-frame-twin', kindKey: 'catalog.frame.kind.pipeFrameTwin', diagram: 'pipeFrameTwin' },
};

const DIMENSION_KEYS = ['series', 'width', 'height', 'outerDiameter', 'innerDiameter', 'finThickness', 'finTop', 'mouthWidth', 'roomWidth',
  'shoulder', 'roomHeight', 'pitch', 'webWidth', 'unitMassKgPerM', 'ixCm4', 'iyCm4', 'zxCm3', 'zyCm3'] as const;

function rowOf(record: PipeFrameRecord): CatalogItemRow {
  const dims = Object.fromEntries(DIMENSION_KEYS.flatMap((key): (readonly [string, number])[] => {
    const value = record[key];
    return value === null ? [] : [[key, value]];
  }));
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: 'アルミ',
    densityMaterialId: 'aluminum',
    dims,
    evidence: { title: '資料 GF-2 パイプ形のフレームの総合カタログ(製造元の寸法に合わせた物)', edition: null, url: '',
      locator: `PDF ${record.page} 頁 断面の図と技術データ(寸法・単位質量・Ix・Iy・Zx・Zy)`, sha256: '', fetchedDate: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    simplified: record.simplified,
    note: `形は簡略(${record.simplified.join('・')})。質量は単位質量の値。Ix・Iy・Zx・Zy は資料の値で、簡略の形から出す値とは違う`,
  };
}

/** 行の寸法から断面を作る(記入の無い寸法は null、溝つき・2 本つなぎの欠けた寸法は NaN にして形を断らせる)。 */
function sectionOf(kind: PipeFrameKind, row: CatalogItemRow): PipeFrameSection {
  const optional = (key: string): number | null => row.dims[key] ?? null;
  const value = (key: string): number => row.dims[key] ?? NaN;
  if (kind === 'single') {
    const finThickness = optional('finThickness');
    const finTop = optional('finTop');
    return { kind, width: optional('width'), height: optional('height'), outerDiameter: optional('outerDiameter'),
      innerDiameter: optional('innerDiameter'),
      fin: finThickness === null && finTop === null ? null : { thickness: finThickness ?? NaN, top: finTop ?? NaN } };
  }
  if (kind === 'slotted') {
    // 溝底の位置が読みで決まらない行は肩の厚さと中の高さを両方持たない(切り欠きを作らない四角。印に出す)。片方だけ無い行は NaN で断る。
    const depthless = optional('shoulder') === null && optional('roomHeight') === null;
    return { kind, width: value('width'), height: value('height'), mouthWidth: value('mouthWidth'), roomWidth: value('roomWidth'),
      shoulder: depthless ? null : value('shoulder'), roomHeight: depthless ? null : value('roomHeight') };
  }
  return { kind, width: optional('width'), outerDiameter: optional('outerDiameter'), height: value('height'), pitch: value('pitch'),
    webWidth: value('webWidth'), innerDiameter: optional('innerDiameter') };
}

function partName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `${row.size}×${lengthText(values)}`;
}

function familyOf(kind: PipeFrameKind, rows: readonly CatalogItemRow[]): CatalogFamily {
  const { id, kindKey, diagram } = KINDS[kind];
  return {
    id,
    group: 'aluminumFrame',
    kindKey,
    catalogRevision: `${id}-2026-11-r1`,
    generatorRevision: 'pipe-frame-1',
    // 留めの欄は一括配置の留めの角だけが書く任意の欄(miterOption.ts。1 冊目の形材と同じ)。
    options: [lengthOptionSpec('1000'), ...MITER_OPTION_SPECS],
    stock: 'linear',
    diagram,
    rows,
    build: (row, values) => {
      const profile = pipeFrameProfile(sectionOf(kind, row));
      const length = lengthOf(values);
      if (profile === null || length === null || !(length.value > 0)) return null;
      const document = buildMiteredSection(profile, length, pipeFrameBounds(sectionOf(kind, row)), values);
      return document === null ? null : withName(document, partName(row, values));
    },
    nominalVolume: (row, values) => {
      const profile = pipeFrameProfile(sectionOf(kind, row));
      const length = lengthOf(values)?.value ?? NaN;
      return profile === null || !(length > 0) ? null : miteredSectionVolume(profile, pipeFrameBounds(sectionOf(kind, row)), values, length);
    },
    // 単位質量(kg/m)× 長さ(mm)= 質量(g)。留めの部材の長さは、留めを引いた後の体積 ÷ 断面積(miterOption.ts)。
    nominalMassG: (row, values) => {
      const length = lengthOf(values)?.value ?? NaN;
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      const massLength = length > 0 ? miteredMassLength(pipeFrameProfile(sectionOf(kind, row)), pipeFrameBounds(sectionOf(kind, row)), values,
        length) : null;
      return massLength !== null && unitMass > 0 ? unitMass * massLength : null;
    },
    sectionBounds: (row) => pipeFrameBounds(sectionOf(kind, row)),
    partName,
  };
}

/** 行の表から種類ごとの 3 族を作る。 */
function pipeFrameFamilies(records: readonly PipeFrameRecord[]): Readonly<Record<PipeFrameKind, CatalogFamily>> {
  const of = (kind: PipeFrameKind): CatalogFamily => familyOf(kind, records.filter((record) => record.kind === kind).map(rowOf));
  return { single: of('single'), slotted: of('slotted'), twin: of('twin') };
}

export const PIPE_FRAME_FAMILIES = pipeFrameFamilies(PIPE_FRAME_RECORDS);
