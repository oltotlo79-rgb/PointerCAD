/**
 * 2穴のボルト締結の計画(追加要件6、EX-06)の入出力の型。
 *
 * 計画は純関数で作り、文書へは `applyBoltedJoint.ts` が1回の新しい文書として足す(Undo 1段)。
 * 穴の厚さ・軸・合わせ面は利用者が選んだその時の形から読んだ値で、保存しない
 * (導出できる値。rules/04)。保存されるのは既存の規格部品の出どころと配置だけである。
 *
 * 強度・予張力・ねじ込み長さの十分さは判定しない。等級名から強さを推定しない。
 */

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { ThreadSeries } from '../../thread/metricThread.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { FastenerDimensionSeries } from '../standard/types.js';
import type { RigidPlacement } from '../placementMath.js';
import type { Placement } from '../types.js';

/** 長さの比較の許容(mm)。`SKETCH_TOLERANCE_MM` と同じ値を名前付きで持つ。 */
export const FASTENING_LENGTH_TOLERANCE_MM = 1e-6;

/** 向きの比較の許容(内積の 1 からのずれ)。 */
export const FASTENING_DIRECTION_TOLERANCE = 1e-9;

/** 選んだ穴の種類。厚さ・深さは選んだ時の形から読んだ値(mm)。 */
export type FasteningHoleSpec =
  /** ねじの無い通し穴。`length` は合わせ面から反対の面までの軸方向の厚さ。 */
  | { readonly kind: 'clearance'; readonly diameter: number; readonly length: number }
  /**
   * 貫通のねじ穴。ねじ部は合わせ面から測って `threadStart` から `threadStart + threadLength` まで
   * (`length` 以下)。ねじの入口が反対の面にある穴は `threadStart > 0` になる。
   */
  | {
      readonly kind: 'throughThreaded'; readonly nominal: string; readonly pitch: number;
      readonly threadStart: number; readonly threadLength: number; readonly length: number;
    }
  /** 止まりのねじ穴。`usableThreadDepth` は合わせ面から測った有効なねじ部の深さ。 */
  | {
      readonly kind: 'blindThreaded'; readonly nominal: string; readonly pitch: number;
      readonly usableThreadDepth: number; readonly drillDepth: number;
    };

/**
 * 利用者が選んだ穴1つと合わせ面1つ。座標は部品の中(配置をかける前)の値。
 *
 * `axisDirection` は合わせ面から板の中へ入る向き(相手の板から離れる向き)で長さ 1。
 * `matingFaceNormal` は合わせ面の外向きの法線で長さ 1(`axisDirection` と逆向き)。
 */
export interface FasteningHoleSelection {
  readonly componentId: string;
  /** 選んだ時の部品の出どころの鍵(`componentSourceKey`)。違えば古い選択として断る。 */
  readonly sourceKey: string;
  /** 穴を作ったフィーチャーの id(部品の中)。 */
  readonly holeFeatureId: string;
  readonly matingFace: SubShapeRef;
  readonly hole: FasteningHoleSpec;
  /** 合わせ面の上にある穴の軸の点。 */
  readonly axisOrigin: Vec3;
  readonly axisDirection: Vec3;
  readonly matingFaceNormal: Vec3;
}

/** 座金は利用者が明示した時だけ入れる。 */
export type FasteningWasherKind = 'plainWasher' | 'springWasher';

export interface BoltedJointRequest {
  readonly first: FasteningHoleSelection;
  readonly second: FasteningHoleSelection;
  readonly dimensionSeries: FastenerDimensionSeries;
  /**
   * 通し穴どうしで使う呼びとねじの系列。通し穴の径から丸めて推定しないため、通し穴どうしでは
   * これか `clearanceEvidence` の確認済みの行が必須。ねじ穴があるときは穴の呼び・ピッチと一致を確かめる。
   */
  readonly explicitBolt?: { readonly nominal: string; readonly threadSeries: ThreadSeries };
  /** 通し穴の径と呼びの対応の根拠。確認済み(verified)の行だけを使う。 */
  readonly clearanceEvidence?: readonly ClearanceEvidenceRow[];
  /** ねじ穴へのねじ込み長さの指定(mm)。ねじ穴の時は必須。 */
  readonly engagement?: number;
  /** 止まり穴で、ボルト先端と有効なねじ部の底との間に残す長さ(mm、0 以上)。止まり穴の時は必須。 */
  readonly blindBottomClearance?: number;
  /** ナットの外へ出すねじの最小長さ(mm、0 以上)。通し穴どうしの時は必須。 */
  readonly minimumProtrusion?: number;
  readonly headWashers: readonly FasteningWasherKind[];
  readonly nutWashers: readonly FasteningWasherKind[];
  /** ボルトの呼び長さの候補。行の鍵ごとの根拠を持つ。 */
  readonly lengthAvailability: readonly BoltLengthAvailability[];
}

/** 通し穴の径から呼びを選ぶ根拠の1行(JIS B 1001 等)。出典の無い行は使わない。 */
export interface ClearanceEvidenceRow {
  readonly nominal: string;
  readonly minimumHoleDiameter: number;
  readonly maximumHoleDiameter: number;
  readonly verified: boolean;
  readonly source: string;
}

/** ボルトの寸法行1つに対する呼び長さの候補と、その根拠。 */
export interface BoltLengthAvailability {
  readonly boltRowKey: string;
  readonly lengths: readonly number[];
  /** 径ごとの根拠か、全径に共通の未確認の一覧か。 */
  readonly basis: 'perDiameterEvidence' | 'globalUnverifiedList';
  readonly verified: boolean;
  readonly source: string;
  /** 根拠が特定のねじの系列(並目など)だけのものなら、その系列。省略は系列を問わない。 */
  readonly threadSeries?: ThreadSeries;
}

/** 断る理由。画面は code を i18n の文言へ写す(モデルに文言を持たない)。 */
export type BoltedJointRejectionCode =
  | 'componentMissing' | 'componentSuppressed' | 'componentNotPlaceable' | 'sameComponent'
  | 'staleSource' | 'missingSourceRevision' | 'invalidPlacement' | 'invalidWorldFrame'
  | 'holeFeatureMissing' | 'holeFaceMissing' | 'holeFaceMismatch' | 'matingFaceMissing'
  | 'holeNotOnMatingFace' | 'threadEntryUnknown' | 'alignmentBlocked' | 'unsupportedHole'
  | 'invalidDimension' | 'invalidAxis' | 'axisNotNormalized' | 'faceAxisMismatch'
  | 'axesNotOpposed' | 'axesNotCoaxial' | 'facesNotInContact' | 'facesOverlap'
  | 'bothHolesThreaded' | 'unknownThread' | 'pitchNotInCatalog' | 'nominalMismatch' | 'pitchMismatch'
  | 'boltSizeUnspecified' | 'boltRowMissing' | 'nutRowMissing' | 'washerRowMissing'
  | 'insufficientClearance' | 'holeLargerThanBearing' | 'washerDoesNotFit'
  | 'washerOnTappedSide' | 'engagementRequired' | 'engagementExceedsThread'
  | 'blindClearanceRequired' | 'blindBottoming' | 'protrusionRequired'
  | 'lengthAvailabilityMissing' | 'noStandardLengthFits'
  | 'existingConstraintConflict' | 'existingConstraintUnresolved';

export interface BoltedJointRejection {
  readonly code: BoltedJointRejectionCode;
  /** 調べた値(穴・部品の id、寸法)。画面の説明に使う。 */
  readonly detail: Readonly<Record<string, string | number>>;
}

/** 確かめられない規格の事実。黙って値を作らず、計画に残す。 */
export type FasteningMissingFact =
  | 'perDiameterLengthAvailability'
  | 'threadLengthAbove125'
  | 'bearingFaceDiameter'
  | 'washerTableUnverified'
  | 'catalogRowUnverified';

export type BoltedJointConfiguration = 'throughBoltWithNut' | 'tappedThrough' | 'tappedBlind';

/** 足す規格部品1つ。`createStandardPartSource` へそのまま渡す入力と、置く配置。 */
export interface FastenerOperation {
  readonly role: 'bolt' | 'nut' | 'headWasher' | 'nutWasher';
  readonly catalog: 'hexBolt' | 'hexNut' | FasteningWasherKind;
  readonly size: string;
  readonly options: Readonly<Record<string, string>>;
  readonly rowKey: string;
  readonly rowVerified: boolean;
  readonly placement: Placement;
}

export interface BoltedJointPlan {
  readonly configuration: BoltedJointConfiguration;
  /** 頭の側の部品と、ねじ込み・ナットの側の部品。 */
  readonly headSideComponentId: string;
  readonly farSideComponentId: string;
  readonly nominal: string;
  readonly pitch: number;
  readonly threadSeries: ThreadSeries;
  /** 締め付ける厚さ(板＋明示した座金。mm)。 */
  readonly gripLength: number;
  readonly boltLength: number;
  /**
   * ボルトのねじ部と穴の有効なねじ部が実際に重なる長さ(ねじ穴の時)。先端が穴を突き抜けた分は
   * 含めない。
   */
  readonly engagedLength: number | null;
  /** 先端が相手の合わせ面から入った深さ(ねじ穴の時)。 */
  readonly penetration: number | null;
  /** 先端が外へ出る長さ。ナットの時はナットの外面から、貫通ねじ穴の時は相手の反対の面から。 */
  readonly protrusion: number | null;
  readonly lengthBasis: BoltLengthAvailability['basis'];
  readonly lengthVerified: boolean;
  readonly missingFacts: readonly FasteningMissingFact[];
  /** 計画の時の出どころの鍵と配置の指紋。足す前に照合する。 */
  readonly sourceIdentities: Readonly<Record<string, string>>;
  /**
   * 整列のために動かす部品(相手の部品とその組全体)と、組立の座標で掛ける変位
   * (`新しい配置 = 変位 ∘ いまの配置`)。動かす部品の計画の時の配置の指紋も持ち、足す前に照合する。
   */
  readonly alignment: {
    readonly movedComponentIds: readonly string[];
    readonly delta: RigidPlacement;
    readonly placementFingerprints: Readonly<Record<string, string>>;
  };
  readonly operations: readonly FastenerOperation[];
}

export type BoltedJointPlanResult =
  | { readonly ok: true; readonly plan: BoltedJointPlan }
  | { readonly ok: false; readonly rejections: readonly BoltedJointRejection[] };
