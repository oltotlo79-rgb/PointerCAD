// 輪郭のオフセット(FR-321)の角の種類と結果の形は `occt/makeOffsetWire.ts` が正本。
// 同じ約束を2か所に書かないため、ここでは取り込んで輸出し直すだけにする
// (型だけの取り込みなので、実行時の読み込みは起きない)。
import type { HoleEntrySpec } from './occt/makeHole.js';
import type { OffsetContour, OffsetJoinType } from './occt/makeOffsetWire.js';
// 押し出しの終端(FR-415)・薄板の厚みの向き(FR-416)・曲面の作り方(FR-428)も
// オフセットと同じ理由で、作り手のファイルの定義を取り込んで輸出し直すだけにする
// (段の依頼が持つ値の意味は、その値を読む作り手の側が正本)。
import type { ExtrudeEndSpec } from './occt/makeSolidSweep.js';
import type { SurfaceInput } from './occt/makeSurface.js';
import type { ThinExtrudeSide } from './occt/makeThinExtrude.js';
// 書き出し・読み込み(FR-802、FR-803、P6 タスク10)が使う 4 つも同じ理由で取り込む。
// 三角形の網(`ExportMesh`)は `occt/exportMesh.ts`、色(`RgbTuple`)は
// `occt/xcafDocument.ts`、ファイルの単位(`StepFileLengthUnit`)は `occt/readStep.ts`、
// 面ごとの色の表(`FaceColorMap`)は `occt/xcafFaceColors.ts` が正本。
// **ここでは輸出し直さない**(輸出の口は `index.ts` が作り手のファイルから 1 度だけ開く。
// 同じ名前が 2 経路から出ると、取り込む側がどちらを指しているのか読めなくなるため)。
import type { ExportMesh } from './occt/exportMesh.js';
import type { PrintabilityResult } from './occt/inspectPrintability.js';
import type { StepFileLengthUnit } from './occt/readStep.js';
import type { RgbTuple } from './occt/xcafDocument.js';
import type { FaceColorMap } from './occt/xcafFaceColors.js';
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
  readonly partId?: string;
  readonly items: readonly SketchProjectionItem[];
}

/** 交差の依頼をまとめたもの。 */
export interface SketchSectionRequest {
  readonly partId?: string;
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

/**
 * 段の依頼が持つ値のうち、意味を決めているのが作り手のファイルのもの(P5 タスク42a)。
 *
 * オフセットの角の種類(`OffsetJoinType`)と同じ理由で、**定義はその値を読む作り手の側に
 * 1 つだけ置き**、ここでは取り込んで輸出し直す。押し出しの終端(FR-415)は
 * `occt/makeSolidSweep.ts`、薄板の厚みの向き(FR-416)は `occt/makeThinExtrude.ts`、
 * 穴の入口(FR-422)は `occt/makeHole.ts`、曲面の作り方(FR-428)は
 * `occt/makeSurface.ts` がそれぞれ正本である。
 */
export type { ExtrudeEndSpec, HoleEntrySpec, SurfaceInput, ThinExtrudeSide };

/**
 * 薄板押し出し(FR-416、P5 §2.12)の厚みの指定。
 *
 * 厚みと向きは**必ず組**で決まる(厚みだけ・向きだけでは形が決まらない)ので、
 * `ExtrudeStepSpec` に 2 つの欄をばらばらに足さず 1 つの入れ物にまとめる
 * (`ChamferSizeSpec` / `HoleEntrySpec` と同じ流儀)。向きの意味は
 * `occt/makeThinExtrude.ts` の `ThinExtrudeSide` が正本。
 */
export interface ThinExtrudeSpec {
  /** 壁の厚み(mm)。0 より大きい数。 */
  readonly thickness: number;
  /** 厚みをどちら側へ付けるか(輪郭が外側 / 内側 / 中心)。 */
  readonly side: ThinExtrudeSide;
}

/**
 * ソリッドを作る 1 手順。向き・両側・反転の計算は model 側で済ませて渡す。
 *
 * **P5 で欄が増えた**(FR-415 の終端、FR-401 のテーパ、FR-416 の薄板)。増えた欄は
 * **すべて省略でき、省略したときは P2 からの押し出しと 1 ドットも変わらない**
 * (版 4 以前の文書と、まだ欄を渡していない model の経路がそのまま動く。計画書 §2.13)。
 */
export interface ExtrudeStepSpec {
  readonly kind: 'extrude';
  /** 断面の閉ループ。makePlanarFace と同じ並び。 */
  readonly profile: readonly CurveSpec[];
  /** 押し出す向き(単位ベクトル)。 */
  readonly direction: Vec3Tuple;
  /** 押し出す長さ(mm)。正の数。 */
  readonly distance: number;
  /**
   * 終端の指定(FR-415)。省略すると `{ kind: 'distance', distance }` と同じ。
   *
   * `toFace`(指定の面まで)は model が距離を計算して渡す約束なので、カーネルから見ると
   * `distance` と同じ扱いになる(`occt/makeSolidSweep.ts` の `ExtrudeEndSpec` の注釈)。
   * `toNext`(次の面まで)だけは相手の形が要るので `targetKey` も一緒に渡す。
   */
  readonly end?: ExtrudeEndSpec;
  /**
   * 側面の傾き(ラジアン、FR-401)。**大きさだけ**を持ち、0 以上 90 度未満。
   * 向きは `taperOutward` で指定する(抜き勾配の `angle` + `reversed` と同じ持ち方)。
   */
  readonly taperAngle?: number;
  /** true で押し出すほど外へ広がり、false(既定)で内へ絞る。 */
  readonly taperOutward?: boolean;
  /** 薄板押し出し(FR-416)。省略すると中身の詰まった押し出しになる。 */
  readonly thin?: ThinExtrudeSpec;
  /**
   * 「次の面まで」(`end.kind === 'toNext'`)の相手の立体を指すキャッシュの鍵。
   * それ以外の終端では省く(渡されても見ない)。
   *
   * **この鍵の段は消費しない**(材料の位置を読むだけで、相手の立体は画面に残る。
   * `PrimitiveStepSpec.targetKey` と同じ扱い)。**呼び出し側は、この段の鍵の材料に
   * `targetKey` を必ず含める**——含めないと、相手の立体を動かしても押し出しの鍵が
   * 変わらず、古い長さの形がキャッシュから返る(NFR-PF-3 の鍵の連鎖)。
   */
  readonly targetKey?: string | null;
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
  | SpringStepSpec
  /** 基本形状(FR-429、P5 §2.7)。ばねと同じく対象を取らない「作る」段(§0.a-0.19)。 */
  | PrimitiveStepSpec
  /** 罫線面(FR-430)とロフト(FR-410、P5 §2.9)。これも対象を取らない「作る」段(§0.a-0.27)。 */
  | ThruSectionsStepSpec
  // ここから下は P5 の Should 群・Could 群(タスク42a)。定義は下の「加工の段」の節にある。
  /** 抜き勾配(FR-417)。 */
  | DraftStepSpec
  /** ミラー(FR-419)。対象を消費しない(§0.a-0.36)。 */
  | MirrorStepSpec
  /** 移動/回転(FR-424)。 */
  | TransformStepSpec
  /** 拡大縮小(FR-424)。 */
  | ScaleStepSpec
  /** スイープ(FR-409)。対象を取らない「作る」段。 */
  | SweepStepSpec
  /** リブ(FR-420)。 */
  | RibStepSpec
  /** エンボス(FR-421)。 */
  | EmbossStepSpec
  /** 外ねじ(FR-423)。 */
  | ThreadShaftStepSpec
  /** 曲面(FR-428)。`bodyKind: 'shell'` のボディを作る。 */
  | SurfaceStepSpec
  /** 平面による切断(FR-432)。分割(FR-424)もこれで満たす(§0.a-0.60)。 */
  | CutStepSpec
  /** くり抜き(FR-418)。 */
  | ShellStepSpec
  /** 読み込んだ形のベースボディ(FR-802、P6 §2.8、タスク10)。定義は下の節にある。 */
  | ImportedSolidStepSpec;

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
  /**
   * この段だけの三角形分割の粗さ(P5 §2.13、§0.a-0.54)。省略なら段の種類ごとの既定。
   *
   * 優先順位は **段ごとの指定 > 呼び出し側が `recomputeSolids` の第 2 引数へ渡した指定 >
   * 段の種類ごとの既定**(掃引体だけ粗くする `SWEEP_TESSELLATION_OPTIONS`)。
   * 段ごとに変えられるようにしてあるのは、形の種類が同じでも寸法によって必要な細かさが
   * 変わるためで、値を決めるのは model 側(`kernelBridge.ts` の `toSolidStepRequest`)。
   * P6 の STL / 3MF の「品質(偏差)指定」(FR-803)もこの欄へ乗る(計画書 §7.1-(d))。
   */
  readonly tessellation?: TessellationOptions;
}

/** 形状キャッシュの使用中保護とメモリの診断(OCCT 本体のバイト数は含めない)。 */
export interface ShapeCacheDiagnostics {
  /** 保持する形の数。保護中の上書きで解放を待っている旧形も含む。 */
  readonly shapeCount: number;
  /** 確保中の異なる鍵の数。まだ作っていない鍵も含む。 */
  readonly protectedKeyCount: number;
  /** 保持するメッシュの typed array のバイト数の合計。 */
  readonly meshBytes: number;
  /** 保護対象だけで容量を超えた現在の件数。 */
  readonly protectedOverBudget: number;
  /** 確保が残った状態で clear した回数(累計)。 */
  readonly clearWithActiveTokensCount: number;
  readonly diagnostics: readonly string[];
}

/** 履歴をまとめて計算し直す依頼。 */
export interface SolidRecomputeRequest {
  /** 文書/session 内で安定した部品の識別子。省略時は part:current。 */
  readonly partId?: string;
  readonly steps: readonly SolidStepRequest[];
  /** 取り消しの世代番号。cancelSolidRecompute に同じ番号を渡すと止まる(NFR-PF-4)。 */
  readonly generation: number;
  /**
   * 外観を割り当てた面の指紋(FR-1106、P5 §2.2.3)。段を作り終えたあと、
   * カーネルが同じ面を選び直して `SolidRecomputeResult.appearanceMatches` で返す。
   *
   * **省略か空なら照合を一切行わない。** 照合の物差し(境界箱の対角長)を測るのにも
   * OCCT を呼ぶので、外観を 1 つも割り当てていない文書では 1 回も呼ばないようにして、
   * 費用をゼロにする(§0.a-0.54 の「外観の追加で所要を増やさない」)。
   */
  readonly appearanceQueries?: readonly AppearanceQuery[];
  /**
   * ボディの表面積(`SolidBodyMesh.area`)を測るか(統括の決定 2026-09-05、P5 タスク14)。
   *
   * **省略か false なら測らず、`area` は入らない。** 表面積は形が手元にあるこの場でしか
   * 安く測れないが、それでもただではない(2026-09-05 実測: 面 26 枚の板で 11.4ms)。
   * NFR-PF-2 の上限 500ms に対して穴 20 個の板がすでに 485〜510ms を使っているので、
   * 誰も見ない表面積のために余裕を削らない、という判断である。
   *
   * **true にするのは、測定・質量特性(FR-1101・FR-1102、タスク28・29)が値を要るときだけ。**
   * 外観の面の照合(FR-1106)は面ごとの面積(`SolidFaceInfo.area`)しか使わないので、
   * この欄とは関わりが無い(照合を頼んでも表面積は測らない)。
   *
   * キャッシュに命中した段でこの欄が true になったときは、覚えてある形から
   * その場で測って足す(段を作り直さない)。
   */
  readonly measureAreas?: boolean;
}

/**
 * 形の種類(FR-428、P5 §0.a-0.45。P6 §0.a-0.24 で `'mesh'` が加わった)。
 *
 * - `'solid'`: 閉じた立体を含む形。
 * - `'shell'`: 面だけのボディ(押し出し面・回転面など)。曲面の段(`makeSurface.ts`)が作る。
 * - `'mesh'`: **読み込んだ三角形の形**(STL / OBJ / glTF / 3MF のベースボディ、FR-802)。
 *
 * `'solid'` と `'shell'` の判定は `solidMesh.ts` の `hasSolid` そのままで、**体積では決めない**
 * (ふたの無い開いた殻は体積が 0 とは限らない。P5 タスク41 の実測)。
 *
 * **`'mesh'` を作るのは kernel ではなく model 側**(`importedMesh` のフィーチャー。
 * P6 §2.8、タスク20)。三角形の網は B-rep へ変換しない(§0.a-0.23)ので、この種類の
 * ボディは幾何カーネルの中に形を持たない。kernel から見ると **`'mesh'` は
 * 「段の材料にできない印」** で、加工の段が対象に取ろうとしたら
 * `worker/recomputeSolids.ts` の `findStepInput` が 1 か所で断る(§2.8 の断りの表)。
 */
export type SolidBodyKind = 'solid' | 'shell' | 'mesh';

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
  /**
   * 表面積(mm²)。測定(FR-1102)と曲面の検証(FR-428)に使う。
   *
   * **依頼が `SolidRecomputeRequest.measureAreas` で求めたときだけ入る**(統括の決定
   * 2026-09-05、P5 タスク14)。求めていない再計算では `undefined` のままで、
   * 測る費用(面 26 枚の板で 11.4ms)を払わない。理由は `measureAreas` の注釈にある。
   * **`area` はこの決定により任意の欄のままとし、タスク4 でも必須へ上げない。**
   */
  readonly area?: number;
  /**
   * 形の種類(FR-428)。**必須の欄**(§0.a-0.77、タスク42b)。
   *
   * 判定は `buildSolidBodyMesh` の `hasSolid(oc, shape)` そのままで、**体積では決めない**。
   * タスク41 で「ふたの無い開いた殻は体積が 0 とは限らない」ことが実測(体積 8000 の
   * 開いた殻)で確かめられたため、体積からは `solid` / `shell` を判別できない。
   * `hasSolid` は部分形状を数えるだけなので安く、どの段でも必ず入れられる。
   *
   * §0.a-0.4 等で任意にしていたのは、この欄を組み立てる model 側の見本が揃うまでの
   * 経過措置だった(`area` は「求めたときだけ測る」ので任意のまま。理由が違う)。
   */
  readonly bodyKind: SolidBodyKind;
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
  /**
   * 外観の面の照合の結果(FR-1106)。依頼の `appearanceQueries` と同じ並び・同じ件数で返る。
   * 依頼が省略・空なら空配列。
   *
   * 任意の欄にしてあるのは `SolidBodyMesh.area` と同じ理由(組み立て側の model を
   * 直せるのが P5 タスク4)で、kernel の `recomputeSolids` は必ず値を入れる。
   */
  readonly appearanceMatches?: readonly AppearanceMatch[];
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
  /** 円筒・円錐の解析軸上点(mm)。重心と異なる。収集結果では他の面は null。 */
  readonly axisOrigin?: Vec3Tuple | null;
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
  /** 円の解析中心(mm)。円弧の重心と異なる。収集結果では他の辺は null。 */
  readonly axisOrigin?: Vec3Tuple | null;
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
 * 外観を割り当てた面 1 つぶんの照合の依頼(FR-1106、P5 §2.2.3)。
 *
 * 外観は履歴ではなく「割り当て」なので、文書は面を指紋(`SubShapeQuery`)で覚えている。
 * 形を作り直すと面の通し番号がずれるため、再計算のたびにここでカーネルが選び直す。
 * **指紋の採点と規約は P3 の部分形状の参照(`occt/matchSubShape.ts`)をそのまま使い、
 * 外観のための別の規約は作らない。**
 */
export interface AppearanceQuery {
  /** 割り当て 1 つの id。結果と 1 対 1 に対応づけるためだけに使う(中身は見ない)。 */
  readonly id: string;
  /** 面を持つボディの段のキャッシュの鍵(`SolidStepRequest.key`)。 */
  readonly bodyKey: string;
  /** 覚えてある面の指紋。面以外(辺・頂点)が来たら照合せずに断る。 */
  readonly query: SubShapeQuery;
}

/** 照合の結果 1 件(FR-1106)。 */
export interface AppearanceMatch {
  /** 依頼の `AppearanceQuery.id` をそのまま返す。 */
  readonly id: string;
  /**
   * 面が属するボディの識別子(`SolidStepRequest.id`)。
   * **画面に出るボディが依頼の鍵に見つからなかったときは空文字**で、
   * そのときは `faceIndex` も必ず `null` になる(消費された・失敗した・そもそも無い段)。
   */
  readonly bodyId: string;
  /**
   * 選び直せた面の通し番号。しきい値(0.6)に届かなければ `null`。
   * `null` は「見つからないので既定の外観に戻して警告する」の合図(FR-1106)。
   */
  readonly faceIndex: number | null;
}

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
  /**
   * 入口の形(ざぐり・皿もみ、FR-422、§0.a-0.39)。形の定義は `occt/makeHole.ts` の
   * `HoleEntrySpec` が正本(皿もみの角度は**ラジアン**。深さは kernel が角度と径から出すので、
   * model は計算しない)。
   *
   * **省くと今までどおりの真っ直ぐな穴**(`{ kind: 'plain' }`)になる。
   * 任意の欄にしてあるのは、この欄を組み立てる model 側(`kernelBridge.ts`)を直せるのが
   * P5 タスク46 だからで、**タスク46 が既定 `{ kind: 'plain' }` を必ず入れるようにしたら
   * 必須へ引き上げてよい**(`SolidBodyMesh.bodyKind` と同じ経過措置)。
   */
  readonly entry?: HoleEntrySpec;
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
  /**
   * 下穴の入口の形(ざぐり・皿もみ、FR-422、§0.a-0.39)。**穴(`HoleStepSpec.entry`)と
   * まったく同じ扱い**で、形の定義は `occt/makeHole.ts` の `HoleEntrySpec` が正本
   * (皿もみの角度は**ラジアン**。深さは kernel が角度と径から出す)。
   *
   * **省くと今までどおりの真っ直ぐな下穴**(`{ kind: 'plain' }`)になる。
   * ねじ山は入口の底から始まる(`occt/makeThread.ts` の `threadOrigins`)ので、
   * 削れる量は「入口が無いときの削れ量 + 入口の削れ量」になる。
   *
   * 任意の欄にしてあるのは穴と同じ理由(欄を組み立てる model 側を直すのが別のタスク)で、
   * model が既定 `{ kind: 'plain' }` を必ず入れるようになったら必須へ引き上げてよい。
   */
  readonly entry?: HoleEntrySpec;
}

/**
 * 丸める半径(FR-407、FR-426、§0.a-0.48)。
 *
 * 数 1 つなら一定半径(`occt/makeFillet.ts`)、始点と終点の 2 つなら可変半径
 * (`occt/makeVariableFillet.ts`)。**辺の始点側が `start`、終点側が `end`** で、
 * どちらが始点かは B-rep の辺の向きで決まる(`Add_3(R1, R2, E)` の R1 が始点側)。
 * 可変半径は段の中のすべての辺に同じ 2 値を当てる(辺ごとに変えたいときは段を分ける)。
 */
export type FilletRadiusSpec = number | { readonly start: number; readonly end: number };

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
  /** 丸める半径(mm)。0 より大きい数、または可変半径の 2 値(FR-426)。 */
  readonly radius: FilletRadiusSpec;
}

/**
 * 一定半径に絞った R 面取りの依頼(`occt/makeFillet.ts` が受け取る形)。
 *
 * `FilletStepSpec` の半径が可変にも広がった(FR-426)ので、**一定半径しか扱わない
 * `makeFillet` には絞った型で渡す**。振り分けるのは `recomputeSolids` の 1 か所だけで、
 * 作り手の側に「どちらの半径か」の分岐を持ち込まない(ファイルは別のまま。§0.a-0.48)。
 */
export type ConstantFilletStepSpec = FilletStepSpec & { readonly radius: number };

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

/**
 * 基本形状の寸法(mm)。種類ごとに欄が違う判別共用体(FR-429、計画書 P5 §2.7.2)。
 *
 * 円錐だけが半径を 2 つ持つ。上半径 0 で尖った円錐に、0 より大きい値で円錐台になるので、
 * **円錐台を別の種類にしないで済む**(§0.a-0.16)。寸法の範囲の検査と断りの文言は
 * `occt/makePrimitive.ts` が持つ(model 側にも同じ検査があり、実行前に赤くする。§2.7.1)。
 */
export type PrimitiveShapeSpec =
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'box'; readonly sizeX: number; readonly sizeY: number; readonly sizeZ: number }
  | { readonly kind: 'cylinder'; readonly radius: number; readonly height: number }
  | {
      readonly kind: 'cone';
      readonly bottomRadius: number;
      readonly topRadius: number;
      readonly height: number;
    }
  | { readonly kind: 'torus'; readonly majorRadius: number; readonly minorRadius: number };

/**
 * 基本形状を 1 つ作る 1 手順(FR-429、計画書 P5 §2.7.2)。
 * **対象を取らない**(押し出し・回転・縫合・ばねと同じ「新しいボディを作る」段、§0.a-0.19)。
 *
 * 例外は基準点を「立体の頂点」にしたとき(§0.a-0.18、P5 タスク14b)で、そのときだけ
 * `originQuery` と `targetKey` が入り、カーネルが対象の形から頂点を引く。
 * **それでも対象は消費しない**(穴・ばね・ブーリアンと違い、頂点を貸した立体は
 * そのまま画面に残る)ので、「新しいボディを作る」段であることは変わらない。
 */
export interface PrimitiveStepSpec {
  readonly kind: 'primitive';
  /**
   * 基準点(mm)。球・箱・トーラスは中心、円柱・円錐は底面の中心(§0.a-0.17)。
   *
   * **`originQuery` が入っているときは、その頂点からのオフセットとして扱う**
   * (統括の決定 2026-09-05、P5 タスク14b)。頂点そのものを基準にするなら `[0, 0, 0]`。
   * `originQuery` が `null` のときは、これまでどおり世界座標そのものである。
   */
  readonly origin: Vec3Tuple;
  /** 向き。長さは問わない(カーネルが長さ 1 へ揃える)。`gp_Ax2` の Z 方向になる。 */
  readonly axis: Vec3Tuple;
  readonly shape: PrimitiveShapeSpec;
  /**
   * 基準点にする「立体の頂点」の指紋(FR-429 の 3 通りのうちの 1 つ、§0.a-0.18)。
   *
   * 座標の式・スケッチの点で基準点を決めるときは `null`。頂点を指すときは
   * **必ず `kind: 'vertex'` の指紋**を入れる(面・辺を渡されたら断る)。
   * 選び直しは P3 の部分形状の参照とまったく同じ採点(`occt/matchSubShape.ts` の
   * `matchVertex`)で行い、基本形状のための別の規約は作らない。
   *
   * **頂点の指紋は番号が変わると最高 0.5 でしきい値 0.6 に届かない**(§0.a-0.18 の注意)。
   * つまり上流を大きく作り替えると「見つからない」になりやすく、そのときは
   * 日本語の理由を添えて断る(FR-504)。
   */
  readonly originQuery: SubShapeQuery | null;
  /**
   * `originQuery` の頂点を持つ立体の段のキャッシュの鍵。`originQuery` が `null` なら `null`。
   *
   * **この鍵の段は消費しない**(§0.a-0.19)。穴・面取り・ブーリアンの `targetKey` は
   * 対象を食べてしまうが、基本形状は頂点の座標を読むだけなので、対象のボディは
   * そのまま画面に残る(結果は 2 ボディになる)。
   *
   * **呼び出し側(model の `part/cacheKey.ts`、P5 タスク15)は、この段の鍵の材料に
   * `originQuery` と `targetKey` を必ず含める。** 含めないと、上流の押し出しを伸ばして
   * 頂点が動いても段の鍵が変わらず、古い位置の形がキャッシュから返る(NFR-PF-3 の
   * 鍵の連鎖は「材料が変われば鍵が変わる」ことに全面的に頼っているため)。
   */
  readonly targetKey: string | null;
}

/**
 * 罫線面・ロフトの断面 1 つ(FR-430、FR-410、計画書 P5 §2.9、タスク24)。
 *
 * ふつうは閉じた輪郭(`curves`)だが、**球だけは縁を持たない**ので中心と半径で渡す。
 * 球が入っているときは `ThruSections` にそのまま渡さず、球に外接する直線
 * (接する円錐面)で結ぶ経路へ入る(`occt/makeThruSections.ts` の冒頭)。
 *
 * **立体の面を輪郭にするときは `faceQuery`**(§0.a-0.73、P5 タスク24b)。model 側で
 * 輪郭の曲線に直さないのは、面を指す手がかりが指紋(`SubShapeQuery`)しか無く、
 * **選び直しはカーネルの中で行う**と決めてあるためである(P3 §2.2.4。穴・面取りと同じ)。
 */
export type ThruSectionSpec =
  | { readonly kind: 'curves'; readonly curves: readonly CurveSpec[] }
  | { readonly kind: 'sphere'; readonly center: Vec3Tuple; readonly radius: number }
  | {
      readonly kind: 'faceQuery';
      /**
       * 面を持つ立体の段のキャッシュの鍵。
       *
       * **この鍵の段は消費しない**(§0.a-0.27)。輪郭を貸した立体はそのまま画面に残る。
       *
       * **呼び出し側(model の `part/cacheKey.ts`)は、この段の鍵の材料に `targetKey` と
       * `query` を必ず含める。** 含めないと、上流の押し出しを伸ばして面が動いても
       * 段の鍵が変わらず、古い輪郭の形がキャッシュから返る(NFR-PF-3 の鍵の連鎖は
       * 「材料が変われば鍵が変わる」ことに全面的に頼っている。`PrimitiveStepSpec`
       * の `targetKey` と同じ理由)。
       */
      readonly targetKey: string;
      /** 輪郭にする面の指紋。**必ず `kind: 'face'`**(辺・頂点を渡されたら断る)。 */
      readonly query: SubShapeQuery;
    };

/**
 * 球へつなぐ一般の輪郭(§2.9.3-(b))を割る点の数(§0.a-0.74、利用者の決定 2026-09-05)。
 *
 * 多いほど球への接し方が滑らかになり、そのぶん遅くなる。既定の 24 は
 * NFR-PF-2(500ms)に収まるいちばん細かい値で、48 / 72 は「なめらかさ」を優先して
 * 利用者が選ぶ重い段である(実測は `occt/makeThruSections.ts` の冒頭の表)。
 */
export type SphereSegmentCount = 24 | 48 | 72;

/**
 * 輪郭をつないで立体にする 1 手順(罫線面 FR-430・ロフト FR-410、計画書 P5 §2.9)。
 *
 * **対象を取らない「作る」段**(押し出し・回転・縫合・ばね・基本形状と同じ。§0.a-0.27)。
 * 輪郭の材料になった立体はそのまま画面に残る。
 *
 * 罫線面(直線で結ぶ)とロフト(なめらかに結ぶ)は、利用者から見て別の道具なので
 * **model 側のフィーチャーの種類は分ける**が、カーネルでは `ruled` の真偽だけが違うので
 * 段は 1 種類にまとめてある(§0.a-0.25。同じものを 2 つ作らない)。
 */
export interface ThruSectionsStepSpec {
  readonly kind: 'thruSections';
  /** つなぐ断面。2 つ以上。球を入れられるのは 1 つまでで、そのとき輪郭は 1 つだけ。 */
  readonly sections: readonly ThruSectionSpec[];
  /** true なら直線で結ぶ(罫線面)、false ならなめらかに結ぶ(ロフト)。 */
  readonly ruled: boolean;
  /** true なら両端に面を張って閉じた立体にする。false なら殻のまま(いまは常に true)。 */
  readonly closed: boolean;
  /** 輪郭のねじれを直すための、2 つ目以降の輪郭の稜線のずらし数(整数。§0.a-0.28)。 */
  readonly twist: number;
  /**
   * 球へつなぐ一般の輪郭を割る点の数(§0.a-0.74)。**段ごとに必須**。
   *
   * 省略できる欄にしていないのは、文書に書かれていない段が「既定の 24」で
   * 黙って作られると、後で既定を変えたときに保存済みの文書の形が一斉に変わるためである
   * (既定を入れるのは model 側。`docs/plans/P5-高度なソリッド・外観と測定.md` §0.a-0.74)。
   * 24 / 48 / 72 以外の値(古い文書・壊れた文書から来た値)は理由をつけて断る。
   *
   * **球を含まない段では形に効かない。** 全周の円と球の厳密な経路(§2.9.3-(a))も
   * 点に割らないので、この値には依らない。
   */
  readonly sphereSegments: SphereSegmentCount;
}

// ---------------------------------------------------------------------------
// P5 の Should 群・Could 群の段(FR-401、FR-409、FR-415〜FR-428、FR-432。タスク42a)。
//
// 形を作るのは `occt/make*.ts` で、**段の型はその作り手の依頼(`*Input`)の上位互換**
// (判別のための `kind` と、対象を指す `targetKey` を足しただけ)にしてある。
// こうしておくと `recomputeSolids` が欄を詰め替えずにそのまま渡せる(構造的部分型)ので、
// 同じ欄の名前と意味を 2 か所に書かずに済む(`EllipseCurveSpec` と同じ流儀)。
//
// **消費するかどうか**(対象の立体が画面に残るか)は段ごとに違う。決めるのは
// `SolidStepRequest.visible` を組み立てる model 側で、カーネルはそれに触れないが、
// model が取り違えないよう各型の注釈に「消費する / しない」を明記する。
// ---------------------------------------------------------------------------

/**
 * 抜き勾配(FR-417、P5 §2.11)。中立面を基準に、選んだ面を型が抜ける向きへ傾ける。
 *
 * **対象を消費する**(傾けた立体 1 つだけが残る)。
 * 角度の上限は 60 度(§0.a-0.72)。判定と断りの文言は `occt/makeDraft.ts` が持つ。
 */
export interface DraftStepSpec {
  readonly kind: 'draft';
  /** 傾ける立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** 傾ける面の指紋。1 枚以上。曲面(円柱の側面など)でもよい。 */
  readonly faces: readonly SubShapeQuery[];
  /** 基準にする平らな面(中立面)の指紋。この面は動かない。 */
  readonly neutralFace: SubShapeQuery;
  /** 角度(ラジアン)。0 より大きく 60 度以下。 */
  readonly angle: number;
  /** 抜き方向を反転する(内側へ狭める)。 */
  readonly reversed: boolean;
}

/**
 * ミラー(FR-419、§0.a-0.36)。平面に対する鏡像を 1 つ作る。
 *
 * **対象を消費しない。** 鏡像を作ったあと元と鏡像を「和」でつなぐのが普通の使い方で、
 * 元を消すと和が取れない(基本形状・罫線面と同じ「作る」段)。結果は 2 ボディになる。
 */
export interface MirrorStepSpec {
  readonly kind: 'mirror';
  /** 鏡に映す立体を指すキャッシュの鍵。**この段は消費しない。** */
  readonly targetKey: string;
  /** 鏡の平面が通る点(mm)。 */
  readonly origin: Vec3Tuple;
  /** 鏡の平面の法線。長さは 1 でなくてよい(カーネルが揃える)。 */
  readonly normal: Vec3Tuple;
}

/**
 * 移動/回転(FR-424、§0.a-0.41)。対象を剛体変換した立体を 1 つ作る。
 *
 * **対象を消費する**(元の位置に残すと二重になる)。
 * 欄の意味は `RigidTransformSpec` と同じで、回転角は必ずラジアン。
 */
export interface TransformStepSpec {
  readonly kind: 'transform';
  /** 動かす立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  readonly translation: Vec3Tuple;
  readonly rotationOrigin: Vec3Tuple;
  readonly rotationAxis: Vec3Tuple;
  /** 回転角(ラジアン)。0 なら平行移動だけ。 */
  readonly rotationAngle: number;
}

/**
 * 拡大縮小(FR-424、§0.a-0.41)。**対象を消費する。**
 *
 * `uniform`(全体の倍率)と `perAxis`(軸ごとの倍率)は**どちらか一方だけ**を入れる
 * (両方 null・両方非 null はどちらも組み立ての誤りとして断る。`occt/transformShape.ts`)。
 * 軸ごとに倍率が違うと円柱面が楕円柱面に変わり、下流の指紋が外れうる(タスク35 の実測)。
 */
export interface ScaleStepSpec {
  readonly kind: 'scale';
  /** 拡大縮小する立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** 拡大縮小の中心。この点は動かない。 */
  readonly origin: Vec3Tuple;
  /** 全体の倍率(0 より大きい)。軸ごとに変えるときは null。 */
  readonly uniform: number | null;
  /** 軸ごとの倍率(X, Y, Z の順、いずれも 0 より大きい)。全体の倍率のときは null。 */
  readonly perAxis: readonly [number, number, number] | null;
}

/**
 * スイープ(FR-409、§0.a-0.43、§0.a-0.76)。断面を経路に沿って掃く。
 *
 * **対象を取らない「作る」段**(押し出し・回転・縫合・ばね・基本形状と同じ)。
 * 断面の重心は経路の始点へ移され、断面の法線は経路の接線へ最小回転で合わせられる。
 */
export interface SweepStepSpec {
  readonly kind: 'sweep';
  /** 掃く断面の閉ループ。 */
  readonly profile: readonly CurveSpec[];
  /** 経路。並んだ順につながっていること。閉じた経路でもよい。 */
  readonly path: readonly CurveSpec[];
  /** true で Frenet(既定)、false で「ねじれを抑える」向きの決め方。 */
  readonly frenet: boolean;
}

/**
 * リブ(FR-420、§0.a-0.37、§0.a-0.75)。開いた輪郭に厚みを付けた壁を立体へ足す。
 *
 * **対象を消費する**(リブが付いた立体 1 つだけが残る)。
 */
export interface RibStepSpec {
  readonly kind: 'rib';
  /** リブを足す立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** 輪郭(閉じていなくてよい)。並んだ順につながっていること。 */
  readonly profile: readonly CurveSpec[];
  /** 輪郭の平面の法線。厚みはこの向きへ付ける。 */
  readonly normal: Vec3Tuple;
  /** 壁の厚み(mm)。 */
  readonly thickness: number;
  /** 両側へ付けるか(false なら法線の側だけ)。 */
  readonly symmetric: boolean;
  /** 伸ばす向き(材料へ向かう向き)。 */
  readonly direction: Vec3Tuple;
  /**
   * 材料に届くまで壁を伸ばすか(**省くと true = 今までどおり**)。
   *
   * `false` のときは伸ばす長さを**輪郭の長さ**にする(`occt/makeRib.ts`)。
   * 短すぎて材料に届かない置き方は 2 つに分かれたボディになるので断る(FR-504)。
   */
  readonly extendToBody?: boolean;
}

/**
 * エンボス(FR-421、§0.a-0.38)。平らな面へ輪郭を彫る / 浮き出す。
 *
 * **対象を消費する。** 面は平面だけ(曲面へのラップは P6 以降)。
 */
export interface EmbossStepSpec {
  readonly kind: 'emboss';
  /** 彫る(浮き出す)立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** 相手の面の指紋。平らな面だけ。 */
  readonly face: SubShapeQuery;
  /** 面の上に置いた閉じた輪郭。複数可。 */
  readonly profiles: readonly (readonly CurveSpec[])[];
  /** 面から測った深さ(mm)。0 より大きいこと。 */
  readonly depth: number;
  /** true なら浮き出す(和)、false なら彫る(差)。 */
  readonly raised: boolean;
}

/**
 * 外ねじ(FR-423、§0.a-0.40)。円柱面にねじを切る。
 *
 * **対象を消費する。** 選ぶのは**円柱面 1 つ**で、深さ・貫通の概念は無い
 * (ねじ穴は平らな面と点を選ぶ。だから別の段にしてある)。
 * **軸の径は面から測る**ので利用者に入れさせない(NFR-UX-4)。`majorDiameter` は
 * 画面に出す印(`ThreadMarkInfo`)に載せる呼び径で、削る深さはピッチから決まる。
 *
 * **簡略表示(`modeled: false`)では B-rep に触れない**(§0.a-0.15)。印だけを返し、
 * 形はもとのまま渡すので費用はほぼ 0。実らせん(`modeled: true`)は 1 本で数秒かかる
 * (2026-09-05 実測 中央値 4184ms、負荷あり)ので、既定は簡略にする。
 */
export interface ThreadShaftStepSpec {
  readonly kind: 'threadShaft';
  /** ねじを切る立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** ねじを切る円柱面の指紋。平面など円柱でない面は断る。 */
  readonly face: SubShapeQuery;
  /** 呼び径 d(mm)。**印に載せる値**で、削る深さは軸の実寸とピッチから決める。 */
  readonly majorDiameter: number;
  readonly pitch: number;
  /** ねじ部の長さ(mm)。 */
  readonly length: number;
  /** 軸のどちらの端から切り始めるか。`first` は円柱面の軸のパラメータが小さいほうの端。 */
  readonly fromEnd: 'first' | 'last';
  /** 実らせんを切るなら true。false(既定の簡略表示)なら B-rep に触れない。 */
  readonly modeled: boolean;
}

/**
 * 曲面(FR-428、§0.a-0.45)。**閉じた立体ではなく面のボディ**(`bodyKind: 'shell'`)を作る。
 *
 * **対象を取らない「作る」段。** ただし作り方が「すでにある立体の面を取り出す」
 * (`shape.kind === 'face'`)か「その面を距離だけ離す」(`shape.kind === 'offset'`)の
 * ときだけ `targetKey` の形から面を選び直すので、そのときは鍵を添える。
 * **それでも対象は消費しない**(面を貸した立体はそのまま画面に残る。
 * `PrimitiveStepSpec` の頂点・`ThruSectionSpec` の `faceQuery` と同じ扱い)。
 *
 * **呼び出し側は、`targetKey` を使う段の鍵の材料に `targetKey` と面の指紋を必ず含める**
 * (含めないと上流を編集しても鍵が変わらず、古い面の形が返る。NFR-PF-3 の鍵の連鎖)。
 */
export interface SurfaceStepSpec {
  readonly kind: 'surface';
  /** 作り方。6 種の定義は `occt/makeSurface.ts` の `SurfaceInput` が正本。 */
  readonly shape: SurfaceInput;
  /**
   * 面を借りる立体の段の鍵。**`shape.kind` が `'face'` か `'offset'` のときだけ要る**
   * (それ以外は null)。**消費しない。**
   */
  readonly targetKey: string | null;
}

/**
 * 平面による切断(FR-432、P5 §2.9b。分割(FR-424)もこれで満たす。§0.a-0.60)。
 *
 * **対象を消費する。** 両側が要るなら切断の段を 2 つ置く
 * (「1 フィーチャー = 最大 1 ボディ」の規則を曲げない。§0.a-0.41)。
 */
export interface CutStepSpec {
  readonly kind: 'cut';
  /** 切る立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /** 切断面が通る点(mm)。平面上ならどこでもよい。 */
  readonly origin: Vec3Tuple;
  /** 単位法線(model が解決済み)。長さは念のためカーネルでも揃える。 */
  readonly normal: Vec3Tuple;
  /** 法線の側を残すなら true。 */
  readonly keepPositive: boolean;
}

/**
 * くり抜き(FR-418、§0.a-0.47)。壁の厚さを残して中身を抜く。
 *
 * **対象を消費する。**
 */
export interface ShellStepSpec {
  readonly kind: 'shell';
  /** くり抜く立体を指すキャッシュの鍵。この段が消費する。 */
  readonly targetKey: string;
  /**
   * 開ける面の指紋。**0 枚でもよい**(そのときは外から見た形が変わらず、中だけが空になる)。
   * 同じ面を 2 度指しても 1 度だけ数える。
   */
  readonly openFaces: readonly SubShapeQuery[];
  /** 壁の厚さ(mm)。0 より大きいこと。 */
  readonly thickness: number;
  /** true で外向きに肉を付ける。false(既定の使い方)で内向き(外側の大きさが変わらない)。 */
  readonly outward: boolean;
}

/**
 * 読み込んだ形のベースボディ(FR-802、P6 §2.8、§0.a-0.9、タスク10)。
 *
 * **対象を取らない「作る」段**(押し出し・基本形状と同じ)。履歴を持たない形なので、
 * 段がすることは「抱き込んであるバイト列から B-rep を戻す」ことだけである。
 *
 * **鍵は `.pcad` の中の入れ物の名前(`shapeRef`)だけで足りる**(model の `part/cacheKey.ts`、
 * タスク20)。読み込んだ形は再計算で変わりようがないので、**同じ部品を開いている間は
 * 2 回目以降が必ず形状キャッシュに当たる**(`SolidRecomputeResult.cacheHits` が増える)。
 *
 * バイト列を段に載せて毎回渡すのは、Worker が作り直されたとき(タブの再読み込み、
 * キャッシュの追い出し)に戻せる材料がここにしか無いためである。**読み込んだ B-rep を
 * `.pcad` へ抱き込むこと自体が `rules/04` の「導出できるものは保存しない」への例外**で、
 * 利用者の承認(§0.a-0.9)を得ている——読み込んだものは再計算で導出できないので趣旨に反しない。
 *
 * **三角形の形(`importedMesh`、`bodyKind: 'mesh'`)はここへ来ない**(§0.a-0.23。
 * メッシュは B-rep にしないので、幾何カーネルの段にならない。model が直接ボディにする)。
 */
export interface ImportedSolidStepSpec {
  readonly kind: 'importedSolid';
  /**
   * `.pcad` の `shapes/<shapeRef>.brep` に入っている B-rep のバイト列。
   * 中身の作り手と読み手は `occt/brepBytes.ts` の `writeBrepBytes` / `readBrepBytes`。
   */
  readonly bytes: Uint8Array;
}

/**
 * 測る対象 1 つ(FR-1101、FR-1102、P5 §2.10.1、タスク28)。
 *
 * 形そのものは Comlink 越しに渡せないので、**段のキャッシュの鍵**(`SolidStepRequest.key`)で
 * 「覚えてある形」を指す(投影・交差の `SketchProjectionItem.shapeKey` と同じ流儀)。
 * 面・辺・頂点を測るときは指紋を添える。`null` ならボディ全体を測る。
 */
export interface MeasureTargetSpec {
  /** 測る形を持つ段のキャッシュの鍵。 */
  readonly bodyKey: string;
  /** 測る部分形状の指紋。ボディ全体を測るなら `null`。 */
  readonly subShape: SubShapeQuery | null;
  /**
   * アセンブリで表示中の配置。省略時は部品内の局所座標のまま測る。
   * 測定専用の導出値で、形状キャッシュや履歴は変更しない。
   */
  readonly placement?: PlacementSpec;
}

/**
 * 測定の依頼(FR-1101、FR-1102)。**形は作り直さない読み取りだけ**で、
 * 履歴の再計算も鍵の作り直しも起こさない(§0.a-0.30)。
 *
 * 件数は測るものごとに決まっている。`distance` は 2 つ、`massProperties` は 1 つで、
 * 合わない件数で頼まれたら理由をつけて断る(投げない。NFR-RE-1)。
 *
 * **カーネルへ頼むのはこの 2 つだけ**(§0.a-0.30)。点間の距離・辺の長さ・面の面積・
 * 面どうしのなす角は、再計算がすでに返している一覧(`SolidVertexInfo.position` /
 * `SolidEdgeInfo.length` / `SolidFaceInfo.area` / `SolidFaceInfo.axis`)から
 * model 側が計算するので、Worker を往復しない(NFR-PF-4)。
 */
export interface MeasureRequest {
  readonly partId?: string;
  readonly targets: readonly MeasureTargetSpec[];
  readonly kind: 'distance' | 'massProperties';
}

/**
 * 測定の結果(FR-1101、FR-1102)。
 *
 * 測れなかったときも投げずに `failed` を返す(FR-504、NFR-RE-1)。
 * 単位は距離・重心が mm、体積が mm³、表面積が mm²、慣性モーメントが mm⁵
 * (密度を掛けない体積の 2 次モーメント)。**質量(g)と g·mm² の慣性モーメントは、
 * 密度(g/cm³)を持っている model 側が掛ける**(§0.a-0.32、タスク29)。
 */
export type MeasureResult =
  | {
      readonly kind: 'distance';
      /** 最短距離(mm)。交わっているときは 0。 */
      readonly distance: number;
      /** 1 つ目の対象の上の最近点(mm)。 */
      readonly pointA: Vec3Tuple;
      /** 2 つ目の対象の上の最近点(mm)。 */
      readonly pointB: Vec3Tuple;
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
      readonly centreOfMass: Vec3Tuple;
      /** 重心を通る主軸まわりの体積の 2 次モーメント(mm⁵)。並びは主軸と同じ。 */
      readonly principalMoments: readonly [number, number, number];
      /** 主軸の向き(長さ 1)。第 1・第 2・第 3 の順。 */
      readonly principalAxes: readonly [Vec3Tuple, Vec3Tuple, Vec3Tuple];
    }
  /** 測れなかった。`message` はそのまま画面に出す日本語(FR-504)。 */
  | { readonly kind: 'failed'; readonly message: string };

// ---------------------------------------------------------------------------
// 書き出しと読み込み(FR-802、FR-803。P6 §2.3・§2.4・§2.8、タスク10)。
//
// **口(`KernelApi` のメソッド)は書き出し 1 本・読み込み 1 本しか作らない**(§0.a-0.2)。
// STEP / 三角形 / B-rep の切り替えは**依頼の中の `format` で判別**し、実装は網羅 `switch`
// (`default` を作らない)で受ける。形式が増えたときに口を増やすと、UI と Worker の
// 両側に同じ数の配線が要るうえ、どこまで実装したのかが型から読めなくなるためである。
// ---------------------------------------------------------------------------

/**
 * 書き出す立体 1 つの指定。
 *
 * **形そのものは渡さない**(B-rep は Comlink を越えられない)。段のキャッシュの鍵
 * (`SolidStepRequest.key`)で「覚えてある形」を指す——投影・交差の `shapeKey` や
 * 測定の `bodyKey` と同じ流儀である。
 *
 * 名前と色は**ファイルへ書き込む値**で、model 側(外観の割り当てと履歴の名前)が持っている。
 * 色は sRGB の 0〜1(`#rrggbb` を 255 で割った値)。`null` なら書かない。
 */
export interface ShapeExportItem {
  /** 書き出す形を持つ段のキャッシュの鍵。 */
  readonly bodyKey: string;
  /** 立体の名前。`null` なら OCCT の既定(`SOLID`)になる。 */
  readonly name: string | null;
  /** 立体の色(sRGB の 0〜1)。`null` なら色を付けない。 */
  readonly color: RgbTuple | null;
  /**
   * 面ごとの色(**面の通し番号 → 色**。§2.5.1、P6 タスク7b+13b)。**省略できる。**
   *
   * 面の割り当ては立体の色より優先する(`xcafFaceColors.ts` / `writeCafMesh.ts` の注釈)。
   * 色を持てない形式(STL / `'mesh'` / `'brep'`)は**この欄を見ない**——
   * `worker/kernelApi.ts` の `exportShapes` が形式ごとに配線を絞るのが正本で、
   * ここでは持てる形式(STEP / OBJ / glTF)を制限しない(依頼の型を形式で分けていないため)。
   */
  readonly faceColors?: FaceColorMap;
}

/** STEP のアセンブリで共有する部品定義 1 つ(P7 タスク41)。 */
export interface ShapeExportAssemblyDefinition {
  /** アセンブリの中だけで一意な、参照用の安定した id。 */
  readonly id: string;
  /** STEP の PRODUCT に書く部品名。 */
  readonly name: string | null;
  /** この部品を構成するボディ。同じ定義を何回置いても形はここに 1 回だけ載せる。 */
  readonly bodies: readonly ShapeExportItem[];
}

/**
 * STEP アセンブリの配置木。`part` は共有定義への参照、`assembly` は子を持つ参照である。
 * 保存用の model 型へ依存させず、Comlink を越えられる文字列と数だけで表す。
 */
export type ShapeAssemblyNode =
  | {
      readonly kind: 'part';
      readonly id: string;
      readonly name: string | null;
      readonly definitionId: string;
      /** 親から見た局所配置。 */
      readonly placement: PlacementSpec;
    }
  | {
      readonly kind: 'assembly';
      readonly id: string;
      readonly name: string | null;
      /** 親から見た局所配置。 */
      readonly placement: PlacementSpec;
      readonly children: readonly ShapeAssemblyNode[];
    };

/** STEP へ書くアセンブリ構造。 */
export interface ShapeExportAssembly {
  readonly name: string | null;
  readonly definitions: readonly ShapeExportAssemblyDefinition[];
  readonly children: readonly ShapeAssemblyNode[];
}

/**
 * 三角形を作る形式が共通で受ける品質の指定(FR-803)。
 *
 * **長さと角度の「対」で受ける。** 弦のずれだけを細かくしても、角度の偏差の既定
 * (0.5 ラジアン)が先に効いて丸い面はそれ以上細かくならない(`occt/exportMesh.ts` の
 * 実測: 球 r=10 を長さ 0.1mm で切ると、角度 0.5rad で 976 枚・体積の不足 1.43%、
 * 0.2rad で 2,020 枚・0.72%、0.1rad で 8,000 枚・0.18%)。
 *
 * **品質の 3 択(粗い / 標準 / 細かい)からこの 2 つの数への読み替えは `packages/model` の
 * 表が正本**で、kernel は写しを持たず数で受け取る(同じ表が 2 か所にあると片方が古くなる)。
 */
export interface ShapeExportMeshQuality {
  /**
   * 弦の最大ずれ(mm)。小さいほど細かい。`ExportSelection.deviationMm` をそのまま渡す。
   * **画面用の三角形は汚さない**(`occt/exportMesh.ts` が複製に掛ける)。
   */
  readonly deviationMm: number;
  /**
   * 法線の向きの最大ずれ(ラジアン)。省くと画面用と同じ既定(0.5)になり、
   * 省いたときの三角形は角度を足す前とまったく同じになる。
   */
  readonly angularDeflectionRad?: number;
}

/**
 * 書き出したファイル 1 つ(FR-803)。
 *
 * **1 回の書き出しで 2 つ以上のファイルが出ることがある。** OBJ は `.obj` と `.mtl` の
 * 2 つで、`.obj` の `mtllib` の行が `.mtl` の名前を指しているため**名前を勝手に変えると
 * 色が付かない**。だから名前は kernel が組んで返し、呼び出し側は数えずにそのまま全部
 * 保存する(§0.a-0.20 の書き出しのパネル、タスク32)。
 */
export interface ShapeExportFile {
  /** 保存するときのファイル名(拡張子つき)。 */
  readonly fileName: string;
  /** ファイルの中身。 */
  readonly bytes: Uint8Array;
}

/**
 * 書き出しの依頼(FR-803)。**形式は依頼の中の `format` で判別する**(§0.a-0.2)。
 *
 * **口(`KernelApi.exportShapes`)は 1 本しか作らない。** 形式が増えるたびに口を増やすと、
 * UI と Worker の両側へ同じ数の配線が要るうえ、どこまで実装したのかが型から読めなくなる。
 * 実装は網羅 `switch`(`default` を作らない)で受けるので、ここへ 1 つ足すと**足したぶんだけ
 * 実装が型検査で落ちて**配線し忘れが起きない。
 *
 * ファイルの形式との対応:
 *
 * | `format` | 何が返るか | 使い道 |
 * |---|---|---|
 * | `'step'` | STEP AP214 のバイト列 1 つ(名前と色つき) | STEP |
 * | `'stl'` | `.stl` 1 ファイル(バイナリ / ASCII) | STL |
 * | `'obj'` | `.obj` と `.mtl` の 2 ファイル(立体ごとの色つき) | OBJ |
 * | `'gltf'` | `.glb` 1 ファイル(立体ごとの色つき、単位は m) | glTF |
 * | `'mesh'` | 立体ごとの三角形の網(ファイルは組まない) | 3MF(`packages/io` が組む) |
 * | `'brep'` | 立体ごとの B-rep のバイト列 | `.pcad` の `shapes/<id>.brep` |
 *
 * **`'mesh'` だけファイルを返さないのは、3MF を書くのが `packages/io` だから**(§0.a-0.19)。
 * io は OCCT を呼べず(§0.a-0.2)、偏差を指定した三角形は kernel でしか作れないので、
 * kernel は三角形までを返して ZIP と XML の組み立ては io に任せる。
 */
export type ShapeExportRequest =
  | {
      readonly partId?: string;
      readonly format: 'step';
      readonly bodies: readonly ShapeExportItem[];
      /** 省略時は従来どおり `bodies` を平らに書く。指定時は共有定義と配置木を書く。 */
      readonly assembly?: ShapeExportAssembly;
      /** 色を書くか(§0.a-0.22)。省くと書く。列挙が取れない環境では形だけになる。 */
      readonly withColors?: boolean;
    }
  | ({
      readonly partId?: string;
      readonly format: 'stl';
      readonly bodies: readonly ShapeExportItem[];
      /**
       * `true` なら ASCII、省くとバイナリ(§2.4)。
       *
       * **STL に色は書かない**(§0.a-0.15。仕様に色が無い)ので、依頼の `name` / `color` は
       * 使わない。「STL には色が付きません」の案内は書き出しの画面が出す(タスク32)。
       */
      readonly ascii?: boolean;
      /** ファイル名の基(拡張子なし。省くと `model`)。 */
      readonly baseName?: string;
    } & ShapeExportMeshQuality)
  | ({
      readonly partId?: string;
      readonly format: 'obj';
      readonly bodies: readonly ShapeExportItem[];
      /** ファイル名の基(拡張子なし。省くと `model`)。`.obj` と `.mtl` で同じ基を使う。 */
      readonly baseName?: string;
    } & ShapeExportMeshQuality)
  | ({
      readonly partId?: string;
      readonly format: 'gltf';
      readonly bodies: readonly ShapeExportItem[];
      /** ファイル名の基(拡張子なし。省くと `model`)。 */
      readonly baseName?: string;
    } & ShapeExportMeshQuality)
  | ({
      readonly partId?: string;
      readonly format: 'mesh';
      readonly bodies: readonly ShapeExportItem[];
    } & ShapeExportMeshQuality)
  | {
      readonly partId?: string;
      readonly format: 'brep';
      readonly bodies: readonly ShapeExportItem[];
    };

/** 書き出した立体 1 つぶんの三角形(`format: 'mesh'`)。 */
export interface ShapeExportMeshBody {
  /** 依頼の `bodyKey` をそのまま返す。並びも依頼のまま。 */
  readonly bodyKey: string;
  /** 三角形の網。並びは `occt/exportMesh.ts` の `ExportMesh` が正本。 */
  readonly triangles: ExportMesh;
}

/** 書き出した立体 1 つぶんの B-rep のバイト列(`format: 'brep'`)。 */
export interface ShapeExportBrepBody {
  /** 依頼の `bodyKey` をそのまま返す。並びも依頼のまま。 */
  readonly bodyKey: string;
  /** `.pcad` の `shapes/<id>.brep` へそのまま入れられるバイト列。 */
  readonly bytes: Uint8Array;
}

/**
 * 書き出しの結果(FR-803)。依頼と同じ `format` を返すので、受け取る側も網羅 `switch` で
 * 分けられる(依頼と結果が食い違うことは無い)。
 *
 * **ファイルを組む 3 形式(STL / OBJ / glTF)は結果の形を 1 つに揃えてある。** 呼び出し側は
 * `files` をそのまま全部保存すればよく、「OBJ のときだけ 2 ファイル」を知らずに済む。
 *
 * **名前と色は返さない。** どちらも呼び出し側が依頼へ入れた値そのままで、
 * 持ち帰っても新しく分かることが無いためである(読み込みは逆に、ファイルから
 * 取り出した名前と色を返す)。
 */
export type ShapeExportResult =
  | {
      readonly format: 'step';
      /** STEP ファイルの中身(AP214)。 */
      readonly bytes: Uint8Array;
      /** 色を 1 つでも載せられたか。列挙が取れない環境では false(形は書けている)。 */
      readonly colorWritten: boolean;
    }
  | {
      readonly format: 'stl' | 'obj' | 'gltf';
      /** 保存するファイル。STL は `[.stl]`、OBJ は `[.obj, .mtl]`、glTF は `[.glb]`。 */
      readonly files: readonly ShapeExportFile[];
      /** 実際に書いた三角形の枚数(落としたぶんを除く)。 */
      readonly triangleCount: number;
      /**
       * 面積 0(または `NaN`)で落とした三角形の枚数。
       *
       * OCCT は球の極や回転面の継ぎ目で同じ節点を 2 度含む三角形を作ることがあり
       * (`occt/writeStl.ts` の `DEGENERATE_CROSS_LENGTH_MM2`)、そのままでは法線が
       * `NaN` になってどの道具でも開けないファイルになる。**落とした枚数を返すのは、
       * 「三角形を n 枚除きました」の 1 行を画面が出せるようにするため**(タスク32)。
       */
      readonly droppedTriangleCount: number;
    }
  | { readonly format: 'mesh'; readonly bodies: readonly ShapeExportMeshBody[] }
  | { readonly format: 'brep'; readonly bodies: readonly ShapeExportBrepBody[] };

/**
 * 3D プリント向けの点検の依頼(FR-815、NFR-PF-4、P6 §0.51・§2.16、タスク42)。
 *
 * **対象は書き出しと同じ `ShapeExportItem[]`。** 名前も色も使わず、`bodyKey` で
 * Worker が直近に画面へ返した表示メッシュを引く。別品質で再メッシュ化しないため、
 * 点検結果の三角形番号は表示メッシュの同じ番号を必ず指す。
 *
 * **品質(偏差)の対は従来の呼び出しとの互換のため残すが、点検では使わない。** 精密な
 * 別メッシュを点検する場合は、その結果メッシュ自体を画面へ重ねる別機能として扱う。
 *
 * **複数ボディを指定すると、三角形を 1 つに連ねてから点検する**(水密性・肉厚とも
 * 「ボディをまたいだ 1 つの形」として測る。`worker/kernelApi.ts` の実装)。
 */
export interface ShapeInspectRequest extends ShapeExportMeshQuality {
  readonly partId?: string;
  /** 点検する立体。書き出しと同じ鍵の一覧(名前・色は使わない)。 */
  readonly bodies: readonly ShapeExportItem[];
  /** 最小肉厚のしきい値(mm)。省略すると `DEFAULT_MIN_THICKNESS_MM`(occt 側の既定)。 */
  readonly minThicknessMm?: number;
  /** オーバーハングの角度のしきい値(度)。省略すると `DEFAULT_OVERHANG_ANGLE_DEG`。 */
  readonly overhangAngleDeg?: number;
}

/** 点検に実際に使った表示メッシュ 1 つの同一性。 */
export interface ShapeInspectMeshIdentity {
  /** 点検依頼で指定された、表示メッシュを持つ段の鍵。 */
  readonly bodyKey: string;
  /** その表示メッシュを画面へ返した再計算の世代。 */
  readonly meshRevision: number;
  /** その表示メッシュの三角形数。 */
  readonly triangleCount: number;
}

/** Worker が返す点検結果。判定と、判定に使った表示メッシュの同一性を対にする。 */
export interface ShapeInspectResult extends PrintabilityResult {
  /** 複数ボディでは点検依頼と同じ順。各要素は上の 3 欄だけを持つ。 */
  readonly meshes: readonly ShapeInspectMeshIdentity[];
}

/**
 * 読み込みの依頼(FR-802)。書き出しと同じく**依頼の中の `format` で判別する**。
 *
 * `'step'` / `'stl'` / `'obj'` / `'gltf'` はファイルから読む口、`'brep'` は `.pcad` に
 * 抱き込んだバイト列を戻す口である。3MF の読み込み(FR-809)は `packages/io` が
 * 自前の ZIP / XML の読み手で行うので、この union には入らない(§0.a-0.26)。
 */
export type ShapeImportRequest =
  | {
      readonly format: 'step';
      /** STEP ファイルの中身。 */
      readonly bytes: Uint8Array;
      /** 仮想ファイルに付ける名前(省くと `import.step`)。中身の判別には使わない。 */
      readonly fileName?: string;
      /** 色を読むか(省くと読む)。false なら `color` は必ず `null` になる。 */
      readonly withColors?: boolean;
    }
  | {
      /** `.pcad` の `shapes/<id>.brep` に抱き込んだバイト列(§0.a-0.9)。 */
      readonly format: 'brep';
      readonly bytes: Uint8Array;
    }
  | {
      /** STL ファイルの中身(バイナリ・ASCII のどちらでもよい。読み手が見分ける)。 */
      readonly format: 'stl';
      readonly bytes: Uint8Array;
      /** 仮想ファイルに付ける名前(省くと `import.stl`)。 */
      readonly fileName?: string;
    }
  | {
      /** OBJ ファイルの中身。 */
      readonly format: 'obj';
      readonly bytes: Uint8Array;
      /** 仮想ファイルに付ける名前(省くと `import.obj`)。 */
      readonly fileName?: string;
    }
  | {
      /** glTF(`.glb` / `.gltf`)ファイルの中身。 */
      readonly format: 'gltf';
      readonly bytes: Uint8Array;
      /** 仮想ファイルに付ける名前(省くと `import.glb`)。 */
      readonly fileName?: string;
    };

/**
 * 読み込んだ立体 1 つぶんに共通する欄(FR-802、P6 §2.8)。
 *
 * 色はファイルに入っていた値をそのまま返すが、**model は当面これを使わず既定の外観にする**
 * (§0.a-0.28)。捨てずに返しておくのは、P7 以降で取り込むときに読み直さずに済ませるため。
 */
interface ShapeImportBodyCommon {
  /** ファイルに入っていた名前。無ければ `null`。 */
  readonly name: string | null;
  /** ファイルに入っていた色(sRGB の 0〜1)。無ければ `null`。 */
  readonly color: RgbTuple | null;
  /** 体積(mm³)。面だけの形では 0 とは限らない(`SolidBodyMesh.volume` と同じ約束)。 */
  readonly volume: number;
  /** 画面用の三角形。粗さは画面の既定(`DEFAULT_LINEAR_DEFLECTION`)。 */
  readonly triangles: ExportMesh;
}

/**
 * 読み込んだ立体 1 つぶん(FR-802、P6 §2.8)。
 *
 * **形(`TopoDS_Shape`)は入らない。** B-rep は Comlink を越えられないので、代わりに
 * ①**そのまま `.pcad` へ入れられるバイト列**(`brepBytes`)と、②**画面へ出せる三角形**
 * (`triangles`)を返す。model はこの 2 つで `importedSolid` のフィーチャーを組み立て、
 * 次の再計算では①を段(`ImportedSolidStepSpec`)へ載せて形を戻す(タスク20)。
 *
 * **`bodyKind` で 2 つに割ってある。** STL / OBJ / glTF は三角形しか持たないファイルで、
 * そこから B-rep を作ることはしない(§0.a-0.23。面が三角形の数だけできて、その上の
 * フィレットも穴あけも実用にならない)。だから**メッシュの枝には `brepBytes` が無い**——
 * 「無い値に `null` を入れて渡す」形にすると、受け取る側が `null` の検査を忘れても
 * 型検査が助けてくれない。model は `bodyKind` で分けて `importedSolid`(B-rep を
 * `shapes/<id>.brep` へ)と `importedMesh`(三角形を `meshes/<id>.bin` へ)を作り分ける
 * (§0.a-0.24、タスク20)。
 */
export type ShapeImportBody =
  | (ShapeImportBodyCommon & {
      /** 閉じた立体か、面だけの殻か。どちらも B-rep を持つ。 */
      readonly bodyKind: 'solid' | 'shell';
      /** `.pcad` の `shapes/<id>.brep` へそのまま入れるバイト列。 */
      readonly brepBytes: Uint8Array;
    })
  | (ShapeImportBodyCommon & {
      /**
       * 読み込んだ三角形の形(§0.a-0.23)。**B-rep を持たない**ので、加工フィーチャーの
       * 対象にできない(`worker/recomputeSolids.ts` の 1 か所で断る)。
       */
      readonly bodyKind: 'mesh';
    });

/** 読み込んだ STEP の共有部品定義と `bodies` の対応。 */
export interface ShapeImportAssemblyDefinition {
  readonly id: string;
  readonly name: string | null;
  /** この定義の B-rep・三角形を持つ `ShapeImportResult.bodies` の添字。 */
  readonly bodyIndex: number;
}

/** 読み込んだ STEP のアセンブリ構造(P7 タスク42)。 */
export interface ShapeImportAssembly {
  readonly name: string | null;
  readonly definitions: readonly ShapeImportAssemblyDefinition[];
  readonly children: readonly ShapeAssemblyNode[];
}

/**
 * 読み込みの結果(FR-802、FR-811)。
 *
 * **中身はすでに mm へ換算してある**(NFR-RE-3。内部は mm 固定)。`unit` は
 * 「ファイルが何で書かれていたか」の記録で、`ImportedSource.unit`(P6 §2.8)へそのまま乗る。
 *
 * **形式ごとの `unit`(§0.a-0.6):**
 *
 * | 形式 | `unit` | 理由 |
 * |---|---|---|
 * | STEP | `'mm'` / `'inch'` / `'other'` | ファイルが単位を持つ(`SystemLengthUnit`)ので読み取る |
 * | glTF | `'mm'` | 仕様が長さを m と定めており、OCCT が読む前に mm へ直す(取り違えようがない) |
 * | STL / OBJ | `'other'` | **どちらの仕様にも単位が無い。** 数をそのまま mm として取り込むので、違ったら利用者に訊く(訊くのは ui。タスク32) |
 * | B-rep | `'mm'` | `.pcad` に抱き込んだ内部単位そのもの |
 */
export interface ShapeImportResult {
  /** 立体の一覧。並びはファイルの中の並び。 */
  readonly bodies: readonly ShapeImportBody[];
  /**
   * ファイルが使っていた長さの単位(上の表)。
   *
   * 型の名前は STEP 由来(`occt/readStep.ts`)だが、**`'mm' | 'inch' | 'other'` という
   * 3 択そのものは形式に依らない**ので、形式ごとに別の型を作らずこれを使い回す。
   */
  readonly unit: StepFileLengthUnit;
  /**
   * OCCT が読み取った単位の名前そのまま(`['millimetre']` / `['INCH']` など)。
   * **名前を持つのは STEP だけ**で、ほかの形式では必ず空になる。
   */
  readonly unitNames: readonly string[];
  /** STEP が持つ共有定義と配置木。ほかの形式では省略する。 */
  readonly assembly?: ShapeImportAssembly;
}

/**
 * 向きを表す四元数 `(x, y, z, w)`(P7 §2.4、タスク8)。
 *
 * `w = cos(θ/2)`、`(x, y, z) = 軸 × sin(θ/2)`。**長さ 1 に揃っていなくてもよい**
 * (`occt/placeBodies.ts` の `makePlacementTransform` が形にする前に長さで割る)。
 * `q` と `−q` は同じ回転なので、符号を `w >= 0` へ揃えるかどうかは形に影響しない。
 * 揃えるのは保存の決定性のための決めごと(§0.54)で、model 側の 1 か所だけで行う。
 */
export type QuaternionTuple = readonly [number, number, number, number];

/**
 * アセンブリに置いた部品 1 つの配置(P7 §0.5、§2.4、タスク8)。点は `p' = R(q)·p + t` で写る。
 *
 * **4×4 行列で持たない。** 反復のたびに正規化 1 回で回転へ戻せて、行列を直に入れたときの
 * ような「回転でなくなる」丸め誤差の漏れが起きないためである(§0.5)。
 *
 * 既存の `RigidTransformSpec`(パターンの「平行移動 + 回転軸 + 回転角」)とは**別の型**で、
 * どちらへ渡すかで回転の表し方が違う。橋渡し(四元数 ⇄ 軸と角)は model 側の
 * `assembly/placementMath.ts` が持つ(§1.4-8)。
 */
export interface PlacementSpec {
  /** 位置(mm)。回転のあとに足される。 */
  readonly position: Vec3Tuple;
  /** 向き。原点まわりの回転で、部品の中の座標に掛かる。 */
  readonly rotation: QuaternionTuple;
}
/** 干渉解析専用の導出DTO。保存文書・履歴・形状キャッシュの鍵には含めない。 */
export type InterferencePairId = readonly [string, string];
export type InterferenceInputCode = 'unresolvedPart' | 'missingBody' | 'unsupportedBody' | 'invalidPlacement';
export type InterferenceFailureCode = InterferenceInputCode | 'boundsFailed' | 'unionFailed' | 'meshFailed'
  | import('./occt/intersectionVolume.js').IntersectionVolumeFailure['code'];
export type InterferenceComponentSpec =
  | { readonly kind: 'ready'; readonly componentId: string; readonly bodyKeys: readonly string[];
      readonly placement: PlacementSpec }
  | { readonly kind: 'excluded'; readonly componentId: string; readonly reason: 'hidden' | 'suppressed' }
  | { readonly kind: 'unavailable'; readonly componentId: string; readonly code: InterferenceInputCode;
      readonly message: string; readonly missingKeys?: readonly string[] };
export interface InterferenceRequest {
  readonly requestId: string;
  readonly components: readonly InterferenceComponentSpec[];
  readonly pairs?: readonly InterferencePairId[];
  readonly ignoredPairs?: readonly InterferencePairId[];
}
export interface InterferenceMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
}
export interface InterferencePair {
  readonly aComponentId: string;
  readonly bComponentId: string;
  readonly volume: number;
  readonly mesh: InterferenceMesh;
}
export interface InterferencePairFailure {
  readonly pair: InterferencePairId;
  readonly stage: 'input' | 'bounds' | 'union' | 'placement' | 'common' | 'mesh' | 'release';
  readonly code: InterferenceFailureCode;
  readonly message: string;
  readonly missingKeys?: readonly string[];
  readonly cleanupMessages?: readonly string[];
}
export interface InterferenceSkip {
  readonly pair: InterferencePairId;
  readonly reason: 'suppressed' | 'hidden' | 'ignored';
}
export interface InterferenceReport {
  readonly requestId: string;
  readonly pairs: readonly InterferencePair[];
  readonly totalPairCount: number;
  readonly checkedPairCount: number;
  readonly skippedPairCount: number;
  readonly pendingPairCount: number;
  readonly failures: readonly InterferencePairFailure[];
  readonly skips: readonly InterferenceSkip[];
  readonly cancelled: boolean;
}
export interface InterferenceRootFailure {
  readonly code: 'invalidRequest' | 'noComponents' | 'kernelUnavailable' | 'callbackFailed'
    | 'cleanupFailed' | 'unexpectedFailure';
  readonly message: string;
  readonly cleanupMessages?: readonly string[];
}
export type InterferenceResult = InterferenceReport & (
  | { readonly kind: 'checked'; readonly failure: null }
  | { readonly kind: 'failed'; readonly failure: InterferenceRootFailure });
export interface InterferenceProgress {
  readonly requestId: string;
  readonly phase: 'prepare' | 'candidates' | 'common' | 'mesh';
  readonly completedPairs: number;
  readonly totalPairs: number;
  readonly completedComponents: number;
  readonly totalComponents: number;
  readonly currentPair?: InterferencePairId;
}
