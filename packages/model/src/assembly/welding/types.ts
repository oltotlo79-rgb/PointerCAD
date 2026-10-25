/**
 * 組立の2部品の間の直線のすみ肉溶接のビード(3D 溶接の最初の範囲)。
 *
 * ビードは普通の形として持つ。区間ごとに生成した部品(出どころは `standardPart`、カタログ `filletWeld`、
 * 三角形の断面を溶接線に沿って押し出す)を、ほかの部品と同じく組立へ置く。B-rep・質量・保存と読込み・Undo は
 * 既存の部品の経路をそのまま使う。保存するのは利用者が決めた値(脚長、区間の始点と長さ、材質、配置としての
 * 溶接線の座標系)だけで、導ける形はそこから組み直す。
 *
 * この範囲に無いもの: 溶接の強度、のど厚の検査、溶加材の性質、熱、塑性。ビードの質量は利用者が明示した材質で
 * 数え、溶加材の密度は仮定しない。
 */

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { Vec3 } from '../../sketch/vec3.js';

/** 長さの比較(mm)。締結と同じ値。 */
export const WELD_LENGTH_TOLERANCE_MM = 1e-6;
/** 向きの比較(内積のずれ)。 */
export const WELD_DIRECTION_TOLERANCE = 1e-9;
/** 保存する溶接の台本の版。作り方を変えても古いビードを黙って変えない。 */
export const FILLET_WELD_CATALOG_REVISION = 'weld-1';
export const FILLET_WELD_GENERATOR_REVISION = 'fillet-weld-1';
/**
 * 直角でない当たりのビードの版。断面の3つ目の頂点を保存した内角 `weldAngle` で置くので、旧い読み手(版 1 だけを
 * 知る)は組まずに断る(直角の三角形で黙って代えない)。直角のビードは従来の版・欄のまま。
 */
export const FILLET_WELD_OBLIQUE_GENERATOR_REVISION = 'fillet-weld-2';
/** Exterior cylindrical contact uses a true circular profile; older generators must refuse it. */
export const FILLET_WELD_CYLINDRICAL_GENERATOR_REVISION = 'fillet-weld-3';
/** Inner cylindrical material side requires an explicit side and its own saved generator. */
export const FILLET_WELD_INNER_CYLINDRICAL_GENERATOR_REVISION = 'fillet-weld-4';

/**
 * 2 面の間の内角(ビードの断面の 2 脚の間の角)。cos・sin は度から 1 か所(`weldInteriorAngle`)で求め、計画・
 * 部品の生成・直す計画が同じ値を使う。
 */
export interface WeldInteriorAngle {
  readonly degrees: number;
  readonly cos: number;
  readonly sin: number;
}

/**
 * 内角(度)から cos・sin を求める唯一の口。0° 以下・180° 以上(面が重なる・平行)・直角(従来の版で扱う)・非数は
 * `null`。平行に近い当たりを扱えるかは脚長で決まるので `weldAngleConditioned` で別に確かめる。
 */
export function weldInteriorAngle(degrees: number): WeldInteriorAngle | null {
  if (!Number.isFinite(degrees) || degrees <= 0 || degrees >= 180) return null;
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return Math.abs(cos) <= WELD_DIRECTION_TOLERANCE || !(sin > 0) ? null : { degrees, cos, sin };
}

/**
 * 平行に近い当たりの条件数による下限(角度の決め打ちの範囲を置かない)。
 *
 * 仮定(証明ではない): 2 面の外向きの法線 a・b の向きは、それぞれ角度 `WELD_DIRECTION_TOLERANCE`(rad)の内で分かって
 * いるとみなす。これは計画が向きの比較(平行・直交・辺の向き)に使う許容差をそのまま当てた保守的な前提で、法線の
 * 長さが 1 か(単位の検査)を確かめても、この角度の誤差の上限は保証されない。
 * この前提の下で a·b は最大 2 × その値だけずれ、内角(cos θ = −a·b)のずれは dθ ≈ d(a·b) / sin θ、長さ ℓ の脚の先の
 * 動きは ℓ·dθ。これが溶接の幾何の許容差 `WELD_LENGTH_TOLERANCE_MM` 以下であること:
 *   sin θ ≥ 2 × WELD_DIRECTION_TOLERANCE × max(脚長) / WELD_LENGTH_TOLERANCE_MM
 * (脚 6・8 mm なら sin θ ≥ 0.016、θ は約 0.917°〜179.083°)。断面が細すぎないこと(最小の高さ)はこの条件からは
 * 導けないので、`weldCrossSectionIssue` で実際の三角形の寸法から別に確かめる。
 */
export function weldAngleSinFloor(legOnSecond: number, legOnFirst: number): number {
  return 2 * WELD_DIRECTION_TOLERANCE * Math.max(legOnSecond, legOnFirst) / WELD_LENGTH_TOLERANCE_MM;
}

/** 内角が脚長に対して上の条件を満たすか(直角は常に満たす)。 */
export function weldAngleConditioned(angle: WeldInteriorAngle | null, legOnSecond: number, legOnFirst: number): boolean {
  return angle === null || angle.sin >= weldAngleSinFloor(legOnSecond, legOnFirst);
}

/**
 * ビードの断面(局所の X–Y 平面の三角形)の実際の寸法: 角 (0,0)、2 つ目の面の上の脚の先 (legOnSecond, 0)、1 つ目の
 * 面の上の脚の先(直角は (0, legOnFirst)、直角でなければ (legOnFirst cos θ, legOnFirst sin θ))。面積は直角なら
 * 脚の積 / 2(従来と同じ式)、直角でなければ脚の積 × sin θ / 2。最小の高さ = 2 × 面積 / 最も長い辺。
 */
export interface WeldCrossSection {
  readonly firstLegTip: readonly [number, number];
  readonly area: number;
  readonly longestSide: number;
  readonly minimumAltitude: number;
}

export function weldCrossSection(legOnSecond: number, legOnFirst: number, angle: WeldInteriorAngle | null): WeldCrossSection {
  const firstLegTip: readonly [number, number] = angle === null ? [0, legOnFirst] : [legOnFirst * angle.cos, legOnFirst * angle.sin];
  const area = angle === null ? legOnSecond * legOnFirst / 2 : legOnSecond * legOnFirst * angle.sin / 2;
  const third = Math.hypot(firstLegTip[0] - legOnSecond, firstLegTip[1]);
  const longestSide = Math.max(legOnSecond, legOnFirst, third);
  return { firstLegTip, area, longestSide, minimumAltitude: 2 * area / longestSide };
}

/**
 * 断面を組めない理由。`illConditioned`: 平行に近く内角を許容差の中で決められない(上の条件)。`degenerate`: 実際の
 * 三角形の最小の高さが溶接の幾何の許容差 `WELD_LENGTH_TOLERANCE_MM` 未満(細すぎて形にならない)。`nonFinite`:
 * 面積・高さが桁あふれ・非数(計画は公称体積の検査で断る)。直角も同じ基準で確かめる(保存の形が従来と同じでも、
 * 安全の基準は分けない)。どれも無ければ `null`。
 */
export function weldCrossSectionIssue(
  legOnSecond: number, legOnFirst: number, angle: WeldInteriorAngle | null,
): 'illConditioned' | 'degenerate' | 'nonFinite' | null {
  if (!weldAngleConditioned(angle, legOnSecond, legOnFirst)) return 'illConditioned';
  const section = weldCrossSection(legOnSecond, legOnFirst, angle);
  if (!Number.isFinite(section.area) || !Number.isFinite(section.minimumAltitude)) return 'nonFinite';
  return section.area > 0 && section.minimumAltitude >= WELD_LENGTH_TOLERANCE_MM ? null : 'degenerate';
}

/** 脚長に対して扱える内角の範囲(度)。下限を超える脚長では直角でない当たりを扱えない(両方 90)。 */
export function weldAngleRangeDegrees(legOnSecond: number, legOnFirst: number): { readonly minimum: number; readonly maximum: number } {
  const floor = weldAngleSinFloor(legOnSecond, legOnFirst);
  if (!(floor < 1)) return { minimum: 90, maximum: 90 };
  const minimum = Math.asin(floor) * 180 / Math.PI;
  return { minimum, maximum: 180 - minimum };
}

/** 1つの溶接の全区間が共有する id の接頭辞(`weld-<n>`。残っている番号は使い回さない)。 */
export const WELD_ID_PREFIX = 'weld-';

/**
 * 1つの部品で選んだ平面。選んだ時の形から読んだ値で、部品自身の座標(配置の前)。`normal` は外向きの
 * 単位法線、`centroid` は面の重心。
 */
export interface WeldFaceSelection {
  readonly componentId: string;
  /** 選んだ時の `componentSourceKey`。違えば古い選択。 */
  readonly sourceKey: string;
  readonly face: SubShapeRef;
  readonly centroid: Vec3;
  /** Plane material normal; null for a cylinder, whose local radial normal is resolved at the actual seam. */
  readonly normal: Vec3 | null;
}

/** ビードが沿う1つ目の部品の直線の辺(当たりの線)。その部品の座標での中点・単位の向き・長さ。 */
export interface WeldEdgeSelection {
  readonly edge: SubShapeRef;
  readonly midpoint: Vec3;
  readonly direction: Vec3;
  readonly length: number;
}

/** ビードの1区間。当たりの線に沿って `start` mm から始まり、長さ `length` mm。 */
export interface WeldSegmentSpec {
  readonly start: number;
  readonly length: number;
}

export interface FilletWeldRequest {
  /** 1つ目の部品の面。脚 `legOnFirst` がこの面に載る(例: 立板の側面)。 */
  readonly first: WeldFaceSelection;
  /** 2つ目の部品の面。脚 `legOnSecond` がこの面に載る(例: 底板の上面)。 */
  readonly second: WeldFaceSelection;
  /** 2つ目の面の平面上にある1つ目の部品の辺。溶接線。 */
  readonly edge: WeldEdgeSelection;
  /** 1つ目の面の法線の向きの脚(2つ目の面に載る、mm)。 */
  readonly legOnSecond: number;
  /** 2つ目の面の法線の向きの脚(1つ目の面に載る、mm)。 */
  readonly legOnFirst: number;
  /** 連続(1区間)または断続のビード。始点は向きを決めた溶接線に沿って測る。 */
  readonly segments: readonly WeldSegmentSpec[];
  /** 材質の id(`densityMaterials.ts`)。必須。溶加材は仮定しない。 */
  readonly materialId: string;
}

export type FilletWeldRejectionCode =
  | 'componentMissing' | 'componentSuppressed' | 'componentNotPlaceable' | 'sameComponent'
  | 'staleSource' | 'missingSourceRevision' | 'invalidPlacement' | 'invalidWorldFrame'
  | 'faceNotPlanar' | 'edgeNotStraight' | 'invalidVector' | 'vectorNotNormalized' | 'invalidDimension'
  | 'unsupportedJointAngle' | 'edgeNotOnFirstFace' | 'edgeNotOnSecondFace' | 'edgeNotAlongCorner'
  | 'notConcaveCorner' | 'noSegments' | 'segmentOutsideContact' | 'segmentsOverlap' | 'segmentsUnordered'
  | 'materialRequired' | 'unknownMaterial' | 'weldMissing' | 'weldDamaged'
  | 'selectionNotFound' | 'edgeNotOnFirstComponent' | 'tooManySegments'
  | 'contactFaceUnavailable' | 'contactNotCovered' | 'contactBoundaryCrossed' | 'contactUndecidable'
  | 'degenerateCrossSection' | 'overlapsExistingWeld';

/** 断る理由の全種類。表の鍵が合併型と1対1になることを型で確かめる(画面の文言の網羅の検査に使う)。 */
const REJECTION_CODE_TABLE: Readonly<Record<FilletWeldRejectionCode, true>> = {
  componentMissing: true, componentSuppressed: true, componentNotPlaceable: true, sameComponent: true,
  staleSource: true, missingSourceRevision: true, invalidPlacement: true, invalidWorldFrame: true,
  faceNotPlanar: true, edgeNotStraight: true, invalidVector: true, vectorNotNormalized: true, invalidDimension: true,
  unsupportedJointAngle: true, edgeNotOnFirstFace: true, edgeNotOnSecondFace: true, edgeNotAlongCorner: true,
  notConcaveCorner: true, noSegments: true, segmentOutsideContact: true, segmentsOverlap: true, segmentsUnordered: true,
  materialRequired: true, unknownMaterial: true, weldMissing: true, weldDamaged: true,
  selectionNotFound: true, edgeNotOnFirstComponent: true, tooManySegments: true,
  contactFaceUnavailable: true, contactNotCovered: true, contactBoundaryCrossed: true, contactUndecidable: true,
  degenerateCrossSection: true, overlapsExistingWeld: true,
};

export const FILLET_WELD_REJECTION_CODES: readonly FilletWeldRejectionCode[] = (
  Object.keys(REJECTION_CODE_TABLE) as FilletWeldRejectionCode[]);

export interface FilletWeldRejection {
  readonly code: FilletWeldRejectionCode;
  readonly detail: Readonly<Record<string, string | number>>;
}

/**
 * 組立の座標での溶接線の座標系(常に右手系の正規直交)。`xAxis` = 2 つ目の面の上で 1 つ目の部品から離れる向き
 * (脚 `legOnSecond`)、`yAxis` = 2 つ目の面の外向きの法線、`zAxis` = 線。直角の当たりでは `yAxis` が脚
 * `legOnFirst` の向きと一致する。直角でない時、脚 `legOnFirst` は cos θ·x + sin θ·y(θ = 内角)で、座標系を
 * 歪めずに断面の頂点の座標で表す。
 */
export interface WeldFrame {
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly zAxis: Vec3;
}

export interface WeldContactEvidence {
  readonly segment: number;
  readonly side: 'first' | 'second';
  readonly componentId: string;
  readonly coveredRatio: number;
}

export interface FilletWeldPlan {
  /** Present only for a radial-plane/cylinder joint; the second leg is arc length. */
  readonly cylindricalRadius?: number;
  /** Absent means the unchanged exterior revision 3; never inferred from radius alone. */
  readonly cylindricalSide?: 'interior';
  readonly weldId: string;
  readonly firstComponentId: string;
  readonly secondComponentId: string;
  readonly frame: WeldFrame;
  /** 確かめた当たりの線の長さ(mm)。 */
  readonly contactLength: number;
  readonly legOnSecond: number;
  readonly legOnFirst: number;
  readonly segments: readonly WeldSegmentSpec[];
  readonly materialId: string;
  /** 2 面の間の内角。直角の当たりは `null`(保存も従来の版・欄のまま)。 */
  readonly interiorAngle: WeldInteriorAngle | null;
  /** ビードの合計長さと公称体積(脚長の積 × sin θ / 2 × 長さ、直角は積 / 2 × 長さ)。カーネルとは独立に求める。 */
  readonly totalLength: number;
  readonly nominalVolume: number;
  /** 計画した時の出どころの鍵と配置の指紋。足す直前にもう一度確かめる。 */
  readonly sourceIdentities: Readonly<Record<string, string>>;
  /**
   * 当たりの証拠: ビード 1 区間ごと・面ごとに、足元の長方形を部品の実際の面が覆う割合(`weldContact.ts`。
   * 境界が内側を横切らないことを確かめた上での値)。計画が通ったものだけが入る。
   */
  readonly contact: readonly WeldContactEvidence[];
  /** この計画で置き換える既存のビードの部品(溶接を直す時)。新しい溶接では空。 */
  readonly replacedComponentIds: readonly string[];
}

export type FilletWeldPlanResult =
  | { readonly ok: true; readonly plan: FilletWeldPlan }
  | { readonly ok: false; readonly rejections: readonly FilletWeldRejection[] };
