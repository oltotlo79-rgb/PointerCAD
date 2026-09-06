/**
 * model から幾何カーネルへの唯一の接点(計画書 docs/plans/P1-式とスケッチ.md タスク12、
 * docs/plans/P3-加工フィーチャー.md タスク17)。
 *
 * @pointercad/kernel の型はこのファイルの中だけで使い、外へは model の型で返す
 * (P0 §0.11、rules/04-設計の規律.md の依存方向)。ここ以外から kernel を呼ばない。
 */

import {
  createKernelWorker,
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  makeSketchChamfer,
  makeSketchFillet,
  matchEdge,
  matchFace,
  matchVertex,
  type AppearanceMatch,
  type AppearanceQuery,
  type CurveSpec,
  type FaceMeshData,
  type KernelApi,
  type MeasureRequest,
  type MeasureResult,
  type MeasureTargetSpec,
  type OffsetJoinType,
  type PlanarFaceRequest,
  type PlaneCurve,
  type PrintabilityProgress,
  type PrintabilityResult,
  type ShapeExportItem,
  type ShapeInspectRequest,
  type ShapeExportRequest,
  type ShapeExportResult,
  type ShapeImportBody,
  type ShapeImportRequest,
  type ShapeImportResult,
  type SketchOffsetItem,
  type SketchOffsetOutcome,
  type SketchPlaneFrame,
  type SketchProjectionItem,
  type SketchProjectionOutcome,
  type SketchSectionItem,
  type SketchTessellationFailure,
  type SolidBodyMesh,
  type SolidProgress,
  type SolidRecomputeRequest,
  type SolidRecomputeResult,
  type SolidStepRequest,
  type SolidStepSpec,
  type SubShapeQuery,
  type SurfaceInput,
  type ThruSectionSpec,
  type Vec2Tuple,
} from '@pointercad/kernel';
import * as Comlink from 'comlink';

import { EXPORT_MESH_QUALITY, type ExportMeshQuality } from './exchange/types.js';
import type { ResolvedSubShape } from './geometry/planeSpec.js';
import type { SubShapeRef } from './geometry/subShapeRef.js';
import type {
  ResolvedSolidStep,
  SolidStepPlan,
  SubShapeQueryPlan,
  SurfaceShapePlan,
  ThruSectionPlan,
} from './part/resolvePart.js';
import type { EdgeCurveKind, FaceSurfaceKind } from './part/types.js';
import type { WorkPlane } from './sketch/planeMath.js';
import { isFullEllipse } from './sketch/resolveSketch.js';
import type {
  OffsetCornerKind,
  ResolvedCurve,
  ResolvedFace,
  SketchFaceMesh,
  SketchMesh,
} from './sketch/types.js';
import { addVec3, scaleVec3, type Vec3 } from './sketch/vec3.js';

/** 面 1 枚を作れなかった理由。カーネルが日本語で返したものをそのまま持ち回る(FR-504)。 */
export interface SketchFaceFailure {
  /** 依頼した面フィーチャーの id。 */
  readonly featureId: string;
  readonly message: string;
}

/**
 * 面をカーネルへ渡した結果。1 枚失敗しても残りは作るので、
 * できた面(mesh)とできなかった理由(failures)を両方返す(FR-504、NFR-RE-1)。
 */
export interface SketchTessellationOutcome {
  readonly mesh: SketchMesh;
  readonly failures: readonly SketchFaceFailure[];
}

/**
 * オフセット 1 件の依頼(model の言葉、FR-321、P4 タスク15)。
 * 距離は**符号つき**で、どちら側かは呼び出し側(`recomputeSketch`)が決めてから渡す。
 */
export interface SketchOffsetRequestItem {
  readonly featureId: string;
  /** オフセット元の曲線。並んだ順につながっていること。 */
  readonly curves: readonly ResolvedCurve[];
  readonly distance: number;
  readonly corner: OffsetCornerKind;
}

/** オフセットで得た輪郭 1 本。面の境界に使えるのは閉じているものだけ。 */
export interface SketchOffsetContour {
  readonly curves: readonly ResolvedCurve[];
  readonly closed: boolean;
}

/** オフセット 1 件の結果。輪郭が 2 本以上に分かれることもある。 */
export interface SketchOffsetEntry {
  readonly featureId: string;
  readonly contours: readonly SketchOffsetContour[];
}

/** オフセットを 1 件作れなかった理由。カーネルが日本語で返したものを持ち回る(FR-504)。 */
export interface SketchOffsetFailure {
  readonly featureId: string;
  readonly message: string;
}

/** オフセットの結果。1 件失敗しても残りは作る(FR-504、NFR-RE-1)。 */
export interface SketchOffsetResult {
  readonly results: readonly SketchOffsetEntry[];
  readonly failures: readonly SketchOffsetFailure[];
}

/* ------------------------------------------------------------------ *
 * 投影・交差(FR-325、P4 タスク25・26)
 * ------------------------------------------------------------------ */

/**
 * 投影・交差 1 件の依頼(model の言葉)。
 *
 * **もとの立体は「段の鍵」で指す。** 立体の B-rep はカーネル(Worker)の中にしか無く、
 * 形そのものは渡せないので、`recomputeSolids` が預けたときの鍵(`ResolvedSolidStep.key`)を
 * そのまま渡してカーネル側の形状キャッシュから引いてもらう。鍵は上流の値から作られている
 * ので、上流が変われば鍵が変わり、投影も必ず作り直される(NFR-PF-3 の鍵の連鎖)。
 */
export interface SketchProjectionRequestItem {
  readonly featureId: string;
  /** もとの立体の段の鍵。 */
  readonly bodyKey: string;
  /**
   * 投影する面・辺。**`null` なら立体そのもの**(交差、または立体全体の投影)。
   * 面・辺は指紋で渡し、選び直しはカーネルの中で行う(§2.2.4)。
   */
  readonly source: SubShapeRef | null;
  /** 投影先・切り口の作図面。 */
  readonly plane: WorkPlane;
}

/** 投影・交差 1 件の結果。曲線はワールド座標へ戻した後の形で、つながる順に並ぶ。 */
export interface SketchProjectionEntry {
  readonly featureId: string;
  readonly curves: readonly ResolvedCurve[];
}

/** 投影・交差を 1 件作れなかった理由。カーネルが日本語で返したものを持ち回る(FR-504)。 */
export interface SketchProjectionFailure {
  readonly featureId: string;
  readonly message: string;
}

/** 投影・交差の結果。1 件失敗しても残りは作る(FR-504、NFR-RE-1)。 */
export interface SketchProjectionResult {
  readonly results: readonly SketchProjectionEntry[];
  readonly failures: readonly SketchProjectionFailure[];
}

/* ------------------------------------------------------------------ *
 * スケッチの角の丸め・面取り(FR-323、P4 タスク18・19)— Worker を通らない同期の口
 * ------------------------------------------------------------------ */

/**
 * ## なぜ Worker を往復しないのか、なぜここに置くのか(統括の決定 §0.a-0.20)
 *
 * 角の丸め・面取りの形は、角を作るのが 2 本の**線分**である限り閉じた式で解ける。
 * タスク19 の実測で OCCT(`ChFi2d_FilletAlgo` / `ChFi2d_ChamferAPI`)は使わないと決まり、
 * kernel の `makeSketchFillet2d.ts` / `makeSketchChamfer2d.ts` は **OCCT に触れない純関数**
 * になった(理由は同ファイルの冒頭)。だから Worker への往復は要らない。
 *
 * それでも呼び出しをこのファイルに通すのは、**model からカーネルを呼ぶのは
 * `kernelBridge.ts` だけ**という決め(このファイルの冒頭、P0 §0.11)を守るため。
 * 式そのものは kernel が単一の正本を持ち(OCCT との一致を検査で固定しているのは
 * kernel 側だけで、model からは OCCT を呼べない)、model 側へ写して 2 か所に持つことは
 * しない(`splineMath.ts` が抱えている二重定義を増やさない)。
 *
 * ほかの口と違って**同期の純関数**である。Worker を持たないので `KernelBridge` の
 * メソッドにはせず、このファイルの関数として置く。
 */

/** 角を作る線分 1 本(model の言葉)。 */
export interface SketchCornerSegment {
  readonly from: Vec3;
  readonly to: Vec3;
}

/**
 * 丸めの円弧を置く作図面。**角度 0 の向き(第1軸)を含む**のは、model の円弧
 * (`SketchArcFeature`)の開始角・終了角が作図面の第1軸から測ると決まっているため。
 */
export interface SketchCornerPlane {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly axisU: Vec3;
}

/** 丸めた結果。角度は plane.axisU を 0 とし plane.normal まわりに正(ラジアン)。 */
export interface SketchFilletGeometry {
  /** 丸め後、1 本目の線の新しい端点(円弧との接点)。 */
  readonly trimmed1: Vec3;
  readonly trimmed2: Vec3;
  readonly arcCenter: Vec3;
  readonly arcRadius: number;
  readonly arcStartAngle: number;
  readonly arcEndAngle: number;
}

/** 面取りした結果。足す線分は trimmed1 から trimmed2 へ引く。 */
export interface SketchChamferGeometry {
  readonly trimmed1: Vec3;
  readonly trimmed2: Vec3;
}

/**
 * 角を丸めた形を求める(FR-323)。角として成り立たないとき、半径が線の長さに
 * 収まらないときは日本語の `Error` を投げる(呼び出し側が断りへ直す)。
 */
export function sketchFilletGeometry(
  line1: SketchCornerSegment,
  line2: SketchCornerSegment,
  plane: SketchCornerPlane,
  radius: number,
): SketchFilletGeometry {
  return makeSketchFillet({
    line1: { kind: 'segment', from: line1.from, to: line1.to },
    line2: { kind: 'segment', from: line2.from, to: line2.to },
    plane,
    radius,
  });
}

/**
 * 角を面取りした形を求める(FR-323)。作図面を取らないのは、面取りの結果が
 * 2 つの絶対座標だけで決まるため(kernel の `makeSketchChamfer2d.ts` の注釈)。
 */
export function sketchChamferGeometry(
  line1: SketchCornerSegment,
  line2: SketchCornerSegment,
  distance1: number,
  distance2: number,
): SketchChamferGeometry {
  return makeSketchChamfer({
    line1: { kind: 'segment', from: line1.from, to: line1.to },
    line2: { kind: 'segment', from: line2.from, to: line2.to },
    distance1,
    distance2,
  });
}

/** ボディ 1 つの表示用データ(model の言葉)。kernel の SolidBodyMesh を詰め替えたもの。 */
export interface SolidBodyMeshData {
  /** 頂点座標。x, y, z の順に 3 個ずつ並ぶ。 */
  readonly positions: Float32Array;
  /** 頂点法線。positions と同じ長さ。 */
  readonly normals: Float32Array;
  /** 三角形の頂点番号。3 個ずつ並ぶ。 */
  readonly indices: Uint32Array;
  /** 稜線の線分列。線分 1 本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly edgePositions: Float32Array;
  readonly triangleCount: number;
}

/**
 * 面 1 枚の素性(計画書 P3 §2.2、§2.8)。部分形状の当たり判定・強調・指紋の材料になる。
 * kernel の `SolidFaceInfo` と同じ形だが、model は kernel の型を再輸出しないので
 * この場に自分の型として持つ(P0 §0.11)。
 */
export interface SolidFaceEntry {
  /** `TopExp.MapShapes_2` の順で数えた 0 始まりの通し番号。 */
  readonly index: number;
  readonly surfaceKind: FaceSurfaceKind;
  /** 面積(mm²)。 */
  readonly area: number;
  /** 重心(mm)。 */
  readonly centroid: Vec3;
  /** 平面は法線、円柱・円錐は軸。求まらなければ null。 */
  readonly axis: Vec3 | null;
  /** 円柱・円錐・球の半径(mm)。平面では null。 */
  readonly radius: number | null;
  /** この面の三角形が mesh.indices の何番目から何枚あるか。 */
  readonly triangleOffset: number;
  readonly triangleCount: number;
}

/** 辺 1 本の素性。並びは面と同じく通し番号の順(計画書 P3 §2.2、§2.8)。 */
export interface SolidEdgeEntry {
  readonly index: number;
  readonly curveKind: EdgeCurveKind;
  /** 長さ(mm)。 */
  readonly length: number;
  /** 中点(mm)。 */
  readonly midpoint: Vec3;
  readonly start: Vec3;
  readonly end: Vec3;
  /** 直線は向き、円は軸。求まらなければ null。 */
  readonly axis: Vec3 | null;
  /** 円の半径(mm)。それ以外は null。 */
  readonly radius: number | null;
  /** この辺の線分が mesh.edgePositions の何番目から何本あるか。 */
  readonly segmentOffset: number;
  readonly segmentCount: number;
}

/** 頂点 1 つの素性。位置しか持たない(計画書 P3 §2.2、§2.8)。 */
export interface SolidVertexEntry {
  readonly index: number;
  readonly position: Vec3;
}

/**
 * ねじの簡略表示の印(§0.a-0.15)。B-rep には現れない、描画だけのための情報。
 * 下穴は実際に掘るが、ねじ山は形を作らずに細い円と軸線で表すので、再計算の費用がかからない。
 */
export interface ThreadMarkEntry {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly majorDiameter: number;
  readonly length: number;
}

/**
 * 形の種類(FR-428、P5 §0.a-0.45。P6 §0.a-0.24 で `'mesh'` が加わった)。閉じた立体を含む形は
 * `'solid'`、面だけのボディ(押し出し面・回転面など)は `'shell'`、**読み込んだ三角形の形**
 * (STL / OBJ / glTF / 3MF のベースボディ、FR-802、P6 §2.8)は `'mesh'`。
 *
 * kernel にも同じ名前・同じ3値の型があるが、**kernel の型は再輸出しない**約束
 * (このファイルの冒頭、P0 §0.11)なので model 側で同じ並びを持つ(P6 タスク10 が
 * kernel 側を広げ、タスク20 の前借りとして model 側もここで追随した)。P5 タスク3 の
 * 時点ではどの段も閉じた立体しか作らないので必ず `'solid'` で、`'shell'` が実際に来るのは
 * 曲面の段が入るタスク41 から、`'mesh'` が来るのは読み込んだ形のベースボディ
 * (`importedMesh` のフィーチャー)が入る P6 タスク20 から。
 */
export type SolidBodyKind = 'solid' | 'shell' | 'mesh';

/**
 * 外観を割り当てた面 1 つぶんの照合の依頼(FR-1106、P5 §2.2.3、§0.a-0.2)。
 *
 * 文書は面を指紋(`SubShapeRef`)で覚えているだけなので、形を作り直すと面の通し番号が
 * ずれる。**選び直しの採点はカーネルにしか無い**(`matchSubShape.ts`。重みとしきい値を
 * model へ複製しない、§0.a-0.2)ので、再計算のたびにこの依頼をカーネルへ添えて
 * 選び直してもらう。`bodyFeatureId` はその面を持つボディを作ったフィーチャーの id で、
 * 橋がそれを段の鍵(`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す。
 */
export interface AppearanceFaceRequest {
  /** 割り当て 1 つの id(`AppearanceEntry.id`)。結果との対応づけだけに使う。 */
  readonly id: string;
  readonly bodyFeatureId: string;
  readonly ref: SubShapeRef;
}

/**
 * 外観の面の照合の結果 1 件(FR-1106)。**依頼と同じ並び・同じ件数で返る**
 * (1 件も落とさない)。
 *
 * `faceIndex` が `null` なら「選び直せなかった」で、呼び出し側(ui)は警告を出して
 * その面を既定の外観で描く(FR-1106「選び直せなかった割り当ては警告し、既定の外観に
 * 戻す」)。**割り当て自体は文書から消さない**ので、利用者が形を元に戻せば復活する。
 */
export interface AppearanceMatchEntry {
  readonly id: string;
  readonly bodyFeatureId: string;
  readonly faceIndex: number | null;
}

/** 画面に出るボディ 1 つ。id はそれを作ったフィーチャーの id と同じ(§0.a-0.5)。 */
export interface SolidBody {
  readonly featureId: string;
  readonly mesh: SolidBodyMeshData;
  /** 体積(mm³)。プロパティ欄に出す(FR-501)。 */
  readonly volume: number;
  /**
   * 表面積(mm²)。測定(FR-1102)と曲面(FR-428)で使う。
   *
   * **任意の欄にしてあるのは、`SolidBody` を組み立てている見本(`packages/ui` の
   * ビューポートとストアの検査、`part/subShapeCache.test.ts`)を直せるのが、
   * それぞれのパッケージを受け持つ後続のタスク(ui のタスク10・11)だからである。**
   * ここを必須にすると、P5 タスク4 の担当が触れない範囲の型検査が落ちる。
   * カーネルから来た値はそのまま写し、**カーネルが返さなかったときは欄ごと省く**
   * (0 と偽らない)。kernel 側で必須へ引き上げる話は kernel の後続タスクが持つ。
   */
  readonly area?: number;
  /**
   * 形の種類(FR-428)。**model の型ではまだ任意**にしてあるが、任意にしてある理由は
   * `area` と同じ(`SolidBody` を組み立てている ui の見本を直せるのが ui のタスク)。
   * **詰め替えでは必ず値を入れる**——カーネル側は §0.a-0.77(タスク42b)で必須の欄に
   * なったので、`toSolidBody` は既定へ落とさずカーネルの値をそのまま写す。
   * 実際の再計算の結果でこの欄が空になることは無い。
   */
  readonly bodyKind?: SolidBodyKind;
  /**
   * 中身のある立体として受け取れたか。三角形が 1 枚以上あり、体積が有限の正の値であること。
   *
   * カーネルは立体になっていない形(体積 0、B-rep として壊れている形)を作った時点で
   * 断って failures へ回すので、いまここへ来るボディは必ず true になる。それでも欄を持つのは、
   * 表示側が「形は返ったが中身が無い」を毎回自分で確かめずに済ませるため(FR-504、NFR-RE-1)。
   */
  readonly isValid: boolean;
  /**
   * 部分形状(面・辺・頂点)の一覧(計画書 P3 §2.2、§2.8、タスク10・17)。並びは通し番号の順で、
   * `faces.length` / `edges.length` は必ずカーネルの `faceCount` / `edgeCount` と一致する
   * (kernel 側の buildSolidBodyMesh・subShapes.ts が保証し、本ファイルの検査で固定する)。
   * 加工フィーチャー(穴・面取り等)が保存する `SubShapeRef` の指紋は、この一覧から作る。
   */
  readonly faces: readonly SolidFaceEntry[];
  readonly edges: readonly SolidEdgeEntry[];
  readonly vertices: readonly SolidVertexEntry[];
  /** ねじの簡略表示の印(§0.a-0.15)。無ければ空配列。 */
  readonly threadMarks: readonly ThreadMarkEntry[];
}

/** 立体を 1 つ作れなかった理由。カーネルが日本語で返したものをそのまま持ち回る(FR-504)。 */
export interface SolidBodyFailure {
  /** 作れなかったフィーチャーの id。 */
  readonly featureId: string;
  readonly message: string;
}

/** 立体の再計算の結果。1 段失敗しても止めずに残りを返す(FR-504、NFR-RE-1)。 */
export interface SolidRecomputeOutcome {
  readonly bodies: readonly SolidBody[];
  readonly failures: readonly SolidBodyFailure[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目の実測値)。 */
  readonly cacheHits: number;
  /** 段と段の間で打ち切られたか(NFR-PF-4)。 */
  readonly cancelled: boolean;
  /**
   * 外観の面の照合の結果(FR-1106)。`SolidRecomputeOptions.appearance` と
   * 同じ並び・同じ件数で返り、頼まなければ空配列。
   *
   * 任意の欄にしてあるのは `SolidBody.area` と同じ理由(この型を組み立てている見本を
   * 直せるのが別のタスクの担当だから)で、詰め替えでは必ず値を入れる。
   */
  readonly appearanceMatches?: readonly AppearanceMatchEntry[];
}

/** 計算の進み具合(NFR-PF-4)。kernel の SolidProgress を model の言葉へ写したもの。 */
export interface PartProgress {
  /** これから計算する段のフィーチャー id。 */
  readonly featureId: string;
  /** これから計算する段の位置。0 から始まる。画面には index + 1 を出す。 */
  readonly index: number;
  /** 段の総数。 */
  readonly total: number;
  /** 画面に出す段の名前。 */
  readonly label: string;
}

/** 段を始める前に 1 回ずつ呼ばれる(NFR-PF-4)。 */
export type PartProgressCallback = (progress: PartProgress) => void;

/**
 * 中止を尋ねる口。true を返すと、段と段の間で残りを打ち切る(NFR-PF-4)。
 * 1 段の演算そのものは途中で止められない(§2.6 の限界)。
 */
export type PartCancelToken = () => boolean;

/** 立体の再計算に添える設定。どれも省略できる。 */
export interface SolidRecomputeOptions {
  /**
   * 世代番号。呼び出しごとに 1 つ増やし、古い応答を捨てる目印にする
   * (P1 の attachSketchRecompute と同じ発想)。
   */
  readonly generation?: number;
  readonly onProgress?: PartProgressCallback;
  readonly shouldCancel?: PartCancelToken;
  /**
   * 外観を割り当てた面(FR-1106、§2.2.3)。**省略か空なら照合を一切頼まない。**
   * 照合の物差し(境界箱の対角長)を測るのにもカーネルは OCCT を呼ぶので、外観を
   * 1 つも割り当てていない文書では費用をゼロにする(§0.a-0.54)。
   */
  readonly appearance?: readonly AppearanceFaceRequest[];
  /**
   * ボディの表面積(`SolidBody.area`)を測るか(FR-1102、統括の決定 2026-09-05 07:28)。
   *
   * **既定は測らない。** 表面積は測定・質量特性(タスク29 以降)が求めたときだけ要る値で、
   * 測る費用(カーネルの実測で面 26 枚の板に 11.4ms)を毎回の再計算で払わないため。
   * **外観の面の照合はこの値を使わない**(照合が見るのは面ごとの面積で、それは
   * 面の一覧に元から入っている)ので、`appearance` を渡してもここは真にならない。
   */
  readonly measureAreas?: boolean;
}

/* ------------------------------------------------------------------ *
 * 測定(FR-1101、FR-1102、P5 タスク29)
 * ------------------------------------------------------------------ */

/**
 * 測る対象 1 つ(model の言葉)。
 *
 * 立体は「それを作ったフィーチャーの id」で指す(§0.a-0.5「段の id = ボディの id」)。
 * kernel は形状キャッシュの鍵(`ResolvedSolidStep.key`)でしか形を引けないので、
 * `KernelBridge.measure` がこの id を鍵へ引き直してからカーネルへ渡す(外観の面の照合
 * `toAppearanceQueries` と同じ流儀、§2.2.3)。
 */
export interface MeasureTarget {
  readonly bodyFeatureId: string;
  /** 面・辺・頂点の指紋。ボディ全体を測るなら null。 */
  readonly subShape: SubShapeRef | null;
}

/**
 * 測定の結果(FR-1101、FR-1102)。kernel の `MeasureResult` を model の言葉へ詰め替えたもの
 * (kind ごとの欄はそのまま持ち回る)。
 *
 * **距離・重心はワールド座標の mm。慣性モーメント(`principalMoments`)は重心を通る主軸
 * まわりの体積の 2 次モーメントで、密度を掛けていない mm⁵のまま**(§0.a-0.32)。
 * 密度(g/cm³)を掛けた質量(g)・慣性モーメント(g·mm²)は、密度表を持つ model 側の
 * `measure/massProperties.ts`(`massFromVolume` / `inertiaWithDensity`)が別途計算する
 * (統括の決定: 密度の掛け算は model のこの 1 か所だけで行う)。
 */
export type MeasureOutcome =
  | {
      readonly kind: 'distance';
      /** 最短距離(mm)。交わっているときは 0。 */
      readonly distance: number;
      /** 1 つ目の対象の上の最近点(mm)。 */
      readonly pointA: Vec3;
      /** 2 つ目の対象の上の最近点(mm)。 */
      readonly pointB: Vec3;
      /** 一方が他方の内側にある(交わっている)か。 */
      readonly inner: boolean;
    }
  | {
      readonly kind: 'massProperties';
      /** 体積(mm³)。 */
      readonly volume: number;
      /** 表面積(mm²)。 */
      readonly area: number;
      /** 重心(mm)。 */
      readonly centreOfMass: Vec3;
      /** 重心を通る主軸まわりの体積の 2 次モーメント(mm⁵、密度を掛けていない)。 */
      readonly principalMoments: readonly [number, number, number];
      /** 主軸の向き(長さ 1)。第 1・第 2・第 3 の順。 */
      readonly principalAxes: readonly [Vec3, Vec3, Vec3];
    }
  /** 測れなかった。message はそのまま画面に出す日本語(FR-504。kernel の文言を持ち回る)。 */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 対象の立体を作ったフィーチャーの id が、いま渡された `steps` の中に見つからなかったとき
 * (§0.a-0.30)。
 *
 * kernel(`worker/kernelApi.ts` の `MEASURE_MISSING_SHAPE_MESSAGE`)が形状キャッシュに
 * 鍵が無かったときに返すのと**同じ日本語**。kernel はこの文字列を輸出していない
 * (`KernelApi` の実装の中だけの定数)ので、断りの文言を 1 つに揃えるためここへ複製する。
 * **測定は再計算を起こさない読み取り**(§0.a-0.30)なので、鍵が引けない対象があるときは
 * カーネルを呼ばずにここで断る(古い・存在しない鍵で問い合わせて紛らわしい失敗を返させない)。
 */
const MEASURE_MISSING_SHAPE_MESSAGE = '測れませんでした。もう一度お試しください。';

/**
 * 測定の依頼を kernel の言葉へ詰め替える。対象の立体を「段の鍵」へ引き直す
 * (`toAppearanceQueries` と同じ流儀)。**1 つでも鍵が引けなければ null を返し**、
 * 呼び出し側はカーネルを呼ばずに断る(§0.a-0.30)。
 */
function toMeasureRequest(
  steps: readonly ResolvedSolidStep[],
  targets: readonly MeasureTarget[],
  kind: 'distance' | 'massProperties',
): MeasureRequest | null {
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const specs: MeasureTargetSpec[] = [];
  for (const target of targets) {
    const bodyKey = keyByFeatureId.get(target.bodyFeatureId);
    if (bodyKey === undefined) {
      return null;
    }
    specs.push({
      bodyKey,
      subShape: target.subShape === null ? null : toSubShapeQuery(target.subShape),
    });
  }
  return { targets: specs, kind };
}

/** 測定の結果を model の言葉へ詰め替える(kernel の型を外へ出さない、NFR-MA-1)。 */
function toMeasureOutcome(result: MeasureResult): MeasureOutcome {
  switch (result.kind) {
    case 'distance':
      return {
        kind: 'distance',
        distance: result.distance,
        pointA: result.pointA,
        pointB: result.pointB,
        inner: result.inner,
      };
    case 'massProperties':
      return {
        kind: 'massProperties',
        volume: result.volume,
        area: result.area,
        centreOfMass: result.centreOfMass,
        principalMoments: result.principalMoments,
        principalAxes: result.principalAxes,
      };
    case 'failed':
      return { kind: 'failed', message: result.message };
  }
}

/* ------------------------------------------------------------------ *
 * 書き出しと読み込み(FR-802〜804、FR-811、P6 タスク32b)
 * ------------------------------------------------------------------ */

/**
 * 色 1 つ(sRGB の 0〜1)。`exchange/exportColors.ts` の `rgbTupleOf` が返す並びそのままで、
 * kernel の `RgbTuple` と欄が同じ。
 *
 * **model にも名前を置くのは、`packages/ui` が kernel の型を輸入できないから**である
 * (依存の向きは `ui → model → kernel`、rules/04)。書き出しの依頼を組み立てるのは ui なので、
 * ui が読める言葉で受ける口をここに置く(`exchange/types.ts` の `ExportMeshQuality` と同じ理由)。
 */
export type ExportColor = readonly [number, number, number];

/**
 * 書き出す立体 1 つ(model の言葉)。
 *
 * **形も段の鍵も渡さない。** 立体は「それを作ったフィーチャーの id」で指し、鍵
 * (`ResolvedSolidStep.key`)への引き直しは `KernelBridge.exportShapes` が行う
 * (測定の `MeasureTarget` とまったく同じ流儀、§0.a-0.5)。
 *
 * 名前と色は**ファイルへ書き込む値**で、履歴の名前と外観の割り当て(`bodyColorsFor` /
 * `faceColorsFor`)から呼び出し側が組む。**色を書かない指定のときは `null` と省略で渡す**
 * ——形式ごとに「色を書くか」の欄を持つのは STEP だけなので、ほかの形式では
 * 値そのものを空にするのが色を落とす唯一の手立てである(§0.a-0.22)。
 */
export interface ShapeExportBody {
  /** 書き出す立体を作ったフィーチャーの id(= ボディの id)。 */
  readonly featureId: string;
  /** 立体の名前。`null` なら幾何カーネルの既定になる。 */
  readonly name: string | null;
  /** 立体の色。`null` なら色を付けない。 */
  readonly color: ExportColor | null;
  /**
   * 面ごとの色(面の通し番号 → 色。§2.5.1)。**面の割り当ては立体の色より優先する。**
   * 色を付けた面が 1 枚も無い立体では省く(空の表を作らない)。
   */
  readonly faceColors?: ReadonlyMap<number, ExportColor>;
}

/**
 * 書き出しの形式(幾何カーネルの言葉)。**3MF だけ `'mesh'`** で、三角形までを受け取って
 * ZIP と XML は `packages/io` が組む(§0.a-0.19。io は幾何カーネルを呼べない)。
 */
export type ShapeExportFormat = 'step' | 'stl' | 'obj' | 'gltf' | 'mesh';

/** 書き出しの依頼(model の言葉)。 */
export interface ShapeExportOptions {
  readonly format: ShapeExportFormat;
  /** 書き出す立体。並びがそのままファイルの中の並びになる。 */
  readonly bodies: readonly ShapeExportBody[];
  /** 三角形の細かさの対(§0.a-0.64)。三角形を使わない形式(STEP)では `null`。 */
  readonly meshQuality: ExportMeshQuality | null;
  /** 色を書くか(§0.a-0.22)。**効くのは STEP だけ**(ほかは `color` を空にして落とす)。 */
  readonly withColors: boolean;
  /** STL を文字で書くか(§0.a-0.14)。STL 以外では見ない。 */
  readonly ascii: boolean;
  /** ファイル名の基(拡張子なし)。`.obj` と `.mtl` は同じ基を使う(§0.a-0.16)。 */
  readonly baseName: string;
}

/**
 * 書き出したファイル 1 つ。**名前を変えずにそのまま保存する。**
 * `.obj` の材質の行が `.mtl` を名前で指しているので、変えると色が付かない(§2.4)。
 */
export interface ExportedFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/** 書き出した立体 1 つぶんの三角形(3MF のときだけ返る。§0.a-0.19)。 */
export interface ExportedMeshBody {
  /** 依頼に入れた名前をそのまま返す(io が 3MF の物体の名前に使う)。 */
  readonly name: string | null;
  /** 依頼に入れた色をそのまま返す。 */
  readonly color: ExportColor | null;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * 書き出しの結果。**断りは投げずに `kind: 'failed'` で返す**(測定と同じ流儀)。
 * 理由の日本語は幾何カーネルが持っているものをそのまま持ち回る(FR-504、NFR-RE-1)。
 */
export type ShapeExportOutcome =
  | {
      readonly kind: 'files';
      /** 保存するファイル。STEP は `[.step]`、OBJ は `[.obj, .mtl]`、glTF は `[.glb]`。 */
      readonly files: readonly ExportedFile[];
      /** 面積 0 で落とした三角形の枚数。三角形を使わない形式では 0。 */
      readonly droppedTriangleCount: number;
    }
  | { readonly kind: 'meshes'; readonly bodies: readonly ExportedMeshBody[] }
  | { readonly kind: 'failed'; readonly message: string };

/** 読み込みの依頼(model の言葉)。3MF は `packages/io` が読むのでここには入らない。 */
export interface ShapeImportOptions {
  readonly format: 'step' | 'stl' | 'obj' | 'gltf';
  /** 仮想ファイルに付ける名前。中身の判別には使われない。 */
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** 色を読むか(効くのは STEP だけ。省くと読む)。 */
  readonly withColors?: boolean;
}

/** 読み込んだ三角形の形の中身(`.pcad` の `meshes/<id>.bin` へそのまま入る並び)。 */
export interface ImportedTriangles {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** 読み込んだ立体 1 つに共通する欄。 */
interface ImportedBodyCommon {
  /** ファイルに入っていた名前。無ければ `null`。 */
  readonly name: string | null;
  /** ファイルに入っていた色。無ければ `null`(当面は使わない。§0.a-0.28)。 */
  readonly color: ExportColor | null;
  /** 体積(mm³)。 */
  readonly volume: number;
  /** 画面用の三角形の枚数。 */
  readonly triangleCount: number;
}

/**
 * 読み込んだ立体 1 つ(FR-802、§2.8)。**B-rep を持つ枝と三角形だけの枝を型で分ける。**
 * 「無い値に `null` を入れる」形にすると、受け取る側が確かめ忘れても型検査が助けない
 * (kernel の `ShapeImportBody` と同じ分け方)。
 */
export type ImportedBody =
  | (ImportedBodyCommon & {
      readonly bodyKind: 'solid' | 'shell';
      /** `.pcad` の `shapes/<id>.brep` へそのまま入れるバイト列。 */
      readonly brepBytes: Uint8Array;
    })
  | (ImportedBodyCommon & {
      readonly bodyKind: 'mesh';
      /** `.pcad` の `meshes/<id>.bin` へ入れる三角形。 */
      readonly mesh: ImportedTriangles;
    });

/**
 * 読み込みの結果(FR-802、FR-811)。**座標はすでに mm へ換算済み**(NFR-RE-3)で、
 * `unit` は「ファイルが何で書かれていたか」の記録である。`'other'`(STL / OBJ)のときは
 * 呼び出し側が利用者へ訊く(§0.a-0.6)。
 */
export type ShapeImportOutcome =
  | {
      readonly kind: 'imported';
      readonly bodies: readonly ImportedBody[];
      readonly unit: 'mm' | 'inch' | 'other';
    }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 書き出す立体の段の鍵が引けなかったとき。
 *
 * kernel(`worker/kernelApi.ts` の `MISSING_BODY_MESSAGE`)が形状キャッシュに鍵が無かった
 * ときに返すのと**同じ日本語**。kernel はこの文字列を輸出していないので、断りの文言を
 * 1 つに揃えるためここへ複製する(測定の `MEASURE_MISSING_SHAPE_MESSAGE` と同じ扱い)。
 * **1 つでも引けなければ書き出しごと断る**——一部だけ入ったファイルを渡すと、利用者は
 * 欠けに気づかないまま他の CAD へ持っていくことになる(NFR-UX-5)。
 */
const EXPORT_MISSING_SHAPE_MESSAGE = 'もとになる立体が見つかりませんでした。もう一度計算し直してください。';

/**
 * 頼んでいない形式が返ったとき。**この橋は `'brep'` を頼まない**(`.pcad` へ抱き込む
 * バイト列は読み込みの経路で得る)ので起こらないが、網羅 `switch` の枝を黙って落とさない
 * ために断りを 1 つ置く。エラーコードは増やしていない(日本語の 1 行だけ)。
 */
const EXPORT_UNEXPECTED_FORMAT_MESSAGE = '書き出せませんでした。もう一度お試しください。';

/** STEP のファイル名に付ける拡張子。ほかの 3 形式の名前は幾何カーネルが組んで返す。 */
const STEP_FILE_EXTENSION = '.step';

/** カーネルが投げた理由を、そのまま画面へ出せる 1 行にする(文言の正本はカーネル側)。 */
function toFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 書き出す立体を kernel の言葉へ詰め替える。**1 つでも段の鍵が引けなければ `null`** を返し、
 * 呼び出し側はカーネルを呼ばずに断る(`toMeasureRequest` と同じ流儀)。
 */
function toShapeExportItems(
  steps: readonly ResolvedSolidStep[],
  bodies: readonly ShapeExportBody[],
): readonly ShapeExportItem[] | null {
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const items: ShapeExportItem[] = [];
  for (const body of bodies) {
    const bodyKey = keyByFeatureId.get(body.featureId);
    if (bodyKey === undefined) {
      return null;
    }
    items.push({
      bodyKey,
      name: body.name,
      color: body.color,
      faceColors: body.faceColors,
    });
  }
  return items;
}

/**
 * 三角形の細かさの対。三角形を使う形式なのに対が無いのは呼び出し側の取り違えだが、
 * **断らずに標準の細かさで書く**(NFR-RE-1「止めずに警告する」)。表の正本は
 * `exchange/types.ts` の 1 か所だけ(同じ 3 つの数を写さない)。
 */
function meshQualityOf(options: ShapeExportOptions): ExportMeshQuality {
  return options.meshQuality ?? EXPORT_MESH_QUALITY.normal;
}

/** 書き出しの依頼を kernel の言葉へ詰め替える(網羅 `switch`。形式が増えたら落ちる)。 */
function toShapeExportRequest(
  items: readonly ShapeExportItem[],
  options: ShapeExportOptions,
): ShapeExportRequest {
  switch (options.format) {
    case 'step':
      return { format: 'step', bodies: items, withColors: options.withColors };
    case 'stl':
      return {
        format: 'stl',
        bodies: items,
        ascii: options.ascii,
        baseName: options.baseName,
        ...meshQualityOf(options),
      };
    case 'obj':
    case 'gltf':
      return {
        format: options.format,
        bodies: items,
        baseName: options.baseName,
        ...meshQualityOf(options),
      };
    case 'mesh':
      return { format: 'mesh', bodies: items, ...meshQualityOf(options) };
  }
}

/**
 * 書き出しの結果を model の言葉へ詰め替える(kernel の型を外へ出さない、NFR-MA-1)。
 *
 * **STEP のファイル名だけはここで組む。** ほかの 3 形式は名前まで幾何カーネルが返す
 * (`.obj` が `.mtl` を名前で指すため)ので、呼び出し側から見た約束——「返ったファイルを
 * 名前のまま全部保存する」——を STEP でも同じにしておく。
 */
function toShapeExportOutcome(
  result: ShapeExportResult,
  options: ShapeExportOptions,
): ShapeExportOutcome {
  switch (result.format) {
    case 'step':
      return {
        kind: 'files',
        files: [
          { fileName: `${options.baseName}${STEP_FILE_EXTENSION}`, bytes: result.bytes },
        ],
        // STEP は三角形を通らないので、落とした三角形は 1 枚も無い。
        droppedTriangleCount: 0,
      };
    case 'stl':
    case 'obj':
    case 'gltf':
      return {
        kind: 'files',
        files: result.files,
        droppedTriangleCount: result.droppedTriangleCount,
      };
    case 'mesh':
      // 並びは依頼のままなので、名前と色は同じ位置の依頼から取れる(kernel の約束)。
      return {
        kind: 'meshes',
        bodies: result.bodies.map((body, index) => ({
          name: options.bodies[index]?.name ?? null,
          color: options.bodies[index]?.color ?? null,
          positions: body.triangles.positions,
          indices: body.triangles.indices,
        })),
      };
    case 'brep':
      return { kind: 'failed', message: EXPORT_UNEXPECTED_FORMAT_MESSAGE };
  }
}

/** 読み込みの依頼を kernel の言葉へ詰め替える(網羅 `switch`)。 */
function toShapeImportRequest(options: ShapeImportOptions): ShapeImportRequest {
  switch (options.format) {
    case 'step':
      return {
        format: 'step',
        bytes: options.bytes,
        fileName: options.fileName,
        withColors: options.withColors,
      };
    case 'stl':
      return { format: 'stl', bytes: options.bytes, fileName: options.fileName };
    case 'obj':
      return { format: 'obj', bytes: options.bytes, fileName: options.fileName };
    case 'gltf':
      return { format: 'gltf', bytes: options.bytes, fileName: options.fileName };
  }
}

/** 読み込んだ立体 1 つを model の言葉へ詰め替える(B-rep の枝と三角形の枝を保つ)。 */
function toImportedBody(body: ShapeImportBody): ImportedBody {
  const common: ImportedBodyCommon = {
    name: body.name,
    color: body.color,
    volume: body.volume,
    triangleCount: body.triangles.triangleCount,
  };
  if (body.bodyKind === 'mesh') {
    return {
      ...common,
      bodyKind: 'mesh',
      mesh: {
        positions: body.triangles.positions,
        normals: body.triangles.normals,
        indices: body.triangles.indices,
      },
    };
  }
  return { ...common, bodyKind: body.bodyKind, brepBytes: body.brepBytes };
}

/** 読み込みの結果を model の言葉へ詰め替える。 */
function toShapeImportOutcome(result: ShapeImportResult): ShapeImportOutcome {
  return {
    kind: 'imported',
    bodies: result.bodies.map((body) => toImportedBody(body)),
    unit: result.unit,
  };
}

/* ------------------------------------------------------------------ *
 * 3D プリント向けの点検(FR-815、P6 §0.51・§0.53・§2.16、タスク46 = 43a)
 * ------------------------------------------------------------------ */

/**
 * 画面に出ている三角形と**同じ細かさ**の対(§0.53 の色表示のための決め)。
 *
 * 点検の結果は**三角形ごとの真偽**で返り、ui はそれを画面の三角形へそのまま塗る
 * (`solid/printabilityColors.ts`)。塗る相手と測った相手の三角形の並びが違うと、
 * 赤や橙がまったく別の場所に付く。書き出し用の三角形は `buildExportMesh` が形の複製へ
 * 掛け直して作るが、**面の走査も向きの規則も画面用(`tessellate.ts`)とまったく同じ**
 * なので、細かさの対を画面と同じにすれば並びもそろう(`occt/exportMesh.ts` の注釈)。
 *
 * **数はカーネルの既定(`DEFAULT_LINEAR_DEFLECTION` / `DEFAULT_ANGULAR_DEFLECTION`)を
 * そのまま引く**——書き写すと、画面側の既定を変えたときにここだけ古くなる。
 * 書き出しの 3 択(`EXPORT_MESH_QUALITY`)にこの対は無い(`normal` は角度が 0.2 で、
 * 書き出しの精度のために画面より細かい)ので、別に 1 つ置いてある。
 */
export const DISPLAY_MESH_QUALITY: ExportMeshQuality = {
  deviationMm: DEFAULT_LINEAR_DEFLECTION,
  angularDeflectionRad: DEFAULT_ANGULAR_DEFLECTION,
};

/**
 * 点検の三角形ごとの真偽の読み出しと、しきい値の既定を**カーネルからそのまま出し直す**。
 *
 * このファイルの決まりは「kernel の**型**を外へ出さない」(冒頭の注釈)で、値の写しを
 * 禁じてはいない。ここで出し直すのは次の 3 つだけである。
 *
 * - `readPrintabilityFlag`: 詰めたビットの並べ方(下位ビットから)を知る唯一の関数。
 *   ui が同じ式を書き写すと、並べ方を変えたときに片方だけ古くなる
 *   (`sketchFilletGeometry` を model が写さずカーネルの式を使うのと同じ判断)。
 * - `DEFAULT_MIN_THICKNESS_MM` / `DEFAULT_OVERHANG_ANGLE_DEG`: 判定のしきい値の既定。
 *   プロパティ欄の初期値に要るが、数を写すと**画面に出る値と実際に使う値が食い違う**。
 *
 * どれも素の数と純関数で、`TopoDS_Shape` のようなカーネル固有の型は 1 つも通らない。
 */
export {
  DEFAULT_MIN_THICKNESS_MM,
  DEFAULT_OVERHANG_ANGLE_DEG,
  readPrintabilityFlag,
} from '@pointercad/kernel';

/** 点検のどの段を計算しているか(NFR-PF-4 の進み具合)。重いのは肉厚の段だけ。 */
export type PrintabilityPhase = 'watertight' | 'overhang' | 'thickness';

/** 点検の進み具合(NFR-PF-4)。kernel の `PrintabilityProgress` を model の言葉へ写したもの。 */
export interface PrintabilityProgressView {
  readonly phase: PrintabilityPhase;
  /** その段で見終わった三角形の枚数。 */
  readonly processed: number;
  /** 三角形の総数。 */
  readonly total: number;
  /** 全体でどこまで進んだか(0〜1)。 */
  readonly ratio: number;
}

/** 点検の進み具合を受け取る口(`PartProgressCallback` と同じ流儀)。 */
export type PrintabilityProgressCallback = (progress: PrintabilityProgressView) => void;

/**
 * 点検の要約(数と真偽だけ。画面の文言は ui が作る)。
 *
 * **欄の名前も型もカーネルの `PrintabilitySummary` にそろえてある**ので、詰め替えは
 * 欄を写すだけで済む(`toPrintabilityOutcome`)。名前をそろえるのは、点検の意味を決めて
 * いるのがカーネル側の 1 か所(`occt/inspectPrintability.ts`)だからで、model が別の
 * 言い換えを作ると、しきい値の意味が 2 通りに割れる。
 */
export interface PrintabilitySummary {
  /** 点検した三角形の総数(面積 0 のものを含む)。 */
  readonly triangleCount: number;
  /** 面積 0(または座標が `NaN`)で点検から外した三角形の枚数。 */
  readonly degenerateCount: number;
  /** 肉厚の段で見終わった三角形の枚数。途中でやめると総数より少なくなる。 */
  readonly inspectedTriangleCount: number;
  /** しきい値より薄かった三角形の枚数。 */
  readonly thinCount: number;
  /** 支持が要る(せり出している)三角形の枚数。 */
  readonly overhangCount: number;
  /** ちょうど 2 枚に共有されていない辺の本数。 */
  readonly openEdgeCount: number;
  /** そういう辺を 1 本でも持つ三角形の枚数。 */
  readonly openEdgeTriangleCount: number;
  /** 閉じた形か(開いた辺が 1 本も無いか)。 */
  readonly watertight: boolean;
  /** 測れた肉厚のうち最も薄い値(mm)。1 本も反対側に当たらなければ `null`。 */
  readonly minThicknessFoundMm: number | null;
  /** 判定に使った最小肉厚のしきい値(mm)。 */
  readonly minThicknessMm: number;
  /** 判定に使ったせり出しの角度(度)。 */
  readonly overhangAngleDeg: number;
  /** 肉厚の判定に使った升目の大きさ(mm)。形が大きいと既定より粗くなる。 */
  readonly cellSizeMm: number;
}

/**
 * 点検の結果(FR-815)。
 *
 * 三角形ごとの真偽は**1 ビットずつ詰めてある**(5 万三角形で 1 本 6,250 バイト、
 * 3 本で 18.3KiB。§2.17-9)。読み出しは `readPrintabilityFlag`——**同じビットの並べ方を
 * 2 か所に書かない**ため、model はカーネルの純関数をそのまま輸出し直す
 * (`sketchFilletGeometry` と同じ扱い)。
 */
export interface PrintabilityReport {
  /** 三角形の総数(ビット列の長さの根拠)。 */
  readonly triangleCount: number;
  /** しきい値より薄い三角形。 */
  readonly thinTriangles: Uint8Array;
  /** 支持が要る三角形。 */
  readonly overhangTriangles: Uint8Array;
  /** 開いた辺を持つ三角形。 */
  readonly openEdgeTriangles: Uint8Array;
  readonly summary: PrintabilitySummary;
  /** 途中でやめたか。**やめても結果は返る**(肉厚だけが測ったところまでになる)。 */
  readonly cancelled: boolean;
}

/**
 * 点検の結果。**断りは投げずに `kind: 'failed'` で返す**(測定・書き出しと同じ流儀、
 * FR-504、NFR-RE-1)。理由の日本語はカーネルが持っているものをそのまま持ち回る。
 */
export type PrintabilityOutcome =
  | { readonly kind: 'inspected'; readonly report: PrintabilityReport }
  | { readonly kind: 'failed'; readonly message: string };

/** 点検の依頼(model の言葉)。 */
export interface PrintabilityOptions {
  /**
   * 点検する立体を作ったフィーチャーの id。**並びがそのまま結果の三角形の並びになる**
   * (2 つ以上を指すと、カーネルは三角形を 1 つに連ねてから測る)。空なら断る。
   */
  readonly bodies: readonly string[];
  /**
   * 三角形の細かさの対。**省くと画面と同じ細かさ**(`DISPLAY_MESH_QUALITY`)になり、
   * 三角形の並びが画面と一致して色をそのまま塗れる(§0.53)。細かさを変えると
   * 判定は精しくなるが、並びが画面と食い違うので色は塗れなくなる。
   */
  readonly meshQuality?: ExportMeshQuality | null;
  /** 最小肉厚のしきい値(mm)。省くとカーネルの既定(0.8mm)。 */
  readonly minThicknessMm?: number;
  /** せり出しの角度のしきい値(度)。省くとカーネルの既定(45°)。 */
  readonly overhangAngleDeg?: number;
  readonly onProgress?: PrintabilityProgressCallback;
  readonly shouldCancel?: PartCancelToken;
}

/**
 * 点検する立体が 1 つも指定されていないとき。
 *
 * カーネルは三角形が 0 枚のときに `PRINTABILITY_NO_TRIANGLE_MESSAGE`(「点検できる形が
 * ありません。」)で断るが、**立体を 1 つも渡さないなら Worker を起こす意味が無い**ので
 * 同じ日本語をここで返す(測定の `MEASURE_MISSING_SHAPE_MESSAGE` と同じ扱いで、
 * 文言をそろえるために複製する)。
 */
const PRINTABILITY_NO_BODY_MESSAGE = '点検できる形がありません。';

/** 点検の依頼をカーネルの言葉へ詰め替える。 */
function toShapeInspectRequest(
  items: readonly ShapeExportItem[],
  options: PrintabilityOptions,
): ShapeInspectRequest {
  const quality = options.meshQuality ?? DISPLAY_MESH_QUALITY;
  return {
    bodies: items,
    deviationMm: quality.deviationMm,
    angularDeflectionRad: quality.angularDeflectionRad,
    minThicknessMm: options.minThicknessMm,
    overhangAngleDeg: options.overhangAngleDeg,
  };
}

/**
 * 点検する立体を、書き出しと同じ「段の鍵の一覧」へ引き直す。
 *
 * **名前も色も点検では使わない**(`ShapeInspectRequest` の注釈)ので `null` を入れる。
 * 引き直しそのものは書き出しと同じ関数(`toShapeExportItems`)に任せる——鍵が引けない
 * ときの判断を 2 か所に書かないため。
 */
function toShapeInspectItems(
  steps: readonly ResolvedSolidStep[],
  bodies: readonly string[],
): readonly ShapeExportItem[] | null {
  return toShapeExportItems(
    steps,
    bodies.map((featureId) => ({ featureId, name: null, color: null })),
  );
}

/**
 * 点検の進捗を model の言葉へ写す(Comlink を通らない直結の橋のぶん)。
 *
 * Worker 版は `toPrintabilityProgressProxy` が同じ写しを Comlink.proxy で包んで行う。
 * 写しそのものを 2 か所に書かないよう、包まない版をここに置いてあちらから使う。
 */
function printabilityProgressOf(
  onProgress: PrintabilityProgressCallback | undefined,
): ((progress: PrintabilityProgress) => void) | undefined {
  if (onProgress === undefined) {
    return undefined;
  }
  return (progress: PrintabilityProgress) => {
    onProgress({
      phase: progress.phase,
      processed: progress.processed,
      total: progress.total,
      ratio: progress.ratio,
    });
  };
}

/** 点検の結果を model の言葉へ詰め替える(kernel の型を外へ出さない、NFR-MA-1)。 */
function toPrintabilityOutcome(result: PrintabilityResult): PrintabilityOutcome {
  return {
    kind: 'inspected',
    report: {
      triangleCount: result.triangleCount,
      thinTriangles: result.thinTriangles,
      overhangTriangles: result.overhangTriangles,
      openEdgeTriangles: result.openEdgeTriangles,
      summary: {
        triangleCount: result.summary.triangleCount,
        degenerateCount: result.summary.degenerateCount,
        inspectedTriangleCount: result.summary.inspectedTriangleCount,
        thinCount: result.summary.thinCount,
        overhangCount: result.summary.overhangCount,
        openEdgeCount: result.summary.openEdgeCount,
        openEdgeTriangleCount: result.summary.openEdgeTriangleCount,
        watertight: result.summary.watertight,
        minThicknessFoundMm: result.summary.minThicknessFoundMm,
        minThicknessMm: result.summary.minThicknessMm,
        overhangAngleDeg: result.summary.overhangAngleDeg,
        cellSizeMm: result.summary.cellSizeMm,
      },
      cancelled: result.cancelled,
    },
  };
}

/** model から幾何カーネルへの唯一の接点。ここ以外から kernel を呼ばない。 */
export interface KernelBridge {
  /** 面の一覧をカーネルへ渡し、表示用の三角形を受け取る(FR-309)。 */
  tessellateSketchFaces(faces: readonly ResolvedFace[]): Promise<SketchTessellationOutcome>;
  /**
   * 解決済みの段を履歴順にカーネルへ渡し、表示用のボディを受け取る(FR-401〜404、要件§6.3)。
   * 文書が変わったときだけ呼ぶ。ホバー・選択・視点操作では呼ばない(§2.4)。
   *
   * Worker が壊れて応答しなくなったときは例外を投げず、進行中の依頼を
   * `KERNEL_BROKEN_MESSAGE` の失敗として解決する(§2.9、NFR-RE-1「止めずに警告する」)。
   * 次にこの関数を呼んだときは Worker を作り直してから依頼を出す。作り直すと
   * 形状キャッシュが空になるので、次の再計算は全段作り直しになる(遅くなるが落ちない)。
   */
  recomputeSolids(
    steps: readonly ResolvedSolidStep[],
    options?: SolidRecomputeOptions,
  ): Promise<SolidRecomputeOutcome>;
  /**
   * 輪郭を距離ぶんずらした曲線の列をカーネルへ頼む(FR-321、P4 タスク15)。
   * 何件でも 1 回の往復でまとめて頼め、1 件失敗しても残りは返る(FR-504)。
   */
  offsetSketchCurves(
    requests: readonly SketchOffsetRequestItem[],
  ): Promise<SketchOffsetResult>;
  /**
   * 立体の面・辺の輪郭を作図面へ投影した曲線をカーネルへ頼む(FR-325、P4 タスク25)。
   * 何件でも 1 回の往復でまとめて頼め、1 件失敗しても残りは返る(FR-504)。
   */
  projectSketchCurves(
    requests: readonly SketchProjectionRequestItem[],
  ): Promise<SketchProjectionResult>;
  /**
   * 立体と作図面の交線(断面の輪郭)をカーネルへ頼む(FR-325)。
   * **交わらないときは失敗ではなく曲線 0 本**で返る(断るのは呼び出し側)。
   */
  sectionSketchCurves(
    requests: readonly SketchProjectionRequestItem[],
  ): Promise<SketchProjectionResult>;
  /**
   * 覚えてある形を測る(FR-1101、FR-1102、P5 タスク29)。**再計算を起こさない読み取り**
   * (§0.a-0.30)。対象は立体を作ったフィーチャーの id で指し、`steps` から段の鍵
   * (`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す(外観の面の照合と同じ流儀)。
   *
   * **`steps` の中に鍵が引けない対象が 1 つでもあれば、カーネルを呼ばずに断る**
   * (測定は読み取りだけなので、ここから再計算を起こさない、§0.a-0.30)。
   */
  measure(
    steps: readonly ResolvedSolidStep[],
    targets: readonly MeasureTarget[],
    kind: 'distance' | 'massProperties',
  ): Promise<MeasureOutcome>;
  /**
   * 覚えてある形をファイルへ書き出す(FR-803、FR-804、P6 タスク32b)。**測定と同じく
   * 再計算を起こさない読み取り**で、対象は立体を作ったフィーチャーの id で指し、`steps` から
   * 段の鍵(`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す。
   *
   * **1 つでも鍵が引けなければ、カーネルを呼ばずに `kind: 'failed'` で断る**(一部だけ
   * 入ったファイルを渡さない、NFR-UX-5)。書けなかった理由も投げずに返す(NFR-RE-1)。
   */
  exportShapes(
    steps: readonly ResolvedSolidStep[],
    options: ShapeExportOptions,
  ): Promise<ShapeExportOutcome>;
  /**
   * ファイルから立体を読み込む(FR-802、FR-811、P6 タスク32b)。**今の文書には触れない**
   * ——読めた形を返すだけで、履歴へ積むかどうかは呼び出し側が決める(NFR-RE-1)。
   *
   * 読めなかった理由は投げずに `kind: 'failed'` で返す(文言の正本は幾何カーネル)。
   */
  importShape(options: ShapeImportOptions): Promise<ShapeImportOutcome>;
  /**
   * 3D プリント向けの点検(FR-815、P6 タスク46)。**測定・書き出しと同じく再計算を
   * 起こさない読み取り**で、対象は立体を作ったフィーチャーの id で指し、`steps` から
   * 段の鍵(`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す。
   *
   * **1 つでも鍵が引けなければ、カーネルを呼ばずに `kind: 'failed'` で断る**(測定と同じ、
   * §0.a-0.30)。点検できなかった理由も投げずに返す(NFR-RE-1)。
   *
   * 進み具合と中止は `options` に渡す(`recomputeSolids` と同じ形)。**中止しても結果は
   * 返る**(`PrintabilityReport.cancelled` が真になり、肉厚だけが測ったところまでになる)。
   */
  inspectPrintability(
    steps: readonly ResolvedSolidStep[],
    options: PrintabilityOptions,
  ): Promise<PrintabilityOutcome>;
  dispose(): void;
}

/**
 * 解決済みの曲線をカーネルの言葉へ直す。長さは mm、角度はラジアン(FR-203)。
 *
 * 楕円の角度は解決の段でパラメータ角へ直してあるので、そのまま渡す(§1.4-8)。
 * **全周の楕円は開始角・終了角を渡さない**: カーネルは両方そろっているときだけ
 * 弧として作り、無ければ全周の楕円にする(`makeEllipseEdge.ts` の決め)。
 */
export function toCurveSpec(curve: ResolvedCurve): CurveSpec {
  switch (curve.kind) {
    case 'segment':
      return { kind: 'segment', from: curve.from, to: curve.to };
    case 'arc':
      return {
        kind: 'arc',
        center: curve.center,
        normal: curve.normal,
        xAxis: curve.xAxis,
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'ellipse':
      if (isFullEllipse(curve)) {
        return {
          kind: 'ellipse',
          center: curve.center,
          normal: curve.normal,
          majorAxis: curve.majorAxis,
          majorRadius: curve.majorRadius,
          minorRadius: curve.minorRadius,
        };
      }
      return {
        kind: 'ellipse',
        center: curve.center,
        normal: curve.normal,
        majorAxis: curve.majorAxis,
        majorRadius: curve.majorRadius,
        minorRadius: curve.minorRadius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'spline':
      return {
        kind: 'spline',
        mode: curve.mode,
        points: curve.points,
        closed: curve.closed,
      };
  }
}

/** 面 1 枚の依頼を作る。結果との対応づけには面フィーチャーの id を使う。 */
export function toFaceRequest(face: ResolvedFace): PlanarFaceRequest {
  return { id: face.featureId, curves: face.curves.map((curve) => toCurveSpec(curve)) };
}

/** 全周(ラジアン)。カーネルが角度を省いた楕円は全周の意味になる。 */
const FULL_TURN = 2 * Math.PI;

/**
 * カーネルから返った曲線を model の言葉へ直す(FR-321、P4 タスク15)。`toCurveSpec` の逆。
 *
 * `featureId` は結果を持つフィーチャー(オフセット)の id を付ける。オフセットが返すのは
 * 線分と円弧だけ(`makeOffsetWire.ts`)だが、型の上では 4 種すべて来うるので全部を受ける。
 * B スプラインが返る道(将来の投影・交差)では、曲線の式ではなく**点列**として受ける
 * (`ResolvedSpline` は通過点・制御点しか持たない、`types.ts` の注釈)。
 * 全周の楕円は角度が省かれて返るので、0 から 1 周ぶんとして読む(`toCurveSpec` の裏返し)。
 */
export function fromCurveSpec(spec: CurveSpec, featureId: string): ResolvedCurve {
  switch (spec.kind) {
    case 'segment':
      return { kind: 'segment', featureId, from: spec.from, to: spec.to };
    case 'arc':
      return {
        kind: 'arc',
        featureId,
        center: spec.center,
        normal: spec.normal,
        xAxis: spec.xAxis,
        radius: spec.radius,
        startAngle: spec.startAngle,
        endAngle: spec.endAngle,
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        featureId,
        center: spec.center,
        normal: spec.normal,
        majorAxis: spec.majorAxis,
        majorRadius: spec.majorRadius,
        minorRadius: spec.minorRadius,
        startAngle: spec.startAngle ?? 0,
        endAngle: spec.endAngle ?? FULL_TURN,
      };
    case 'spline':
      return {
        kind: 'spline',
        featureId,
        mode: spec.mode,
        points: spec.points,
        closed: spec.closed,
      };
  }
}

/** 角の作り方(model の言葉)をカーネルの言葉へ直す。 */
function toJoinType(corner: OffsetCornerKind): OffsetJoinType {
  return corner === 'sharp' ? 'intersection' : 'arc';
}

/** オフセット 1 件の依頼をカーネルの言葉へ直す。 */
function toOffsetItem(request: SketchOffsetRequestItem): SketchOffsetItem {
  return {
    id: request.featureId,
    curves: request.curves.map((curve) => toCurveSpec(curve)),
    distance: request.distance,
    joinType: toJoinType(request.corner),
  };
}

/** オフセットが返らなかったとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_OFFSET_MESSAGE = 'カーネルからオフセットの結果が返りませんでした。';

/**
 * オフセットの結果を model の言葉へ詰め替える。
 * 頼んだのに結果も理由も返らなかった id は、理由を補って失敗として扱う(FR-504。
 * 面の詰め替え `toOutcome` と同じ書き方)。
 */
export function toOffsetResult(
  requests: readonly SketchOffsetRequestItem[],
  outcome: SketchOffsetOutcome,
): SketchOffsetResult {
  const results: SketchOffsetEntry[] = outcome.results.map((result) => ({
    featureId: result.id,
    contours: result.contours.map((contour) => ({
      curves: contour.curves.map((curve) => fromCurveSpec(curve, result.id)),
      closed: contour.closed,
    })),
  }));
  const failures: SketchOffsetFailure[] = outcome.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  const reported = new Set<string>(results.map((result) => result.featureId));
  for (const failure of failures) {
    reported.add(failure.featureId);
  }
  for (const request of requests) {
    if (!reported.has(request.featureId)) {
      failures.push({ featureId: request.featureId, message: MISSING_OFFSET_MESSAGE });
    }
  }

  return { results, failures };
}

/* ------------------------------------------------------------------ *
 * 投影・交差の詰め替え(FR-325、P4 タスク25)
 * ------------------------------------------------------------------ */

/** 作図面の 2 次元座標をワールド座標へ戻す。第 2 軸は `WorkPlane.axisV`(= 法線 × 第 1 軸)。 */
function planePointToWorld(plane: WorkPlane, uv: Vec2Tuple): Vec3 {
  return addVec3(
    plane.origin,
    addVec3(scaleVec3(plane.axisU, uv[0]), scaleVec3(plane.axisV, uv[1])),
  );
}

/**
 * カーネルが返した作図面の上の曲線を、model の解決済みの曲線へ戻す(FR-325)。
 *
 * - 線分・円弧は形のまま残る(投影のほとんどの用途がここに入る。`makeProjection.ts`)。
 * - 点列(傾いた円・楕円・自由曲線)は**通過点のスプライン**として受ける。
 *   `ResolvedSpline` は通過点しか持たない型なので、そのまま詰められる
 *   (`fromCurveSpec` の注釈が予告していた「B スプラインが返る道」がこれ)。
 *
 * 円弧の角度は「第 1 軸から第 2 軸へ回る向きが正」で、`ResolvedArc` の約束と同じ
 * (`makeProjection.ts` の `PlaneArc` の注釈)。そのまま渡してよい。
 */
export function fromPlaneCurve(
  curve: PlaneCurve,
  plane: WorkPlane,
  featureId: string,
): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return {
        kind: 'segment',
        featureId,
        from: planePointToWorld(plane, curve.from),
        to: planePointToWorld(plane, curve.to),
      };
    case 'arc':
      return {
        kind: 'arc',
        featureId,
        center: planePointToWorld(plane, curve.center),
        normal: plane.normal,
        xAxis: plane.axisU,
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'polyline':
      return {
        kind: 'spline',
        featureId,
        mode: 'interpolate',
        points: curve.points.map((point) => planePointToWorld(plane, point)),
        closed: curve.closed,
      };
  }
}

/** 作図面を kernel の言葉へ直す。第 2 軸は kernel が「法線 × 第 1 軸」で作り直す。 */
function toPlaneFrame(plane: WorkPlane): SketchPlaneFrame {
  return { origin: plane.origin, axisU: plane.axisU, normal: plane.normal };
}

/** 投影の依頼をカーネルの言葉へ直す。 */
function toProjectionItem(request: SketchProjectionRequestItem): SketchProjectionItem {
  return {
    id: request.featureId,
    shapeKey: request.bodyKey,
    subShape: request.source === null ? null : toSubShapeQuery(request.source),
    plane: toPlaneFrame(request.plane),
  };
}

/** 交差の依頼をカーネルの言葉へ直す(切るのは立体そのものなので指紋は渡さない)。 */
function toSectionItem(request: SketchProjectionRequestItem): SketchSectionItem {
  return {
    id: request.featureId,
    shapeKey: request.bodyKey,
    plane: toPlaneFrame(request.plane),
  };
}

/** 投影・交差が返らなかったとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_PROJECTION_MESSAGE = 'カーネルから投影・交差の結果が返りませんでした。';

/**
 * 投影・交差の結果を model の言葉へ詰め替える。
 * 頼んだのに結果も理由も返らなかった id は理由を補って失敗にする(`toOffsetResult` と同じ)。
 */
export function toProjectionResult(
  requests: readonly SketchProjectionRequestItem[],
  outcome: SketchProjectionOutcome,
): SketchProjectionResult {
  const planeByFeature = new Map(requests.map((request) => [request.featureId, request.plane]));
  const results: SketchProjectionEntry[] = [];
  const failures: SketchProjectionFailure[] = outcome.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  for (const result of outcome.results) {
    const plane = planeByFeature.get(result.id);
    if (plane === undefined) {
      // 頼んでいない id が返ることは無いが、返ってきても黙って捨てず理由を残す。
      failures.push({ featureId: result.id, message: MISSING_PROJECTION_MESSAGE });
      continue;
    }
    results.push({
      featureId: result.id,
      curves: result.curves.map((curve) => fromPlaneCurve(curve, plane, result.id)),
    });
  }

  const reported = new Set<string>(results.map((result) => result.featureId));
  for (const failure of failures) {
    reported.add(failure.featureId);
  }
  for (const request of requests) {
    if (!reported.has(request.featureId)) {
      failures.push({ featureId: request.featureId, message: MISSING_PROJECTION_MESSAGE });
    }
  }

  return { results, failures };
}

/**
 * 部分形状の指紋を kernel の言葉(`SubShapeQuery`)へ詰め替える(§2.4.2、§2.8、タスク17 手順3)。
 *
 * model の `SubShapeQueryPlan`(= `SubShapeRef`)は「そのボディを作ったフィーチャーの id」
 * (`bodyFeatureId`)を持つが、カーネルは段の対象(targetKey で指したボディ)の中だけを
 * 探すのでその id は要らない。`fingerprint` に包まれた欄をカーネルの平らな形へ展開する。
 * `as` は使わず、種類ごとに手で組む(fingerprint.kind で分岐し、各節を return で閉じる)。
 */
function toSubShapeQuery(reference: SubShapeQueryPlan): SubShapeQuery {
  const { index, fingerprint } = reference;
  switch (fingerprint.kind) {
    case 'face':
      return {
        kind: 'face',
        index,
        surfaceKind: fingerprint.surfaceKind,
        area: fingerprint.area,
        position: fingerprint.position,
        axis: fingerprint.axis,
        radius: fingerprint.radius,
      };
    case 'edge':
      return {
        kind: 'edge',
        index,
        curveKind: fingerprint.curveKind,
        length: fingerprint.length,
        position: fingerprint.position,
        axis: fingerprint.axis,
        radius: fingerprint.radius,
      };
    case 'vertex':
      return { kind: 'vertex', index, position: fingerprint.position };
  }
}

/**
 * 罫線面・ロフトの断面 1 つをカーネルの言葉へ直す(FR-430、FR-410、P5 §2.9)。
 * 曲線の並びは `toCurveSpec` を使い回し、球は中心と半径をそのまま渡す。
 */
function toThruSectionSpec(section: ThruSectionPlan): ThruSectionSpec {
  switch (section.kind) {
    case 'curves':
      return { kind: 'curves', curves: section.curves.map((curve) => toCurveSpec(curve)) };
    case 'sphere':
      return { kind: 'sphere', center: section.center, radius: section.radius };
    case 'faceQuery':
      // 立体の面(§0.a-0.73)。輪郭の取り出しはカーネルの中で行うので、指紋と
      // 対象の段の鍵だけを渡す(穴・面取りの面と同じ扱い)。対象は消費しない(§0.a-0.27)。
      return {
        kind: 'faceQuery',
        targetKey: section.targetKey,
        query: toSubShapeQuery(section.query),
      };
  }
}

/**
 * 解決済みの 1 段の作り方をカーネルの言葉へ直す。
 * 向き・反転・両側の平行移動・角度の度→ラジアンは resolvePart が済ませてあるので、
 * ここでやるのは欄の名前を合わせることと、曲線・指紋を kernel の形へ直すことだけ。
 * 各節は return で閉じる(no-fallthrough)。
 *
 * 穴・ねじ穴・R面取り・C面取り・ばねの欄(`centers` / `transforms` / `thread` / `mark` / `size` 等)は
 * model 側の型(resolvePart.ts の `SolidStepPlan`)と kernel 側の型(kernel/src/types.ts の
 * `HoleStepSpec` 等)で欄の名前と形をそろえてあるので、指紋(`face` / `targets`)だけ
 * `toSubShapeQuery` で詰め替え、残りはそのまま渡す(タスク17 手順3)。
 */
function toSolidStepSpec(plan: SolidStepPlan): SolidStepSpec {
  switch (plan.kind) {
    case 'extrude':
      // P5 で足した終端・傾き・薄板(FR-415・FR-401・FR-416)は**省略されたまま渡す**。
      // 段に無い欄はカーネルでも既定(距離ぶんを片側へ、傾きなし、中実)になるので、
      // P2 からの押し出しの依頼は 1 ドットも変わらない(`ExtrudeStepSpec` の注釈)。
      return {
        kind: 'extrude',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        direction: plan.direction,
        distance: plan.distance,
        ...(plan.end === undefined ? {} : { end: plan.end }),
        ...(plan.taperAngle === undefined
          ? {}
          : { taperAngle: plan.taperAngle, taperOutward: plan.taperOutward ?? false }),
        ...(plan.thin === undefined || plan.thin === null ? {} : { thin: plan.thin }),
        ...(plan.targetKey === undefined || plan.targetKey === null
          ? {}
          : { targetKey: plan.targetKey }),
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        axisOrigin: plan.axisOrigin,
        axisDirection: plan.axisDirection,
        angle: plan.angle,
      };
    case 'sew':
      return {
        kind: 'sew',
        profiles: plan.profiles.map((profile) => profile.map((curve) => toCurveSpec(curve))),
        tolerance: plan.tolerance,
      };
    case 'boolean':
      return {
        kind: 'boolean',
        operation: plan.operation,
        targetKey: plan.targetKey,
        toolKey: plan.toolKey,
      };
    case 'hole':
      return {
        kind: 'hole',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        centers: plan.centers,
        diameter: plan.diameter,
        depth: plan.depth,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms,
        // 入口の形(ざぐり・皿もみ、FR-422、タスク46)。**広げないときは段にも載せない**
        // (省くとカーネルでも `{ kind: 'plain' }` になる。`HoleStepSpec.entry` の注釈)。
        ...(plan.entry === undefined ? {} : { entry: plan.entry }),
      };
    case 'thread':
      return {
        kind: 'thread',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        centers: plan.centers,
        drillDiameter: plan.drillDiameter,
        depth: plan.depth,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms,
        thread: plan.thread,
        mark: plan.mark,
        // 入口の形(ざぐり・皿もみ、FR-422、42c/46c)。穴とまったく同じ扱い(上の 'hole' 節)。
        ...(plan.entry === undefined ? {} : { entry: plan.entry }),
      };
    case 'fillet':
      return {
        kind: 'fillet',
        targetKey: plan.targetKey,
        targets: plan.targets.map((target) => toSubShapeQuery(target)),
        radius: plan.radius,
      };
    case 'chamfer':
      return {
        kind: 'chamfer',
        targetKey: plan.targetKey,
        targets: plan.targets.map((target) => toSubShapeQuery(target)),
        size: plan.size,
        swapReferenceFace: plan.swapReferenceFace,
      };
    case 'spring':
      // ばねは対象ボディを持たない(§0.36)ので targetKey が無い。
      return {
        kind: 'spring',
        origin: plan.origin,
        direction: plan.direction,
        coilDiameter: plan.coilDiameter,
        wireDiameter: plan.wireDiameter,
        pitch: plan.pitch,
        turns: plan.turns,
        handedness: plan.handedness,
      };
    case 'primitive':
      // 基本形状(FR-429、P5 §2.7)。中心・向き・寸法だけで決まる「作る」段だが、
      // 中心を立体の頂点にしたときだけ頂点の指紋(`originQuery`)と、その頂点を持つ
      // 立体の段の鍵(`targetKey`)を添え、カーネルが頂点を引いて位置を決める
      // (§0.a-0.18)。**それでも対象は消費しない**(§0.a-0.19)ので、加工フィーチャーの
      // `targetKey` と違い結果には両方のボディが残る。寸法(`shape`)は model と kernel で
      // 欄の名前・形をそろえてあるので、指紋だけ詰め替えて残りはそのまま渡す。
      return {
        kind: 'primitive',
        origin: plan.origin,
        axis: plan.axis,
        shape: plan.shape,
        originQuery: plan.originQuery === null ? null : toSubShapeQuery(plan.originQuery),
        targetKey: plan.targetKey,
      };
    case 'thruSections':
      /*
        罫線面(FR-430)とロフト(FR-410)は、model のフィーチャーが 2 種類でも
        カーネルの段は 1 種類で `ruled` の真偽しか違わない(P5 §0.a-0.25)。
        断面は輪郭(曲線の並び)・球(中心と半径)・立体の面(指紋と上流の鍵)の 3 通りで、
        詰め替えは `toThruSectionSpec`。球の近似の点の数(`sphereSegments`、§0.a-0.74)は
        カーネル側が必須の欄にしてある(既定を入れるのは model の役目)ので必ず渡す。
      */
      return {
        kind: 'thruSections',
        sections: plan.sections.map((section) => toThruSectionSpec(section)),
        ruled: plan.ruled,
        closed: plan.closed,
        twist: plan.twist,
        sphereSegments: plan.sphereSegments,
      };
    /*
      P5 の Should 群のうちタスク45 が解決する 4 種(FR-417・FR-419・FR-424)。
      角度のラジアン化・平面の数値化・倍率の正規化は resolvePart が済ませてあるので、
      ここでやるのは指紋(`faces` / `neutralFace`)の詰め替えだけである。
      **消費するかどうかは `visible` を決める model 側の話**で、依頼の形には出ない。
    */
    case 'draft':
      return {
        kind: 'draft',
        targetKey: plan.targetKey,
        faces: plan.faces.map((face) => toSubShapeQuery(face)),
        neutralFace: toSubShapeQuery(plan.neutralFace),
        angle: plan.angle,
        reversed: plan.reversed,
      };
    case 'mirror':
      return {
        kind: 'mirror',
        targetKey: plan.targetKey,
        origin: plan.origin,
        normal: plan.normal,
      };
    case 'transform':
      return {
        kind: 'transform',
        targetKey: plan.targetKey,
        translation: plan.translation,
        rotationOrigin: plan.rotationOrigin,
        rotationAxis: plan.rotationAxis,
        rotationAngle: plan.rotationAngle,
      };
    case 'scale':
      return {
        kind: 'scale',
        targetKey: plan.targetKey,
        origin: plan.origin,
        uniform: plan.uniform,
        perAxis: plan.perAxis,
      };
    /*
      P5 の Should 群のうちタスク46 が解決する 5 種(FR-409・420・421・423・428)と、
      前倒しした Could 群の 1 種(FR-418)。断面・経路の座標、向き、角度のラジアン化、
      呼び径の引き当ては resolvePart が済ませてあるので、ここでやるのは曲線と指紋の
      詰め替えだけである(欄の名前と形は model と kernel でそろえてある)。
    */
    case 'sweep':
      return {
        kind: 'sweep',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        path: plan.path.map((curve) => toCurveSpec(curve)),
        frenet: plan.frenet,
      };
    case 'rib':
      return {
        kind: 'rib',
        targetKey: plan.targetKey,
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        normal: plan.normal,
        thickness: plan.thickness,
        symmetric: plan.symmetric,
        direction: plan.direction,
        // 材料に届くまで伸ばすか(FR-420、42c/46c)。RibStepSpec.extendToBody と同じ欄名。
        extendToBody: plan.extendToBody,
      };
    case 'emboss':
      return {
        kind: 'emboss',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        profiles: plan.profiles.map((profile) => profile.map((curve) => toCurveSpec(curve))),
        depth: plan.depth,
        raised: plan.raised,
      };
    case 'threadShaft':
      return {
        kind: 'threadShaft',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        majorDiameter: plan.majorDiameter,
        pitch: plan.pitch,
        length: plan.length,
        fromEnd: plan.fromEnd,
        modeled: plan.modeled,
      };
    case 'surface':
      // 曲面(FR-428)。作り方 6 種の詰め替えは `toSurfaceInput`。`face` / `offset` の
      // ときだけ面を借りる立体の鍵を添えるが、**消費はしない**(§0.a-0.45)。
      return {
        kind: 'surface',
        shape: toSurfaceInput(plan.shape),
        targetKey: plan.targetKey,
      };
    case 'shell':
      return {
        kind: 'shell',
        targetKey: plan.targetKey,
        openFaces: plan.openFaces.map((face) => toSubShapeQuery(face)),
        thickness: plan.thickness,
        outward: plan.outward,
      };
    case 'cut':
      // 平面による切断(FR-432、§2.9b)。平面は resolvePart が「通る点+単位法線」まで
      // 解いてあるので、欄名を合わせるだけ(指紋は段へ運ばない)。
      return {
        kind: 'cut',
        targetKey: plan.targetKey,
        origin: plan.origin,
        normal: plan.normal,
        keepPositive: plan.keepPositive,
      };
    case 'importedSolid':
      /*
        読み込んだ形(FR-802、P6 §2.8、タスク20)。カーネルの `ImportedSolidStepSpec` は
        **バイト列 1 つだけ**を受け取る(`shapeRef` は `.pcad` の中の入れ物の名前で、
        カーネルは `.pcad` を知らないので運ばない。鍵は resolvePart が済ませてある)。
      */
      return { kind: 'importedSolid', bytes: plan.bytes };
  }
}

/**
 * 曲面の作り方(FR-428)をカーネルの `SurfaceInput` へ直す(タスク46)。
 * 種類も欄名も同じだが、曲線(`ResolvedCurve` → `CurveSpec`)と指紋
 * (`SubShapeRef` → `SubShapeQuery`)だけは詰め替えが要る。各節は return で閉じる。
 */
function toSurfaceInput(shape: SurfaceShapePlan): SurfaceInput {
  switch (shape.kind) {
    case 'extrude':
      return {
        kind: 'extrude',
        profile: shape.profile.map((curve) => toCurveSpec(curve)),
        direction: shape.direction,
        distance: shape.distance,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: shape.profile.map((curve) => toCurveSpec(curve)),
        axisOrigin: shape.axisOrigin,
        axisDirection: shape.axisDirection,
        angle: shape.angle,
      };
    case 'planar':
      return { kind: 'planar', profile: shape.profile.map((curve) => toCurveSpec(curve)) };
    case 'loft':
      return {
        kind: 'loft',
        sections: shape.sections.map((section) => section.map((curve) => toCurveSpec(curve))),
        ruled: shape.ruled,
      };
    case 'face':
      return { kind: 'face', face: toSubShapeQuery(shape.face) };
    case 'offset':
      return {
        kind: 'offset',
        face: toSubShapeQuery(shape.face),
        distance: shape.distance,
      };
  }
}

/**
 * 履歴 1 段ぶんの依頼を作る。結果との対応づけにはフィーチャーの id を使い、
 * 進捗に出す名前はフィーチャーの表示名をそのまま渡す(FR-501)。
 */
export function toSolidStepRequest(step: ResolvedSolidStep): SolidStepRequest {
  return {
    key: step.key,
    id: step.featureId,
    label: step.name,
    step: toSolidStepSpec(step.plan),
    visible: step.visible,
  };
}

/* ------------------------------------------------------------------ *
 * 外観の面の照合(FR-1106、P5 §2.2.3、タスク4)
 * ------------------------------------------------------------------ */

/**
 * 外観を割り当てた面を、カーネルへの照合の依頼へ詰め替える(§2.2.3)。
 *
 * **依頼が 1 件も無ければ空配列を返す。** カーネルは空なら照合の段そのものを飛ばし、
 * 物差し(境界箱の対角長)を測るための OCCT の呼び出しも 1 回も行わない
 * (§0.a-0.54「外観の追加で所要を増やさない」)。
 *
 * 次の 2 つは依頼に乗せずに落とす。落とした割り当ては `toAppearanceMatches` が
 * `faceIndex: null`(= 見つからない)で必ず補うので、件数は依頼元と食い違わない。
 *
 * - **段が見つからない割り当て**: そのフィーチャーが履歴から消えた、抑制された、
 *   ブーリアンに消費された場合。鍵が引けないので照合しようがない。
 * - **面以外の指紋**: 外観は面にしか付かない(`AppearanceTarget`)が、指紋の型は
 *   辺・頂点も表せるので、種類で守る(カーネルも面以外は断る)。
 */
export function toAppearanceQueries(
  steps: readonly ResolvedSolidStep[],
  requests: readonly AppearanceFaceRequest[],
): readonly AppearanceQuery[] {
  if (requests.length === 0) {
    return [];
  }
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const queries: AppearanceQuery[] = [];
  for (const request of requests) {
    const bodyKey = keyByFeatureId.get(request.bodyFeatureId);
    if (bodyKey === undefined || request.ref.fingerprint.kind !== 'face') {
      continue;
    }
    queries.push({ id: request.id, bodyKey, query: toSubShapeQuery(request.ref) });
  }
  return queries;
}

/**
 * 照合の結果を model の言葉へ詰め替える(§2.2.3)。
 *
 * **戻りは依頼(`requests`)と同じ並び・同じ件数**で、依頼に乗せなかったもの・
 * カーネルが返さなかったものは `faceIndex: null` で補う。呼び出し側(ui)は
 * 「見つからない割り当てが n 件」を数えるだけでよく、どこで落ちたかを気にしなくて済む。
 *
 * ボディの id は**文書側の値をそのまま返す**。カーネルは面の属するボディが
 * 見つからないときに空文字を返す約束だが、見つかったときの値は「段の id = ボディの id」
 * (§0.a-0.5)より必ず `request.bodyFeatureId` と同じなので、空文字を外へ出す意味が無い。
 */
export function toAppearanceMatches(
  requests: readonly AppearanceFaceRequest[],
  matches: readonly AppearanceMatch[] | undefined,
): readonly AppearanceMatchEntry[] {
  if (requests.length === 0) {
    return [];
  }
  const faceIndexById = new Map((matches ?? []).map((match) => [match.id, match.faceIndex]));
  return requests.map((request) => ({
    id: request.id,
    bodyFeatureId: request.bodyFeatureId,
    faceIndex: faceIndexById.get(request.id) ?? null,
  }));
}

/**
 * 立体の再計算の依頼を 1 つ組み立てる(Worker 版と直結版で同じものを使う)。
 *
 * ## 段ごとの三角形分割の粗さ(§2.13、§0.a-0.54)について
 *
 * `SolidStepRequest.tessellation` にはここでは何も入れず、**粗さの規則はカーネルに
 * 1 か所だけ置いたままにする**(`recomputeSolids.ts` の `isRelaxableSweepStep`。
 * ばねと実らせんのねじ穴を 0.15 / 0.7 へ緩める、P3 仕上げ (a) の実測)。
 * 同じ規則を model にも書くと 2 か所になり、片方だけ直したときに食い違うため。
 * カーネルは「段ごとの指定 > 全体の指定 > 段の種類の既定」の順で選ぶので、ここで
 * 値を添えるとカーネルの既定の方が負けてしまう。基本形状(球・トーラス)を緩める案は
 * **効き目が無いことがタスク14 で実測された**(球 r10 は 0.8 を添えても 978 枚のまま)
 * ので入れない。利用者が粗さを選べるようにする段になったら、その値だけをここへ通す。
 */
function toSolidRecomputeRequest(
  steps: readonly ResolvedSolidStep[],
  options: SolidRecomputeOptions,
): SolidRecomputeRequest {
  return {
    steps: steps.map((step) => toSolidStepRequest(step)),
    generation: options.generation ?? 0,
    appearanceQueries: toAppearanceQueries(steps, options.appearance ?? []),
    measureAreas: options.measureAreas ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * 部分形状の選び直し(FR-325・FR-328〜330 の上流追従、P4 タスク25)— 同期の純関数
 * ------------------------------------------------------------------ */

/**
 * 位置の点を部品の大きさで割るための長さ(境界箱の対角長の半分)。
 *
 * カーネル側(`makeHole.ts` 等)は `boundingDiagonal`(OCCT の `Bnd_Box`)で測るが、
 * model は B-rep を持たないので**三角形の頂点の並び**から同じ量を測る。
 * 三角形は形の表面を覆っているので、境界箱は実用上ほぼ一致する(曲面では
 * 近似の分だけわずかに小さく出るが、位置の点は 0〜1 の連続な値で、しきい値
 * (`SUB_SHAPE_MATCH_THRESHOLD`)の判定がこの差で覆るほど敏感ではない)。
 */
function matchScaleOf(body: SolidBody): number {
  const positions = body.mesh.positions;
  if (positions.length < 3) {
    return 0;
  }
  const low: [number, number, number] = [positions[0], positions[1], positions[2]];
  const high: [number, number, number] = [positions[0], positions[1], positions[2]];
  for (let index = 3; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) * 0.5;
}

/**
 * 指紋に最も近い面・辺・頂点を、いまのボディの中から選び直す(FR-325、FR-330、タスク25)。
 *
 * 採点は kernel の `matchFace` / `matchEdge` / `matchVertex`(OCCT を使わない純関数)を
 * そのまま使うので、**重み・しきい値・同点の決め方は加工フィーチャーと完全に同じ**である
 * (§0.a-0.4)。この関数を通すと、スケッチの頂点参照・作業平面・基準ジオメトリが
 * 「保存された指紋の位置」ではなく「いまの形の位置」を見るようになる。
 *
 * 届かなければ null(呼び出し側が `missingSubShape` で断る、FR-504)。
 * Worker を通らない同期の純関数なので、`KernelBridge` のメソッドにはしない
 * (`sketchFilletGeometry` と同じ扱い、このファイルの §「なぜ Worker を往復しないのか」)。
 */
export function selectSubShape(body: SolidBody, reference: SubShapeRef): ResolvedSubShape | null {
  const query = toSubShapeQuery(reference);
  const scale = matchScaleOf(body);
  switch (query.kind) {
    case 'face': {
      const match = matchFace(body.faces, query, scale);
      const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'face',
        position: found.centroid,
        axis: found.axis,
        surfaceKind: found.surfaceKind,
        curveKind: null,
      };
    }
    case 'edge': {
      const match = matchEdge(body.edges, query, scale);
      const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'edge',
        position: found.midpoint,
        axis: found.axis,
        surfaceKind: null,
        curveKind: found.curveKind,
      };
    }
    case 'vertex': {
      const match = matchVertex(body.vertices, query, scale);
      const found =
        match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'vertex',
        position: found.position,
        axis: null,
        surfaceKind: null,
        curveKind: null,
      };
    }
  }
}

/** 立体が消えたとき(画面に出すはずの段の結果も理由も返らなかったとき)に付ける理由。 */
const MISSING_BODY_MESSAGE = 'カーネルから立体が返りませんでした。';

/**
 * カーネルの結果を model のボディへ詰め替える。妥当性の判定は SolidBody.isValid の注釈のとおり。
 * `faces` / `edges` / `vertices` / `threadMarks` は kernel の一覧と欄の名前・形が同じなので
 * (計画書 §2.8)、詰め替えは配列をそのまま渡すだけで済む(model 独自の型として持つのは
 * `SolidFaceEntry` 等の型そのものを kernel から再輸出しないためで、値の変形は要らない)。
 */
function toSolidBody(mesh: SolidBodyMesh): SolidBody {
  return {
    featureId: mesh.id,
    mesh: {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      edgePositions: mesh.edgePositions,
      triangleCount: mesh.triangleCount,
    },
    volume: mesh.volume,
    // 表面積は依頼が求めたときだけカーネルが測る(SolidRecomputeOptions.measureAreas)。
    // 測っていなければ欄ごと空のまま渡し、0 と偽らない。
    area: mesh.area,
    // 形の種類はカーネルの必須の欄(§0.a-0.77、タスク42b)なので、そのまま写す。
    // 判定は kernel の `hasSolid` そのままで、体積では決めない(体積 8000 の開いた殻がある)。
    bodyKind: mesh.bodyKind,
    isValid: mesh.triangleCount > 0 && Number.isFinite(mesh.volume) && mesh.volume > 0,
    faces: mesh.faces,
    edges: mesh.edges,
    vertices: mesh.vertices,
    threadMarks: mesh.threadMarks,
  };
}

/**
 * カーネルの結果を model の言葉へ詰め替える。
 * 画面に出すはずの段(visible)なのにボディも理由も返らなかったものは、
 * 黙って消えないよう理由を補って失敗として扱う(FR-504。面の詰め替えと同じ書き方)。
 */
export function toSolidOutcome(
  steps: readonly ResolvedSolidStep[],
  result: SolidRecomputeResult,
  appearance: readonly AppearanceFaceRequest[] = [],
): SolidRecomputeOutcome {
  const bodies = result.bodies.map((mesh) => toSolidBody(mesh));
  const collected: SolidBodyFailure[] = result.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  const reported = new Set<string>(bodies.map((body) => body.featureId));
  for (const failure of collected) {
    reported.add(failure.featureId);
  }
  for (const step of steps) {
    // 途中で打ち切られた段は「まだ計算していない」だけなので、失敗にしない(NFR-PF-4)。
    if (step.visible && !reported.has(step.featureId) && !result.cancelled) {
      collected.push({ featureId: step.featureId, message: MISSING_BODY_MESSAGE });
    }
  }

  return {
    bodies,
    failures: collected,
    cacheHits: result.cacheHits,
    cancelled: result.cancelled,
    appearanceMatches: toAppearanceMatches(appearance, result.appearanceMatches),
  };
}

/**
 * 進捗を受け取る関数を Comlink.proxy で包む。
 * 包まずに渡すと関数は構造化複製できず、実行時に「クローンできません」で落ちる(§1.2-5)。
 * Worker は計算中でも外向きの postMessage を出せるので、UI 側は計算中も更新を受け取れる。
 */
function toProgressProxy(
  onProgress: PartProgressCallback | undefined,
): ((progress: SolidProgress) => void) | undefined {
  if (onProgress === undefined) {
    return undefined;
  }
  return Comlink.proxy((progress: SolidProgress) => {
    onProgress({
      featureId: progress.stepId,
      index: progress.index,
      total: progress.total,
      label: progress.label,
    });
  });
}

/**
 * 点検の進捗を受け取る関数を Comlink.proxy で包む(`toProgressProxy` と同じ理由)。
 *
 * 写しそのもの(kernel の値 → model の 4 欄)は `printabilityProgressOf` が持つ。
 * **写さずにそのまま渡すことはしない**——kernel の値をそのまま外へ出すと、あとで
 * カーネル側に欄が増えたときに model の型に無い欄が混ざる(`toSolidBody` と同じ扱い)。
 */
function toPrintabilityProgressProxy(
  onProgress: PrintabilityProgressCallback | undefined,
): ((progress: PrintabilityProgress) => void) | undefined {
  const copy = printabilityProgressOf(onProgress);
  return copy === undefined ? undefined : Comlink.proxy(copy);
}

declare global {
  interface Window {
    /**
     * **検査専用の口**(P5、NFR-PF-4 の E2E)。アプリはこの値を 1 か所も書かない。
     *
     * 正の数を入れておくと、立体の**段と段の間**(カーネルが中止を尋ねてくるところ)で
     * 毎回この ms だけ待ってから答える。頁の外(Playwright)から入れるためだけにあり、
     * 入っていなければ(通常の道では `undefined`)待ちは 1 ミリ秒も挟まらない。
     */
    pcadDebugStepDelayMs?: number;
  }
}

/**
 * 段と段の間に挟む検査専用の待ち(ms)。入っていなければ 0(= 待たない)。
 *
 * Node の検査や Worker の中には `window` が無いので、まず有無を見る。
 */
function debugStepDelayMs(): number {
  if (typeof window === 'undefined') {
    return 0;
  }
  const value = window.pcadDebugStepDelayMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/**
 * 中止を尋ねる関数も同じ理由で Comlink.proxy で包む(§1.2-5)。
 *
 * ここに**検査専用の遅延の口**(`window.pcadDebugStepDelayMs`)を 1 つだけ挟んである。
 * カーネルは段と段の間でこの関数を `await` して答えを待つ(`recomputeSolids` の
 * 「中止の口が渡されているときだけ制御を譲る」)ので、ここで待つと**計算そのものが
 * その ms だけ延びる**。長い計算(NFR-PF-4 の帯と「中止」)を機械の速さに頼らず作れる。
 * CPU を絞って長い計算を作る手は、共有の遅いランナーでは検査が時間切れになった
 * (rules/06 10.14)。値が入っていない通常の道では `shouldCancel()` をそのまま返し、
 * 約束(Promise)すら作らない。
 */
function toCancelProxy(
  shouldCancel: PartCancelToken | undefined,
): (() => boolean | Promise<boolean>) | undefined {
  if (shouldCancel === undefined) {
    return undefined;
  }
  return Comlink.proxy(() => {
    const delayMs = debugStepDelayMs();
    if (delayMs === 0) {
      return shouldCancel();
    }
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(shouldCancel());
      }, delayMs);
    });
  });
}

/** 面が消えたとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_FACE_MESSAGE = 'カーネルから面が返りませんでした。';

/** 色が引けないときの塗り色。解決済みの面には必ず色があるので、通常は使わない。 */
const FALLBACK_FACE_COLOR = '#ffffff';

/**
 * カーネルの結果を model の言葉へ詰め替える。
 * 依頼したのに面もエラーも返らなかった id は、理由を補って失敗として扱う(FR-504)。
 */
function toOutcome(
  faces: readonly ResolvedFace[],
  meshes: readonly FaceMeshData[],
  failures: readonly SketchTessellationFailure[],
): SketchTessellationOutcome {
  const colorByFeature = new Map(faces.map((face) => [face.featureId, face.color]));
  const built: SketchFaceMesh[] = meshes.map((mesh) => ({
    featureId: mesh.id,
    color: colorByFeature.get(mesh.id) ?? FALLBACK_FACE_COLOR,
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    // 線分1本あたり 6 要素(始点 xyz + 終点 xyz)の並び(docs/報告記録.md 2026-09-02 21:03)。
    boundaryPositions: mesh.boundaryPositions,
  }));

  const reported = new Set<string>(built.map((mesh) => mesh.featureId));
  const collected: SketchFaceFailure[] = failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));
  for (const failure of collected) {
    reported.add(failure.featureId);
  }
  for (const face of faces) {
    if (!reported.has(face.featureId)) {
      collected.push({ featureId: face.featureId, message: MISSING_FACE_MESSAGE });
    }
  }

  return { mesh: { faces: built }, failures: collected };
}

/**
 * Worker が壊れたときに利用者へ見せる理由(NFR-RE-1、§2.9、§0.a-0.19)。
 * OCCT の C++ 側が `abort()` すると WASM ごと止まり、以後どの依頼にも応答しなくなる。
 * この場合いまの再計算はやり直せないので、値を戻すよう案内する。
 */
export const KERNEL_BROKEN_MESSAGE =
  'カーネルが止まりました。値を元に戻してから、もう一度お試しください。';

/**
 * Worker が壊れたかどうかを持つ小さな状態機械(§2.9)。
 * Worker そのものには触れないので、実物の Worker を起動できない Node のテストからも
 * 判断のロジックだけを確かめられる(docs/報告記録.md 2026-09-02 14:50 の④
 * 「Worker の実動作は Node では確かめられない」)。
 */
export interface KernelHealth {
  readonly broken: boolean;
  markBroken(): void;
  /** 作り直したことにする。 */
  reset(): void;
}

export function createKernelHealth(): KernelHealth {
  let broken = false;
  return {
    get broken(): boolean {
      return broken;
    },
    markBroken(): void {
      broken = true;
    },
    reset(): void {
      broken = false;
    },
  };
}

/** Worker への 1 回の依頼が、応答で終わったか破損に割り込まれたかの内部結果。 */
type BrokenRace<T> = { readonly broken: false; readonly result: T } | { readonly broken: true };

/**
 * Worker への接続 1 本ぶん(worker 本体・Comlink の代理・壊れた合図)。
 * `createKernelBridge` は壊れたら丸ごと作り直すので、この形にまとめて 1 回で差し替える。
 */
interface KernelConnection {
  readonly worker: Worker;
  readonly remote: Comlink.Remote<KernelApi>;
  /**
   * Worker が壊れた瞬間に解決する合図(§2.9)。応答を待つだけの Promise は Worker が
   * 壊れても永遠に解決しないため、応答待ちの処理をこの合図と Promise.race させることで、
   * 待っている呼び出しだけは必ず終わらせる(進行中の依頼を拒否せず解決する、§0.a-0.19)。
   */
  readonly brokenSignal: Promise<void>;
  readonly handleBroken: () => void;
}

/** Worker を 1 本起動し、'error' / 'messageerror' を壊れた合図につなぐ(§2.9)。 */
function createKernelConnection(onBroken: () => void): KernelConnection {
  const worker = createKernelWorker();
  const remote = Comlink.wrap<KernelApi>(worker);
  // Promise の executor は同期で走るので、resolver は必ず notify へ入ってから使われる。
  // ここでは TypeScript の未代入検査を避けるため、あらかじめ no-op で初期化しておく。
  let notify: () => void = () => undefined;
  const brokenSignal = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const handleBroken = (): void => {
    onBroken();
    notify();
  };
  worker.addEventListener('error', handleBroken);
  worker.addEventListener('messageerror', handleBroken);
  return { worker, remote, brokenSignal, handleBroken };
}

/**
 * Worker への 1 回の依頼を、その接続の「壊れた合図」と競わせる(§2.9、§0.a-0.19)。
 *
 * **なぜ要るか**: Comlink の応答待ちの Promise は、Worker が `abort()` で止まると
 * 永遠に解決も拒否もしない。合図と競わせないと、待っている呼び出しがそのまま残り、
 * 画面は理由も出ないまま固まる(利用者からは「押しても何も起きない」に見える)。
 *
 * **1 か所にまとめる理由**: 以前は `recomputeSolids` だけがこの形を持っており、
 * 面の三角形分割・オフセット・投影・断面・測定の 5 つは合図と競っていなかった
 * (docs/報告記録.md 2026-09-06 12:04 の③)。同じ形を 5 か所へ写すと、次に手続きが
 * 増えたときにまた写し忘れる。だから競わせ方はこの関数だけが知っている。
 *
 * `refuse` は「壊れたときに返す値」を作る。**拒否(throw)はしない**——呼び手が
 * 既に扱っている断りの形(失敗の一覧、または `kind: 'failed'`)で解決する。
 */
async function raceWithBroken<T>(
  connection: KernelConnection,
  request: Promise<T>,
  refuse: () => T,
): Promise<T> {
  const race = await Promise.race<BrokenRace<T>>([
    request.then((result) => ({ broken: false, result })),
    connection.brokenSignal.then(() => ({ broken: true })),
  ]);
  return race.broken ? refuse() : race.result;
}

/**
 * 壊れたときの断りの一覧。**依頼した 1 件ごとに 1 つ**、理由は `KERNEL_BROKEN_MESSAGE`。
 * 面・オフセット・投影・断面はどれも「1 件失敗しても残りは返す」形(FR-504)なので、
 * 全件をこの理由の失敗にすれば、呼び手は普段の失敗と同じ道で画面へ出せる。
 */
function brokenFailures(
  items: readonly { readonly featureId: string }[],
): readonly { readonly featureId: string; readonly message: string }[] {
  return items.map((item) => ({ featureId: item.featureId, message: KERNEL_BROKEN_MESSAGE }));
}

/** 接続を締める。壊れた Worker への解放要求が失敗しても、後始末は続ける(NFR-RE-1)。 */
function closeKernelConnection(connection: KernelConnection): void {
  connection.worker.removeEventListener('error', connection.handleBroken);
  connection.worker.removeEventListener('messageerror', connection.handleBroken);
  try {
    connection.remote[Comlink.releaseProxy]();
  } catch {
    // Worker がすでに応答しない状態では解放の要求自体が失敗しうるが、
    // 呼び出し側は必ず worker.terminate() へ進むので実害は無い。
  }
  connection.worker.terminate();
}

/** Web Worker 内の幾何カーネルへつなぐ。ブラウザ・Electron のレンダラでのみ使える。 */
export function createKernelBridge(): KernelBridge {
  const health = createKernelHealth();
  let connection = createKernelConnection(() => health.markBroken());

  /**
   * 壊れた Worker を締めて作り直す(§2.9、§0.a-0.19)。形状キャッシュは Worker の中にあるので
   * 作り直すと空になり、次の再計算は全段作り直しになる(遅くなるが落ちない、この限界は
   * `KernelBridge.recomputeSolids` の doc comment にも書いた)。
   */
  function restart(): void {
    closeKernelConnection(connection);
    health.reset();
    connection = createKernelConnection(() => health.markBroken());
  }

  return {
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す。
      if (health.broken) {
        restart();
      }
      const active = connection;
      // 線・円弧の折れ線は UI が自前で作るので、カーネルへは面だけを頼む
      // (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
      return raceWithBroken(
        active,
        active.remote
          .tessellateSketch({
            curves: [],
            faces: faces.map((face) => toFaceRequest(face)),
          })
          .then((result) => toOutcome(faces, result.faces, result.failures)),
        // 面は 1 枚も作れていないので、頼んだ全部を壊れた理由の失敗にする(FR-504)。
        () => ({ mesh: { faces: [] }, failures: brokenFailures(faces) }),
      );
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      const request: SolidRecomputeRequest = toSolidRecomputeRequest(steps, options);
      // 第 2 引数は全体のテッセレーションの粗さ。段の種類ごとの既定はカーネルが持っており
      // (toSolidRecomputeRequest の注釈)、ここで値を渡すとその既定が負けるので undefined。
      return raceWithBroken(
        active,
        active.remote
          .recomputeSolids(
            request,
            undefined,
            toProgressProxy(options.onProgress),
            toCancelProxy(options.shouldCancel),
          )
          .then((result) => toSolidOutcome(steps, result, options.appearance ?? [])),
        // Worker がこの依頼の途中で壊れた。拒否せずに理由つきの失敗として解決する
        // (recomputePart.ts が kernelFailed として拾う。§0.a-0.19「拒否しない」)。
        // 消費されて画面に出ないはずの段(visible: false)は、成功しても失敗しても
        // 利用者には見えないので失敗に数えない(toSolidOutcome の扱いと揃える)。
        () => ({
          bodies: [],
          failures: brokenFailures(steps.filter((step) => step.visible)),
          cacheHits: 0,
          cancelled: false,
          // 照合そのものを行えていないので空で返す。ここで全件を「見つからない」にすると、
          // 段の失敗の警告に「色を付けた面が見つかりません」を重ねてしまう(FR-504)。
          appearanceMatches: [],
        }),
      );
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote
          .offsetSketchCurves({ items: requests.map((request) => toOffsetItem(request)) })
          .then((outcome) => toOffsetResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async projectSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote
          .projectSketchCurves({ items: requests.map((request) => toProjectionItem(request)) })
          .then((outcome) => toProjectionResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async sectionSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote
          .sectionSketchCurves({ items: requests.map((request) => toSectionItem(request)) })
          .then((outcome) => toProjectionResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async measure(steps, targets, kind): Promise<MeasureOutcome> {
      const request = toMeasureRequest(steps, targets, kind);
      if (request === null) {
        // 鍵が引けない対象があるので、Worker を起こさずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote.measure(request).then((result) => toMeasureOutcome(result)),
        // 測定の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async exportShapes(steps, options): Promise<ShapeExportOutcome> {
      const items = toShapeExportItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、Worker を起こさずここで断る(NFR-UX-5)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote.exportShapes(toShapeExportRequest(items, options)).then(
          (result) => toShapeExportOutcome(result, options),
          // カーネルが断ったとき(鍵が消えていた・書けなかった)は理由をそのまま持ち回る。
          // **拒否のまま競わせない**——拒否は `raceWithBroken` を素通りしてしまうため。
          (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
        ),
        // 書き出しの結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async importShape(options): Promise<ShapeImportOutcome> {
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote.importShape(toShapeImportRequest(options)).then(
          (result) => toShapeImportOutcome(result),
          (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
        ),
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async inspectPrintability(steps, options): Promise<PrintabilityOutcome> {
      if (options.bodies.length === 0) {
        // 点検する形が 1 つも無いので Worker を起こさない(§0.a-0.30)。
        return { kind: 'failed', message: PRINTABILITY_NO_BODY_MESSAGE };
      }
      const items = toShapeInspectItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、Worker を起こさずここで断る(測定と同じ)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        active.remote
          .inspectPrintability(
            toShapeInspectRequest(items, options),
            toPrintabilityProgressProxy(options.onProgress),
            toCancelProxy(options.shouldCancel),
          )
          .then(
            (result) => toPrintabilityOutcome(result),
            // カーネルが断ったとき(鍵が消えていた・三角形が 0 枚)は理由をそのまま持ち回る。
            // **拒否のまま競わせない**——拒否は `raceWithBroken` を素通りしてしまうため。
            (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
          ),
        // 点検の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    dispose(): void {
      closeKernelConnection(connection);
    },
  };
}

/**
 * Worker を通さず、同じプロセスの `KernelApi` へ直につなぐ橋(P4 タスク25)。
 *
 * **本番では使わない。** ブラウザ・Electron は必ず `createKernelBridge`(Worker 版)を使う
 * (幾何カーネルは Web Worker 上で動かす、rules/04・NFR-PF-4)。この関数があるのは、
 * **Node の検査で「部品文書の経路が実カーネルで最後まで通る」ことを確かめる**ためである
 * (t21 の教訓: 偽の橋だけでは配線もれが見つからない。`docs/報告記録.md` 2026-09-04 21:05)。
 *
 * Worker が無いので壊れの検知・作り直し(§2.9)は持たない。`dispose` も何もしない
 * (形状キャッシュは渡された `KernelApi` の持ち物で、寿命は呼び出し側が決める)。
 */
export function createDirectKernelBridge(api: KernelApi): KernelBridge {
  return {
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      const result = await api.tessellateSketch({
        curves: [],
        faces: faces.map((face) => toFaceRequest(face)),
      });
      return toOutcome(faces, result.faces, result.failures);
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
      }
      const request: SolidRecomputeRequest = toSolidRecomputeRequest(steps, options);
      // Comlink を通らないので、進捗・中止の関数は proxy で包まずそのまま渡せる。
      const result = await api.recomputeSolids(
        request,
        undefined,
        options.onProgress === undefined
          ? undefined
          : (progress: SolidProgress) =>
              options.onProgress?.({
                featureId: progress.stepId,
                index: progress.index,
                total: progress.total,
                label: progress.label,
              }),
        options.shouldCancel,
      );
      return toSolidOutcome(steps, result, options.appearance ?? []);
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.offsetSketchCurves({
        items: requests.map((request) => toOffsetItem(request)),
      });
      return toOffsetResult(requests, outcome);
    },

    async projectSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.projectSketchCurves({
        items: requests.map((request) => toProjectionItem(request)),
      });
      return toProjectionResult(requests, outcome);
    },

    async sectionSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.sectionSketchCurves({
        items: requests.map((request) => toSectionItem(request)),
      });
      return toProjectionResult(requests, outcome);
    },

    async measure(steps, targets, kind): Promise<MeasureOutcome> {
      const request = toMeasureRequest(steps, targets, kind);
      if (request === null) {
        // 鍵が引けない対象があるので、カーネルを呼ばずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
      }
      const result = await api.measure(request);
      return toMeasureOutcome(result);
    },

    async exportShapes(steps, options): Promise<ShapeExportOutcome> {
      const items = toShapeExportItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、カーネルを呼ばずここで断る(NFR-UX-5)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      try {
        return toShapeExportOutcome(
          await api.exportShapes(toShapeExportRequest(items, options)),
          options,
        );
      } catch (error) {
        // Worker 版と同じく、断りは投げずに理由つきの失敗で返す(NFR-RE-1)。
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    async importShape(options): Promise<ShapeImportOutcome> {
      try {
        return toShapeImportOutcome(await api.importShape(toShapeImportRequest(options)));
      } catch (error) {
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    async inspectPrintability(steps, options): Promise<PrintabilityOutcome> {
      if (options.bodies.length === 0) {
        return { kind: 'failed', message: PRINTABILITY_NO_BODY_MESSAGE };
      }
      const items = toShapeInspectItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、カーネルを呼ばずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      try {
        // Comlink を通らないので、進捗・中止の関数は proxy で包まずそのまま渡せる。
        return toPrintabilityOutcome(
          await api.inspectPrintability(
            toShapeInspectRequest(items, options),
            printabilityProgressOf(options.onProgress),
            options.shouldCancel,
          ),
        );
      } catch (error) {
        // Worker 版と同じく、断りは投げずに理由つきの失敗で返す(NFR-RE-1)。
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    dispose(): void {
      // Worker を持たないので閉じるものが無い。
    },
  };
}
