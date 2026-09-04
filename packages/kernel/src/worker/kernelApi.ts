import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import { makeOffsetWire } from '../occt/makeOffsetWire.js';
import { makePlanarFace } from '../occt/makePlanarFace.js';
import { makeProjection } from '../occt/makeProjection.js';
import { makeSection } from '../occt/makeSection.js';
import { discretizeEdge, makeCurveEdge } from '../occt/makeSketchEdges.js';
import { MISSING_SUB_SHAPE_MESSAGE, pickSubShape } from '../occt/pickSubShape.js';
import { tessellate } from '../occt/tessellate.js';
import type {
  FaceMeshData,
  SketchOffsetFailure,
  SketchOffsetOutcome,
  SketchOffsetRequest,
  SketchOffsetResult,
  SketchProjectionFailure,
  SketchProjectionOutcome,
  SketchProjectionRequest,
  SketchProjectionResult,
  SketchSectionRequest,
  SketchTessellation,
  SketchTessellationFailure,
  SketchTessellationRequest,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  TessellationOptions,
} from '../types.js';
// 窓口の名前と実体の名前が同じだと読み分けにくいので、実体は別名で取り込む。
import {
  recomputeSolids as runSolidRecompute,
  type CachedSolid,
  type SolidCancelToken,
  type SolidProgressCallback,
} from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

/**
 * 投影・交差(FR-325)のもとになる立体が形状キャッシュに無いとき。
 *
 * 形は `recomputeSolids` が段を作ったときに預けられるので、通常は必ず当たる。
 * 当たらないのは、①その段が作れなかった、②容量(`SHAPE_CACHE_CAPACITY`)を
 * 超えて追い出された、③Worker が作り直されてキャッシュが空になった、のいずれか。
 * どれも「もう一度計算し直せば直る」ので、そう伝える(FR-504、NFR-RE-1)。
 */
const MISSING_BODY_MESSAGE =
  'もとになる立体が見つかりませんでした。もう一度計算し直してください。';

/** UI 側から Comlink 越しに呼べる幾何カーネルの窓口。 */
export interface KernelApi {
  /** スケッチの曲線を折れ線に、閉ループを面にする(FR-309)。 */
  tessellateSketch(
    request: SketchTessellationRequest,
    options?: TessellationOptions,
  ): Promise<SketchTessellation>;
  /**
   * 部品の履歴を先頭から計算し直し、表示用のボディを返す(FR-401〜404、FR-504)。
   *
   * onProgress と cancelToken は Comlink.proxy で包んだ関数を渡す。
   * cancelToken が true を返すと、段と段の間で残りを打ち切って cancelled: true で返る
   * (1 段の演算そのものは途中で止められない。NFR-PF-4)。
   */
  recomputeSolids(
    request: SolidRecomputeRequest,
    options?: TessellationOptions,
    onProgress?: SolidProgressCallback,
    cancelToken?: SolidCancelToken,
  ): Promise<SolidRecomputeResult>;
  /**
   * 輪郭を距離ぶん平行にずらした曲線の列を作る(FR-321、P4 タスク15)。
   *
   * 何件でも 1 回の往復でまとめて頼める(面のテッセレーションと同じ形)。
   * 1 件失敗しても残りは作り、理由を `failures` へ入れて返す(FR-504、NFR-RE-1)。
   * 距離の符号(どちら側へずらすか)は呼び出し側が決める(§0.a-0.22)。
   */
  offsetSketchCurves(request: SketchOffsetRequest): Promise<SketchOffsetOutcome>;
  /**
   * 立体の面・辺の輪郭を作図面へ投影した曲線を作る(FR-325、P4 タスク25・26)。
   *
   * もとの立体は**形状キャッシュの鍵**で指す(B-rep は Comlink 越しに渡せないため)。
   * 鍵は `recomputeSolids` が段ごとに預けたもので、上流が変われば鍵も変わる。
   * 何件でも 1 回の往復でまとめて頼め、1 件失敗しても残りは作る(FR-504、NFR-RE-1)。
   */
  projectSketchCurves(request: SketchProjectionRequest): Promise<SketchProjectionOutcome>;
  /**
   * 立体と作図面の交線(断面の輪郭)を作る(FR-325)。
   * 交わらないときは**失敗ではなく空の結果**を返す(`makeSection.ts` の決め)。
   */
  sectionSketchCurves(request: SketchSectionRequest): Promise<SketchProjectionOutcome>;
}

/**
 * OCCT の読み込み手続きを受け取って KernelApi を組み立てる。
 * ブラウザでは loadOcctForBrowser、Node のテストでは loadOcctForNode を渡す。
 */
export function createKernelApi(loadOcct: () => Promise<OpenCascadeInstance>): KernelApi {
  // 形状キャッシュは窓口 1 つにつき 1 つ。再計算をまたいで残すことで、
  // 変えていないフィーチャーを作り直さずに済ませる(NFR-PF-3)。
  // 掃除は容量 SHAPE_CACHE_CAPACITY の LRU に任せ、retain は呼ばない(2026-09-03 統括判断)。
  const cache = createShapeCache<CachedSolid>();

  return {
    async tessellateSketch(sketch, options = {}): Promise<SketchTessellation> {
      const oc = await loadOcct();
      const curvePolylines: Float32Array[] = [];
      const faces: FaceMeshData[] = [];
      const failures: SketchTessellationFailure[] = [];

      for (const curve of sketch.curves) {
        const handle = makeCurveEdge(oc, curve);
        try {
          curvePolylines.push(discretizeEdge(oc, handle.edge, options));
        } finally {
          handle.delete();
        }
      }

      // 面が 1 枚失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
      for (const faceRequest of sketch.faces) {
        try {
          const handle = makePlanarFace(oc, faceRequest.curves, options);
          try {
            const surface = tessellate(oc, handle.face, options);
            faces.push({
              id: faceRequest.id,
              positions: surface.positions,
              normals: surface.normals,
              indices: surface.indices,
              triangleCount: surface.triangleCount,
              boundaryPositions: handle.boundaryPositions,
              boundaryEdgeCount: handle.boundaryEdgeCount,
            });
          } finally {
            handle.delete();
          }
        } catch (error) {
          failures.push({
            id: faceRequest.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { curvePolylines, faces, failures };
    },

    async recomputeSolids(
      request,
      options = {},
      onProgress,
      cancelToken,
    ): Promise<SolidRecomputeResult> {
      const oc = await loadOcct();
      return runSolidRecompute({ oc, cache }, request, options, onProgress, cancelToken);
    },

    async offsetSketchCurves(request): Promise<SketchOffsetOutcome> {
      const oc = await loadOcct();
      const results: SketchOffsetResult[] = [];
      const failures: SketchOffsetFailure[] = [];

      // 1 件失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
      for (const item of request.items) {
        try {
          const contours = makeOffsetWire(oc, {
            curves: item.curves,
            distance: item.distance,
            joinType: item.joinType,
          });
          results.push({ id: item.id, contours });
        } catch (error) {
          failures.push({
            id: item.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { results, failures };
    },

    async projectSketchCurves(request): Promise<SketchProjectionOutcome> {
      const oc = await loadOcct();
      const results: SketchProjectionResult[] = [];
      const failures: SketchProjectionFailure[] = [];

      // 1 件失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
      for (const item of request.items) {
        const cached = cache.get(item.shapeKey);
        if (cached === undefined) {
          failures.push({ id: item.id, message: MISSING_BODY_MESSAGE });
          continue;
        }
        // 指紋で選び直した面・辺は「新しく作られた形」なので、使い終えたら手放す。
        // 立体そのもの(subShape が null)はキャッシュの持ち物なので手放さない。
        const picked =
          item.subShape === null
            ? null
            : pickSubShape(oc, cached.shape, cached.mesh, item.subShape);
        if (item.subShape !== null && picked === null) {
          failures.push({ id: item.id, message: MISSING_SUB_SHAPE_MESSAGE });
          continue;
        }
        try {
          const curves = makeProjection(oc, {
            source: picked ?? cached.shape,
            plane: item.plane,
          });
          results.push({ id: item.id, curves: curves.curves });
        } catch (error) {
          failures.push({
            id: item.id,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          picked?.delete();
        }
      }

      return { results, failures };
    },

    async sectionSketchCurves(request): Promise<SketchProjectionOutcome> {
      const oc = await loadOcct();
      const results: SketchProjectionResult[] = [];
      const failures: SketchProjectionFailure[] = [];

      for (const item of request.items) {
        const cached = cache.get(item.shapeKey);
        if (cached === undefined) {
          failures.push({ id: item.id, message: MISSING_BODY_MESSAGE });
          continue;
        }
        try {
          const curves = makeSection(oc, { target: cached.shape, plane: item.plane });
          results.push({ id: item.id, curves: curves.curves });
        } catch (error) {
          failures.push({
            id: item.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { results, failures };
    },
  };
}
