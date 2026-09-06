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

import type { AppearanceTable, AppearanceTarget } from '../appearance/types.js';
import type { AxisSpec, PlaneSpec } from '../geometry/planeSpec.js';
import type {
  EdgeCurveKind,
  FaceSurfaceKind,
  SubShapeFingerprint,
  SubShapeKind,
  SubShapeRef,
} from '../geometry/subShapeRef.js';
import type { Parameter } from '../parameters/types.js';
// ミラーの基準にする平面の id(基準の 3 面 `xy` / `xz` / `yz` と、任意の作業平面
// (FR-328)のフィーチャー id の両方が入る文字列。P5 §0.a-0.36)。
import type { WorkPlaneId } from '../sketch/planeMath.js';
import type { CoordinateInput, PointReference, SketchDocument } from '../sketch/types.js';
import type { ThreadSeries } from '../thread/metricThread.js';
// 読み込んだ形の素性(`ImportedSource.unit`、FR-811)が使う長さの単位。正本は
// `units/length.ts`(P6 タスク1)で、ここは型だけを借りる。
import type { LengthUnit } from '../units/length.js';

/** スケッチの面フィーチャー1枚への参照。断面に使う(§0.a-0.7、§0.a-0.8)。 */
export interface SketchFaceRef {
  readonly sketchId: string;
  readonly faceFeatureId: string;
}

/**
 * スケッチの曲線フィーチャーの並びへの参照(P5 §2.11、タスク43)。
 *
 * スイープの経路・リブの輪郭・曲面の輪郭のように、**閉じているとは限らない線の連なり**を
 * 指すために使う。閉じた輪郭 1 枚を指す `SketchFaceRef`(面フィーチャー)とは別物で、
 * 面を作れない開いた線からでも形が作れる種類がこちらを持つ。
 *
 * 並びが意味を持つ(経路は書かれた順につながっている前提)。実際につながっているか、
 * 1 つの平面に乗っているかは解決(タスク46)とカーネルが確かめて理由つきで断る(FR-504)。
 */
export interface SketchCurveRef {
  readonly sketchId: string;
  /** 曲線フィーチャー(線分・円弧・スプライン等)の id。1 つ以上。並びが意味を持つ。 */
  readonly curveIds: readonly string[];
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
  | 'loft'
  /*
    ここから下は P5 の Should 群(P5 計画書 §2.11、タスク43)。
    9 種を一度に足す。消費するかどうかは種類ごとに違うので
    `createPartDocument.ts` の `consumedTargetsOf` の表を必ず見ること。
  */
  /** 抜き勾配(FR-417)。中立面を基準に選んだ面を傾ける。対象を消費する。 */
  | 'draft'
  /** ミラー(FR-419)。鏡像を 1 つ作る。**対象を消費しない**(§0.a-0.36)。 */
  | 'mirror'
  /** 移動/回転(FR-424)。剛体変換した立体を作る。対象を消費する(§0.a-0.41)。 */
  | 'transform'
  /** 拡大縮小(FR-424)。倍率を掛けた立体を作る。対象を消費する(§0.a-0.41)。 */
  | 'scale'
  /** スイープ(FR-409)。断面を経路に沿って掃く。対象を取らない「作る」種類。 */
  | 'sweep'
  /** リブ(FR-420)。開いた輪郭に厚みを付けた壁を足す。対象を消費する。 */
  | 'rib'
  /** エンボス(FR-421)。平らな面へ輪郭を彫る / 浮き出す。対象を消費する。 */
  | 'emboss'
  /** 外ねじ(FR-423)。円柱面にねじを切る。対象を消費する。 */
  | 'threadShaft'
  /** 曲面(FR-428)。閉じた立体ではなく面だけのボディを作る。対象を消費しない。 */
  | 'surface'
  /**
   * くり抜き(シェル。FR-418、§0.a-0.47、P5 計画書 §2.12)。壁の厚さを残して中身を抜く。
   * 対象を消費する。Could 群だが、型・解決・読み書きはタスク46 で前倒しした
   * (カーネルの段(タスク53)と鍵の材料(タスク44)が先にそろっていたため)。
   */
  | 'shell'
  /**
   * 平面による切断(FR-432、P5 計画書 §2.9b、タスク27c)。分割(FR-424)もこれで満たす
   * (§0.a-0.60)。対象を消費して**残す側 1 つ**のボディを作る。「反対側も残す」は
   * コマンドが 2 つ目の切断を積むことで満たす(§0.a-0.58)ので、1 つの切断が
   * 2 つのボディを作る形にはしない。
   */
  | 'cut'
  /**
   * 読み込んだ形(ベースボディ。FR-802、P6 計画書 §2.8、§0.a-0.9)。STEP から入った
   * B-rep をそのまま持つ。履歴を持たず、対象も取らない「作る」フィーチャーで、
   * **その上へ穴・面取り・ブーリアンを積める**(要件 FR-802 の「その上へのフィーチャー
   * 追加は可能」)。
   */
  | 'importedSolid'
  /**
   * 読み込んだ三角形の形(ベースボディ。FR-802、P6 計画書 §2.8、§0.a-0.24)。
   * STL / OBJ / 3MF / glTF から入った三角形をそのまま持つ。
   * **B-rep にしない**(§0.a-0.23)ので幾何カーネルの段にならず、加工もできない。
   */
  | 'importedMesh';

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

/**
 * 押し出しの終端(FR-415、P5 計画書 §2.11、タスク43)。
 *
 * **長さそのものは `ExtrudeFeature.distance` が持ち続ける。** ここは「どこまで押し出すか」の
 * 決め方だけを 4 通りで持つ。距離を種類の中へ写すと、終端の種類を切り替えるたびに利用者が
 * 入れた長さが消えてしまうためである(NFR-UX-1)。
 *
 * - `distance`: 長さを指定して片側へ(P2 からの押し出し)。
 * - `symmetric`: 断面の両側へ(長さの半分ずつ)。
 * - `toFace`: 指定した面まで。距離は解決(タスク45)が面までの距離として計算する。
 * - `toNext`: 断面から先で最初に当たった材料の中まで(タスク33 の実測での意味)。
 *
 * カーネルの `ExtrudeEndSpec`(`occt/makeSolidSweep.ts`)は同じ 4 種を**数値**で持つ。
 * 式から数値への変換は解決の担当なので、ここでは参照と種類だけを保存する(要件§8)。
 */
export type ExtrudeEnd =
  | { readonly kind: 'distance' }
  | { readonly kind: 'symmetric' }
  | { readonly kind: 'toFace'; readonly face: SubShapeRef }
  | { readonly kind: 'toNext' };

/**
 * 薄板押し出し(FR-416、§0.a-0.46)の厚みの向き。
 *
 * カーネルの `ThinExtrudeSide`(`occt/makeThinExtrude.ts`)と同じ 3 値。
 * §0.a-0.46 は「厚みの欄 1 つ」の想定だったが、タスク53 の実測で向きの欄も要ると分かった
 * (`docs/報告記録.md` 2026-09-05 16:13 の申し送り)。
 */
export type ThicknessSide = 'inner' | 'outer' | 'both';

/**
 * 押し出し(FR-401)。
 *
 * P5 タスク43 で終端(FR-415)・テーパ(FR-401)・薄板(FR-416)の欄を足した。
 *
 * **足した 5 欄はすべて省略できる。** 省略したときは P2 からの押し出し(距離ぶんを片側へ、
 * 傾きなし、中実)と 1 ドットも変わらない形になる。カーネルの `ExtrudeShapeOptions`
 * (`occt/makeSolidSweep.ts`、タスク33)が同じ理由で全欄を省略可能にしているのと同じ決めで、
 * 版 6 までの `.pcad` と既存の呼び出し側(その場入力・コマンド・検査の見本)を 1 か所も
 * 書き換えずに済む。**既定値は 1 か所** — `createPartDocument.ts` の `extrudeShapingOf` が
 * 省略を埋めるので、読む側は必ずそれを通す(既定を各所へ写さない)。
 */
export interface ExtrudeFeature extends SolidFeatureBase {
  readonly kind: 'extrude';
  readonly profile: SketchFaceRef;
  /** 押し出す長さ(mm)。正の数。向きは reversed で決める。 */
  readonly distance: ExpressionValue;
  /** 面の法線と逆向きへ出すか。 */
  readonly reversed: boolean;
  /**
   * 両側へ出すか。true なら距離の半分ずつ両方向(平行移動は model 側で計算する)。
   *
   * **P5 タスク43 以降は `end` が正本で、この欄は `end.kind === 'symmetric'` と同じ意味を
   * 持つ P2 からの欄である。** 消さずに残したのは、解決(`resolvePart.ts`)・プロパティ・
   * その場入力がこの欄を読んでおり、それらを書き換えるのはタスク45・49・52 の担当だから。
   * 読み手(`packages/io`)は `end` の欄が無い古い文書ではこの欄から `end` を作る。
   */
  readonly symmetric: boolean;
  /**
   * どこまで押し出すか(FR-415)。省略すると `symmetric` から決まる
   * (`symmetric` が真なら両側、偽なら距離。`extrudeShapingOf` が埋める)。
   */
  readonly end?: ExtrudeEnd;
  /**
   * 側面の傾き(度)。**大きさだけ**を持ち、0 以上 MAX_TAPER_ANGLE_DEGREES 以下。既定 0。
   * 向きは `taperOutward` が持つ(抜き勾配の `angle` + `reversed` と同じ持ち方。タスク33)。
   */
  readonly taperAngle?: ExpressionValue;
  /** true で押し出すほど外へ広がり、false(既定)で内へ絞る(FR-401)。 */
  readonly taperOutward?: boolean;
  /**
   * 薄板にするときの壁の厚み(mm)。**null(と省略)なら中身の詰まった押し出し**
   * (既定、FR-416)。数を入れると輪郭をオフセットした輪郭との差を押し出す(§0.a-0.46)。
   */
  readonly thickness?: ExpressionValue | null;
  /** 厚みをどちら側へ付けるか(FR-416)。既定 inner。`thickness` が null のときは使わない。 */
  readonly thicknessSide?: ThicknessSide;
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

/**
 * 穴の入口の形(ざぐり・皿もみ。FR-422、P5 §0.a-0.39、タスク43)。
 *
 * 穴の種類を増やすのではなく**同じ穴の入口だけを広げる**指定にしてある(§0.a-0.39 の承認)。
 * 既定は `plain`(広げない)で、この欄が無い古い文書も `plain` として読む。
 *
 * **角度はここでは度で持つ。** カーネルの `HoleEntrySpec`(`occt/makeHole.ts`)はラジアンで
 * 受け取るので、換算は解決(タスク46)が行う(§0.a-0.9「角度はラジアンへ」と同じ約束)。
 * 皿もみの円錐の深さは `(頭径 − 穴の径) / 2 / tan(角度 / 2)` でカーネルが決めるので、
 * model は欄として持たない(導出できるものは保存しない、rules/04)。
 */
export type HoleEntry =
  /** 広げない(既定)。 */
  | { readonly kind: 'plain' }
  /** ざぐり。径 `diameter`・深さ `depth` の円柱で入口を広げる。 */
  | {
      readonly kind: 'counterbore';
      readonly diameter: ExpressionValue;
      readonly depth: ExpressionValue;
    }
  /** 皿もみ。頭径 `diameter`・開き角 `angle`(度、既定 90)の円錐で入口を広げる。 */
  | {
      readonly kind: 'countersink';
      readonly diameter: ExpressionValue;
      readonly angle: ExpressionValue;
    };

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
  /**
   * 入口の形(ざぐり・皿もみ。FR-422、タスク43)。**省略は `plain`**(広げない)。
   * 押し出しの終端と同じ理由で省略可能にしてある(`holeEntryOf` が埋める)。
   */
  readonly entry?: HoleEntry;
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
  /** 入口の形(ざぐり・皿もみ。FR-422、タスク43)。省略は `plain`。穴とまったく同じ扱い。 */
  readonly entry?: HoleEntry;
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
  /**
   * 丸める半径(mm)。**可変半径(FR-426)のときは辺の始点側の半径**になる。
   *
   * P5 タスク46 で可変半径を足したが、**欄の形は P3 のまま**にしてある。終点側の半径を
   * 省略できる欄 `radiusEnd` として足すほうが、①版 4 以前 / 版 5 前半の `.pcad` を
   * 読み手の分岐なしでそのまま読める、②省略した文書と一定半径を明示した文書が 1 ドットも
   * 違わない段・鍵になる、③既存の呼び出し側(その場入力・プロパティ・コマンド・検査の見本)を
   * 1 か所も書き換えずに済む、の 3 つが同時に成り立つためである(押し出しの `end` と
   * 穴の `entry` をタスク43 が省略できる欄にしたのとまったく同じ決め)。
   */
  readonly radius: ExpressionValue;
  /**
   * 可変半径(FR-426、§0.a-0.48)の**終点側の半径**(mm)。
   *
   * **null(と省略)なら一定半径**(既定、P3 からのふるまい)。数を入れると、辺の始点側で
   * `radius`、終点側で `radiusEnd` になるように半径が変わる(カーネルの
   * `FilletRadiusSpec = number | { start; end }` の `start` / `end` に 1 対 1 で対応)。
   * **読む側は必ず `filletRadiusOf` を通す**(既定を各所へ写さない。`holeEntryOf` と同じ約束)。
   */
  readonly radiusEnd?: ExpressionValue | null;
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
    }
  /**
   * 点の集まりへ複製(FR-425、P5 §0.a-0.42、タスク43)。
   *
   * もとの工具を、並べた点それぞれの位置へ平行移動して差し引く。個数は点の数そのもので、
   * 間隔・角度・総数の欄を持たない(位置は点が決める)。**もとの位置には工具を置かない**
   * かどうかは解決(タスク46)が決める(直線・円形が「もとを含めた総数」なのと違い、
   * 点集合は「並べたい場所を全部書く」ものなので、点の一覧がそのまま置き場所になる)。
   */
  | { readonly kind: 'points'; readonly points: readonly PointReference[] };

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

// ---------------------------------------------------------------------------
// P5 の Should 群(FR-401、FR-409、FR-415、FR-417、FR-419〜425、FR-427、FR-428。
// P5 計画書 §2.11、タスク43)。
//
// **型だけを足す段で、解決(座標・向き・段の依頼の組み立て)はタスク45・46 の担当。**
// 欄の名前と意味は、カーネルの段の型(`packages/kernel/src/types.ts` の `DraftStepSpec`
// ほか)と揃えてある。ただし**保存するのは式と参照だけ**で、数値・ラジアン・世界座標へ
// 直すのは解決の仕事である(要件§8、rules/04「導出できるものは保存しない」)。
// ---------------------------------------------------------------------------

/**
 * 抜き勾配(FR-417、P5 §2.11)。中立面を基準に、選んだ面を型が抜ける向きへ傾ける。
 *
 * **対象を消費する**(傾けた立体 1 つだけが残る)。抜く向きは中立面の法線が決めるので
 * 軸の欄を持たず、思っていたのと逆なら `reversed` 1 つで直せる(§2.15 の段の表の
 * つまみ「向きを反転」。タスク34 の実測で `Add` の `Flag` は向きを変えなかったため、
 * カーネルも `reversed` で抜き方向そのものを反転する)。
 */
export interface DraftFeature extends SolidFeatureBase {
  readonly kind: 'draft';
  /** 傾ける立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 傾ける面。1 枚以上。円柱の側面のような曲面でもよい(円錐台になる)。 */
  readonly faces: readonly SubShapeRef[];
  /** 基準にする面(中立面)。この面は動かない。**平らな面だけ**(タスク34)。 */
  readonly neutralFace: SubShapeRef;
  /** 傾きの大きさ(度)。0 より大きく MAX_DRAFT_ANGLE_DEGREES 以下(§0.a-0.72)。 */
  readonly angle: ExpressionValue;
  /** 抜き方向を反転する(内側へ狭める)。既定 false。 */
  readonly reversed: boolean;
}

/**
 * ミラーの鏡にする平面(FR-419、§0.a-0.36)。
 *
 * **基準の 3 面(XY / XZ / YZ)と任意の作業平面(FR-328)は同じ `workPlane` で持つ。**
 * `WorkPlaneId` が両方を表す文字列だからで、種類を分けると同じものを 2 通りに書けてしまう。
 * 立体の平らな面を鏡にするときだけ `face`(指紋)になる。
 *
 * 平面の決め方 7 種の `PlaneSpec`(FR-328、切断 FR-432 と共有)はここでは使わない。
 * ミラーの基準として §0.a-0.36 が認めたのは「基準平面・作業平面・立体の平らな面」の
 * 3 つだけで、`PlaneSpec` の 3 点指定などを鏡にする道具は用意しないためである。
 */
export type MirrorPlane =
  | { readonly kind: 'workPlane'; readonly planeId: WorkPlaneId }
  | { readonly kind: 'face'; readonly face: SubShapeRef };

/**
 * ミラー(FR-419、§0.a-0.36)。平面に対する鏡像のボディを 1 つ作る。
 *
 * **対象を消費しない。** 鏡像を作ったあと元と鏡像を「和」(FR-404)でつなぐのが普通の
 * 使い方で、元を消してしまうと和が取れない(基本形状・罫線面と同じ「作る」フィーチャー)。
 * したがって `liveBodyIds` には元と鏡像の両方が残る。
 */
export interface MirrorFeature extends SolidFeatureBase {
  readonly kind: 'mirror';
  /** 鏡に映す立体を作ったフィーチャーの id。**消費しない。** */
  readonly targetFeatureId: string;
  readonly plane: MirrorPlane;
}

/**
 * 移動/回転(FR-424、§0.a-0.41)。対象を剛体変換したボディを 1 つ作る。
 *
 * **対象を消費する**(元の位置に残すと同じ形が二重になる)。回転と平行移動を 1 つの
 * フィーチャーにまとめてあるのは、カーネルの `RigidTransformSpec`(P3 の
 * `transformShape.ts`)がそのまま両方を受け取るためである(§0.a-0.41)。
 */
export interface TransformFeature extends SolidFeatureBase {
  readonly kind: 'transform';
  /** 動かす立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 平行移動の量(mm)。X / Y / Z の順で式 3 つ。 */
  readonly translation: readonly [ExpressionValue, ExpressionValue, ExpressionValue];
  /** 回転軸。null なら回さない(平行移動だけ)。 */
  readonly rotationAxis: AxisSpec | null;
  /** 回転角(度)。`rotationAxis` が null のときは使わない。 */
  readonly rotationAngle: ExpressionValue;
}

/**
 * 拡大縮小の倍率(FR-424、§0.a-0.41)。全体か軸ごとかの 2 通り。
 *
 * どちらも MIN_SCALE 以上 MAX_SCALE 以下(範囲の検査は解決、タスク45)。
 * **軸ごとに倍率が違うと円柱面が楕円柱面に変わり、下流の指紋が外れうる**
 * (タスク35 の実測)。断りではなく警告の対象で、判断は解決とカーネルに任せる。
 */
export type ScaleFactor =
  | { readonly kind: 'uniform'; readonly value: ExpressionValue }
  | {
      readonly kind: 'perAxis';
      readonly x: ExpressionValue;
      readonly y: ExpressionValue;
      readonly z: ExpressionValue;
    };

/** 拡大縮小(FR-424、§0.a-0.41)。**対象を消費する。** */
export interface ScaleFeature extends SolidFeatureBase {
  readonly kind: 'scale';
  /** 拡大縮小する立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 拡大縮小の中心。この点は動かない。 */
  readonly origin: PointReference;
  readonly factor: ScaleFactor;
}

/**
 * スイープ(FR-409、§0.a-0.43、§0.a-0.76)。断面を経路に沿って掃く。
 *
 * **対象を取らない「作る」フィーチャー**(押し出し・回転・縫合・ばね・基本形状と同じ)。
 * 断面の重心は経路の始点へ移され、断面の法線は経路の接線へ最小回転で合わせられる
 * (タスク37)。経路はスケッチの曲線の連なりで、閉じていてもよい。
 */
export interface SweepFeature extends SolidFeatureBase {
  readonly kind: 'sweep';
  /** 掃く断面(閉じた輪郭 1 枚)。 */
  readonly profile: SketchFaceRef;
  /** 経路。並んだ順につながっていること。 */
  readonly path: SketchCurveRef;
  /**
   * 向きの決め方。true で Frenet(曲線の曲がりに合わせて断面も回る)、
   * false(既定)で「ねじれを抑える」(§2.15 の段の表のつまみ)。
   */
  readonly frenet: boolean;
}

/** リブの厚みを輪郭のどちら側へ付けるか(FR-420、§2.15)。 */
export type RibSide =
  /** 輪郭を壁の中心にして両側へ半分ずつ(既定)。 */
  | 'both'
  /** 輪郭の平面の法線の側だけへ。 */
  | 'positive'
  /** 法線と逆の側だけへ。 */
  | 'negative';

/**
 * リブ(FR-420、§0.a-0.37、§0.a-0.75)。開いた輪郭に厚みを付けた壁を立体へ足す。
 *
 * **対象を消費する**(リブが付いた立体 1 つだけが残る)。輪郭は**開いた線**でよく、
 * 面を作れないので `SketchCurveRef` で持つ。
 */
export interface RibFeature extends SolidFeatureBase {
  readonly kind: 'rib';
  /** リブを足す立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 壁にする輪郭(閉じていなくてよい)。 */
  readonly profile: SketchCurveRef;
  /** 壁の厚み(mm)。0 より大きい。 */
  readonly thickness: ExpressionValue;
  /** 厚みを輪郭のどちら側へ付けるか。既定 both。 */
  readonly side: RibSide;
  /**
   * 材料に届くまで壁を伸ばすか(既定 true)。false なら輪郭の長さぶんだけの壁を立てる。
   * 伸ばす向きは輪郭の平面と対象の位置から解決(タスク46)が決める。
   */
  readonly extendToBody: boolean;
}

/**
 * エンボス(FR-421、§0.a-0.38)。平らな面へ輪郭を彫る / 浮き出す。
 *
 * **対象を消費する。** 面は平らな面だけ(曲面へのラップは P6 以降。タスク39)。
 */
export interface EmbossFeature extends SolidFeatureBase {
  readonly kind: 'emboss';
  /** 彫る(浮き出す)立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 相手の面。**平らな面だけ。** */
  readonly face: SubShapeRef;
  /** 面の上に置く閉じた輪郭(スケッチの面フィーチャー1 枚)。 */
  readonly profile: SketchFaceRef;
  /** 面から測った高さ(mm)。0 より大きい。彫るときはそのぶんの深さになる。 */
  readonly height: ExpressionValue;
  /** true なら浮き出す(和)、false(既定)なら彫る(差)。 */
  readonly raised: boolean;
}

/**
 * 外ねじ(FR-423、§0.a-0.40)。円柱面にねじを切る。
 *
 * **対象を消費する。** 選ぶのは**円柱面 1 つ**で、ねじ穴(`ThreadHoleFeature`)のように
 * 平らな面と中心点を選ぶのではない。だから別の種類にしてある(タスク40)。
 * **軸の径は面から測るので利用者に入れさせない**(NFR-UX-4)。`nominal` は呼び(M6 など)で、
 * 呼び径と軸の実寸が食い違う指定(φ20 の軸に M10 など)は解決(タスク46)が断る。
 *
 * 既定は簡略表示(`modeled: false`)。実らせんは 1 本で数秒かかる(2026-09-05 実測、
 * 負荷下で中央値 4184ms)ので、選んだときだけ切る(§0.a-0.15、ねじ穴と同じ決め)。
 */
export interface ThreadShaftFeature extends SolidFeatureBase {
  readonly kind: 'threadShaft';
  /** ねじを切る立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** ねじを切る円柱面。平面など円柱でない面は解決とカーネルが断る。 */
  readonly face: SubShapeRef;
  /** JIS の呼び(例 'M6')。`ThreadHoleFeature.designation` と同じ規格表の鍵(FR-406)。 */
  readonly nominal: string;
  readonly series: ThreadSeries;
  /** ピッチ(mm)。規格表から入るが、式で書き換えられる(FR-202)。 */
  readonly pitch: ExpressionValue;
  /** ねじ部の長さ(mm)。 */
  readonly length: ExpressionValue;
  /** 軸のどちらの端から切り始めるか。`first` は円柱面の軸のパラメータが小さいほうの端。 */
  readonly fromEnd: 'first' | 'last';
  /** 実らせんを切るなら true。false(既定)は簡略表示で、形そのものは変わらない。 */
  readonly modeled: boolean;
}

/**
 * 曲面の作り方(FR-428、§0.a-0.45)。
 *
 * **5 種の実名と欄はカーネルの `SurfaceInput`(`occt/makeSurface.ts`)に揃えてある。**
 * 同じ操作を model と kernel で別の名前で呼ぶと、解決(タスク46)が詰め替えのたびに
 * 対応表を持つことになるためである(基本形状の `PrimitiveShape` と同じ流儀)。
 *
 * 輪郭は**開いていてよい**(線分 1 本からでも面になる)ので `SketchCurveRef` で持つ。
 * `face` だけが既にある立体の面を材料にするが、**面を読むだけなので対象は消費しない**
 * (罫線面の `solidFace`・基本形状の頂点とまったく同じ扱い。§0.a-0.27)。
 */
export type SurfaceOperation =
  /** 輪郭を面の法線の向きへ掃いた面。 */
  | {
      readonly kind: 'extrude';
      readonly profile: SketchCurveRef;
      readonly distance: ExpressionValue;
      /** 輪郭の平面の法線と逆向きへ掃くか(押し出しの `reversed` と同じ意味)。 */
      readonly reversed: boolean;
    }
  /** 輪郭を軸まわりに回した面。半円弧を全周回せば球面になる。 */
  | {
      readonly kind: 'revolve';
      readonly profile: SketchCurveRef;
      readonly axis: AxisSpec;
      /** 回転角(度)。0 より大きく 360 以下。 */
      readonly angle: ExpressionValue;
      readonly reversed: boolean;
    }
  /** 閉じた輪郭から張った平らな面 1 枚。 */
  | { readonly kind: 'planar'; readonly profile: SketchCurveRef }
  /** 輪郭どうしをつないだ面(ロフトの面版)。2 つ以上。 */
  | {
      readonly kind: 'loft';
      readonly sections: readonly SketchCurveRef[];
      /** true なら直線で結ぶ(罫線)、false ならなめらかに結ぶ(ロフト)。 */
      readonly ruled: boolean;
    }
  /** すでにある立体の面を 1 枚取り出した面。**対象は消費しない。** */
  | {
      readonly kind: 'face';
      /** 面を借りる立体を作ったフィーチャーの id。**消費しない。** */
      readonly targetFeatureId: string;
      readonly face: SubShapeRef;
    }
  /**
   * すでにある立体の面を 1 枚取り出し、距離だけ離した面(FR-428)。**対象は消費しない。**
   *
   * カーネルの `SurfaceInput` に 6 種目として足された(タスク42b、`PerformBySimple`)。
   * `distance` は面の法線の側を正とし、負にすれば逆へ離れる。**0 は解決が断る**
   * (離れないので `face` と同じ形になり、同じ形に 2 通りの書き方ができてしまう)。
   */
  | {
      readonly kind: 'offset';
      /** 面を借りる立体を作ったフィーチャーの id。**消費しない。** */
      readonly targetFeatureId: string;
      readonly face: SubShapeRef;
      /** 離す距離(mm)。0 以外。 */
      readonly distance: ExpressionValue;
    };

/**
 * 曲面(FR-428、§0.a-0.45)。**閉じた立体ではなく面だけのボディ**を作る。
 *
 * カーネルは `bodyKind: 'shell'` の印を付けて返し、体積ではなく面積で意味を持つ
 * (ふたの無い開いた殻の体積は 0 とは限らない、タスク41 の実測)。
 * フィレット・面取り・穴のような加工は面だけの形には掛けられず、カーネルが断る。
 *
 * **5 種のどれも対象を消費しない。** 計画書 §2.11 は「オフセット・厚み付けは消費する」と
 * 書いていたが、タスク41 の `SurfaceInput` にその 2 種は無い(面のオフセットは
 * タスク42 の追加、厚み付けはシェル FR-418 としてタスク53 が別に作った)。
 */
export interface SurfaceFeature extends SolidFeatureBase {
  readonly kind: 'surface';
  readonly operation: SurfaceOperation;
}

/**
 * くり抜き(シェル。FR-418、§0.a-0.47、P5 計画書 §2.12)。壁の厚さを残して中身を抜く。
 *
 * **対象を消費する**(くり抜いた立体 1 つだけが残る)。欄はカーネルの `ShellStepSpec`
 * (`packages/kernel/src/types.ts`、タスク53)と同じ意味・同じ名前にしてあるので、解決は
 * 式を数へ直すだけで詰め替えられる。
 *
 * **開ける面は 0 枚でもよい。** そのときは外から見た形が変わらず、中だけが空になる
 * (タスク53 の実測: 20³ を厚さ 2 で閉じたままくり抜くと 3904 = 8000 − 16³)。
 * 同じ面を 2 度指しても 1 度だけ数える(解決が重複を除く。R 面取りと同じ扱い)。
 */
export interface ShellFeature extends SolidFeatureBase {
  readonly kind: 'shell';
  /** くり抜く立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 開ける面。**0 枚でもよい。** 対象の立体の面だけを指せる(解決が確かめる)。 */
  readonly openFaces: readonly SubShapeRef[];
  /** 壁の厚さ(mm)。0 より大きい。 */
  readonly thickness: ExpressionValue;
  /**
   * true で外向きに肉を付ける(外側の大きさが変わる)。
   * false(既定の使い方)で内向き——外側の大きさが変わらない。
   */
  readonly outward: boolean;
}

/**
 * 平面による切断(FR-432、§0.a-0.56〜0.60、P5 計画書 §2.9b.2)。
 *
 * 切断面は**任意の作業平面(FR-328)と同じ `PlaneSpec`** で持つ(§0.a-0.56)。
 * 「面を確定できる要素の組み合わせ」を 2 か所に書かないためで、切断専用の平面の型は
 * 作らない。将来の断面表示(FR-111)も同じ型を指せる。
 *
 * **対象を消費し、残る側 1 つのボディを作る。** 残す側は解決した平面の**法線の向き**で
 * 決まる(§0.a-0.57)ので、`resolvePlaneSpec` が同じ指定から必ず同じ法線を返すこと
 * (決定性)がこの欄の意味を支えている。
 */
export interface CutFeature extends SolidFeatureBase {
  readonly kind: 'cut';
  /** 切る対象のボディ(フィーチャー id)。消費する。 */
  readonly targetFeatureId: string;
  /** 切断面の決め方(FR-328 と共有する 7 種)。 */
  readonly plane: PlaneSpec;
  /** 法線の側を残すか、その反対か(§0.a-0.57)。既定 `'positive'`。 */
  readonly keep: 'positive' | 'negative';
  /**
   * 「反対側も残す」で自動追加された 2 つ目のとき、1 つ目の切断フィーチャーの id。
   * null なら単独の切断(§0.a-0.58)。
   *
   * **形には影響しない**(鍵に混ぜない。`CutKeyMaterial` の注釈)。効くのは消費の数え方
   * だけで、対で結ばれた 2 つは対象を **1 度だけ**消費したものとして扱う。相手が文書から
   * 消えた・抑制されたときは、残ったほうが単独の切断として振る舞う(**文書は書き換えない**)。
   */
  readonly pairedWith: string | null;
}

// ---------------------------------------------------------------------------
// 読み込んだ形(ベースボディ 2 種。FR-802、P6 計画書 §2.8、§0.a-0.9 / §0.a-0.24)
//
// ⚠️ **ここは `rules/04-設計の規律.md` の「導出できるものは保存しない」への唯一の例外**
// である(P6 §0.a-0.9 / §0.a-0.24 で利用者が承認した例外①②)。読み込んだ形は
// **再計算で導出できない**——元のファイルは手元から消えるかもしれず、消えたら部品が
// 開けなくなる。だから形そのもの(B-rep / 三角形)を `.pcad` の ZIP へ抱き込む。
// 「導出できるものは保存しない」の趣旨(同じものを 2 か所に持って食い違わせない)には
// 反しない——読み込んだ形はどこからも導出できない一次情報だからである。
//
// **`document.json` に入るのは下の 2 つの型だけ**で、バイト列は ZIP の別エントリ
// (`shapes/<shapeRef>.brep` / `meshes/<meshRef>.bin`)に置く(§2.8。`document.json` を
// 巨大にしないため)。読み書きは `packages/io`(タスク21)の担当。
// ---------------------------------------------------------------------------

/**
 * 読み込んだファイルの形式(P6 計画書 §2.8)。
 *
 * **`exchange/types.ts` の `ImportFormat`(= Must の 3 つ)とはわざと別の型にしてある。**
 * あちらは「いま読み込みの口を開けている形式」で、こちらは「文書に記録された、その形が
 * どの形式から入ったか」である。3MF / glTF の読み込みは Could(FR-809、§0.a-0.26)なので
 * 口が開くのは後になるが、開いた後に文書の型を広げると版が上がってしまう。
 */
export type ImportedSourceFormat = 'step' | 'stl' | 'obj' | '3mf' | 'gltf';

/**
 * 読み込んだ形の素性(P6 計画書 §2.8)。**形そのものではなく、由来の記録**である。
 *
 * 画面(フィーチャーツリーとプロパティ)が「何を、いつ、どの単位で読んだか」を出すために
 * 持つ。中身(バイト列)は ZIP の別エントリにあるので、ここには 1 バイトも入らない。
 */
export interface ImportedSource {
  /** どの形式から入ったか。 */
  readonly format: ImportedSourceFormat;
  /** 読み込んだファイルの名前(表示用。パスは持たない。NFR-SE-1)。 */
  readonly fileName: string;
  /**
   * 取り込んだときにファイルが使っていた長さの単位(FR-811、§0.a-0.6)。
   *
   * **中身はすでに mm へ換算済み**(NFR-RE-3、内部は mm 固定)。ここに残すのは
   * 「元は inch だった」を画面に出すためだけで、この欄で形が変わることはない。
   */
  readonly unit: LengthUnit;
  /** 読み込んだファイルのバイト数(表示用)。 */
  readonly byteLength: number;
  /**
   * 取り込んだ時刻(ISO 8601)。**省略できる**(= 記録なし)。
   *
   * 省略を許すのは、①時刻は形にも鍵にも効かない、②検査の見本が時刻を書かずに済む、
   * ③時計を持たない経路(移行・ひな形)から作った文書でも成り立つ、の 3 つによる
   * (押し出しの `end`・穴の `entry` と同じ「省略できる欄」の流儀)。
   */
  readonly importedAt?: string;
}

/**
 * 読み込んだ形(ベースボディ。FR-802、§2.8、§0.a-0.9)。**STEP から入った B-rep。**
 *
 * 対象を取らず、何も消費しない「作る」フィーチャー(基本形状・ばねと同じ)。
 * **その上へ穴・面取り・ブーリアンを積める**(FR-802「その上へのフィーチャー追加は可能」)。
 * 履歴を持たないので、寸法を編集する欄は 1 つも無い(式の欄が無い唯一のソリッド 2 種)。
 */
export interface ImportedSolidFeature extends SolidFeatureBase {
  readonly kind: 'importedSolid';
  /**
   * `.pcad` の ZIP の `shapes/<shapeRef>.brep` の名前の素(§2.8)。
   *
   * **形状キャッシュの鍵はこの文字列だけで足りる**(`part/cacheKey.ts`)。読み込んだ形は
   * 再計算で変わりようがないので、同じ `shapeRef` なら必ず同じ形になり、2 回目以降の
   * 再計算はキャッシュに当たる(NFR-PF-3)。
   */
  readonly shapeRef: string;
  readonly source: ImportedSource;
  /**
   * 形の種類。**`'solid'` か `'shell'` だけ**(三角形の形は `ImportedMeshFeature`)。
   *
   * カーネルの `ShapeImportBody.bodyKind`(タスク10)が返した値をそのまま写す。
   * B-rep のバイト列から導けはするが、**導くにはカーネルを呼ぶしかない**——文書を開いた
   * だけの時点(書き出しの可否の案内、STL への断り「面だけの立体は STL に書き出せません。」)で
   * 要るので、読み込んだ素性の一部として保存する(この節の冒頭の例外の内側)。
   */
  readonly bodyKind: 'solid' | 'shell';
}

/**
 * 読み込んだ三角形の形(ベースボディ。FR-802、§2.8、§0.a-0.24)。
 * **STL / OBJ / 3MF / glTF から入った三角形。**
 *
 * **B-rep にしない**(§0.a-0.23)。したがって幾何カーネルの段にならず、
 * **穴・面取り・ブーリアンの対象にできない**(断りは `part/resolvePart.ts` の 1 か所)。
 * 表示・測定・書き出しはできる。
 */
export interface ImportedMeshFeature extends SolidFeatureBase {
  readonly kind: 'importedMesh';
  /** `.pcad` の ZIP の `meshes/<meshRef>.bin` の名前の素(§2.8)。鍵もこれだけ。 */
  readonly meshRef: string;
  readonly source: ImportedSource;
  /**
   * 三角形の数。`meshes/<meshRef>.bin` の見出しにも入っているが、**バイト列を読まずに**
   * ツリーとプロパティへ出すためにここにも持つ(§2.8 の「大きすぎる形」の案内も同じ数を使う)。
   * 中身と食い違わないのは、両方とも読み込みの 1 回で決まり、以後どちらも変わらないため。
   */
  readonly triangleCount: number;
  /**
   * 体積(mm³)。**省略できる**(= 測っていない / 閉じていないので測れない)。
   *
   * 三角形の集まりが閉じているとは限らず、閉じていない形の体積は意味を持たない
   * (曲面のボディで体積が 0 とは限らないのと同じ事情。P5 タスク41 の実測)。
   * `null` ではなく省略にしてあるのは、「測ったら 0 だった」を将来 `0` で表せるようにするため。
   */
  readonly volume?: number;
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
  | LoftFeature
  // P5 の Should 群 9 種(§2.11、タスク43)。
  | DraftFeature
  | MirrorFeature
  | TransformFeature
  | ScaleFeature
  | SweepFeature
  | RibFeature
  | EmbossFeature
  | ThreadShaftFeature
  | SurfaceFeature
  // P5 の Could 群のうち、型・解決・読み書きをタスク46 が前倒しした 1 種(FR-418)。
  | ShellFeature
  // 平面による切断(FR-432、§2.9b、タスク27c)。分割(FR-424)もこれで満たす。
  | CutFeature
  // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
  | ImportedSolidFeature
  | ImportedMeshFeature;

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

// ---------------------------------------------------------------------------
// 選択セット(FR-112。P6 計画書 §0.a-0.44、§2.13、タスク37)
// ---------------------------------------------------------------------------

/**
 * 選択セットに入れられるもの 1 つ(FR-112「選んだ組に名前を付けて保存・呼び出し」)。
 *
 * **P5 の `AppearanceTarget` をそのまま共有する**(§0.a-0.44「`AppearanceTarget` と
 * 同じ形」、統括の指示「型を 2 つ作らない」)。同じ形の型を 2 つ置くと、`packages/io` の
 * 読み書き・`isSameAppearanceTarget` の同一判定・部分形状の指紋の選び直しが
 * 2 通りずつ要ることになり、片方だけ直したときに黙って食い違う。
 *
 * **`kind: 'face'` は「部分形状 1 つ」の意味で読む。** 外観は面 1 枚にしか付けられない
 * ので P5 はこの名前にしたが、`SubShapeRef` 自身が `fingerprint.kind` に
 * 面・辺・頂点のどれかを持っている(`geometry/subShapeRef.ts`)ので、選択セットが
 * 辺や頂点を持っても型は 1 ドットも変える必要がない。§0.a-0.44 の草案の名前
 * (`{ kind: 'subShape' }`)へ改名しなかったのは、改名すると版 7 の `.pcad` の
 * 外観の欄まで書き換わり、P5 で保存されたファイルが開けなくなるためである。
 */
export type SelectionMember = AppearanceTarget;

/**
 * 選択セット 1 つ(FR-112、§0.a-0.44)。
 *
 * **履歴ではない。** 形を作らない「札」なので `solids` には入れず、文書の別の欄として
 * 持つ(外観 `appearance` とまったく同じ扱い)。セットを足しても消しても再計算は
 * 起こらない(`part/documentChange.ts` の `affectsShape` が偽を返す)。
 *
 * - **同じ名前を 2 つ作れる**(§2.13 の表)。区別は `id` で付ける。名前で引く仕組みを
 *   持たないので、重複してもどのセットを指しているかが曖昧にならない。
 * - **空のセットを作れる**(同上)。先に名前だけ決めて後から要素を足す使い方を許す。
 * - 要素は座標ではなく**指紋**(`SubShapeRef`)で持つので、再計算の後も選び直せる
 *   (P3 からの仕組み)。選び直せなかった要素は警告して外す(§2.13、`pruneSelectionSets`)。
 */
export interface SelectionSet {
  /** セットの id(採番は `selectionSet-<n>`、`part/selectionSets.ts` の `nextSelectionSetId`)。 */
  readonly id: string;
  /** 利用者が付けた名前(FR-112)。空にはできない。同じ名前が 2 つあってもよい。 */
  readonly name: string;
  /** セットに入っているもの。0 個でもよい。 */
  readonly members: readonly SelectionMember[];
}

// ---------------------------------------------------------------------------
// 下絵の画像(FR-332。P6 計画書 §0.a-0.45、§2.14、タスク38)
// ---------------------------------------------------------------------------

/**
 * 下絵の画像 1 枚(FR-332「読み込んだ画像を作図面に置き、2 点で寸法を合わせてなぞる」)。
 * P6 計画書 §0.a-0.45 の形に従う。
 *
 * **画像そのものはこの欄に入れない。** `imageId` で `.pcad` の ZIP のエントリ
 * (`canvases/<imageId>.png`、`packages/io` の `PCAD_CANVAS_ENTRY_PREFIX`)を指すだけで、
 * `document.json` には id と寸法しか書かない(§0.9 と同じ流儀。数 MB の画像を JSON へ
 * 入れると読み書きが桁違いに遅くなる)。
 *
 * **画像を `.pcad` へ保存するのは `rules/04`「導出できるものは保存しない」の
 * 承認済みの例外**(§0.a-0.45 の例外③、統括の承認 2026-09-05)である。読み込んだ画像は
 * **再計算では導出できない**——元のファイルが手元から消えたら二度と作れない——ので、
 * 読み込んだ B-rep(§0.a-0.9)・読み込んだ三角形(§0.a-0.24)と同じ理屈で抱き込む。
 *
 * **下絵は形にならない。** 押し出しの材料にも当たり判定にもならず、変更しても再計算を
 * 起こさない(§2.14、`affectsShape` が偽)。線には吸着しない(§0.a-0.47)。
 */
export interface SketchCanvas {
  /** 下絵の id(採番は `canvas-<n>`、`sketch/canvas.ts` の `nextCanvasId`)。 */
  readonly id: string;
  /** フィーチャーツリー・一覧に出す名前(FR-501 と同じ扱い)。 */
  readonly name: string;
  /**
   * 貼り付ける作図面(FR-332「作図面に置く」)。基準の 3 面と任意の作業平面(FR-328)の
   * どちらも入る文字列(`sketch/planeMath.ts` の `WorkPlaneId`。ミラーの `MirrorPlane` が
   * 同じ理由で同じ型を使っている)。
   */
  readonly plane: WorkPlaneId;
  /**
   * ZIP の中の画像を指す名前。エントリ名は `canvases/<imageId>.png` になる。
   * **拡張子は形式に関わらず `.png` 固定**(§0.a-0.45 の決め)で、PNG か JPEG かは
   * 読み出したバイト列の先頭から判る(`sketch/canvas.ts` の `detectImageFormat`)。
   * 導出できるものを二重に持たないため、形式そのものは欄にしない(`rules/04`)。
   */
  readonly imageId: string;
  /** 作図面の上での幅(mm、FR-202 の式)。2 点の寸法合わせ(§2.14)が決める。 */
  readonly width: ExpressionValue;
  /** 同じく高さ(mm)。縦横比は利用者が崩せる(画像が歪んでいることがあるため)。 */
  readonly height: ExpressionValue;
  /** 画像の中心を置く位置(作図面の座標。FR-202 の式のまま持つ)。 */
  readonly origin: CoordinateInput;
  /** 作図面の中での回り(度)。0 なら画像の横が作図面の第 1 軸に沿う。 */
  readonly rotation: ExpressionValue;
  /**
   * 不透明度 **0〜1**(0 で透明、1 で不透明)。**外観の透過率(0〜100%)とは尺度が違う。**
   * three.js の `Material.opacity` がそのまま 0〜1 で、下絵は「なぞるための薄い紙」で
   * あって材質ではないので、描く側(ui タスク39)が換算せずに使える尺度にしてある
   * (§2.14 とタスク39 の検証表「不透明度 0.5 → 材質の `opacity` が 0.5」)。
   */
  readonly opacity: ExpressionValue;
  /** 画面に出すか(FR-332 の「入切」)。false でも文書からは消えない。 */
  readonly visible: boolean;
}

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
  /**
   * 選択セット(FR-112、§0.a-0.44。P6 タスク37)。**版 7 で足した必須の欄**で、
   * 版 6 以前のファイルは `packages/io` の `SCHEMA_MIGRATIONS[6]` が空配列で補う
   * (`parameters`(版 5)・`appearance`(版 6)とまったく同じ道筋)。
   *
   * 外観と同じく**履歴ではない**ので、変更しても再計算も段の鍵の作り直しも起こさない
   * (`part/documentChange.ts` の `affectsShape` が偽を返す)。
   */
  readonly selectionSets: readonly SelectionSet[];
  /**
   * 下絵の画像(FR-332、§0.a-0.45。P6 タスク38)。`selectionSets` と同じく版 7 で足した
   * 必須の欄で、版 6 以前のファイルは移行が空配列で補う。
   *
   * 画像のバイト列はここに入らない(`SketchCanvas.imageId` が ZIP のエントリを指す)。
   * 下絵は材料にならないので、変更しても再計算を起こさない(§2.14)。
   */
  readonly canvases: readonly SketchCanvas[];
}
