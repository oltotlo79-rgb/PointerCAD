/** sketch data exchanged through the model's kernel bridge. Types only; no Worker lifetime. */
import type {
  SubShapeRef,
} from '../geometry/subShapeRef.js';
import type {
  WorkPlane,
} from '../sketch/planeMath.js';
import type {
  OffsetCornerKind,
  ResolvedCurve,
  SketchMesh,
} from '../sketch/types.js';
import type {
  Vec3,
} from '../sketch/vec3.js';


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
  /** sectionSketchCurves専用。指定精度の断面はdoubleを保持し、点数を間引かない。 */
  readonly curveToleranceMm?: number;
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
