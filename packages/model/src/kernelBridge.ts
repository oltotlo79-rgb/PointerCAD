/**
 * model から幾何カーネルへの唯一の接点(計画書 docs/plans/P1-式とスケッチ.md タスク12)。
 *
 * @pointercad/kernel の型はこのファイルの中だけで使い、外へは model の型で返す
 * (P0 §0.11、rules/04-設計の規律.md の依存方向)。ここ以外から kernel を呼ばない。
 */

import {
  createKernelWorker,
  type CurveSpec,
  type FaceMeshData,
  type KernelApi,
  type PlanarFaceRequest,
  type SketchTessellationFailure,
  type SolidBodyMesh,
  type SolidProgress,
  type SolidRecomputeRequest,
  type SolidRecomputeResult,
  type SolidStepRequest,
  type SolidStepSpec,
} from '@pointercad/kernel';
import * as Comlink from 'comlink';

import type { ResolvedSolidStep, SolidStepPlan } from './part/resolvePart.js';
import type { ResolvedCurve, ResolvedFace, SketchFaceMesh, SketchMesh } from './sketch/types.js';

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
   */
  recomputeSolids(
    steps: readonly ResolvedSolidStep[],
    options?: SolidRecomputeOptions,
  ): Promise<SolidRecomputeOutcome>;
  dispose(): void;
}

/** 解決済みの曲線をカーネルの言葉へ直す。長さは mm、角度はラジアン(FR-203)。 */
export function toCurveSpec(curve: ResolvedCurve): CurveSpec {
  if (curve.kind === 'segment') {
    return { kind: 'segment', from: curve.from, to: curve.to };
  }
  return {
    kind: 'arc',
    center: curve.center,
    normal: curve.normal,
    xAxis: curve.xAxis,
    radius: curve.radius,
    startAngle: curve.startAngle,
    endAngle: curve.endAngle,
  };
}

/** 面 1 枚の依頼を作る。結果との対応づけには面フィーチャーの id を使う。 */
export function toFaceRequest(face: ResolvedFace): PlanarFaceRequest {
  return { id: face.featureId, curves: face.curves.map((curve) => toCurveSpec(curve)) };
}

/**
 * 解決済みの 1 段の作り方をカーネルの言葉へ直す。
 * 向き・反転・両側の平行移動・角度の度→ラジアンは resolvePart が済ませてあるので、
 * ここでやるのは欄の名前を合わせることと、曲線を CurveSpec へ直すことだけ。
 * 各節は return で閉じる(no-fallthrough)。
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

/** カーネルの結果を model のボディへ詰め替える。妥当性の判定は SolidBody.isValid の注釈のとおり。 */
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

/** Web Worker 内の幾何カーネルへつなぐ。ブラウザ・Electron のレンダラでのみ使える。 */
export function createKernelBridge(): KernelBridge {
  const worker = createKernelWorker();
  const remote = Comlink.wrap<KernelApi>(worker);

  return {
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      // 線・円弧の折れ線は UI が自前で作るので、カーネルへは面だけを頼む
      // (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
      const result = await remote.tessellateSketch({
        curves: [],
        faces: faces.map((face) => toFaceRequest(face)),
      });
      return toOutcome(faces, result.faces, result.failures);
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false };
      }
      const request: SolidRecomputeRequest = {
        steps: steps.map((step) => toSolidStepRequest(step)),
        generation: options.generation ?? 0,
      };
      // 第 2 引数はテッセレーションの粗さ。既定のままでよいので undefined を渡す。
      const result = await remote.recomputeSolids(
        request,
        undefined,
        toProgressProxy(options.onProgress),
        toCancelProxy(options.shouldCancel),
      );
      return toSolidOutcome(steps, result);
    },

    dispose(): void {
      remote[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}
