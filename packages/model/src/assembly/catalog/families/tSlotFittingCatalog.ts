/**
 * 族: 資料 SF-1 の、溝に入れる小物のうち 8 回目の記入のままの読み 2 本で形の値が決まった物(3 族。統括の決定 2026-11-18 07:5x・08:3x の 2)。
 * 製造元の名前・型番は書かない(呼びは合う溝幅・外形の寸法・ねじの呼び)。
 *
 * - ジョイントバー: 首の高さ(頭の厚さ)の寸法線が資料に無く、断面が別の品と共通の記載も無いので、頭の幅 × 全厚 × 長さの箱で包み
 *   (`profiles/frameParts.ts` の buildJointBarPart)、めねじを長さの端の面からの位置に並べる。溝に入れると、包んだ分が溝の口と重なって見える。
 *   溝用のナットとしては締結に選ばれない(溝用のナットの族とは別の族)。
 * - スタッド: 板(幅 × 奥行 × 厚さ)の上に、おねじの呼びの径の円柱(`profiles/stackedPart.ts`)。中央の張り出しは幅の記入が無いので作らない。
 * - ローレットナット: 段の高さの記入が無いので、太い段の径 × 全高の円柱で包み、通しのめねじ(谷の径)を抜く。
 * 質量は資料の 1 個の値(包む形 × 密度より軽い時だけの決まり。parts-columns.md §6-2)。行の表 `tSlotFittingRows.ts` は担当の道具が生成する。
 */
import { withName } from '../../standard/partPrimitives.js';
import { buildJointBarPart, jointBarVolume, type JointBarDimensions } from '../profiles/frameParts.js';
import { buildStackedPart, stackedPartHeight, stackedPartVolume, type StackedPartDimensions } from '../profiles/stackedPart.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { JOINT_BAR_RECORDS, KNURLED_NUT_RECORDS, STUD_RECORDS } from './tSlotFittingRows.js';

type FittingMaterial = 'steel' | 'stainless' | 'brass';

interface FittingBase {
  readonly key: string;
  readonly size: string;
  /** 合う溝幅。 */
  readonly slot: number;
  readonly material: FittingMaterial;
  readonly page: number;
  /** 資料の 1 個の質量(g)。 */
  readonly massG: number;
  /** 形に入れていない所。 */
  readonly simplified: readonly string[];
}

/** ジョイントバーの行(数は資料の記入のまま。めねじの位置は長さの端の面からの鎖寸法を道具が累積した物)。 */
export interface JointBarRecord extends FittingBase {
  readonly length: number;
  /** 頭の幅。 */
  readonly width: number;
  /** 全厚(頭の底の面から首の上の面まで)。 */
  readonly thickness: number;
  /** 首の幅(形には使わない。包む形の箱は頭の幅)。 */
  readonly neckWidth: number;
  readonly thread: string;
  readonly holeOffsets: readonly number[];
}

/** スタッドの行(おねじの長さは、中央の張り出しの下の面からのおねじの先と板の上の面の位置の差を、道具が出した物)。 */
export interface StudRecord extends FittingBase {
  readonly width: number;
  readonly depth: number;
  readonly plateThickness: number;
  readonly thread: string;
  readonly threadLength: number;
}

/** ローレットナットの行(太い段の径と全高。細い段の径は形に使わない)。 */
export interface KnurledNutRecord extends FittingBase {
  readonly diameter: number;
  readonly flangeDiameter: number;
  readonly height: number;
  readonly thread: string;
}

const MATERIALS: Readonly<Record<FittingMaterial, string>> = { steel: '鋼', stainless: 'ステンレス', brass: '黄銅' };
const GENERATOR_REVISION = 't-slot-fitting-1';

function rowOf(record: FittingBase, dims: Readonly<Record<string, number>>): CatalogItemRow {
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: MATERIALS[record.material],
    densityMaterialId: record.material,
    dims: { slot: record.slot, massG: record.massG, ...dims },
    evidence: { title: '資料 SF-1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', edition: null, url: '',
      locator: `PDF ${record.page} 頁 部品の図(寸法)と質量の記入`, sha256: '', fetchedDate: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: `形は簡略(${record.simplified.join('・')})。質量は資料の 1 個の値`,
    simplified: record.simplified,
  };
}

/** 族の作り方(族の名前と、行から dims・形・体積を作る関数)。 */
interface FittingFamilySpec<T extends FittingBase> {
  readonly id: string;
  readonly kindKey: string;
  readonly diagram: CatalogFamily['diagram'];
  readonly records: readonly T[];
  readonly dims: (record: T) => Readonly<Record<string, number>>;
  readonly build: (record: T) => ReturnType<CatalogFamily['build']>;
  readonly volume: (record: T) => number | null;
}

function fittingFamily<T extends FittingBase>(spec: FittingFamilySpec<T>): CatalogFamily {
  const { id, kindKey, diagram, records, dims, build, volume } = spec;
  const byKey = new Map(records.map((record) => [record.key, record]));
  return {
    id, group: 'aluminumFrame', kindKey, catalogRevision: `${id}-2026-11-r1`, generatorRevision: GENERATOR_REVISION, options: [], stock: 'count',
    diagram, rows: records.map((record) => rowOf(record, dims(record))),
    build: (row) => {
      const record = byKey.get(row.key);
      const part = record === undefined ? null : build(record);
      return part === null ? null : withName(part, row.size);
    },
    nominalVolume: (row) => {
      const record = byKey.get(row.key);
      return record === undefined ? null : volume(record);
    },
    // 1 個の質量(g)。資料の値。
    nominalMassG: (row) => {
      const mass = row.dims.massG ?? NaN;
      return mass > 0 ? mass : null;
    },
    partName: (row) => row.size,
  };
}

function jointBarDimensions(record: JointBarRecord): JointBarDimensions {
  return { length: record.length, width: record.width, thickness: record.thickness, thread: record.thread, holeOffsets: record.holeOffsets };
}

function studDimensions(record: StudRecord): StackedPartDimensions {
  return { segments: [{ shape: 'square', width: record.width, depth: record.depth, height: record.plateThickness, bore: null }],
    thread: { size: record.thread, length: record.threadLength } };
}

function knurledDimensions(record: KnurledNutRecord): StackedPartDimensions {
  return { segments: [{ shape: 'circle', diameter: record.diameter, height: record.height, bore: null }], thread: null, threadHole: record.thread };
}

export const JOINT_BAR_FAMILY = fittingFamily({
  id: 't-slot-joint-bar', kindKey: 'catalog.frame.kind.jointBar', diagram: 'jointBar', records: JOINT_BAR_RECORDS,
  dims: (record) => ({ length: record.length, width: record.width, thickness: record.thickness, neckWidth: record.neckWidth,
    holeCount: record.holeOffsets.length }),
  build: (record) => buildJointBarPart(jointBarDimensions(record)),
  volume: (record) => jointBarVolume(jointBarDimensions(record)),
});

export const STUD_FAMILY = fittingFamily({
  id: 't-slot-stud', kindKey: 'catalog.frame.kind.tSlotStud', diagram: 'tSlotStud', records: STUD_RECORDS,
  dims: (record) => ({ width: record.width, depth: record.depth, plateThickness: record.plateThickness, threadLength: record.threadLength,
    height: stackedPartHeight(studDimensions(record)) }),
  build: (record) => buildStackedPart(studDimensions(record)),
  volume: (record) => stackedPartVolume(studDimensions(record)),
});

export const KNURLED_NUT_FAMILY = fittingFamily({
  id: 't-slot-knurled-nut', kindKey: 'catalog.frame.kind.knurledNut', diagram: 'knurledNut', records: KNURLED_NUT_RECORDS,
  dims: (record) => ({ diameter: record.diameter, flangeDiameter: record.flangeDiameter, height: record.height }),
  build: (record) => buildStackedPart(knurledDimensions(record)),
  volume: (record) => stackedPartVolume(knurledDimensions(record)),
});
