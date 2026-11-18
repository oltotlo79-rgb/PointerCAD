/**
 * 族: 資料 SF-1 の共通パーツの頁(PDF 337〜339)で寸法が確認できる、小さい溝つきフレーム・その端のキャップ・ブラケット素材
 * (3 族。統括の決定 2026-11-17 18:1x・18:2x)。製造元の名前・型番は書かない(呼びは外形の寸法と溝の面の一般の語)。
 *
 * 行は、資料の 2 本の独立の読みが一致した物だけ(行の表 `smallFrameRows.ts` は道具が生成し、検査が 2 本目の読みの fixture と 1 行ずつ照らす)。
 * - 小さい溝つきフレーム: 外形の四角から、寸法と位置が 2 本で一致した T 溝と穴を抜く包む形(`profiles/smallFrameSection.ts`)。行の溝の欄は作った溝だけを持ち、
 *   寸法の記入が無くて作っていない溝は簡略の印に「下の面の溝（寸法の記入が無いため作っていない）」の形で出す。質量は単位質量 × 長さ。
 * - 端のキャップ: 端のキャップの族と同じ板だけの簡略の形(脚と穴は印)。質量は資料の 1 個の値。
 * - ブラケット素材: 2 枚の板の L に、角の斜めの面までの肉を足した包む形(角の空洞は抜かない)。質量は単位質量 × 長さ。
 */
import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredMassLength, miteredSectionVolume } from '../miterOption.js';
import { buildFrameCapPart, frameCapProfile, type FrameCapDimensions } from '../profiles/framePartShapes.js';
import {
  bracketStockBounds, bracketStockProfile, smallFrameBounds, smallFrameProfile, type BracketStockSection, type SmallFrameFace,
  type SmallFrameSection,
} from '../profiles/smallFrameSection.js';
import type { ProfileLoops } from '../../standard/profileExtrusion.js';
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import type { FrameSectionSlot } from '../../frame/frameSlots.js';
import type { CatalogFamily, CatalogItemRow, CatalogSimplifiedKind } from '../types.js';
import { BRACKET_STOCK_RECORDS, SMALL_FRAME_CAP_RECORDS, SMALL_FRAME_RECORDS } from './smallFrameRows.js';

/** 小さい溝つきフレームの行(道具が生成。数は資料の記入のまま。溝・穴は作った物だけ)。 */
export interface SmallFrameRecord {
  readonly key: string;
  readonly size: string;
  readonly page: number;
  readonly width: number;
  readonly height: number;
  /**
   * 作った溝。nominalWidth は溝幅の呼び(溝の 4 つの寸法が 1 冊目の標準のフレームの溝と同じ組の溝は数、同じ組の無い溝は null。道具が決める)。
   * 作った溝は全部締結に出す(sectionSlots)。null の溝は、溝用のナットの溝幅が決まらないので留められない(統括 2026-11-18 10:0x)。
   */
  readonly slots: readonly { readonly face: SmallFrameFace; readonly mouthWidth: number; readonly roomWidth: number; readonly shoulder: number;
    readonly roomHeight: number; readonly position: number; readonly nominalWidth?: number | null }[];
  readonly holes: readonly { readonly diameter: number; readonly x: number; readonly y: number }[];
  readonly unitMassKgPerM: number;
  readonly simplified: readonly string[];
  /** 行の溝幅の呼び(溝が全部呼びを持ち、全部同じ呼びの行だけ)。 */
  readonly slotWidth?: number;
  /** 簡略の印の種類の鍵(印の文と道具が対で書く)。 */
  readonly simplifiedKinds?: readonly CatalogSimplifiedKind[];
}

/** 端のキャップの行(板だけの簡略の形)。 */
export interface SmallFrameCapRecord {
  readonly key: string;
  readonly size: string;
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
  readonly massG: number;
  readonly simplified: readonly string[];
}

/** ブラケット素材の行。cornerX・cornerY は角の内の面の端の、外の角(左下)からの距離(辺の長さ − 記入)。Ix・Iy は cm⁴、Zx・Zy は cm³。 */
export interface BracketStockRecord {
  readonly key: string;
  readonly size: string;
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly horizontalThickness: number;
  readonly verticalThickness: number;
  readonly cornerX: number;
  readonly cornerY: number;
  readonly holes: readonly { readonly diameter: number; readonly x: number; readonly y: number }[];
  readonly unitMassKgPerM: number;
  readonly ixCm4: number;
  readonly iyCm4: number;
  readonly zxCm3: number;
  readonly zyCm3: number;
  readonly simplified: readonly string[];
}

const EVIDENCE_TITLE = '資料 SF-1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)';
const FACES: readonly SmallFrameFace[] = ['top', 'bottom', 'left', 'right'];

function evidence(page: number, what: string): CatalogItemRow['evidence'] {
  return { title: EVIDENCE_TITLE, edition: null, url: '', locator: `PDF ${page} 頁 ${what}`, sha256: '', fetchedDate: '' };
}

function noteOf(simplified: readonly string[], mass: string): string {
  return simplified.length > 0 ? `形は簡略(${simplified.join('・')})。${mass}` : mass;
}

function baseRow(record: { readonly key: string; readonly size: string; readonly simplified: readonly string[];
  readonly simplifiedKinds?: readonly CatalogSimplifiedKind[] }, material: 'aluminum' | 'nylon', dims: Readonly<Record<string, number>>,
  evidenceRow: CatalogItemRow['evidence'], mass: string): CatalogItemRow {
  return {
    key: record.key, size: record.size, standardLabel: '製造元の寸法に合わせた物', materialLabel: material === 'aluminum' ? 'アルミ' : '樹脂(PA)',
    densityMaterialId: material, dims, evidence: evidenceRow, verification: 'manufacturer-catalog', verified: true, simplified: record.simplified,
    ...(record.simplifiedKinds === undefined ? {} : { simplifiedKinds: record.simplifiedKinds }),
    note: noteOf(record.simplified, mass),
  };
}

/**
 * 溝・穴は行の dims に番号つきの欄で持つ(slot{n}Face は FACES の番号、slot{n}Mouth・Room・Shoulder・RoomHeight・Position、hole{n}D・X・Y)。
 * 締結の口などが溝を読む時は、ここにある溝(作った溝)だけを数える。
 */
function smallRow(record: SmallFrameRecord): CatalogItemRow {
  const dims: Record<string, number> = { width: record.width, height: record.height, unitMassKgPerM: record.unitMassKgPerM, slotCount: record.slots.length,
    holeCount: record.holes.length };
  record.slots.forEach((slot, index) => {
    Object.assign(dims, { [`slot${index}Face`]: FACES.indexOf(slot.face), [`slot${index}Mouth`]: slot.mouthWidth, [`slot${index}Room`]: slot.roomWidth,
      [`slot${index}Shoulder`]: slot.shoulder, [`slot${index}RoomHeight`]: slot.roomHeight, [`slot${index}Position`]: slot.position });
    // 呼びの数だけを dims に持つ(null の溝は欄を持たず、締結に出す時に呼び null になる)。
    if (typeof slot.nominalWidth === 'number') dims[`slot${index}Nominal`] = slot.nominalWidth;
  });
  record.holes.forEach((hole, index) => {
    Object.assign(dims, { [`hole${index}D`]: hole.diameter, [`hole${index}X`]: hole.x, [`hole${index}Y`]: hole.y });
  });
  if (record.slotWidth !== undefined) dims.slotWidth = record.slotWidth;
  return baseRow(record, 'aluminum', dims, evidence(record.page, '断面の図(外形・溝・穴の寸法と単位質量)'), '質量は単位質量の値');
}

/** 締結に出す溝の面の順と、面ごとの内向きの法線・面に沿う向き(1 冊目の溝つきのフレームの tSlotSlots と同じ決まり)。 */
const SLOT_FACE_ORDER: readonly SmallFrameFace[] = ['top', 'left', 'bottom', 'right'];
const FACE_AXES: Readonly<Record<SmallFrameFace, { readonly inward: readonly [number, number]; readonly across: readonly [number, number] }>> = {
  top: { inward: [0, -1], across: [-1, 0] }, left: { inward: [1, 0], across: [0, -1] }, bottom: { inward: [0, 1], across: [1, 0] },
  right: { inward: [-1, 0], across: [0, 1] },
};

/**
 * 締結に出す溝(J-02 P6a。作った溝は全部。標準の溝と大きさの違う溝は呼び null で出し、締結が専用の理由で断る。統括 2026-11-18 10:0x)。
 * 口の中心は外の面の上(上下の面は x = 位置、左右の面は y = 位置)。
 * 部屋の形は両側 45° の簡略なので roomSimplified。並びは面の順(上・左・下・右)、面の中は輪の進む向き(面に沿う向きの小さい方から)。
 * 形が成り立たない行は null。
 */
function smallSectionSlots(row: CatalogItemRow): readonly FrameSectionSlot[] | null {
  const section = smallSection(row);
  if (smallFrameProfile(section) === null) return null;
  const [hx, hy] = [section.width / 2, section.height / 2];
  const slots = section.slots.flatMap((slot, index): FrameSectionSlot[] => {
    const nominalWidth = row.dims[`slot${index}Nominal`] ?? null;
    const { inward, across } = FACE_AXES[slot.face];
    const center: readonly [number, number] = slot.face === 'top' ? [slot.position, hy] : slot.face === 'bottom' ? [slot.position, -hy]
      : slot.face === 'left' ? [-hx, slot.position] : [hx, slot.position];
    return [{ face: slot.face, center, inward, across, opening: slot.mouthWidth, shoulder: slot.shoulder, slotDepth: slot.roomHeight,
      roomSimplified: true, nominalWidth }];
  });
  const along = (slot: FrameSectionSlot): number => slot.center[0] * slot.across[0] + slot.center[1] * slot.across[1];
  return [...slots].sort((a, b) => SLOT_FACE_ORDER.indexOf(a.face) - SLOT_FACE_ORDER.indexOf(b.face) || along(a) - along(b));
}

function smallSection(row: CatalogItemRow): SmallFrameSection {
  const value = (key: string): number => row.dims[key] ?? NaN;
  const slots = Array.from({ length: value('slotCount') || 0 }, (_, index) => ({
    face: FACES[value(`slot${index}Face`)] ?? 'top', mouthWidth: value(`slot${index}Mouth`), roomWidth: value(`slot${index}Room`),
    shoulder: value(`slot${index}Shoulder`), roomHeight: value(`slot${index}RoomHeight`), position: value(`slot${index}Position`),
  }));
  const holes = Array.from({ length: value('holeCount') || 0 }, (_, index) => ({ diameter: value(`hole${index}D`), x: value(`hole${index}X`),
    y: value(`hole${index}Y`) }));
  return { width: value('width'), height: value('height'), slots, holes };
}

function bracketRow(record: BracketStockRecord): CatalogItemRow {
  const dims: Record<string, number> = { width: record.width, height: record.height, horizontalThickness: record.horizontalThickness,
    verticalThickness: record.verticalThickness, cornerX: record.cornerX, cornerY: record.cornerY, unitMassKgPerM: record.unitMassKgPerM,
    ixCm4: record.ixCm4, iyCm4: record.iyCm4, zxCm3: record.zxCm3, zyCm3: record.zyCm3, holeCount: record.holes.length };
  record.holes.forEach((hole, index) => {
    Object.assign(dims, { [`hole${index}D`]: hole.diameter, [`hole${index}X`]: hole.x, [`hole${index}Y`]: hole.y });
  });
  return baseRow(record, 'aluminum', dims, evidence(record.page, '断面の図と技術データ(寸法・単位質量・Ix・Iy・Zx・Zy)'),
    '質量は単位質量の値。Ix・Iy・Zx・Zy は資料の値で、簡略の形から出す値とは違う');
}

function bracketSection(row: CatalogItemRow): BracketStockSection {
  const value = (key: string): number => row.dims[key] ?? NaN;
  const holes = Array.from({ length: value('holeCount') || 0 }, (_, index) => ({ diameter: value(`hole${index}D`), x: value(`hole${index}X`),
    y: value(`hole${index}Y`) }));
  return { width: value('width'), height: value('height'), horizontalThickness: value('horizontalThickness'),
    verticalThickness: value('verticalThickness'), cornerX: value('cornerX'), cornerY: value('cornerY'), holes };
}

function partName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `${row.size}×${lengthText(values)}`;
}

/** 長さを持つ族(小さい溝つきフレーム・ブラケット素材)。質量は単位質量 × 長さ。 */
function linearFamily(id: string, kindKey: string, diagram: CatalogFamily['diagram'], rows: readonly CatalogItemRow[],
  profileOf: (row: CatalogItemRow) => (ProfileLoops & { readonly areaMm2: number }) | null,
  boundsOf: (row: CatalogItemRow) => FrameSectionBounds | null): CatalogFamily {
  return {
    id, group: 'aluminumFrame', kindKey, catalogRevision: `${id}-2026-11-r1`, generatorRevision: 'small-frame-1',
    options: [lengthOptionSpec('1000'), ...MITER_OPTION_SPECS], stock: 'linear', diagram, rows,
    build: (row, values) => {
      const profile = profileOf(row);
      const length = lengthOf(values);
      if (profile === null || length === null || !(length.value > 0)) return null;
      const document = buildMiteredSection(profile, length, boundsOf(row), values);
      return document === null ? null : withName(document, partName(row, values));
    },
    nominalVolume: (row, values) => {
      const profile = profileOf(row);
      const length = lengthOf(values)?.value ?? NaN;
      return profile === null || !(length > 0) ? null : miteredSectionVolume(profile, boundsOf(row), values, length);
    },
    nominalMassG: (row, values) => {
      const length = lengthOf(values)?.value ?? NaN;
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      const massLength = length > 0 ? miteredMassLength(profileOf(row), boundsOf(row), values, length) : null;
      return massLength !== null && unitMass > 0 ? unitMass * massLength : null;
    },
    sectionBounds: (row) => boundsOf(row),
    partName,
  };
}

// 締結に出す溝(sectionSlots)は小さい溝つきフレームの族だけが持つ(長さの族の作り方の引数を増やさず、族に足す)。
export const SMALL_T_SLOT_FRAME_FAMILY: CatalogFamily = {
  ...linearFamily('t-slot-frame-small', 'catalog.frame.kind.smallFrame', 'smallFrame', SMALL_FRAME_RECORDS.map(smallRow),
    (row) => smallFrameProfile(smallSection(row)), (row) => smallFrameBounds(smallSection(row))),
  sectionSlots: (row: CatalogItemRow) => smallSectionSlots(row),
};

export const BRACKET_STOCK_FAMILY = linearFamily('bracket-stock', 'catalog.frame.kind.bracketStock', 'bracketStock',
  BRACKET_STOCK_RECORDS.map(bracketRow), (row) => bracketStockProfile(bracketSection(row)), (row) => bracketStockBounds(bracketSection(row)));

function capDimensions(row: CatalogItemRow): FrameCapDimensions {
  return { shape: 'rect', width: row.dims.width ?? NaN, height: row.dims.height ?? NaN, thickness: row.dims.thickness ?? NaN, armWidth: 0,
    cornerRadius: 0 };
}

function capRow(record: SmallFrameCapRecord): CatalogItemRow {
  return baseRow(record, 'nylon', { width: record.width, height: record.height, thickness: record.thickness, massG: record.massG },
    evidence(record.page, 'キャップの図(板の幅・高さ・厚さ・質量)'), `質量は資料の 1 個の値(${record.massG} g)`);
}

export const SMALL_FRAME_CAP_FAMILY: CatalogFamily = {
  id: 't-slot-frame-cap-small', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.smallFrameCap', catalogRevision: 't-slot-frame-cap-small-2026-11-r1',
  generatorRevision: 'small-frame-1', options: [], stock: 'count', diagram: 'smallFrameCap', rows: SMALL_FRAME_CAP_RECORDS.map(capRow),
  build: (row) => {
    const part = buildFrameCapPart(capDimensions(row));
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const profile = frameCapProfile(capDimensions(row));
    return profile === null ? null : profile.areaMm2 * (row.dims.thickness ?? NaN);
  },
  // 1 個の質量(g)。資料の値(板だけの形 × 密度との差は担当の記録 stage2-compare/mass-check.tsv)。
  nominalMassG: (row) => {
    const mass = row.dims.massG ?? NaN;
    return mass > 0 ? mass : null;
  },
  partName: (row) => row.size,
};
