/**
 * 部品(パート)文書の保存形式(計画書 docs/plans/P2-ソリッド基礎.md §2.1、
 * docs/plans/P3-加工フィーチャー.md §2.4 / §2.6 / §2.7 / §2.7b、要件§8)。
 *
 * P1 の SketchDocument をそのまま中へ入れ、ソリッドフィーチャーの履歴を並べる。
 * 保存するのは履歴と式だけで、解決済みの座標・B-rep・メッシュ・キャッシュの鍵は
 * 保存しない(rules/04-設計の規律.md「導出できるものは保存しない」)。
 * 全パラメータは式文字列+評価値のペア(ExpressionValue)で持つ(FR-202)。
 * 参照はすべて id で持ち、座標や形を複製しない(FR-311、FR-502)。
 *
 * P3 で足したのは、加工フィーチャー6種(穴・ねじ穴・R 面取り・C 面取り・直線/円形パターン)、
 * ばね、そして部分形状(面・辺・頂点)への参照 `SubShapeRef` である。
 * いずれも「保存される形」なのでこのファイルに置く(解決の途中で作る型は resolvePart.ts、
 * 鍵の材料の型は cacheKey.ts が自分で持つ)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type {
  EdgeCurveKind,
  FaceSurfaceKind,
  SubShapeFingerprint,
  SubShapeKind,
  SubShapeRef,
} from '../geometry/subShapeRef.js';
import type { SketchDocument } from '../sketch/types.js';
import type { ThreadSeries } from '../thread/metricThread.js';

/** スケッチの面フィーチャー1枚への参照。断面に使う(§0.a-0.7、§0.a-0.8)。 */
export interface SketchFaceRef {
  readonly sketchId: string;
  readonly faceFeatureId: string;
}

/** スケッチの線分フィーチャー1本への参照。回転軸に使う(§0.a-0.9)。 */
export interface SketchLineRef {
  readonly sketchId: string;
  readonly lineFeatureId: string;
}

/**
 * スケッチの点フィーチャー・点列フィーチャーへの参照
 * (P3 計画書 §2.4.1、§0.a-0.9。穴の中心とばねの始点に使う)。
 *
 * 点列(FR-308)を指したときはその点列の全点へ展開される。1点だけを指す書き方は持たない
 * (要素 id `point-1#3` ではなくフィーチャー id を持つため)。座標そのものは複製せず、
 * 位置は式のまま再編集できる(FR-202、FR-502)。
 */
export interface SketchPointRef {
  readonly sketchId: string;
  /** 点フィーチャー(kind: 'point')または点列フィーチャー(kind: 'pointArray')の id。 */
  readonly pointFeatureId: string;
}

/**
 * 部分形状(面・辺・頂点)への参照一式(`SubShapeKind` / `FaceSurfaceKind` / `EdgeCurveKind` /
 * `SubShapeFingerprint` / `SubShapeRef`)。
 *
 * P4(docs/plans/P4-スケッチ拡張.md §0.a-0.7、§2.6、タスク3)で、3D スケッチ(FR-330)の点が
 * 立体の頂点を参照できるようにするため、`part` にも `sketch` にも依存しない中立の置き場
 * `geometry/subShapeRef.ts` へ実体を移した(このファイルは `sketch/types.ts` を import して
 * おり、そこへ型を置くと `part → sketch → part` の循環になるため)。ここでは既存コード
 * (`resolvePart.ts`・`kernelBridge.ts` 等)の import 文 `from './types.js'` を変えずに済ませる
 * ため、実体を re-export するだけにする。
 */
export type { EdgeCurveKind, FaceSurfaceKind, SubShapeFingerprint, SubShapeKind, SubShapeRef };

export type SolidFeatureKind =
  | 'extrude'
  | 'revolve'
  | 'sew'
  | 'boolean'
  | 'hole'
  | 'threadHole'
  | 'fillet'
  | 'chamfer'
  | 'pattern'
  /** ばね(FR-414、P3 計画書 §2.7b)。対象を取らず、新しいボディを作る。 */
  | 'spring';

interface SolidFeatureBase {
  /**
   * フィーチャーの id。同時にこのフィーチャーが作るボディの id でもある(§0.a-0.5)。
   * 他のフィーチャー(ブーリアン)から参照されるので、文書の中で重ならない。
   */
  readonly id: string;
  /** フィーチャーツリーの表示名(FR-501)。 */
  readonly name: string;
  /** 抑制(FR-503)。true なら再計算で飛ばし、ボディを作らない。 */
  readonly suppressed: boolean;
}

/** 押し出し(FR-401)。テーパーは P3(§0.a-0.8)。 */
export interface ExtrudeFeature extends SolidFeatureBase {
  readonly kind: 'extrude';
  readonly profile: SketchFaceRef;
  /** 押し出す長さ(mm)。正の数。向きは reversed で決める。 */
  readonly distance: ExpressionValue;
  /** 面の法線と逆向きへ出すか。 */
  readonly reversed: boolean;
  /** 両側へ出すか。true なら距離の半分ずつ両方向(平行移動は model 側で計算する)。 */
  readonly symmetric: boolean;
}

/** 回転軸の指定(FR-402、§0.a-0.9)。既定は world の z 軸。 */
export type RevolveAxis =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly line: SketchLineRef };

/** 回転(FR-402)。 */
export interface RevolveFeature extends SolidFeatureBase {
  readonly kind: 'revolve';
  readonly profile: SketchFaceRef;
  readonly axis: RevolveAxis;
  /** 回転角(度)。0 より大きく 360 以下。 */
  readonly angle: ExpressionValue;
  /** 軸の向きを反転するか。 */
  readonly reversed: boolean;
}

/** 縫合(FR-403)。閉じた殻を作れる面を並べる(§0.a-0.7)。 */
export interface SewFeature extends SolidFeatureBase {
  readonly kind: 'sew';
  readonly faces: readonly SketchFaceRef[];
  /** つなぎ目とみなす許容量(mm)。既定 DEFAULT_SEW_TOLERANCE_MM。 */
  readonly tolerance: ExpressionValue;
}

export type BooleanOperation = 'union' | 'subtract' | 'intersect';

/**
 * ブーリアン(FR-404)。対象と相手のボディを消費して1つのボディを作る(§0.a-0.5)。
 * 参照先のフィーチャーが消えても文書としては成り立ち、解決のときに理由つきで失敗する(FR-504)。
 */
export interface BooleanFeature extends SolidFeatureBase {
  readonly kind: 'boolean';
  readonly operation: BooleanOperation;
  /** 残る側のボディを作ったフィーチャーの id。 */
  readonly targetFeatureId: string;
  /** 相手のボディを作ったフィーチャーの id。 */
  readonly toolFeatureId: string;
}

/** 穴の深さの指定(FR-405)。貫通の長さはカーネルが境界箱から決める(§0.a-0.12)。 */
export type HoleDepth =
  | { readonly kind: 'through' }
  | { readonly kind: 'blind'; readonly depth: ExpressionValue };

/**
 * 穴(FR-405)。対象のボディを消費して1つの新しいボディを作る(§0.a-0.5)。
 * 中心はスケッチの点・点列を参照し(§0.a-0.9)、カーネルが面の平面へ投影する。
 */
export interface HoleFeature extends SolidFeatureBase {
  readonly kind: 'hole';
  /** 穴をあける立体を作ったフィーチャーの id。消費する(§0.a-0.5)。 */
  readonly targetFeatureId: string;
  /** 穴をあける面。向きの既定と深さの起点になる(§2.2)。 */
  readonly face: SubShapeRef;
  /** 中心にする点。1つ以上。点列は全ての点へ展開される。 */
  readonly centers: readonly SketchPointRef[];
  readonly diameter: ExpressionValue;
  readonly depth: HoleDepth;
  /** 面の法線からの傾き(度)。0 なら面に垂直(FR-405)。 */
  readonly tiltAngle: ExpressionValue;
  /**
   * 傾ける向き(面内の方位角、度)。基準は面の第1軸(カーネルが `gp_Pln.XAxis()` から取る、
   * §0.a-0.10)。同じ面なら常に同じ向きになる(決定性)。
   */
  readonly tiltAzimuth: ExpressionValue;
}

/** ねじの3D表示(FR-406)。既定は簡略表示で、実らせんはフィーチャーごとのつまみ(§0.a-0.16)。 */
export type ThreadRepresentation = 'simplified' | 'modeled';

/**
 * ねじ穴(FR-406)。穴と同じく対象のボディを消費して1つの新しいボディを作る。
 * ピッチ・下穴径は規格表(thread/metricThread.ts)から入るが、式で書き換えられる(FR-202)。
 */
export interface ThreadHoleFeature extends SolidFeatureBase {
  readonly kind: 'threadHole';
  readonly targetFeatureId: string;
  readonly face: SubShapeRef;
  readonly centers: readonly SketchPointRef[];
  /** JIS の呼び(例 'M6')。規格表の鍵(FR-406)。 */
  readonly designation: string;
  readonly series: ThreadSeries;
  /** ピッチ(mm)。規格表から入るが、式で書き換えられる(FR-202)。 */
  readonly pitch: ExpressionValue;
  /** 下穴径(mm)。既定はめねじ内径 D1(§0.a-0.14)。式で書き換えられる。 */
  readonly drillDiameter: ExpressionValue;
  readonly depth: HoleDepth;
  /** ねじ部の長さ(mm)。止まり穴では深さ以下にする。 */
  readonly threadLength: ExpressionValue;
  /** 簡略表示(既定)か実らせん形状か(FR-406、§0.a-0.15、§0.a-0.16)。 */
  readonly representation: ThreadRepresentation;
  readonly tiltAngle: ExpressionValue;
  readonly tiltAzimuth: ExpressionValue;
}

/**
 * R 面取り(FR-407)。対象のボディを消費して1つの新しいボディを作る。
 * 頂点を指したときは「その頂点に集まる辺をすべて同じ半径で丸める」(§0.a-0.17)。
 * 展開はカーネルが行う(頂点と辺の接続はカーネルしか知らない)。
 */
export interface FilletFeature extends SolidFeatureBase {
  readonly kind: 'fillet';
  readonly targetFeatureId: string;
  /** 丸める辺・頂点。 */
  readonly targets: readonly SubShapeRef[];
  readonly radius: ExpressionValue;
}

/** C 面取りの大きさの指定(FR-408 の①②③)。 */
export type ChamferSize =
  | { readonly kind: 'equal'; readonly distance: ExpressionValue }
  | {
      readonly kind: 'twoDistances';
      readonly distance1: ExpressionValue;
      readonly distance2: ExpressionValue;
    }
  | {
      readonly kind: 'distanceAngle';
      readonly distance: ExpressionValue;
      /** 基準面からの角度(度)。0 より大きく 90 より小さい。 */
      readonly angle: ExpressionValue;
    };

/** C 面取り(FR-408)。対象のボディを消費して1つの新しいボディを作る。 */
export interface ChamferFeature extends SolidFeatureBase {
  readonly kind: 'chamfer';
  readonly targetFeatureId: string;
  readonly targets: readonly SubShapeRef[];
  readonly size: ChamferSize;
  /**
   * 2距離・距離角度のときの基準面を、辺に接する2面のうち後の方にする(§0.a-0.18)。
   * 既定(false)は並びで先に出る面。思っていたのと逆ならこのつまみ1つで直せる。
   */
  readonly swapReferenceFace: boolean;
}

/** パターンの向き・軸(FR-411、FR-412)。回転軸(RevolveAxis)と同じ形を流用する(§0.a-0.21)。 */
export type PatternDirection =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly line: SketchLineRef };

/** パターンの並べ方(FR-411 直線、FR-412 円形)。 */
export type PatternPlacement =
  | {
      readonly kind: 'linear';
      readonly direction: PatternDirection;
      /** 隣り合う複製の間隔(mm)。 */
      readonly spacing: ExpressionValue;
      /** もとを含めた総数。2 以上 MAX_PATTERN_COUNT 以下。 */
      readonly count: ExpressionValue;
      /**
       * 両側へ並べるか。真なら中央がもとの位置になる。
       * 偶数個のときはもとの穴の位置に工具が来ないので解決のときに断る(§2.7)。
       */
      readonly symmetric: boolean;
    }
  | {
      readonly kind: 'circular';
      readonly axis: PatternDirection;
      /** 並べる範囲(度)。全周なら 360。 */
      readonly angle: ExpressionValue;
      readonly count: ExpressionValue;
      /** 全周へ等間隔で並べるか。真なら angle は使わず 360/count で刻む(NFR-UX-4)。 */
      readonly fullCircle: boolean;
    };

/**
 * パターン(FR-411、FR-412)。もとの加工フィーチャー(穴・ねじ穴に限る、§0.a-0.20)の
 * ボディを消費し、同じ工具を並べて差し引いた新しいボディを1つ作る。
 * フィレット・面取りを対象にしないのは「工具の形」が無く、変換した位置の辺を
 * 指紋で選び直す必要があって危ういため。
 */
export interface PatternFeature extends SolidFeatureBase {
  readonly kind: 'pattern';
  /** 繰り返す加工フィーチャーの id(穴・ねじ穴に限る)。消費する。 */
  readonly sourceFeatureId: string;
  readonly placement: PatternPlacement;
}

/** ばねの巻き方向(FR-414、§0.a-0.33)。利用者の語彙(右巻き/左巻き)に合わせる。 */
export type SpringHandedness = 'right' | 'left';

/** 全長・ピッチ・巻数のうち、他の2つから計算して求めるもの(§0.a-0.30)。 */
export type SpringDerived = 'length' | 'pitch' | 'turns';

/**
 * ばね(コイルばね、FR-414、§2.7b)。
 *
 * 対象ボディを持たず、消費もしない。押し出し・回転・縫合と同じ「新しいボディを1つ作る」
 * フィーチャーである(§0.a-0.36)。したがってパターンの対象にもしない。
 * 全長・ピッチ・巻数の関係式は `全長 = ピッチ × 巻数`(らせん経路の軸方向の長さ。
 * 線径のぶんは含まない)で、`derived` が指す欄は保存値を使わず他の2つから計算し直す。
 * 座巻き(端の1巻きを平らにする処理)は P3 では作らない(§0.a-0.32)。
 */
export interface SpringFeature extends SolidFeatureBase {
  readonly kind: 'spring';
  /** らせんの軸の始点。スケッチの点フィーチャーへの参照(§0.a-0.29)。 */
  readonly origin: SketchPointRef;
  /** らせんの軸の向き。回転軸(RevolveAxis)を流用する(§0.a-0.29)。 */
  readonly axis: RevolveAxis;
  /** 軸からの傾き(度)。0 なら軸そのまま(穴と同じ作り、§0.a-0.10)。 */
  readonly tiltAngle: ExpressionValue;
  /** 傾ける向き(軸に直交する面内の方位角、度)。 */
  readonly tiltAzimuth: ExpressionValue;
  /** らせん経路の軸方向の長さ(mm)。線径のぶんは含まない(§0.a-0.30)。 */
  readonly length: ExpressionValue;
  /** 1巻きあたりの軸方向の進み(mm)。 */
  readonly pitch: ExpressionValue;
  /** 巻数。整数でなくてよい(3.5 巻きも作れる)。 */
  readonly turns: ExpressionValue;
  /** 上の3つのうち、保存値を使わず他の2つから計算し直すもの(§0.a-0.30)。 */
  readonly derived: SpringDerived;
  /** コイルの中心径(mm)。線材の中心が通る円の直径。 */
  readonly coilDiameter: ExpressionValue;
  /** 線径(mm)。断面の円の直径。断面は円だけ(§0.a-0.31)。 */
  readonly wireDiameter: ExpressionValue;
  readonly handedness: SpringHandedness;
}

export type SolidFeature =
  | ExtrudeFeature
  | RevolveFeature
  | SewFeature
  | BooleanFeature
  | HoleFeature
  | ThreadHoleFeature
  | FilletFeature
  | ChamferFeature
  | PatternFeature
  | SpringFeature;

/**
 * 部品(パート)文書。Undo のスナップショットの単位で、.pcad に保存される唯一のもの
 * (FR-505、FR-801)。変更のたびに新しい配列を作る(不変)。
 */
export interface PartDocument {
  readonly id: string;
  readonly name: string;
  /** 保存形式の版(§0.a-0.3)。読み書きの互換判定は packages/io が行う。 */
  readonly schemaVersion: number;
  /** スケッチ群。P2 の UI は1本だけ作るが、形は最初から複数を許す。 */
  readonly sketches: readonly SketchDocument[];
  /** いま編集しているスケッチの id。sketches のいずれかを指す(§0.a-0.4)。 */
  readonly activeSketchId: string;
  /** ソリッドフィーチャーの履歴。順序が意味を持つ(要件§2「履歴パラメトリック」)。 */
  readonly solids: readonly SolidFeature[];
}
