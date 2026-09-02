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
} from '@pointercad/kernel';
import * as Comlink from 'comlink';

import type { ResolvedCurve, ResolvedFace, SketchFaceMesh, SketchMesh } from './sketch/types.js';
import type { PartMesh } from './types.js';

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

/** model から幾何カーネルへの唯一の接点。ここ以外から kernel を呼ばない。 */
export interface KernelBridge {
  tessellateBox(dx: number, dy: number, dz: number): Promise<PartMesh>;
  /** 面の一覧をカーネルへ渡し、表示用の三角形を受け取る(FR-309)。 */
  tessellateSketchFaces(faces: readonly ResolvedFace[]): Promise<SketchTessellationOutcome>;
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
    async tessellateBox(dx, dy, dz): Promise<PartMesh> {
      const mesh = await remote.tessellateBox({ dx, dy, dz });
      return {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        edgePositions: mesh.edgePositions,
        triangleCount: mesh.triangleCount,
      };
    },

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

    dispose(): void {
      remote[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}
