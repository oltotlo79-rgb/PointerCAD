/**
 * 族: 資料 SF-1(アルミ構造材の総合カタログ)で寸法が確認できるフレームの部品(統括の決定 2026-11-17)。製造元の名前・型番は書かない。
 * T 溝用ナットの素材(棒材。長さを入れる)・T 溝用ナット・丸ナット・端のキャップ・平板のブラケットの 5 族。行は、資料の 2 回の独立の読みで、形を作るのに
 * 要る欄が全部一致した物だけ(行の表 `framePartRows.ts` は道具が生成し、検査が 2 回目の読みの fixture と 1 行ずつ照らす)。
 * 形は記入のある寸法だけで作る簡略の形で、簡略にした所は行の `simplified` に持つ(頭の斜面・首の長さ・穴の位置・取付けの脚と穴・角の形・
 * 1 個のナットのボールとストッパー〔全高まで包む〕・決まらない止めねじの穴)。
 * **質量は形から計算せず、資料の値**(棒材は単位質量 × 長さ、ほかは 1 個の質量)。形は `profiles/framePartShapes.ts` と
 * 今ある汎用の T 溝用ナットの形(`profiles/frameParts.ts`)。
 */
import { withName } from '../../standard/partPrimitives.js';
import { buildProfileSection } from '../../standard/profileExtrusion.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildSlotNutPart, slotNutVolume, type SlotNutDimensions } from '../profiles/frameParts.js';
import {
  adjusterVolume, angleBracketCatalogVolume, buildAdjusterPart, buildAngleBracketCatalogPart, buildFlatPlatePart, buildFootBasePart,
  buildFrameCapPart, buildRoundNutPart, buildShapedPlatePart, flatPlateProfile, footBaseProfile, frameCapProfile, roundNutVolume,
  shapedPlateProfile, tSlotNutBarBounds, tSlotNutBarProfile, type AdjusterDimensions, type AngleBracketCatalogDimensions,
  type FlatPlateDimensions, type FootBaseDimensions, type FrameCapDimensions, type RoundNutDimensions, type ShapedPlateDimensions,
  type TSlotNutBarSection,
} from '../profiles/framePartShapes.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import {
  ADJUSTER_RECORDS, ANGLE_BRACKET_RECORDS, FLAT_PLATE_RECORDS, FOOT_BASE_RECORDS, FRAME_CAP_RECORDS, ROUND_NUT_RECORDS, SHAPED_PLATE_RECORDS,
  T_SLOT_NUT_BAR_RECORDS, T_SLOT_NUT_RECORDS,
} from './framePartRows.js';
import { HARD_BRACKET_RECORDS } from './hardBracketRows.js';

type DensityMaterial = 'steel' | 'stainless' | 'aluminum' | 'nylon';
/**
 * 行の材料。'mixed' は部位ごとに材料の違う行(密度の表に無い材料を含む。統括の決定 2026-11-18 08:1x)で、密度を持たず、
 * 部品表の材質は行の materialText(資料の材質の文字)、質量は資料の 1 個の値(massG)だけで出す(2 冊目のキャップとフットと同じ仕組み)。
 */
type PartMaterial = DensityMaterial | 'mixed';

/** T 溝用ナットの素材(棒材)の行(道具が生成する。数は資料の記入のまま、単位質量だけ kg/m に直した)。 */
export interface TSlotNutBarRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  /** 入れ方(先入れ・後入れ)。 */
  readonly entry: string;
  readonly material: 'steel' | 'stainless';
  /** 図の PDF の頁。 */
  readonly page: number;
  /** 頭(溝の中に入る広い部分)の幅。 */
  readonly headWidth: number;
  /** 首(溝の口に入る部分)の幅。 */
  readonly neckWidth: number;
  readonly neckHeight: number;
  /** 頭の底の面から首の上の面まで。 */
  readonly totalHeight: number;
  readonly unitMassKgPerM: number;
  readonly simplified: readonly string[];
}

/**
 * T 溝用ナット(1 個)の行。主のねじ穴は、holeOffset が無い行は長さの中央、有る行は長さの端の面から holeOffset。
 * ロック付きで止めねじの呼びが決まった行は、止めねじの穴(setScrewThread・setScrewOffset)も開ける。ボール付き・ストッパー付きの行は、
 * totalHeight がボール・ストッパーの先までを包んだ高さで、slotPartHeightUnknown(溝に入る所の高さが資料に無い)を持つ。
 */
export interface TSlotNutRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  /** 入れ方(先入れ・後入れ)。緩み止めの塗布は呼びにだけ添える。 */
  readonly entry: string;
  readonly material: 'steel' | 'stainless' | 'aluminum';
  readonly page: number;
  /** めねじの呼び(メートルねじの表の呼び)。 */
  readonly thread: string;
  readonly headWidth: number;
  readonly neckWidth: number;
  readonly neckHeight: number;
  readonly totalHeight: number;
  /** 溝の向きの全長。 */
  readonly length: number;
  readonly massG: number;
  /** 長さの端の面から主のねじ穴の中心まで(穴が中央でない行だけ)。 */
  readonly holeOffset?: number;
  /** 止めねじの呼び(ロック付きで、呼びが 2 つの独立の読みで一致した行だけ)。 */
  readonly setScrewThread?: string;
  /** 長さの端の面(holeOffset と同じ端)から止めねじの穴の中心まで。 */
  readonly setScrewOffset?: number;
  /** 溝に入る所の高さが資料に無い(全高がボール・ストッパーの先までを包んだ高さ)。 */
  readonly slotPartHeightUnknown?: true;
  readonly simplified: readonly string[];
}

/** 丸ナット(丸棒に横向きのめねじが 2 つ)の行。 */
export interface RoundNutRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'steel' | 'stainless';
  readonly page: number;
  readonly thread: string;
  readonly diameter: number;
  readonly length: number;
  /** 2 つのめねじの穴の中心の間。 */
  readonly holePitch: number;
  /** 端の面から 1 つ目の穴の中心まで(記入が無い行は (全長 − 穴の間隔) / 2 で、simplified に「穴の位置」)。 */
  readonly holeOffset: number;
  readonly massG: number;
  readonly simplified: readonly string[];
}

/** 端のキャップ(板だけの簡略の形。取付けの脚と穴は省く)の行。 */
export interface FrameCapRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  /** 長方形か L 形。 */
  readonly shape: 'rect' | 'l';
  readonly material: 'nylon';
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
  /** L 形の腕の幅(長方形は null)。 */
  readonly armWidth: number | null;
  /** 4 隅の丸みの半径(2 回の読みで同じ半径が記入されていた時だけ。無ければ 0 で、simplified に「角の形」)。 */
  readonly cornerRadius: number;
  readonly massG: number;
  readonly simplified: readonly string[];
}

/**
 * 平板のブラケット(長方形の板と通し穴の格子)の行。穴の位置は、2 つの読みの書き方を道具が揃えた後(鎖寸法の足し上げ・並べ替え・分解だけ)に
 * 一致した物で、板の左の端と下の端からの位置(重なりなし・小さい順)。穴は位置の列の積(格子)。
 */
export interface FlatPlateRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'steel' | 'stainless' | 'aluminum';
  readonly page: number;
  readonly length: number;
  readonly width: number;
  readonly thickness: number;
  /** 4 隅の面取り C(2 つの読みで同じ記入の時だけ。直角は 0)。 */
  readonly chamfer: number;
  readonly holeDiameter: number;
  readonly holesX: readonly number[];
  readonly holesY: readonly number[];
  /** 資料の質量。形の体積 × 密度と 10% を超えて合わない行は null(質量は形 × 密度で出す)。 */
  readonly massG: number | null;
  readonly simplified: readonly string[];
}

/**
 * 平板のブラケットの L・T・十字(直角だけの輪の外形と通し穴)。外形の頂点は、2 つ以上の読みが一致した辺の長さの並び(外形の左上の角から時計回り)と
 * 穴の位置から、道具が 1 つに決めた物(足し算と並べ替えだけ。検査が辺の長さと穴で確かめ直す)。原点は外形の左下。
 */
export interface ShapedPlateRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'steel' | 'stainless' | 'aluminum';
  readonly page: number;
  readonly shape: 'l' | 't' | 'x';
  readonly outline: readonly (readonly [number, number])[];
  readonly sides: readonly number[];
  readonly thickness: number;
  readonly holeDiameter: number;
  /** 穴の中心(外形の左下からの x・y)。 */
  readonly holes: readonly (readonly [number, number])[];
  readonly massG: number | null;
  readonly simplified: readonly string[];
}

/**
 * L 形のブラケット(寝た脚 a と立つ脚 b の L の断面を幅だけ押し出した形)。穴は脚ごとに、角の外の面からの位置の列 × 幅の端からの位置の列の格子。
 * 厚さの記入は片方の脚にだけあり、記入の無い脚も同じ厚さで作る(簡略の印に、どちらの脚の記入が無く、どう作ったかを書く。多くは立つ脚の記入が無い。
 * V の形の図の 5 行は、厚さの寸法線が立つ脚にだけあり、寝た脚の記入が無い)。リブつきの形はリブを省く(簡略の印)。
 * 穴の列が空の脚は穴を作らない: 寝た脚の穴の幅の向きの位置の記入が無い図の行(`hardBracketRows.ts`。統括の決定 2026-11-18 08:4x の (B))で、
 * 印と呼びの「寝た脚の穴なし」で示す。その脚はフレームの溝への締結で留められない。
 */
export interface AngleBracketRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'steel' | 'stainless' | 'aluminum' | 'mixed';
  /** 部位ごとに材料の違う行('mixed')だけ: 資料の材質の文字。 */
  readonly materialText?: string;
  readonly page: number;
  readonly ribbed: boolean;
  readonly legA: number;
  readonly legB: number;
  readonly width: number;
  readonly thickness: number;
  readonly holeDiameter: number;
  readonly alongA: readonly number[];
  readonly acrossA: readonly number[];
  readonly alongB: readonly number[];
  readonly acrossB: readonly number[];
  readonly massG: number | null;
  readonly simplified: readonly string[];
}

/** フットベース・アジャスターベースの板(長方形の板と、穴ごとに径と位置が 2 つ以上の読みで一致した通し穴)。 */
export interface FootBaseRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'steel' | 'stainless' | 'aluminum' | 'mixed';
  /** 部位ごとに材料の違う行('mixed')だけ: 資料の材質の文字。 */
  readonly materialText?: string;
  readonly page: number;
  readonly kind: string;
  readonly width: number;
  readonly depth: number;
  readonly thickness: number;
  /** 穴(外形の左下からの x・y と径)。 */
  readonly holes: readonly (readonly [number, number, number])[];
  /**
   * L の外形の板だけ: 外形の頂点(左下を原点に反時計回り。直角の多角形で、外接の長方形が幅 × 奥行)。2 組の読みが共通の線((h))まで一致した行
   * (統括の決定 2026-11-18 09:3x の 3)。省略は幅 × 奥行の長方形。
   */
  readonly outline?: readonly (readonly [number, number])[];
  readonly massG: number | null;
  readonly simplified: readonly string[];
}

/** アジャスター(皿の円柱と、おねじの呼びの径の円柱。ねじの山・首振り・敷き物は入れない)。 */
export interface AdjusterRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'steel' | 'stainless' | 'aluminum' | 'nylon' | 'mixed';
  /** 部位ごとに材料の違う行('mixed')だけ: 資料の材質の文字(例: ねじと座の材料)。 */
  readonly materialText?: string;
  readonly page: number;
  readonly thread: string;
  readonly padDiameter: number;
  readonly padThickness: number;
  /** おねじの長さ(資料の記入のまま。六角部が有る行は六角部の上の面から先まで)。 */
  readonly threadLength: number;
  /** 皿とねじの間の六角部の高さ(寸法線の起点が六角部の上の行だけ。対辺の記入が無いので、ねじの径の円柱で表す)。 */
  readonly hexHeight?: number;
  readonly massG: number;
  readonly simplified: readonly string[];
}

const MATERIALS: Readonly<Record<DensityMaterial, string>> = { steel: '鋼', stainless: 'ステンレス', aluminum: 'アルミ', nylon: '樹脂(ナイロン)' };
const GENERATOR_REVISION = 'frame-part-1';

/** 行の材質の表示と密度の材料(部位ごとに材料の違う行は、資料の材質の文字だけで密度を持たない)。 */
function materialFields(record: { readonly material: PartMaterial; readonly materialText?: string }):
Pick<CatalogItemRow, 'materialLabel' | 'densityMaterialId'> {
  return record.material === 'mixed' ? { materialLabel: record.materialText ?? '' }
    : { materialLabel: MATERIALS[record.material], densityMaterialId: record.material };
}

/** 共通の行の欄(出どころは資料の番号と頁だけ。SHA-256 と URL は製品に入れない)。 */
function baseRow(record: { readonly key: string; readonly size: string; readonly page: number; readonly material: PartMaterial;
  readonly materialText?: string; readonly simplified: readonly string[] }, dims: Readonly<Record<string, number>>, massText: string): CatalogItemRow {
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    ...materialFields(record),
    dims,
    evidence: { title: '資料 SF-1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', edition: null, url: '',
      locator: `PDF ${record.page} 頁 部品の図(寸法)と質量の記入`, sha256: '', fetchedDate: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: record.simplified.length > 0 ? `形は簡略(${record.simplified.join('・')})。質量は${massText}` : `質量は${massText}`,
    simplified: record.simplified,
  };
}

function familyBase(id: string, kindKey: string, diagram: CatalogFamily['diagram']): Pick<CatalogFamily, 'id' | 'group' | 'kindKey'
  | 'catalogRevision' | 'generatorRevision' | 'diagram'> {
  return { id, group: 'aluminumFrame', kindKey, catalogRevision: `${id}-2026-11-r1`, generatorRevision: GENERATOR_REVISION, diagram };
}

/** 1 個の質量(g)。行の massG(長さに依らない)。 */
function pieceMass(row: CatalogItemRow): number | null {
  const mass = row.dims.massG ?? NaN;
  return mass > 0 ? mass : null;
}

/** 行の鍵から生成された行を引く(族の rows と同じ鍵の行だけ)。 */
function recordLookup<T extends { readonly key: string }>(records: readonly T[]): (row: CatalogItemRow) => T | undefined {
  const byKey = new Map(records.map((record) => [record.key, record]));
  return (row) => byKey.get(row.key);
}

function barSection(row: CatalogItemRow): TSlotNutBarSection {
  return { headWidth: row.dims.headWidth ?? NaN, neckWidth: row.dims.neckWidth ?? NaN, neckHeight: row.dims.neckHeight ?? NaN,
    totalHeight: row.dims.totalHeight ?? NaN };
}

function barName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `${row.size}×${lengthText(values)}`;
}

export const T_SLOT_NUT_BAR_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-nut-bar', 'catalog.frame.kind.nutBar', 'tSlotNutBar'),
  options: [lengthOptionSpec('1000')],
  stock: 'linear',
  rows: T_SLOT_NUT_BAR_RECORDS.map((record) => baseRow(record, { slot: record.slot, headWidth: record.headWidth,
    neckWidth: record.neckWidth, neckHeight: record.neckHeight, totalHeight: record.totalHeight, unitMassKgPerM: record.unitMassKgPerM },
  '単位質量の値')),
  build: (row, values) => {
    const profile = tSlotNutBarProfile(barSection(row));
    const length = lengthOf(values);
    if (profile === null || length === null || !(length.value > 0)) return null;
    return withName(buildProfileSection(profile, length), barName(row, values));
  },
  nominalVolume: (row, values) => {
    const profile = tSlotNutBarProfile(barSection(row));
    const length = lengthOf(values)?.value ?? NaN;
    return profile === null || !(length > 0) ? null : profile.areaMm2 * length;
  },
  // 単位質量(kg/m)× 長さ(mm)= 質量(g)。
  nominalMassG: (row, values) => {
    const length = lengthOf(values)?.value ?? NaN;
    const unitMass = row.dims.unitMassKgPerM ?? NaN;
    return length > 0 && unitMass > 0 ? unitMass * length : null;
  },
  sectionBounds: (row) => tSlotNutBarBounds(barSection(row)),
  partName: barName,
};

const nutRecord = recordLookup(T_SLOT_NUT_RECORDS);

/** 1 個のナットの形の寸法(主のねじ穴の位置と止めねじの穴は、行に有る時だけ)。 */
function slotNutDimensionsOf(record: TSlotNutRecord): SlotNutDimensions {
  return { thread: record.thread, flangeWidth: record.headWidth, length: record.length, flangeThickness: record.totalHeight - record.neckHeight,
    neckWidth: record.neckWidth, neckHeight: record.neckHeight,
    ...(record.holeOffset === undefined ? {} : { holeOffset: record.holeOffset }),
    ...(record.setScrewThread === undefined || record.setScrewOffset === undefined ? {}
      : { setScrew: { thread: record.setScrewThread, offset: record.setScrewOffset } }) };
}

function nutDimensions(row: CatalogItemRow): SlotNutDimensions | null {
  const record = nutRecord(row);
  return record === undefined ? null : slotNutDimensionsOf(record);
}

/**
 * 1 個のナットの行の dims。締結(frameSlotFastening)が読む鍵: holeOffset(長さの端の面から主のねじ穴の中心まで。無い行は length / 2)と、
 * slotPartHeightUnknown = 1(溝に入る所の高さが資料に無い行。totalHeight − neckHeight を深さとボルトの長さに使わない)。今の中央の行は鍵を持たない。
 */
function nutDims(record: TSlotNutRecord): Readonly<Record<string, number>> {
  return { slot: record.slot, headWidth: record.headWidth, neckWidth: record.neckWidth, neckHeight: record.neckHeight,
    totalHeight: record.totalHeight, length: record.length, massG: record.massG,
    ...(record.holeOffset === undefined ? {} : { holeOffset: record.holeOffset }),
    ...(record.setScrewOffset === undefined ? {} : { setScrewOffset: record.setScrewOffset }),
    ...(record.slotPartHeightUnknown === true ? { slotPartHeightUnknown: 1 } : {}) };
}

export const T_SLOT_NUT_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-nut', 'catalog.frame.kind.catalogNut', 'tSlotNut'),
  options: [],
  stock: 'count',
  rows: T_SLOT_NUT_RECORDS.map((record) => baseRow(record, nutDims(record), '資料の 1 個の値')),
  build: (row) => {
    const dims = nutDimensions(row);
    const part = dims === null ? null : buildSlotNutPart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = nutDimensions(row);
    return dims === null ? null : slotNutVolume(dims);
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

const roundRecord = recordLookup(ROUND_NUT_RECORDS);

function roundDimensions(row: CatalogItemRow): RoundNutDimensions | null {
  const record = roundRecord(row);
  return record === undefined ? null : { thread: record.thread, diameter: record.diameter, length: record.length,
    holePitch: record.holePitch, holeOffset: record.holeOffset };
}

export const ROUND_NUT_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-round-nut', 'catalog.frame.kind.roundNut', 'roundNut'),
  options: [],
  stock: 'count',
  rows: ROUND_NUT_RECORDS.map((record) => baseRow(record, { slot: record.slot, diameter: record.diameter, length: record.length,
    holePitch: record.holePitch, holeOffset: record.holeOffset, massG: record.massG }, '資料の 1 個の値')),
  build: (row) => {
    const dims = roundDimensions(row);
    const part = dims === null ? null : buildRoundNutPart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = roundDimensions(row);
    return dims === null ? null : roundNutVolume(dims);
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

const capRecord = recordLookup(FRAME_CAP_RECORDS);

function capDimensions(row: CatalogItemRow): FrameCapDimensions | null {
  const record = capRecord(row);
  return record === undefined ? null : { shape: record.shape, width: record.width, height: record.height, thickness: record.thickness,
    armWidth: record.armWidth ?? NaN, cornerRadius: record.cornerRadius };
}

export const FRAME_CAP_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-frame-cap', 'catalog.frame.kind.cap', 'frameCap'),
  options: [],
  stock: 'count',
  rows: FRAME_CAP_RECORDS.map((record) => baseRow(record, { slot: record.slot, width: record.width, height: record.height,
    thickness: record.thickness, ...(record.armWidth === null ? {} : { armWidth: record.armWidth }), cornerRadius: record.cornerRadius,
    massG: record.massG }, '資料の 1 個の値')),
  build: (row) => {
    const dims = capDimensions(row);
    const part = dims === null ? null : buildFrameCapPart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = capDimensions(row);
    const profile = dims === null ? null : frameCapProfile(dims);
    return dims === null || profile === null ? null : profile.areaMm2 * dims.thickness;
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

const plateRecord = recordLookup(FLAT_PLATE_RECORDS);

function plateDimensions(row: CatalogItemRow): FlatPlateDimensions | null {
  const record = plateRecord(row);
  return record === undefined ? null : { length: record.length, width: record.width, thickness: record.thickness, chamfer: record.chamfer,
    holeDiameter: record.holeDiameter, holesX: record.holesX, holesY: record.holesY };
}

export const FLAT_PLATE_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-flat-plate', 'catalog.frame.kind.flatPlate', 'flatPlate'),
  options: [],
  stock: 'count',
  // 質量は資料の値。検算(形の体積 × 密度)と合わない行は massG を持たず、部品表は形 × 密度で出す。
  rows: FLAT_PLATE_RECORDS.map((record) => baseRow(record, { slot: record.slot, length: record.length, width: record.width,
    thickness: record.thickness, chamfer: record.chamfer, holeDiameter: record.holeDiameter, holeCount: record.holesX.length * record.holesY.length,
    ...(record.massG === null ? {} : { massG: record.massG }) },
  record.massG === null ? '形の体積 × 密度(資料の質量は検算と合わない)' : '資料の 1 個の値')),
  build: (row) => {
    const dims = plateDimensions(row);
    const part = dims === null ? null : buildFlatPlatePart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = plateDimensions(row);
    const profile = dims === null ? null : flatPlateProfile(dims);
    return dims === null || profile === null ? null : profile.areaMm2 * dims.thickness;
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

/** 質量の説明の語(資料の値か、検算と合わない・読みが確かでないので形 × 密度か)。 */
function massTextOf(massG: number | null): string {
  return massG === null ? '形の体積 × 密度(資料の質量は検算と合わないか、読みで確かでない)' : '資料の 1 個の値';
}

const shapedRecord = recordLookup(SHAPED_PLATE_RECORDS);

function shapedDimensions(row: CatalogItemRow): ShapedPlateDimensions | null {
  const record = shapedRecord(row);
  return record === undefined ? null : { outline: record.outline, thickness: record.thickness, holeDiameter: record.holeDiameter,
    holes: record.holes };
}

export const SHAPED_PLATE_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-shaped-plate', 'catalog.frame.kind.shapedPlate', 'shapedPlate'),
  options: [],
  stock: 'count',
  rows: SHAPED_PLATE_RECORDS.map((record) => baseRow(record, { slot: record.slot, thickness: record.thickness, holeDiameter: record.holeDiameter,
    holeCount: record.holes.length, ...(record.massG === null ? {} : { massG: record.massG }) }, massTextOf(record.massG))),
  build: (row) => {
    const dims = shapedDimensions(row);
    const part = dims === null ? null : buildShapedPlatePart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = shapedDimensions(row);
    const profile = dims === null ? null : shapedPlateProfile(dims);
    return dims === null || profile === null ? null : profile.areaMm2 * dims.thickness;
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

/** L 形のブラケットの族の行: 2 本の読みで両脚の穴が決まった行(framePartRows.ts)の後に、寝た脚の穴を作らない行(hardBracketRows.ts)。 */
const ANGLE_RECORDS: readonly AngleBracketRecord[] = [...ANGLE_BRACKET_RECORDS, ...HARD_BRACKET_RECORDS];
const angleRecord = recordLookup(ANGLE_RECORDS);

function angleDimensions(row: CatalogItemRow): AngleBracketCatalogDimensions | null {
  const record = angleRecord(row);
  return record === undefined ? null : { legA: record.legA, legB: record.legB, width: record.width, thickness: record.thickness,
    holeDiameter: record.holeDiameter, alongA: record.alongA, acrossA: record.acrossA, alongB: record.alongB, acrossB: record.acrossB };
}

export const ANGLE_BRACKET_CATALOG_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-angle-bracket', 'catalog.frame.kind.angleBracketCatalog', 'angleBracketCatalog'),
  options: [],
  stock: 'count',
  // リブつきの形はリブを省くので、質量は資料の値(形 × 密度より実物に近い)。一定の幅の形は検算と合う時だけ資料の値。
  // 寝た脚の穴を作らない行は、資料の質量が形 × 密度より軽い時だけ入れてある(道具が確かめた。補強の抜き穴を作らない行の決まり)。
  rows: ANGLE_RECORDS.map((record) => baseRow(record, { slot: record.slot, legA: record.legA, legB: record.legB, width: record.width,
    thickness: record.thickness, holeDiameter: record.holeDiameter, ...(record.massG === null ? {} : { massG: record.massG }) },
  massTextOf(record.massG))),
  build: (row) => {
    const dims = angleDimensions(row);
    const part = dims === null ? null : buildAngleBracketCatalogPart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = angleDimensions(row);
    return dims === null ? null : angleBracketCatalogVolume(dims);
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

const baseRecord = recordLookup(FOOT_BASE_RECORDS);

function baseDimensions(row: CatalogItemRow): FootBaseDimensions | null {
  const record = baseRecord(row);
  return record === undefined ? null : { width: record.width, depth: record.depth, thickness: record.thickness, holes: record.holes,
    ...(record.outline === undefined ? {} : { outline: record.outline }) };
}

export const FOOT_BASE_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-foot-base', 'catalog.frame.kind.footBase', 'footBase'),
  options: [],
  stock: 'count',
  rows: FOOT_BASE_RECORDS.map((record) => baseRow(record, { width: record.width, depth: record.depth, thickness: record.thickness,
    holeCount: record.holes.length, ...(record.massG === null ? {} : { massG: record.massG }) }, massTextOf(record.massG))),
  build: (row) => {
    const dims = baseDimensions(row);
    const part = dims === null ? null : buildFootBasePart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = baseDimensions(row);
    const profile = dims === null ? null : footBaseProfile(dims);
    return dims === null || profile === null ? null : profile.areaMm2 * dims.thickness;
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};

const adjusterRecord = recordLookup(ADJUSTER_RECORDS);

function adjusterDimensions(row: CatalogItemRow): AdjusterDimensions | null {
  const record = adjusterRecord(row);
  return record === undefined ? null : { thread: record.thread, padDiameter: record.padDiameter, padThickness: record.padThickness,
    threadLength: record.threadLength, ...(record.hexHeight === undefined ? {} : { hexHeight: record.hexHeight }) };
}

export const ADJUSTER_FAMILY: CatalogFamily = {
  ...familyBase('t-slot-adjuster', 'catalog.frame.kind.adjuster', 'adjuster'),
  options: [],
  stock: 'count',
  rows: ADJUSTER_RECORDS.map((record) => baseRow(record, { padDiameter: record.padDiameter, padThickness: record.padThickness,
    threadLength: record.threadLength, ...(record.hexHeight === undefined ? {} : { hexHeight: record.hexHeight }), massG: record.massG },
  '資料の 1 個の値')),
  build: (row) => {
    const dims = adjusterDimensions(row);
    const part = dims === null ? null : buildAdjusterPart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = adjusterDimensions(row);
    return dims === null ? null : adjusterVolume(dims);
  },
  nominalMassG: pieceMass,
  partName: (row) => row.size,
};
