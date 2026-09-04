/**
 * model から幾何カーネルへの唯一の接点(計画書 docs/plans/P1-式とスケッチ.md タスク12、
 * docs/plans/P3-加工フィーチャー.md タスク17)。
 *
 * @pointercad/kernel の型はこのファイルの中だけで使い、外へは model の型で返す
 * (P0 §0.11、rules/04-設計の規律.md の依存方向)。ここ以外から kernel を呼ばない。
 */

import {
  createKernelWorker,
  type CurveSpec,
  type FaceMeshData,
  type KernelApi,
  type OffsetJoinType,
  type PlanarFaceRequest,
  type SketchOffsetItem,
  type SketchOffsetOutcome,
  type SketchTessellationFailure,
  type SolidBodyMesh,
  type SolidProgress,
  type SolidRecomputeRequest,
  type SolidRecomputeResult,
  type SolidStepRequest,
  type SolidStepSpec,
  type SubShapeQuery,
} from '@pointercad/kernel';
import * as Comlink from 'comlink';

import type { ResolvedSolidStep, SolidStepPlan, SubShapeQueryPlan } from './part/resolvePart.js';
import type { EdgeCurveKind, FaceSurfaceKind } from './part/types.js';
import { isFullEllipse } from './sketch/resolveSketch.js';
import type {
  OffsetCornerKind,
  ResolvedCurve,
  ResolvedFace,
  SketchFaceMesh,
  SketchMesh,
} from './sketch/types.js';
import type { Vec3 } from './sketch/vec3.js';

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

/** 画面に出るボディ 1 つ。id はそれを作ったフィーチャーの id と同じ(§0.a-0.5)。 */
export interface SolidBody {
  readonly featureId: string;
  readonly mesh: SolidBodyMeshData;
  /** 体積(mm³)。プロパティ欄に出す(FR-501)。 */
  readonly volume: number;
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
      return {
        kind: 'extrude',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        direction: plan.direction,
        distance: plan.distance,
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

  return { bodies, failures: collected, cacheHits: result.cacheHits, cancelled: result.cancelled };
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

/** 中止を尋ねる関数も同じ理由で Comlink.proxy で包む(§1.2-5)。 */
function toCancelProxy(shouldCancel: PartCancelToken | undefined): (() => boolean) | undefined {
  if (shouldCancel === undefined) {
    return undefined;
  }
  return Comlink.proxy(() => shouldCancel());
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

/** `recomputeSolids` が Worker の破損に割り込まれたかどうかの内部結果。 */
type SolidRecomputeRace =
  | { readonly broken: false; readonly result: SolidRecomputeResult }
  | { readonly broken: true };

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
      // 線・円弧の折れ線は UI が自前で作るので、カーネルへは面だけを頼む
      // (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
      const result = await connection.remote.tessellateSketch({
        curves: [],
        faces: faces.map((face) => toFaceRequest(face)),
      });
      return toOutcome(faces, result.faces, result.failures);
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const active = connection;
      const request: SolidRecomputeRequest = {
        steps: steps.map((step) => toSolidStepRequest(step)),
        generation: options.generation ?? 0,
      };
      // 第 2 引数はテッセレーションの粗さ。既定のままでよいので undefined を渡す。
      const race = await Promise.race<SolidRecomputeRace>([
        active.remote
          .recomputeSolids(
            request,
            undefined,
            toProgressProxy(options.onProgress),
            toCancelProxy(options.shouldCancel),
          )
          .then((result) => ({ broken: false, result })),
        active.brokenSignal.then(() => ({ broken: true })),
      ]);
      if (race.broken) {
        // Worker がこの依頼の途中で壊れた。拒否せずに理由つきの失敗として解決する
        // (recomputePart.ts が kernelFailed として拾う。§0.a-0.19「拒否しない」)。
        // 消費されて画面に出ないはずの段(visible: false)は、成功しても失敗しても
        // 利用者には見えないので失敗に数えない(toSolidOutcome の扱いと揃える)。
        return {
          bodies: [],
          failures: steps
            .filter((step) => step.visible)
            .map((step) => ({ featureId: step.featureId, message: KERNEL_BROKEN_MESSAGE })),
          cacheHits: 0,
          cancelled: false,
        };
      }
      return toSolidOutcome(steps, race.result);
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken) {
        restart();
      }
      const outcome = await connection.remote.offsetSketchCurves({
        items: requests.map((request) => toOffsetItem(request)),
      });
      return toOffsetResult(requests, outcome);
    },

    dispose(): void {
      closeKernelConnection(connection);
    },
  };
}
