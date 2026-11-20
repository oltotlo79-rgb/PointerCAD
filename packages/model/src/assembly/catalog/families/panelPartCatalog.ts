/**
 * 族: 資料 2 のパネル扉の部品とパネル用のフレーム(外形を包む形。統括の決定 2026-11-18 14:1x の (1))。製造元の名前・型番は書かない
 * (呼びは部品の種類の一般の語と外形の寸法)。行の表 `panelPartRows.ts` は担当の道具が、17 回目の読み 2 本で一致した値から生成する。
 *
 * - パネル扉の部品: 外形を包む箱(幅 × 奥行 × 高さ)。全体の 3 つの寸法が 2 本で一致した型番だけ。キット・セットは入れない。
 *   質量は資料の 1 個の値(箱の体積 × 密度より軽い向きの時だけ。部位ごとに材料が違う行は密度を持たず、資料の値だけ)。
 *   資料の質量が無い行は密度を持たず、質量を出さない。
 * - パネル用のフレーム: 外形の四角の断面を長さだけ押し出した形(中空・溝・差し込みは作らない)。質量は資料の単位質量 × 長さ。
 *   切断の一覧と部品表には出るが、断面の性質(梁の解析に使う値)は持たない。
 * - コネクタ: パネル扉の部品と同じ外形を包む箱(行の表 `connectorBoxRows.ts`。20 回目〔向きは 23 回目〕の読み 2 本で一致した値)。
 *   系列の章の行(`connectorBoxSeriesRows.ts`。31 回目の読み 2 本で一致した値)を続ける。
 * - キャップと足の部品: 同じ外形を包む箱(行の表 `capFootBoxRows.ts`。21 回目の読み 2 本で一致した値)。
 * - 可動の部品: 同じ外形を包む箱(行の表 `movablePartBoxRows.ts`。30・31 回目の読み 2 本で一致した値)。
 * - アクセサリ: 同じ外形を包む箱(行の表 `accessoryBoxRows.ts`。32 回目の読み 2 本で一致した値)。
 * - 簡略の印は「外形を包む形で、細部は作っていない」(可動の部品は「動く仕組みは作っていない」を続ける)。
 * - 資料 1 の小さい部品(扉の部品・引出の部品・スライダ・配線の部品・キャップの付属・足回りの部品)も、同じ箱の族の作り `boxFamily` を
 *   資料 1 の名前で使う(族の定義は `smallPartBoxCatalog.ts`。統括の決定 2026-11-19 15:5x の 1)。
 */
import { withName } from '../../standard/partPrimitives.js';
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredMassLength, miteredSectionVolume } from '../miterOption.js';
import { buildPanelBoardPart, panelBoardProfile } from '../profiles/panelBoard.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { ACCESSORY_BOX_RECORDS } from './accessoryBoxRows.js';
import { CAP_FOOT_BOX_RECORDS } from './capFootBoxRows.js';
import { CAP_FOOT_LOCK_RECORDS } from './capFootLockRows.js';
import { CONNECTOR_BOX_RECORDS } from './connectorBoxRows.js';
import { CONNECTOR_BOX_SERIES_RECORDS } from './connectorBoxSeriesRows.js';
import { MOVABLE_PART_BOX_RECORDS } from './movablePartBoxRows.js';
import { PANEL_COVER_FRAME_RECORDS, PANEL_PART_RECORDS } from './panelPartRows.js';

type PartMaterial = 'aluminum' | 'stainless' | 'steel' | 'mixed';

/** パネル扉の部品の行(外形を包む箱。数は資料の記入のまま)。 */
export interface PanelPartRecord {
  readonly key: string;
  readonly size: string;
  readonly page: number;
  /** 部品の種類の一般の語。 */
  readonly kind: string;
  readonly material: PartMaterial;
  /** 部位ごとに材料の違う行('mixed')と資料の質量が無い行だけ: 部品表の材質の文字(一般の材料の語)。 */
  readonly materialText?: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** 資料の 1 個の質量(g)。記入の無い行は null(質量を出さない)。 */
  readonly massG: number | null;
  readonly simplified: readonly string[];
}

/** パネル用のフレームの行(外形の四角の断面と単位質量)。 */
export interface PanelCoverFrameRecord {
  readonly key: string;
  readonly size: string;
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly unitMassKgPerM: number;
  readonly simplified: readonly string[];
}

const EVIDENCE_TITLE = '資料 2 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)';
const MATERIAL_LABELS: Readonly<Record<Exclude<PartMaterial, 'mixed'>, string>> = { aluminum: 'アルミ', stainless: 'ステンレス', steel: '鋼' };

function evidence(page: number, locator: string, title = EVIDENCE_TITLE): CatalogItemRow['evidence'] {
  return { title, edition: null, locator: `PDF ${page} 頁 ${locator}`, reference: '' };
}

function partRow(record: PanelPartRecord, title: string): CatalogItemRow {
  // 資料の質量が無い行と部位ごとに材料の違う行は、密度を持たない(部品表は材質の文字だけで、箱の体積 × 密度の質量を出さない)。
  const density = record.material === 'mixed' || record.massG === null ? {} : { densityMaterialId: record.material };
  const label = record.materialText ?? (record.material === 'mixed' ? '' : MATERIAL_LABELS[record.material]);
  const mass = record.massG === null ? '質量は資料に記入が無いので出さない' : '質量は資料の 1 個の値';
  return {
    key: record.key, size: record.size, standardLabel: '製造元の寸法に合わせた物', materialLabel: label, ...density,
    dims: { width: record.width, depth: record.depth, height: record.height, ...(record.massG === null ? {} : { massG: record.massG }) },
    evidence: evidence(record.page, '部品の図(全体の寸法)と質量の記入', title), verification: 'manufacturer-catalog', verified: true,
    note: `形は簡略(${record.simplified.join('・')})。${mass}`, simplified: record.simplified,
  };
}

function frameRow(record: PanelCoverFrameRecord): CatalogItemRow {
  return {
    key: record.key, size: record.size, standardLabel: '製造元の寸法に合わせた物', materialLabel: 'アルミ', densityMaterialId: 'aluminum',
    dims: { width: record.width, height: record.height, unitMassKgPerM: record.unitMassKgPerM },
    evidence: evidence(record.page, '断面の図(外形の寸法)と単位質量'), verification: 'manufacturer-catalog', verified: true,
    note: `形は簡略(${record.simplified.join('・')})。質量は単位質量の値。断面の性質は持たない`, simplified: record.simplified,
  };
}

/** 箱の寸法(行の欄から)。板の族の箱の形(幅 × 高さの長方形を板厚だけ押し出す)を、幅 × 奥行 × 高さに当てて使う。 */
function boxOf(row: CatalogItemRow): { readonly width: number; readonly height: number; readonly thickness: number } {
  return { width: row.dims.width ?? NaN, height: row.dims.depth ?? NaN, thickness: row.dims.height ?? NaN };
}

/**
 * 外形を包む箱の族(パネル扉の部品・コネクタで同じ作り。行の表と id・種類の鍵・線図だけが違う)。資料 1 の小さい部品の族
 * (統括の決定 2026-11-19 15:5x の 1)は、出どころの資料の名前 `evidenceTitle` に資料 1 の名前を渡す(既定は資料 2)。
 */
export function boxFamily(id: string, kindKey: string, diagram: CatalogFamily['diagram'], records: readonly PanelPartRecord[],
  evidenceTitle = EVIDENCE_TITLE): CatalogFamily {
  return {
    id, group: 'aluminumFrame', kindKey, catalogRevision: `${id}-2026-11-r1`, generatorRevision: 'panel-part-1', options: [], stock: 'count', diagram,
    rows: records.map((record) => partRow(record, evidenceTitle)),
    build: (row) => {
      const part = buildPanelBoardPart(boxOf(row));
      return part === null ? null : withName(part, row.size);
    },
    nominalVolume: (row) => {
      const box = boxOf(row);
      return panelBoardProfile(box) === null ? null : box.width * box.height * box.thickness;
    },
    nominalMassG: (row) => row.dims.massG ?? null,
    partName: (row) => row.size,
  };
}

/** パネル扉の部品(外形を包む箱)の族。 */
export const PANEL_PART_BOX_FAMILY: CatalogFamily = boxFamily('panel-part-box', 'catalog.board.kind.partBox', 'panelPartBox', PANEL_PART_RECORDS);

/**
 * 資料 2 のコネクタ(外形を包む箱)の族(統括の決定 2026-11-18 15:0x の (2))。締結の部品を組み込んだコネクタ 1 点は部品として扱い、
 * キット・セット・組み上がったクランパーは入れない。呼びは一般の語(製造元の品名は書かない)。
 * 行は、はじめの章の表に、系列の章の表(統括の指示 2026-11-18 21:47。同じ鍵の行は道具が除いた)を続ける。
 */
export const CONNECTOR_BOX_FAMILY: CatalogFamily = boxFamily('connector-box', 'catalog.frame.kind.connectorBox', 'connectorBox',
  [...CONNECTOR_BOX_RECORDS, ...CONNECTOR_BOX_SERIES_RECORDS]);

/**
 * 資料 2 のキャップと足の部品(パイプのスタンド・床留めのブラケット・台のスタンドなど。外形を包む箱。統括の決定 2026-11-18 14:4x の (3)・16:2x)。
 * 樹脂を含む行は密度を持たず、資料の質量だけ。足回りのロック(行の表 `capFootLockRows.ts`。39h の読み 2 本で一致した値。統括 2026-11-19 19:3x)を続ける。
 */
export const CAP_FOOT_BOX_FAMILY: CatalogFamily = boxFamily('cap-foot-box', 'catalog.frame.kind.capFootBox', 'capFootBox',
  [...CAP_FOOT_BOX_RECORDS, ...CAP_FOOT_LOCK_RECORDS]);

/**
 * 資料 2 の可動の部品(蝶番のつなぎ・滑るつなぎ・直動の軸受など。外形を包む箱。統括の指示 2026-11-18 21:31・21:47)。
 * 動く仕組み(軸・ばね・ブッシュの動き)は作らない(印)。キット・セット・組み上がった機構は入れない。
 */
export const MOVABLE_PART_BOX_FAMILY: CatalogFamily = boxFamily('movable-part-box', 'catalog.frame.kind.movableBox', 'movableBox',
  MOVABLE_PART_BOX_RECORDS);

/** 資料 2 のアクセサリ(溝の補助具・部品入れ・ケーブルの留め具など。外形を包む箱。統括の指示 2026-11-18 21:45)。 */
export const ACCESSORY_BOX_FAMILY: CatalogFamily = boxFamily('accessory-box', 'catalog.frame.kind.accessoryBox', 'accessoryBox', ACCESSORY_BOX_RECORDS);

const frameSection = (row: CatalogItemRow): { readonly width: number; readonly height: number; readonly thickness: number } => ({
  width: row.dims.width ?? NaN, height: row.dims.height ?? NaN, thickness: 1 });

function frameBounds(row: CatalogItemRow): FrameSectionBounds | null {
  const { width, height } = frameSection(row);
  return panelBoardProfile(frameSection(row)) === null ? null : { minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 };
}

/** パネル用のフレーム(外形の四角の断面。長さと留めを入れる)の族。断面の溝は持たない(溝の締結の相手にならない)。 */
export const PANEL_COVER_FRAME_FAMILY: CatalogFamily = {
  id: 'panel-cover-frame', group: 'aluminumFrame', kindKey: 'catalog.board.kind.coverFrame', catalogRevision: 'panel-cover-frame-2026-11-r1',
  generatorRevision: 'panel-part-1', options: [lengthOptionSpec('1000'), ...MITER_OPTION_SPECS], stock: 'linear', diagram: 'panelCoverFrame',
  rows: PANEL_COVER_FRAME_RECORDS.map(frameRow),
  build: (row, values) => {
    const profile = panelBoardProfile(frameSection(row));
    const length = lengthOf(values);
    if (profile === null || length === null || !(length.value > 0)) return null;
    const document = buildMiteredSection(profile, length, frameBounds(row), values);
    return document === null ? null : withName(document, `${row.size}×${lengthText(values)}`);
  },
  nominalVolume: (row, values) => {
    const profile = panelBoardProfile(frameSection(row));
    const length = lengthOf(values)?.value ?? NaN;
    return profile === null || !(length > 0) ? null : miteredSectionVolume(profile, frameBounds(row), values, length);
  },
  nominalMassG: (row, values) => {
    const length = lengthOf(values)?.value ?? NaN;
    const unitMass = row.dims.unitMassKgPerM ?? NaN;
    const massLength = length > 0 ? miteredMassLength(panelBoardProfile(frameSection(row)), frameBounds(row), values, length) : null;
    return massLength !== null && unitMass > 0 ? unitMass * massLength : null;
  },
  sectionBounds: (row) => frameBounds(row),
  partName: (row, values) => `${row.size}×${lengthText(values)}`,
};
