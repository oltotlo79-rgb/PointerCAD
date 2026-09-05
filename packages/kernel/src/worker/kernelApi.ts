import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import { readBrepBytes, writeBrepBytes } from '../occt/brepBytes.js';
import { buildExportMesh } from '../occt/exportMesh.js';
import { makeOffsetWire } from '../occt/makeOffsetWire.js';
import { distanceBetween, measureMassProperties } from '../occt/measureShape.js';
import { makePlanarFace } from '../occt/makePlanarFace.js';
import { makeProjection } from '../occt/makeProjection.js';
import { makeSection } from '../occt/makeSection.js';
import { discretizeEdge, makeCurveEdge } from '../occt/makeSketchEdges.js';
import { MISSING_SUB_SHAPE_MESSAGE, pickSubShape } from '../occt/pickSubShape.js';
import { readStep } from '../occt/readStep.js';
import { hasSolid, measureVolume } from '../occt/solidMesh.js';
import { tessellate } from '../occt/tessellate.js';
import { writeStep } from '../occt/writeStep.js';
import type { RgbTuple } from '../occt/xcafDocument.js';
import type {
  FaceMeshData,
  MeasureRequest,
  MeasureResult,
  ShapeExportBrepBody,
  ShapeExportItem,
  ShapeExportMeshBody,
  ShapeExportRequest,
  ShapeExportResult,
  ShapeImportBody,
  ShapeImportRequest,
  ShapeImportResult,
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
  SolidBodyKind,
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
import { createShapeCache, type ShapeCache } from './shapeCache.js';

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

/**
 * 測る形が形状キャッシュに無いとき(FR-1101、FR-1102、§0.a-0.30)。
 *
 * 測定は再計算を起こさない読み取りなので、ここで自分から作り直すことはしない。
 * 呼び出し側(UI)は、再計算の完了を待って**自動で 1 回だけ測り直し**、
 * それでも無ければこの文言をそのまま見せる(§0.a-0.30 の条件)。
 */
const MEASURE_MISSING_SHAPE_MESSAGE = '測れませんでした。もう一度お試しください。';

/** 距離を測るのに対象が 2 つでないとき。 */
const MEASURE_NEEDS_TWO_MESSAGE = '距離を測るには 2 つ選んでください。';

/** 質量特性を測るのに対象が 1 つでないとき。 */
const MEASURE_NEEDS_ONE_MESSAGE = '体積と重心を測るには立体を 1 つ選んでください。';

/**
 * 読み込んだ形へ付ける、画面用の三角形の粗さ(FR-802、P6 §2.8)。
 *
 * **省略と同じ意味の空の指定**にしてある。`tessellate` の既定(線形 0.1mm・角度 0.5rad)は
 * 画面表示の既定そのもので、読み込んだ形も画面に出るところは他のボディと変わらないため、
 * ここで別の粗さを決める理由が無い。書き出しの偏差(FR-803)とは別物で、そちらは
 * 依頼が数で指定する(`ShapeExportRequest` の `deviationMm`)。
 */
const IMPORT_TESSELLATION: TessellationOptions = {};

/**
 * 書き出す立体を鍵から引く(FR-803)。
 *
 * **1 つでも見つからなければ書き出しごと断る。** 一部だけ入ったファイルを渡すと、
 * 利用者は欠けに気づかないまま他の CAD へ持っていくことになる(NFR-UX-5 は
 * 「実行してから失敗させない」)。文言は投影・交差と同じ `MISSING_BODY_MESSAGE` で、
 * 直し方(もう一度計算し直す)も同じである。
 *
 * **形はキャッシュの持ち物**なので、この関数も呼び出し側も解放しない。
 */
function resolveExportShapes(
  cache: ShapeCache<CachedSolid>,
  bodies: readonly ShapeExportItem[],
): readonly TopoDS_Shape[] {
  return bodies.map((item) => {
    const cached = cache.get(item.bodyKey);
    if (cached === undefined) {
      throw new Error(MISSING_BODY_MESSAGE);
    }
    return cached.shape;
  });
}

/**
 * 読み込んだ形 1 つを、Comlink 越しに渡せる形へ畳む(FR-802、P6 §2.8)。
 *
 * **バイト列を三角形より先に作る。** `tessellate` は `BRepMesh_IncrementalMesh` を通して
 * **形そのものへ三角形を書き込む**ので、順序を逆にすると三角形分割の付いた形が保存され、
 * `.pcad` に入るバイト列が無駄に大きくなる(`occt/brepBytes.ts` の実測: 20³ の箱で
 * 4,494 → 6,931 バイト。`BinTools.Write_3` は三角形分割も一緒に書く)。
 *
 * 渡された形は呼び出し側が解放する(STEP なら `StepReadResult.delete()`、
 * B-rep なら `readBrepBytes` が返した形)。この関数は持ち主にならない。
 */
function toImportBody(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  name: string | null,
  color: RgbTuple | null,
  bodyKind: SolidBodyKind,
): ShapeImportBody {
  const brepBytes = writeBrepBytes(oc, shape);
  const volume = measureVolume(oc, shape);
  const surface = tessellate(oc, shape, IMPORT_TESSELLATION);
  return {
    name,
    color,
    bodyKind,
    volume,
    brepBytes,
    triangles: {
      positions: surface.positions,
      normals: surface.normals,
      indices: surface.indices,
      triangleCount: surface.triangleCount,
    },
  };
}

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
  /**
   * 覚えてある形を測る(FR-1101、FR-1102、P5 タスク28)。
   *
   * **測定は再計算を起こさない読み取り**(§0.a-0.30)。対象は投影・交差と同じく
   * **形状キャッシュの鍵**(段の `key`)で指し、面・辺・頂点は指紋で選び直す。
   * 選び直しは P3 の部分形状の参照(`occt/pickSubShape.ts` → `matchSubShape.ts`)
   * そのままで、測定のための別の規約は作らない。
   *
   * 鍵が見つからない・指紋に合う面が無い・件数が合わないときは、**投げずに**
   * `{ kind: 'failed' }` を返す(アプリを落とさない。FR-504、NFR-RE-1)。
   */
  measure(request: MeasureRequest): Promise<MeasureResult>;
  /**
   * 覚えてある形をファイルの中身へ書き出す(FR-803、P6 §2.3・§2.4、タスク10)。
   *
   * **形式ごとに口を増やさない**(§0.a-0.2)。STEP のバイト列・三角形の網・B-rep の
   * バイト列の切り替えは依頼の `format` で判別し、実装は網羅 `switch` で受ける
   * (`ShapeExportRequest` の表)。対象は投影・測定と同じく**段のキャッシュの鍵**で指す。
   *
   * **測定と同じく、これは読み取りだけ**で再計算も鍵の作り直しも起こさない。三角形は
   * 形の複製に掛けるので、画面用のキャッシュは 1 枚も汚れない(`occt/exportMesh.ts`)。
   *
   * 鍵が見つからないとき・OCCT が書けなかったときは**日本語の理由で投げる**
   * (測定と違って結果に「失敗」の枝を作らないのは、書き出しが 1 回 1 ファイルの操作で、
   * 一部だけ書けても利用者には渡せないためである。断りは画面がそのまま見せられる)。
   */
  exportShapes(request: ShapeExportRequest): Promise<ShapeExportResult>;
  /**
   * ファイルの中身から形を読み込む(FR-802、FR-811、P6 §2.3・§2.8、タスク10)。
   *
   * 書き出しと同じく**口は 1 本**で、依頼の `format` で判別する。返すのは
   * **`.pcad` へ抱き込むバイト列と画面用の三角形**で、形そのものは Worker の中に残さない
   * (`ShapeImportBody` の注釈)。読み込んだ形の単位は mm へ換算済み(NFR-RE-3)。
   *
   * 読めなかったとき・立体が入っていなかったときは**日本語の理由で投げる**
   * (§2.8 の断りの表。画面はその文言をそのまま見せる)。
   */
  importShape(request: ShapeImportRequest): Promise<ShapeImportResult>;
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

    async measure(request): Promise<MeasureResult> {
      const oc = await loadOcct();
      // 選び直した面・辺・頂点は「新しく作られた形」なので、測り終えたら手放す。
      // ボディそのもの(subShape が null)はキャッシュの持ち物なので手放さない。
      const picked: TopoDS_Shape[] = [];
      const shapes: TopoDS_Shape[] = [];

      try {
        for (const target of request.targets) {
          const cached = cache.get(target.bodyKey);
          if (cached === undefined) {
            return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
          }
          if (target.subShape === null) {
            shapes.push(cached.shape);
            continue;
          }
          const subShape = pickSubShape(oc, cached.shape, cached.mesh, target.subShape);
          if (subShape === null) {
            return { kind: 'failed', message: MISSING_SUB_SHAPE_MESSAGE };
          }
          picked.push(subShape);
          shapes.push(subShape);
        }

        try {
          if (request.kind === 'distance') {
            const [first, second] = shapes;
            if (shapes.length !== 2 || first === undefined || second === undefined) {
              return { kind: 'failed', message: MEASURE_NEEDS_TWO_MESSAGE };
            }
            const found = distanceBetween(oc, first, second);
            return {
              kind: 'distance',
              distance: found.distance,
              pointA: found.pointA,
              pointB: found.pointB,
              inner: found.inner,
            };
          }
          const [only] = shapes;
          if (shapes.length !== 1 || only === undefined) {
            return { kind: 'failed', message: MEASURE_NEEDS_ONE_MESSAGE };
          }
          const properties = measureMassProperties(oc, only);
          return {
            kind: 'massProperties',
            volume: properties.volume,
            area: properties.area,
            centreOfMass: properties.centreOfMass,
            principalMoments: properties.principalMoments,
            principalAxes: properties.principalAxes,
          };
        } catch (error) {
          // OCCT が測れなかった理由はそのまま画面に出せる日本語にしてある(FR-504)。
          return {
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        for (const shape of picked) {
          shape.delete();
        }
      }
    },

    async exportShapes(request): Promise<ShapeExportResult> {
      const oc = await loadOcct();
      const shapes = resolveExportShapes(cache, request.bodies);

      // 網羅 `switch`(`default` を作らない)。形式が増えたら、ここが型検査で落ちる
      // ことで配線し忘れが分かる(`ShapeExportRequest` の注釈)。
      switch (request.format) {
        case 'step': {
          // 立体が 1 つも無いときの断り(「書き出せる立体がありません。」)は
          // `buildXcafDocument` が持っている。ここで先回りして数えないのは、
          // 同じ文言を 2 か所に置かないため(model の `selectExportBodies` も
          // `nothingToExport` で先に断る)。
          const written = writeStep(
            oc,
            request.bodies.map((item, index) => ({
              shape: shapes[index],
              name: item.name,
              color: item.color,
            })),
            { withColors: request.withColors ?? true },
          );
          return { format: 'step', bytes: written.bytes, colorWritten: written.colorWritten };
        }
        case 'mesh': {
          const bodies: ShapeExportMeshBody[] = request.bodies.map((item, index) => ({
            bodyKey: item.bodyKey,
            // 形の複製に掛けるので、画面用キャッシュの三角形は 1 枚も変わらない(§0.a-0.13)。
            triangles: buildExportMesh(oc, shapes[index], request.deviationMm),
          }));
          return { format: 'mesh', bodies };
        }
        case 'brep': {
          const bodies: ShapeExportBrepBody[] = request.bodies.map((item, index) => ({
            bodyKey: item.bodyKey,
            bytes: writeBrepBytes(oc, shapes[index]),
          }));
          return { format: 'brep', bodies };
        }
      }
    },

    async importShape(request): Promise<ShapeImportResult> {
      const oc = await loadOcct();

      // 網羅 `switch`。STL / OBJ の読み込み(タスク16・18)は依頼の union へ 1 つ足すと、
      // ここが型検査で落ちて配線を促す(`ShapeImportRequest` の注釈)。
      switch (request.format) {
        case 'step': {
          // `readStep` が返した形は読み手の持ち物。**必ず `delete()` する**
          // (`rules/06` 10.13 の解放の見分け。忘れると次の読み込みが数倍遅くなる)。
          const read = readStep(oc, request.bytes, {
            fileName: request.fileName,
            withColors: request.withColors,
          });
          try {
            return {
              bodies: read.bodies.map((body) =>
                toImportBody(oc, body.shape, body.name, body.color, body.kind),
              ),
              unit: read.unit,
              unitNames: read.unitNames,
            };
          } finally {
            read.delete();
          }
        }
        case 'brep': {
          // `.pcad` へ抱き込んだバイト列(§0.a-0.9)。名前も色も文書の側が持っているので、
          // ここでは形だけを戻す。単位は内部単位そのもの(mm)で、ファイルの単位は無い。
          const shape = readBrepBytes(oc, request.bytes);
          try {
            return {
              bodies: [
                toImportBody(oc, shape, null, null, hasSolid(oc, shape) ? 'solid' : 'shell'),
              ],
              unit: 'mm',
              unitNames: [],
            };
          } finally {
            shape.delete();
          }
        }
      }
    },
  };
}
