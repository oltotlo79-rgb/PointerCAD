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
