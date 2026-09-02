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

export type SolidStepSpec = ExtrudeStepSpec | RevolveStepSpec | SewStepSpec | BooleanStepSpec;

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
  readonly faceCount: number;
  readonly edgeCount: number;
  /** 体積(mm³)。プロパティ欄の表示と検査に使う。 */
  readonly volume: number;
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
