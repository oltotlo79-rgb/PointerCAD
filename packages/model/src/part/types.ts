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
// 球へつなぐときの点の数(24 / 48 / 72)は kernel の `SphereSegmentCount` が正本
// (§0.a-0.74、統括の指示 2026-09-05)。型だけの取り込みなので実行時の読み込みは起きない。
import type { SphereSegmentCount } from '@pointercad/kernel';

import type { AppearanceTable } from '../appearance/types.js';
import type { AxisSpec, PlaneSpec } from '../geometry/planeSpec.js';
import type {
  EdgeCurveKind,
  FaceSurfaceKind,
  SubShapeFingerprint,
  SubShapeKind,
  SubShapeRef,
} from '../geometry/subShapeRef.js';
import type { Parameter } from '../parameters/types.js';
import type { CoordinateInput, PointReference, SketchDocument } from '../sketch/types.js';
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
  | 'spring'
  /**
   * 基本形状(球・箱・円柱・円錐・トーラス。FR-429、P5 計画書 §2.7)。
   * ばねと同じく対象を取らず、新しいボディを1つ作る(P5 §0.a-0.19)。
   */
  | 'primitive'
  /**
   * 面をつなぐ(罫線面。FR-430、P5 計画書 §2.9)。2 つの断面を直線で結ぶ。
   * 材料にした立体を**消費しない**(P5 §0.a-0.27)。
   */
  | 'ruled'
  /**
   * ロフト(FR-410、P5 計画書 §2.9)。2 つ以上の断面をなめらかに結ぶ。
   * 罫線面と道具が別なので種類も分ける(P5 §0.a-0.25)が、カーネルの段は同じ 1 種類。
   */
  | 'loft';

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

/**
 * 回転軸の指定(FR-402、§0.a-0.9)。既定は world の z 軸。
 *
 * P4(FR-329、タスク9)で基準軸フィーチャーへの参照 `reference` を足した。基準軸は
 * 「2 点 / 辺 / 面の法線 / 2 面の交線」で作れるので、これで**立体の辺や面の法線を
 * 回転軸に使える**ようになる。型は `geometry/planeSpec.ts` の `AxisSpec` と同じで、
 * 任意の作業平面(FR-328)の「点+軸と角度」もこの値をそのまま受け取る。
 */
export type RevolveAxis = AxisSpec;

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

/**
 * パターンの向き・軸(FR-411、FR-412)。回転軸(RevolveAxis)と同じ形を流用する(§0.a-0.21)。
 * P4(FR-329)で基準軸への参照が使えるようになった(`AxisSpec`)。
 */
export type PatternDirection = AxisSpec;

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

/**
 * 基本形状の基準点の指定(FR-429、P5 計画書 §0.a-0.18)。3通り。
 *
 * 要件 FR-429 が「スケッチの点フィーチャー・立体の頂点(部分形状の参照)・座標の式の
 * いずれか」と3通りを明記しているので、入れ物を1つだけ作って既存の3つの型を束ねる
 * (ばねの始点はスケッチの点1通りだけ、P3 §0.a-0.29。基本形状は要件が広いので広げる)。
 *
 * **`vertex` は「消費しない参照」である。** 頂点を貸した立体はそのまま画面に残るので、
 * `consumedTargetsOf` は `vertex` を指していても空を返す(P5 §0.a-0.19)。
 * 頂点の指紋は通し番号が変わると採点が最高 0.5 でしきい値 0.6 に届かないため、上流を
 * 大きく作り替えると「見つからない」になりやすい(断りは解決とカーネルが出す、FR-504)。
 */
export type SolidOrigin =
  | { readonly kind: 'coordinate'; readonly value: CoordinateInput }
  | { readonly kind: 'sketchPoint'; readonly ref: SketchPointRef }
  | { readonly kind: 'vertex'; readonly ref: SubShapeRef };

/**
 * 基本形状の5種(FR-429)。既定名と id の連番もこの語で分ける
 * (`createPartDocument.ts` の `SolidLabelKey`)。
 */
export type PrimitiveShapeKind = 'sphere' | 'box' | 'cylinder' | 'cone' | 'torus';

/**
 * 基本形状の寸法(FR-429、P5 計画書 §2.7.1)。すべて式のまま持つ(FR-202)。
 *
 * 欄名は `packages/kernel/src/types.ts` の `PrimitiveShapeSpec` と揃えてあるので、
 * 解決した数値をそのまま詰め替えられる(タスク16)。
 * 円錐だけが半径を2つ持つ。上半径 0 で尖った円錐、0 より大きい値で円錐台になるので、
 * **円錐台を別の種類にしないで済む**(§0.a-0.16)。部分角度(何度ぶん作るか)は
 * 持たない(§0.a-0.20。必要になれば P6 以降で足す)。
 */
export type PrimitiveShape =
  | { readonly kind: 'sphere'; readonly radius: ExpressionValue }
  | {
      readonly kind: 'box';
      readonly sizeX: ExpressionValue;
      readonly sizeY: ExpressionValue;
      readonly sizeZ: ExpressionValue;
    }
  | {
      readonly kind: 'cylinder';
      readonly radius: ExpressionValue;
      readonly height: ExpressionValue;
    }
  | {
      readonly kind: 'cone';
      readonly bottomRadius: ExpressionValue;
      readonly topRadius: ExpressionValue;
      readonly height: ExpressionValue;
    }
  | {
      readonly kind: 'torus';
      readonly majorRadius: ExpressionValue;
      readonly minorRadius: ExpressionValue;
    };

/**
 * 基本形状(球・箱・円柱・円錐・トーラス。FR-429、P5 計画書 §2.7.1)。
 *
 * 押し出し・回転・縫合・ばねと同じ「新しいボディを1つ作る」フィーチャーで、対象を
 * 消費しない(§0.a-0.19)。ブーリアン・パターン・加工の**対象にはなる**。
 *
 * **基準点の意味は形で変わる**(§0.a-0.17): 球・箱・トーラスは中心、円柱・円錐は
 * 底面の中心。円柱の高さを変えたときに底面が動かないほうが、押し出しの「面から距離ぶん
 * 伸びる」と操作の一貫性が取れるためである(NFR-UX-1)。
 */
export interface PrimitiveFeature extends SolidFeatureBase {
  readonly kind: 'primitive';
  readonly origin: SolidOrigin;
  /**
   * 向き(軸)。カーネルでは `gp_Ax2` の Z 方向になる。回転軸(`RevolveAxis`)と同じ
   * `AxisSpec` を流用する(同じものを2つ作らない。§0.a-0.16)。既定は世界の Z 軸。
   */
  readonly axis: AxisSpec;
  readonly shape: PrimitiveShape;
}

/**
 * 罫線面・ロフトの断面 1 つ(FR-430、FR-410、P5 計画書 §2.9.1)。
 *
 * 断面は「スケッチの面」「立体の面」「球」の 3 通り。前の 2 つは閉じた輪郭を持つが、
 * **球だけは縁を持たない**ので輪郭ではなくフィーチャーの id で指し、解決のときに
 * 中心と半径へ直す(球に外接する直線で結ぶ、§2.9.3)。
 *
 * 立体の面(`solidFace`)は座標ではなく**指紋**(`SubShapeRef`)で持つ。輪郭を取り出すのは
 * カーネルで、model は指紋と対象の段の鍵を渡すだけである(穴の面とまったく同じ扱い、§2.2)。
 * **どの種類でも元の立体は消費しない**(§0.a-0.27)。
 */
export type RuledSection =
  /** スケッチの面フィーチャー1枚。その境界が輪郭になる。 */
  | { readonly kind: 'sketchFace'; readonly ref: SketchFaceRef }
  /** 立体の面1枚。カーネルが指紋で選び直し、外周を輪郭に取り出す。 */
  | { readonly kind: 'solidFace'; readonly ref: SubShapeRef }
  /**
   * 球1つ。**`kind: 'primitive'` の球**(FR-429)のフィーチャー id を指す。
   * ばね等の丸い形ではなく、球の基本形状だけを指せる(中心と半径が一意に決まるため)。
   */
  | { readonly kind: 'sphere'; readonly sphereFeatureId: string };

/**
 * 球へつなぐときの近似の点の数(§0.a-0.74、利用者の決定 2026-09-05)。
 *
 * 球は縁を持たないので、相手の輪郭を N 点に離散化して接点の列を作る(§2.9.3-(b))。
 * 点が多いほど滑らかになるが重くなる(タスク24 の実測: 72 点で 5〜6 秒)ので、
 * 段ごとに 24 / 48 / 72 から選べるようにし、既定は 24 にする。
 *
 * **3 択の実体はカーネルの `SphereSegmentCount` をそのまま使う**(統括の指示 2026-09-05)。
 * 同じ選択肢を 2 か所に書くと、片方だけ増やしたときに黙って食い違うためである。
 * ここで名前を付け直しているのは、model・io・ui が「罫線面の欄」として読む名前を
 * カーネルの語彙から独立させておくため(呼び名だけの別名で、値は 1 か所)。
 */
export type RuledSphereSegments = SphereSegmentCount;

/**
 * 面をつなぐ(罫線面。FR-430、P5 計画書 §2.9.1)。2 つの断面を直線で結ぶ。
 *
 * **対象を消費しない「作る」フィーチャー**(押し出し・ばね・基本形状と同じ、§0.a-0.27)。
 * 輪郭を貸した立体・球はそのまま画面に残るので、要るなら和(FR-404)でまとめられる。
 *
 * 球を置けるのは `first` / `second` の**片方だけ**(球どうしは直線で結べない、§2.9.3)。
 * ロフト(`LoftFeature`)には球を置けない。
 */
export interface RuledFeature extends SolidFeatureBase {
  readonly kind: 'ruled';
  readonly first: RuledSection;
  readonly second: RuledSection;
  /**
   * 輪郭のねじれを直すための、2 つ目の輪郭の稜線のずらし数(§0.a-0.28)。整数の式。既定 0。
   *
   * **立体の面(`solidFace`)の断面には効かない。** カーネルは面から取り出した外周を
   * 元の並びのまま結び、ずらしを断りもしない(タスク24b の実装)。プロパティ(タスク27)は
   * この欄を出すときに、断面が立体の面だけのときは効かないことを添える。
   */
  readonly twist: ExpressionValue;
  /** 球へつなぐときの近似の点の数(§0.a-0.74)。球を使わない罫線面では形に効かない。 */
  readonly sphereSegments: RuledSphereSegments;
}

/**
 * ロフト(FR-410、P5 計画書 §2.9.1)。2 つ以上の断面をなめらかに結ぶ。
 *
 * 罫線面と同じくカーネルの段は `thruSections` 1 種類で、`ruled: false` になるだけの違い
 * (§0.a-0.25)。**球は置けない**ので `sphereSegments` の欄も持たない。
 */
export interface LoftFeature extends SolidFeatureBase {
  readonly kind: 'loft';
  /** つなぐ断面。並びが意味を持つ。2 つ以上ないと解決のときに断る。 */
  readonly sections: readonly RuledSection[];
  /** ねじれの補正(罫線面と同じ意味、§0.a-0.28)。整数の式。既定 0。 */
  readonly twist: ExpressionValue;
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
  | SpringFeature
  | PrimitiveFeature
  | RuledFeature
  | LoftFeature;

// ---------------------------------------------------------------------------
// 基準ジオメトリ(任意の作業平面 FR-328、基準軸・基準点・座標系 FR-329。P4 タスク9)
// ---------------------------------------------------------------------------

/**
 * 基準ジオメトリの種類(FR-328、FR-329)。**実体(ボディ)を作らない**ので
 * `SolidFeature` とは別の履歴に並べる(`PartDocument.references`)。
 */
export type ReferenceFeatureKind =
  | 'referencePlane'
  | 'referenceAxis'
  | 'referencePoint'
  | 'referenceCoordinateSystem';

/**
 * 基準ジオメトリに共通の欄。
 *
 * スケッチの中ではなく**部品文書**に置く理由: 平面・軸・点の指定は立体の面・辺・頂点
 * (`SubShapeRef`)を指せる必要があり(FR-328「既存の面から指定距離だけ離した平面」)、
 * スケッチ 1 本は立体を知らないため、スケッチの履歴には置けない。部品文書に置けば、
 * スケッチと立体の両方を見てから解決できる(解決の順序は `resolveReferences.ts`)。
 */
interface ReferenceFeatureBase {
  /** フィーチャーの id。作業平面はこの id がそのまま作図面の id になる(FR-328)。 */
  readonly id: string;
  /** フィーチャーツリーの表示名(FR-501)。 */
  readonly name: string;
  /** 画面に出すか(FR-329「表示/非表示を切り替えられる」)。false でも参照はできる。 */
  readonly visible: boolean;
}

/**
 * 任意の作業平面(FR-328)。決め方は `PlaneSpec`(7 種)で、P5 の切断(FR-432)と
 * 同じ型を共有する(P5 §0.a-0.56)。
 */
export interface ReferencePlaneFeature extends ReferenceFeatureBase {
  readonly kind: 'referencePlane';
  readonly plane: PlaneSpec;
}

/** 基準軸の決め方(FR-329)。 */
export type ReferenceAxisDefinition =
  /** 2 点を通る直線。向きは 1 点目 → 2 点目。 */
  | { readonly kind: 'twoPoints'; readonly from: PointReference; readonly to: PointReference }
  /** 立体のまっすぐな辺。向きは辺の向き。 */
  | { readonly kind: 'edge'; readonly edge: SubShapeRef }
  /** 立体の平らな面の法線。原点は面の重心。 */
  | { readonly kind: 'faceNormal'; readonly face: SubShapeRef }
  /** 2 つの平らな面の交線。平行な 2 面は交わらないので断る。 */
  | {
      readonly kind: 'faceIntersection';
      readonly face1: SubShapeRef;
      readonly face2: SubShapeRef;
    };

/** 基準軸(FR-329)。回転・パターン・平面の「点+軸と角度」から参照できる。 */
export interface ReferenceAxisFeature extends ReferenceFeatureBase {
  readonly kind: 'referenceAxis';
  readonly definition: ReferenceAxisDefinition;
}

/** 基準点の決め方(FR-329)。 */
export type ReferencePointDefinition =
  /** 座標の式(FR-202)。極座標の基準になる平面は XY(部品文書には作図面が無いため)。 */
  | { readonly kind: 'coordinate'; readonly at: CoordinateInput }
  /** 立体の頂点。 */
  | { readonly kind: 'vertex'; readonly vertex: SubShapeRef }
  /** 立体の辺の中点。 */
  | { readonly kind: 'edgeMidpoint'; readonly edge: SubShapeRef }
  /** 立体の面の中心(重心)。 */
  | { readonly kind: 'faceCenter'; readonly face: SubShapeRef };

/** 基準点(FR-329)。平面の 3 点指定・軸の 2 点指定などから参照できる。 */
export interface ReferencePointFeature extends ReferenceFeatureBase {
  readonly kind: 'referencePoint';
  readonly definition: ReferencePointDefinition;
}

/**
 * 基準座標系(FR-329「原点と 3 軸の向きを決めたローカル座標系」)。
 *
 * 保存するのは**原点と 2 軸**で、第 3 軸(Z)は X × Y から導く(導出できるものは
 * 保存しない、rules/04)。Y は X と直交していなくてよく、解決のときに直交化する
 * (X を保ち、Y は Z × X で作り直す)。
 */
export interface ReferenceCoordinateSystemFeature extends ReferenceFeatureBase {
  readonly kind: 'referenceCoordinateSystem';
  readonly origin: PointReference;
  /** 第 1 軸(X)の向き。 */
  readonly xAxis: AxisSpec;
  /** 第 2 軸(Y)の向きの手掛かり。X と直交化してから使う。 */
  readonly yAxis: AxisSpec;
}

export type ReferenceFeature =
  | ReferencePlaneFeature
  | ReferenceAxisFeature
  | ReferencePointFeature
  | ReferenceCoordinateSystemFeature;

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
  /**
   * 基準ジオメトリの履歴(FR-328、FR-329)。順序が意味を持ち、**自分より前のものだけ**を
   * 参照できる(`resolveReferences.ts`)。実体を作らないので `solids` とは分けて持つ。
   */
  readonly references: readonly ReferenceFeature[];
  /** ソリッドフィーチャーの履歴。順序が意味を持つ(要件§2「履歴パラメトリック」)。 */
  readonly solids: readonly SolidFeature[];
  /**
   * 名前を付けた数値の表(FR-207、P4b §0.a-0.17)。部品に 1 つだけ持ち、スケッチごとには
   * 持たない(「どの数値欄からも名前で参照でき」が部品全体を対象にしているため)。
   * 並び順は利用者が並べ替えた順で、そのまま保存する(評価の順序とは別物。§2.6)。
   *
   * 旧い版のファイルにはこの欄が無いので、**読み手は無ければ空の配列として読む**
   * (`packages/io`、タスク21。必須にすると版 4 以前が開けなくなる)。
   */
  readonly parameters: readonly Parameter[];
  /**
   * 外観の割り当て(色・材質・柄。FR-1106〜1110、要件§4.12、P5 §0.a-0.1)。
   *
   * **履歴ではないので `solids` には入れず、文書の別の欄として持つ。** 外観を変えても
   * 形は変わらず、再計算も段の鍵の作り直しも起こさない(`part/documentChange.ts` の
   * `affectsShape` と `part/cacheKey.ts` の両方が外観を見ない)。立体はフィーチャー id、
   * 面は部分形状の指紋(`SubShapeRef`)で指す。
   *
   * **版 6(P5 タスク5)で `packages/io` が読み書き・移行(`SCHEMA_MIGRATIONS[5]`)を
   * 実装したので必須の欄にした**(`parameters` が版 5 で必須になったのと同じ道筋)。
   * 版 5 以前のファイルは移行が空の表で補う。読み出しは `appearance/documentAppearance.ts`
   * の `appearanceOf` を通しておけば、この欄が将来また整理されても呼び出し側は変わらない。
   */
  readonly appearance: AppearanceTable;
}
