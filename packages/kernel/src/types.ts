// 輪郭のオフセット(FR-321)の角の種類と結果の形は `occt/makeOffsetWire.ts` が正本。
// 同じ約束を2か所に書かないため、ここでは取り込んで輸出し直すだけにする
// (型だけの取り込みなので、実行時の読み込みは起きない)。
import type { OffsetContour, OffsetJoinType } from './occt/makeOffsetWire.js';
// 投影・交差(FR-325、P4 タスク26)の作図面と、作図面の上の 2 次元の曲線も
// `occt/makeProjection.ts` が正本。オフセットと同じ理由で取り込んで輸出し直す。
import type {
  PlaneArc,
  PlaneCurve,
  PlanePolyline,
  PlaneSegment,
  SketchPlaneFrame,
  Vec2Tuple,
} from './occt/makeProjection.js';

/** 表示用の三角形メッシュ。内部単位は mm(NFR-RE-3)。 */
export interface MeshData {
  /** 頂点座標。x, y, z の順に 3 個ずつ並ぶ。 */
  readonly positions: Float32Array;
  /** 頂点法線。positions と同じ長さ。 */
  readonly normals: Float32Array;
  /** 三角形の頂点番号。3 個ずつ並ぶ。 */
  readonly indices: Uint32Array;
  /** 稜線の線分列。線分1本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly edgePositions: Float32Array;
  readonly triangleCount: number;
  readonly faceCount: number;
  readonly edgeCount: number;
}

/** 箱の寸法(mm)。 */
export interface BoxParameters {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** テッセレーションの粗さ。既定値は opencascade.js の実例に合わせる。 */
export interface TessellationOptions {
  /** 弦の最大ずれ(mm)。小さいほど細かい。 */
  readonly linearDeflection?: number;
  /** 角度のずれ(ラジアン)。 */
  readonly angularDeflection?: number;
}

export const DEFAULT_LINEAR_DEFLECTION = 0.1;
export const DEFAULT_ANGULAR_DEFLECTION = 0.5;

/** 3 次元の点・向き。単位は mm(NFR-RE-3)。 */
export type Vec3Tuple = readonly [number, number, number];

/** 2 点を結ぶ線分(FR-304)。 */
export interface SegmentSpec {
  readonly kind: 'segment';
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
}

/**
 * 円弧(FR-305、中心+半径+開始角+終了角)。
 * 角度はラジアンで、xAxis の向きを 0 とし normal まわりに正。
 * 終了角 − 開始角の絶対値が 2π 以上なら全周の円になる。
 */
export interface ArcSpec {
  readonly kind: 'arc';
  readonly center: Vec3Tuple;
  readonly normal: Vec3Tuple;
  readonly xAxis: Vec3Tuple;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * 楕円・楕円弧(FR-318)。欄の意味は `occt/makeEllipseEdge.ts` の `EllipseSpec` と同じで、
 * 判別のための `kind` だけを足した形(そのまま `makeEllipseEdge` へ渡せる)。
 *
 * **`startAngle` / `endAngle` は `gp_Elips` の径数方程式のパラメータ角**(ラジアン)で、
 * 中心から見た幾何の方位角ではない(`makeEllipseEdge.ts` の注釈)。方位角からの変換は
 * model 側(`resolveSketch.ts` の `azimuthToEllipseParameter`)の担当。
 * 全周の楕円は両方を省く(片方だけの指定は認めない)。
 */
export interface EllipseCurveSpec {
  readonly kind: 'ellipse';
  readonly center: Vec3Tuple;
  readonly normal: Vec3Tuple;
  /** 長軸方向(単位ベクトル、normal に直交)。パラメータ角 0 はこの向き。 */
  readonly majorAxis: Vec3Tuple;
  readonly majorRadius: number;
  readonly minorRadius: number;
  readonly startAngle?: number;
  readonly endAngle?: number;
}

/**
 * スプライン(FR-317)。欄の意味は `occt/makeSplineEdge.ts` の `SplineSpec` と同じで、
 * 判別のための `kind` だけを足した形(そのまま `makeSplineEdge` へ渡せる)。
 * `closed` が true なら閉じた曲線で、**閉じるための重複点は入れない**。
 */
export interface SplineCurveSpec {
  readonly kind: 'spline';
  readonly mode: 'interpolate' | 'control';
  readonly points: readonly Vec3Tuple[];
  readonly closed: boolean;
}

export type CurveSpec = SegmentSpec | ArcSpec | EllipseCurveSpec | SplineCurveSpec;

/** 閉ループ 1 本から平面の面を 1 枚作る依頼(FR-309)。 */
export interface PlanarFaceRequest {
  /** 呼び出し側が付ける識別子。結果の対応づけに使う。 */
  readonly id: string;
  readonly curves: readonly CurveSpec[];
}

/** スケッチ 1 つ分のテッセレーションの依頼。 */
export interface SketchTessellationRequest {
  /** 面になっていない線・円弧。折れ線にして返す。 */
  readonly curves: readonly CurveSpec[];
  readonly faces: readonly PlanarFaceRequest[];
}

/** 面 1 枚分の表示用データ。MeshData と同じ並び方をする。 */
export interface FaceMeshData {
  readonly id: string;
  /** 頂点座標。x, y, z の順に 3 個ずつ並ぶ。 */
  readonly positions: Float32Array;
  /** 頂点法線。positions と同じ長さ。 */
  readonly normals: Float32Array;
  /** 三角形の頂点番号。3 個ずつ並ぶ。 */
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  /** 面の外周の稜線。線分1本あたり 6 個(始点 xyz + 終点 xyz)。面の縁を描くのに使う。 */
  readonly boundaryPositions: Float32Array;
  /** 外周を作っている曲線の本数。 */
  readonly boundaryEdgeCount: number;
}

/** 面を作れなかった依頼と、その理由(利用者へそのまま見せる日本語)。 */
export interface SketchTessellationFailure {
  readonly id: string;
  readonly message: string;
}

/** スケッチ 1 つ分のテッセレーションの結果。 */
export interface SketchTessellation {
  /** 依頼の curves と同じ並びの折れ線。1 本あたり x, y, z が 3 個ずつ並ぶ。 */
  readonly curvePolylines: readonly Float32Array[];
  readonly faces: readonly FaceMeshData[];
  /** 面を作れなかった依頼。1 枚失敗しても止めずに返す(FR-504)。 */
  readonly failures: readonly SketchTessellationFailure[];
}

/**
 * 輪郭のオフセット(FR-321、P4 タスク15)を Worker 越しに頼むための型。
 *
 * 形を作るのは `occt/makeOffsetWire.ts` で、角の種類(`OffsetJoinType`)と結果の輪郭
 * (`OffsetContour`)はそこの定義をそのまま使う(同じ約束を2か所に書かない)。
 * 距離は**符号つき**で、どちら側が外かは呼び出し側(model)が決める(§0.a-0.22)。
 */
export type { OffsetContour, OffsetJoinType };

/** オフセット 1 件の依頼。`id` は結果の対応づけに使う(面の依頼と同じ約束)。 */
export interface SketchOffsetItem {
  readonly id: string;
  /** オフセット元の輪郭。並んだ順につながっていること。 */
  readonly curves: readonly CurveSpec[];
  /** 符号つき距離(mm)。 */
  readonly distance: number;
  readonly joinType: OffsetJoinType;
}

/** オフセットの依頼をまとめたもの。1 回の往復で何件でも頼める。 */
export interface SketchOffsetRequest {
  readonly items: readonly SketchOffsetItem[];
}

/** オフセット 1 件の結果。輪郭が 2 本以上に分かれることもある。 */
export interface SketchOffsetResult {
  readonly id: string;
  readonly contours: readonly OffsetContour[];
}

/** オフセットを作れなかった依頼と、その理由(利用者へそのまま見せる日本語)。 */
export interface SketchOffsetFailure {
  readonly id: string;
  readonly message: string;
}

/** オフセットの結果。1 件失敗しても止めずに残りを返す(FR-504、NFR-RE-1)。 */
export interface SketchOffsetOutcome {
  readonly results: readonly SketchOffsetResult[];
  readonly failures: readonly SketchOffsetFailure[];
}

/**
 * 投影・交差(FR-325、P4 タスク25・26)を Worker 越しに頼むための型。
 *
 * 形を作るのは `occt/makeProjection.ts` / `occt/makeSection.ts` で、作図面
 * (`SketchPlaneFrame`)と作図面の上の曲線(`PlaneCurve`)はそこの定義をそのまま使う。
 *
 * **もとの立体は形状キャッシュの鍵で指す。** 立体の B-rep は Worker の中にしか無く、
 * Comlink 越しには渡せないため、`recomputeSolids` が段ごとに預けた鍵
 * (`SolidStepRequest.key`)をそのまま渡して引く。鍵は上流の値から作られている
 * (model の `part/cacheKey.ts`)ので、**上流の立体が変われば鍵が変わり、
 * 投影も必ず作り直される**(NFR-PF-3 の鍵の連鎖と同じ仕組み)。
 */
export type { PlaneArc, PlaneCurve, PlanePolyline, PlaneSegment, SketchPlaneFrame, Vec2Tuple };

/** 投影 1 件の依頼。`id` は結果の対応づけに使う(オフセットと同じ約束)。 */
export interface SketchProjectionItem {
  readonly id: string;
  /** もとの立体の形状キャッシュの鍵。 */
  readonly shapeKey: string;
  /**
   * 投影する面・辺の指紋。カーネルが立体の中から選び直す(§2.2.4)。
   * `null` なら立体そのもの(含まれるすべての辺)を投影する。
   */
  readonly subShape: SubShapeQuery | null;
  /** 投影先の作図面。 */
  readonly plane: SketchPlaneFrame;
}

/** 交差 1 件の依頼。切るのは立体そのものなので、部分形状の指紋は取らない。 */
export interface SketchSectionItem {
  readonly id: string;
  readonly shapeKey: string;
  readonly plane: SketchPlaneFrame;
}

/** 投影の依頼をまとめたもの。1 回の往復で何件でも頼める。 */
export interface SketchProjectionRequest {
  readonly items: readonly SketchProjectionItem[];
}

/** 交差の依頼をまとめたもの。 */
export interface SketchSectionRequest {
  readonly items: readonly SketchSectionItem[];
}

/**
 * 投影・交差 1 件の結果。曲線は作図面の上の 2 次元座標で、つながる順に並ぶ。
 * **交差が空(立体と作図面が交わらない)ときは `curves` が空**で返る。
 * 「交わりません」と断るのは呼び出し側の役目(`makeSection.ts` の注釈)。
 */
export interface SketchProjectionResult {
  readonly id: string;
  readonly curves: readonly PlaneCurve[];
}

/** 投影・交差を作れなかった依頼と、その理由(利用者へそのまま見せる日本語)。 */
export interface SketchProjectionFailure {
  readonly id: string;
  readonly message: string;
}

/** 投影・交差の結果。1 件失敗しても止めずに残りを返す(FR-504、NFR-RE-1)。 */
export interface SketchProjectionOutcome {
  readonly results: readonly SketchProjectionResult[];
  readonly failures: readonly SketchProjectionFailure[];
}

// ここから下はソリッド(立体)の依頼と結果(FR-401〜404)。
// Comlink 越しに渡せる素の値(数値・文字列・真偽・配列・TypedArray)だけで書く。
// OCCT の形そのものは Worker の中に置いたままにする(NFR-MA-1)。

/** ソリッドを作る 1 手順。向き・両側・反転の計算は model 側で済ませて渡す。 */
export interface ExtrudeStepSpec {
  readonly kind: 'extrude';
  /** 断面の閉ループ。makePlanarFace と同じ並び。 */
  readonly profile: readonly CurveSpec[];
  /** 押し出す向き(単位ベクトル)。 */
  readonly direction: Vec3Tuple;
  /** 押し出す長さ(mm)。正の数。 */
  readonly distance: number;
}

/** 断面を軸まわりに回して立体にする 1 手順(FR-402)。 */
export interface RevolveStepSpec {
  readonly kind: 'revolve';
  readonly profile: readonly CurveSpec[];
  readonly axisOrigin: Vec3Tuple;
  readonly axisDirection: Vec3Tuple;
  /** 回転角(ラジアン)。0 より大きく 2π 以下。 */
  readonly angle: number;
}

/** 面を縫い合わせて立体にする 1 手順(FR-403)。 */
export interface SewStepSpec {
  readonly kind: 'sew';
  /** 殻を作る面。1 枚ずつ閉ループで渡す。 */
  readonly profiles: readonly (readonly CurveSpec[])[];
  /** つなぎ目とみなす許容量(mm)。 */
  readonly tolerance: number;
}

/** 2 つの立体を組み合わせる 1 手順(FR-404)。 */
export interface BooleanStepSpec {
  readonly kind: 'boolean';
  readonly operation: 'union' | 'subtract' | 'intersect';
  /** すでに作った形を指すキャッシュの鍵。 */
  readonly targetKey: string;
  readonly toolKey: string;
}

/**
 * 和・差・積の別(FR-404)。
 * 依頼の型 BooleanStepSpec から取り出すので、依頼と実装で選択肢が食い違わない。
 */
export type BooleanOperation = BooleanStepSpec['operation'];

export type SolidStepSpec =
  | ExtrudeStepSpec
  | RevolveStepSpec
  | SewStepSpec
  | BooleanStepSpec
  | HoleStepSpec
  | ThreadStepSpec
  | FilletStepSpec
  | ChamferStepSpec
  /** ばね(FR-414、§2.7b)。対象を取らず、新しい形を作る(§0.36)。 */
  | SpringStepSpec;

/** 履歴 1 段ぶんの依頼。 */
export interface SolidStepRequest {
  /** 結果を覚える鍵。同じ鍵なら作り直さない(NFR-PF-3)。 */
  readonly key: string;
  /** 呼び出し側の識別子(フィーチャー id)。結果の対応づけに使う。 */
  readonly id: string;
  /** 進捗に出す表示名。 */
  readonly label: string;
  readonly step: SolidStepSpec;
  /** この段の結果を画面に出すか。消費されたボディは false。 */
  readonly visible: boolean;
}

/** 履歴をまとめて計算し直す依頼。 */
export interface SolidRecomputeRequest {
  readonly steps: readonly SolidStepRequest[];
  /** 取り消しの世代番号。cancelSolidRecompute に同じ番号を渡すと止まる(NFR-PF-4)。 */
  readonly generation: number;
}

/** ボディ 1 つ分の表示用データ。MeshData と同じ並び方をする。 */
export interface SolidBodyMesh {
  readonly id: string;
  /** 頂点座標。x, y, z の順に 3 個ずつ並ぶ。 */
  readonly positions: Float32Array;
  /** 頂点法線。positions と同じ長さ。 */
  readonly normals: Float32Array;
  /** 三角形の頂点番号。3 個ずつ並ぶ。 */
  readonly indices: Uint32Array;
  /** 稜線の線分列。線分 1 本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly edgePositions: Float32Array;
  readonly triangleCount: number;
  /** faces.length と必ず一致する(計画書 §2.8。タスク10 の検査で固定)。 */
  readonly faceCount: number;
  /** edges.length と必ず一致する(同上)。 */
  readonly edgeCount: number;
  /** 体積(mm³)。プロパティ欄の表示と検査に使う。 */
  readonly volume: number;
  /** 面の一覧(§2.2、§2.3)。並びは通し番号の順。 */
  readonly faces: readonly SolidFaceInfo[];
  readonly edges: readonly SolidEdgeInfo[];
  readonly vertices: readonly SolidVertexInfo[];
  /** ねじの簡略表示の印(§0.a-0.15)。無ければ空配列。 */
  readonly threadMarks: readonly ThreadMarkInfo[];
}

/** 立体を作れなかった段と、その理由。 */
export interface SolidStepFailure {
  readonly id: string;
  /** 利用者へそのまま見せる日本語(FR-504、NFR-RE-1)。 */
  readonly message: string;
}

/** 履歴の再計算の結果。1 段失敗しても止めずに残りを返す(FR-504)。 */
export interface SolidRecomputeResult {
  readonly bodies: readonly SolidBodyMesh[];
  readonly failures: readonly SolidStepFailure[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目の実測値)。 */
  readonly cacheHits: number;
  /** 途中で取り消されたか(NFR-PF-4)。 */
  readonly cancelled: boolean;
}

/** 計算中の進み具合。段を始める前に 1 回ずつ知らせる(NFR-PF-4)。 */
export interface SolidProgress {
  /** これから計算する段の識別子(SolidStepRequest.id と同じ)。 */
  readonly stepId: string;
  /** これから計算する段の位置。0 から始まる。画面には index + 1 を出す。 */
  readonly index: number;
  /** 段の総数。 */
  readonly total: number;
  /** 画面に出す段の名前(SolidStepRequest.label と同じ)。 */
  readonly label: string;
}

// ここから下は加工フィーチャー(FR-405〜408、FR-411、FR-412、FR-414)のための型。
// 上と同じく、Comlink 越しに渡せる素の値(数値・文字列・真偽・配列)だけで書く。
//
// SolidStepSpec の union と SolidBodyMesh の faces / edges / vertices / threadMarks は
// タスク10(kernel の段の追加・メッシュへの一覧の添付)でつないだ(計画書 §2.8)。
// faceCount は faces.length と、edgeCount は edges.length と必ず一致する
// (solidMesh.ts の buildSolidBodyMesh と subShapes.ts の collectSubShapes が保証し、
// recomputeSolids.test.ts が検査で固定する)。

/** 部分形状(B-rep の面・辺・頂点)の種類。選択と参照の単位になる。 */
export type SubShapeKind = 'face' | 'edge' | 'vertex';

/** 面の下地になっている曲面の種類。指紋の必須の一致条件(計画書 §2.2.2)。 */
export type FaceSurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

/** 辺の下地になっている曲線の種類。指紋の必須の一致条件。 */
export type EdgeCurveKind = 'line' | 'circle' | 'ellipse' | 'other';

/**
 * 面 1 枚の素性。指紋の材料と、当たり判定・強調の範囲表を兼ねる。
 *
 * 「形が同じなら必ず同じ値になるもの」だけを持つ(計画書 §2.2.2)。
 * 隣り合う面の一覧や三角形の数は、形が少し変わるだけで壊れるので持たない。
 */
export interface SolidFaceInfo {
  /** TopExp.MapShapes_2 の順で数えた 0 始まりの通し番号。 */
  readonly index: number;
  readonly surfaceKind: FaceSurfaceKind;
  /** 面積(mm²)。 */
  readonly area: number;
  /** 重心(mm)。 */
  readonly centroid: Vec3Tuple;
  /** 平面は法線、円柱・円錐は軸。求まらなければ null。 */
  readonly axis: Vec3Tuple | null;
  /** 円柱・円錐・球の半径(mm)。平面では null。 */
  readonly radius: number | null;
  /** この面の三角形が indices の何番目から何枚あるか。 */
  readonly triangleOffset: number;
  readonly triangleCount: number;
}

/** 辺 1 本の素性。並びは面と同じく TopExp.MapShapes_2 の順。 */
export interface SolidEdgeInfo {
  readonly index: number;
  readonly curveKind: EdgeCurveKind;
  /** 長さ(mm)。 */
  readonly length: number;
  /** 中点(mm)。 */
  readonly midpoint: Vec3Tuple;
  readonly start: Vec3Tuple;
  readonly end: Vec3Tuple;
  /** 直線は向き、円は軸。求まらなければ null。 */
  readonly axis: Vec3Tuple | null;
  /** 円の半径(mm)。それ以外は null。 */
  readonly radius: number | null;
  /** この辺の線分が edgePositions の何番目から何本あるか。 */
  readonly segmentOffset: number;
  readonly segmentCount: number;
}

/** 頂点 1 つの素性。位置しか持たない(種類も大きさも無い)。 */
export interface SolidVertexInfo {
  readonly index: number;
  readonly position: Vec3Tuple;
}

/**
 * ねじの簡略表示の印(§0.a-0.15)。B-rep には現れない、描画だけのための情報。
 * 下穴は実際に掘るが、ねじ山は形を作らずに細い円と軸線で表すので、再計算の費用がかからない。
 */
export interface ThreadMarkInfo {
  readonly origin: Vec3Tuple;
  readonly direction: Vec3Tuple;
  readonly majorDiameter: number;
  readonly length: number;
}

/**
 * 文書が保存する「部分形状の指紋」。段の依頼に乗り、カーネルが選び直しに使う(計画書 §2.2)。
 *
 * B-rep の面・辺には名前が無く通し番号しか手がかりが無いため、上流のフィーチャーを
 * 編集すると番号がずれて別の面を指しうる(トポロジカルネーミング問題)。そこで番号だけでなく
 * 種類・大きさ・軸・位置も一緒に保存し、再計算のたびに最も点の高いものを選び直す。
 * 採点は matchSubShape.ts が行う(OCCT を使わない純関数)。
 */
export type SubShapeQuery =
  | {
      readonly kind: 'face';
      readonly index: number;
      readonly surfaceKind: FaceSurfaceKind;
      readonly area: number;
      readonly position: Vec3Tuple;
      readonly axis: Vec3Tuple | null;
      readonly radius: number | null;
    }
  | {
      readonly kind: 'edge';
      readonly index: number;
      readonly curveKind: EdgeCurveKind;
      readonly length: number;
      readonly position: Vec3Tuple;
      readonly axis: Vec3Tuple | null;
      readonly radius: number | null;
    }
  | { readonly kind: 'vertex'; readonly index: number; readonly position: Vec3Tuple };

/**
 * 工具全体にかける剛体変換(パターン、§0.a-0.20)。空なら恒等 1 つとして扱う。
 *
 * パターンは新しい段の種類を作らず、穴・ねじ穴の工具をこの変換で複製して
 * まとめて差し引く。回転角は必ずラジアン(度で渡す取り違えを避けるため、
 * 度からの換算は model 側の責務。makeSolidSweep.ts の回転と同じ約束)。
 */
export interface RigidTransformSpec {
  readonly translation: Vec3Tuple;
  readonly rotationOrigin: Vec3Tuple;
  readonly rotationAxis: Vec3Tuple;
  /** 回転角(ラジアン)。0 なら平行移動だけ。 */
  readonly rotationAngle: number;
}

/**
 * 穴をあける 1 手順(FR-405)。
 * 向きと投影はカーネルが面から決める(model は面の指紋しか持たないため)。
 */
export interface HoleStepSpec {
  readonly kind: 'hole';
  /** 穴をあける立体を指すキャッシュの鍵。この段が消費する(§0.a-0.5)。 */
  readonly targetKey: string;
  /** 穴をあける面。カーネルが指紋で選び直し、平面と法線を取り出す。 */
  readonly face: SubShapeQuery;
  /** 中心にする点(mm)。カーネルが面の平面へ投影する。 */
  readonly centers: readonly Vec3Tuple[];
  readonly diameter: number;
  /** 貫通なら null、止まり穴なら深さ(mm)。 */
  readonly depth: number | null;
  /** 面の法線からの傾き(ラジアン)。 */
  readonly tiltAngle: number;
  /** 傾ける向き(面内の方位角、ラジアン)。基準は gp_Pln.XAxis()(§0.a-0.10)。 */
  readonly tiltAzimuth: number;
  readonly transforms: readonly RigidTransformSpec[];
}

/** ねじの実らせん(FR-406)。簡略表示のときは ThreadStepSpec.thread を null にする。 */
export interface ThreadCutSpec {
  /** おねじの外径 d(mm)。めねじの谷径にあたる。 */
  readonly majorDiameter: number;
  readonly pitch: number;
  /** ねじ部の長さ(mm)。 */
  readonly length: number;
}

/** 3D の簡略表示に使うねじの印(B-rep には触らない)。位置と向きはカーネルが面から決める。 */
export interface ThreadMarkSpec {
  readonly majorDiameter: number;
  readonly length: number;
}

/** ねじ穴をあける 1 手順(FR-406)。下穴は穴と同じ手順で掘り、ねじ山だけが追加になる。 */
export interface ThreadStepSpec {
  readonly kind: 'thread';
  readonly targetKey: string;
  readonly face: SubShapeQuery;
  readonly centers: readonly Vec3Tuple[];
  /** 下穴の径(mm、= めねじ内径 D1)。 */
  readonly drillDiameter: number;
  readonly depth: number | null;
  readonly tiltAngle: number;
  readonly tiltAzimuth: number;
  readonly transforms: readonly RigidTransformSpec[];
  /** 実らせんを切るときだけ入る。簡略表示のときは null。 */
  readonly thread: ThreadCutSpec | null;
  /** 画面へ返すねじの印(簡略表示、§0.a-0.15)。実形状のときも返してよい。 */
  readonly mark: ThreadMarkSpec | null;
}

/**
 * 角を丸める 1 手順(FR-407)。
 * targets には辺と頂点の指紋が混ざる。頂点はカーネルが「その頂点に集まる辺」へ
 * 展開する(§0.a-0.17。頂点を球状に丸める API は OCCT に無い)。
 */
export interface FilletStepSpec {
  readonly kind: 'fillet';
  /** 丸める立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** 丸める辺・頂点の指紋。並びは文書の並びのまま保つ。 */
  readonly targets: readonly SubShapeQuery[];
  /** 丸める半径(mm)。0 より大きい数。 */
  readonly radius: number;
}

/**
 * C 面取りの大きさの指定(FR-408 の①②③)。
 * 角度はラジアンで渡す(度で渡す取り違えを避けるため、換算は model 側の責務)。
 */
export type ChamferSizeSpec =
  | { readonly kind: 'equal'; readonly distance: number }
  | { readonly kind: 'twoDistances'; readonly distance1: number; readonly distance2: number }
  | { readonly kind: 'distanceAngle'; readonly distance: number; readonly angle: number };

/** 面を取る 1 手順(FR-408)。辺の決め方は R 面取りと同じ関数を使い回す。 */
export interface ChamferStepSpec {
  readonly kind: 'chamfer';
  readonly targetKey: string;
  readonly targets: readonly SubShapeQuery[];
  readonly size: ChamferSizeSpec;
  /**
   * 2 距離・距離角度のときの基準面を、辺に接する 2 面のうち後の方にするか(§0.a-0.18)。
   * 基準面をもう 1 回選ばせると操作が 2 段になるため、既定は並びで先に出る面にし、
   * 思っていたのと逆ならこのつまみ 1 つで入れ替える。
   */
  readonly swapReferenceFace: boolean;
}

/**
 * らせんを掃引してばねを作る 1 手順(FR-414、計画書 §2.7b.2)。
 * 対象を取らない(押し出し・回転・縫合と同じ「新しいボディを作る」段、§0.36)。
 */
export interface SpringStepSpec {
  readonly kind: 'spring';
  /** らせんの軸の始点(mm)。線材の中心はここから coilDiameter/2 離れた位置で始まる。 */
  readonly origin: Vec3Tuple;
  /** 軸の向き(単位ベクトルでなくてよい)。傾きを適用した後。 */
  readonly direction: Vec3Tuple;
  /** コイルの中心径(mm)。 */
  readonly coilDiameter: number;
  /** 線径(mm)。 */
  readonly wireDiameter: number;
  /** 1 巻きあたりの軸方向の進み(mm)。 */
  readonly pitch: number;
  /** 巻数。0 より大きい。整数でなくてよい。上限は 200(§0.a-0.35)。 */
  readonly turns: number;
  readonly handedness: 'right' | 'left';
}
