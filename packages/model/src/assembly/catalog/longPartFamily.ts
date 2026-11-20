/**
 * 長物の族の作り(溝のふた・溝のシール・パネルの押さえ・ダクトのカバー・取手のレールなど、切って使う物。統括の決定 2026-11-19 15:5x の 1):
 * 断面の外形を包む長方形を、利用者が入れた長さだけ押し出した形。溝に入る足・中空・唇の形は作らない(行の簡略の印に出す)。
 *
 * - 長さは式で入れる(既定は族の既定の長さ。行に長さの上限〔定尺・切り売りの最大〕がある時は、上限と族の既定の短い方)。
 *   上限を超える長さは、形・体積・質量のどれも作らない(null。黙って上限に縮めない)。
 * - 質量は資料の単位質量 × 長さ(単位質量の記入が無い行は質量を出さない)。資料が定尺 1 本の質量だけを書く行は、
 *   行の表を作る道具が 1 本の質量 ÷ 定尺で単位質量に直し、その事を行の印の文に書く。
 * - 切断の一覧に出る(stock 'linear')。断面の外形(sectionBounds)と溝(sectionSlots)は持たない: 溝つきのフレームの部材として、
 *   一括配置・接合の確かめ・端のキャップの相手にはしない。断面の性質を持たないので、梁の解析の部材にもならない。
 * - 樹脂・ゴムなど密度の表に無い材料の行と、部位ごとに材料の違う行('mixed')は密度を持たない(部品表は材質の文字と、単位質量 × 長さの質量)。
 */
import { withName } from '../standard/partPrimitives.js';
import { buildProfileSection } from '../standard/profileExtrusion.js';
import { lengthOf, lengthOptionSpec, lengthText } from './lengthOption.js';
import { panelBoardProfile } from './profiles/panelBoard.js';
import type { CatalogFamily, CatalogItemRow } from './types.js';

type LongPartMaterial = 'aluminum' | 'stainless' | 'steel' | 'mixed';

/** 長物の行(断面の外形を包む長方形・単位質量・長さの上限。数は資料の記入のまま)。 */
export interface LongPartRecord {
  readonly key: string;
  readonly size: string;
  readonly page: number;
  /** 部品の種類の一般の語。 */
  readonly kind: string;
  readonly material: LongPartMaterial;
  /** 'mixed' の行(樹脂・ゴム・部位ごとに材料の違う物)だけ: 部品表の材質の文字(一般の材料の語)。 */
  readonly materialText?: string;
  /** 断面の外形を包む長方形の横と縦(mm)。 */
  readonly width: number;
  readonly height: number;
  /** 資料の単位質量(kg/m)。記入の無い行は null(質量を出さない)。 */
  readonly unitMassKgPerM: number | null;
  /** 長さの上限(定尺の長さか切り売りの最大、mm)。上限の無い行は null。 */
  readonly maxLength: number | null;
  /** 資料が定尺 1 本の質量だけを書く行だけ: 単位質量の出し方の文(例「質量は資料の定尺 1 本の質量 ÷ 定尺の単位質量 × 長さ」)。 */
  readonly massNote?: string;
  readonly simplified: readonly string[];
}

/** 長物の族の名乗り(行の表と id・種類の鍵・線図・出どころの資料の名前・既定の長さだけが族ごとに違う)。 */
export interface LongPartFamilySpec {
  readonly id: string;
  readonly kindKey: string;
  readonly diagram: CatalogFamily['diagram'];
  readonly evidenceTitle: string;
  readonly defaultLength: number;
}

const MATERIAL_LABELS: Readonly<Record<Exclude<LongPartMaterial, 'mixed'>, string>> = { aluminum: 'アルミ', stainless: 'ステンレス', steel: '鋼' };

function longPartRow(spec: LongPartFamilySpec, record: LongPartRecord): CatalogItemRow {
  const density = record.material === 'mixed' || record.unitMassKgPerM === null ? {} : { densityMaterialId: record.material };
  const label = record.materialText ?? (record.material === 'mixed' ? '' : MATERIAL_LABELS[record.material]);
  const mass = record.unitMassKgPerM === null ? '質量は資料に記入が無いので出さない' : record.massNote ?? '質量は資料の単位質量 × 長さ';
  const limit = record.maxLength === null ? '' : `。長さは ${record.maxLength} mm まで`;
  return {
    key: record.key, size: record.size, standardLabel: '製造元の寸法に合わせた物', materialLabel: label, ...density,
    dims: {
      width: record.width, height: record.height,
      ...(record.unitMassKgPerM === null ? {} : { unitMassKgPerM: record.unitMassKgPerM }),
      ...(record.maxLength === null ? {} : { maxLength: record.maxLength }),
    },
    evidence: { title: spec.evidenceTitle, edition: null, locator: `PDF ${record.page} 頁 断面の図(外形の寸法)と質量の記入`, reference: '' },
    verification: 'manufacturer-catalog', verified: true,
    note: `形は簡略(${record.simplified.join('・')})。${mass}${limit}。断面の性質は持たない`, simplified: record.simplified,
  };
}

/** 断面(外形を包む長方形。原点は外形の中心)。寸法が正でない時は null。 */
const sectionOf = (row: CatalogItemRow): ReturnType<typeof panelBoardProfile> =>
  panelBoardProfile({ width: row.dims.width ?? NaN, height: row.dims.height ?? NaN, thickness: 1 });

/** 入れた長さ(正で、行の上限以下の時だけ。ほかは null)。 */
function lengthWithin(row: CatalogItemRow, values: Readonly<Record<string, string>>): number | null {
  const length = lengthOf(values)?.value ?? NaN;
  const max = row.dims.maxLength;
  return length > 0 && (max === undefined || length <= max) ? length : null;
}

/** 長物の族(断面の外形を包む長方形 × 長さ)。 */
export function rectangleLongPartFamily(spec: LongPartFamilySpec, records: readonly LongPartRecord[]): CatalogFamily {
  const rowDefault = (row: CatalogItemRow): string => String(Math.min(row.dims.maxLength ?? spec.defaultLength, spec.defaultLength));
  return {
    id: spec.id, group: 'aluminumFrame', kindKey: spec.kindKey, catalogRevision: `${spec.id}-2026-11-r1`, generatorRevision: 'long-part-1',
    options: [lengthOptionSpec(String(spec.defaultLength), rowDefault)], stock: 'linear', diagram: spec.diagram,
    rows: records.map((record) => longPartRow(spec, record)),
    build: (row, values) => {
      const profile = sectionOf(row);
      const length = lengthOf(values);
      if (profile === null || length === null || lengthWithin(row, values) === null) return null;
      return withName(buildProfileSection(profile, length), `${row.size}×${lengthText(values)}`);
    },
    nominalVolume: (row, values) => {
      const profile = sectionOf(row);
      const length = lengthWithin(row, values);
      return profile === null || length === null ? null : profile.areaMm2 * length;
    },
    nominalMassG: (row, values) => {
      const length = lengthWithin(row, values);
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      return length === null || !(unitMass > 0) ? null : unitMass * length;
    },
    partName: (row, values) => `${row.size}×${lengthText(values)}`,
  };
}
