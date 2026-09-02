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

export type CurveSpec = SegmentSpec | ArcSpec;

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
