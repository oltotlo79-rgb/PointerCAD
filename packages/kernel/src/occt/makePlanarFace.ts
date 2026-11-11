import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Edge } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, ExtrudeStepSpec, TessellationOptions } from '../types.js';
import { discretizeEdge, makeCurveEdge } from './makeSketchEdges.js';
import { continuousCurvePieces } from './continuousCurvePieces.js';
import type { NativeProfileCurve, NativeProfileLine } from './subShapeOrigins.js';
import type { MeshCoordinateFrame } from './meshCoordinateFrame.js';
import { createAllocations } from './allocations.js';

/** OCCT の面と、そのために確保した領域の解放手続き。 */
export interface OcctFaceHandle {
  readonly face: TopoDS_Face;
  /**
   * 面の外周の稜線。線分1本あたり 6 個(始点 xyz + 終点 xyz)並ぶ。
   * SolidBodyMesh.edgePositions と同じ並びなので、面の縁を稜線と同じ描き方で出せる(FR-105)。
   */
  readonly boundaryPositions: Float32Array;
  /** 外周を作っている曲線の本数(線分・円弧を合わせた数)。 */
  readonly boundaryEdgeCount: number;
  readonly nativeProfileLines?: readonly NativeProfileLine[];
  readonly nativeProfileCurves?: readonly NativeProfileCurve[];
  delete(): void;
}

/** 折れ線を「線分1本あたり始点+終点」の並びへ直して足す。 */
function appendSegments(target: number[], polyline: Float32Array): void {
  for (let index = 0; index + 5 < polyline.length; index += 3) {
    target.push(
      polyline[index],
      polyline[index + 1],
      polyline[index + 2],
      polyline[index + 3],
      polyline[index + 4],
      polyline[index + 5],
    );
  }
}

/**
 * 閉じた平面のループから面を 1 枚作る(FR-309)。
 * 稜線 → ワイヤ → 面 の順に組み立てる。MakeWire は足した稜線の向きを自分で揃えるので、
 * 呼び出し側は並び順だけを保証すればよい。
 *
 * 成否の判定に Error() の戻り値を使わないのは、opencascade.js の型定義で
 * BRepBuilderAPI_WireError / BRepBuilderAPI_FaceError の各値が空の型 `{}` になっており、
 * 比較には強制変換が要るため(tessellate.ts と同じ理由)。IsDone() は boolean なので使える。
 *
 * 断り方は 2026-09-02 に Node 上で実測した挙動に合わせて 3 段階に分けている。
 * 1. 稜線どうしが離れている  → MakeWire の IsDone() が false。
 * 2. つながっているが輪が閉じていない(L 字など)
 *    → MakeWire は成功し、MakeFace_15 も IsDone() が true を返してしまうため、
 *      ワイヤ自身に閉じているかを聞く(TopoDS_Shape.Closed_1)。
 * 3. 輪郭が同じ平面に乗っていない → MakeFace_15 の IsDone() が false。
 * 4. 輪郭が自分自身と交わっている(蝶ネクタイ)
 *    → MakeFace_15 は IsDone() が true を返すが、三角形分割で 1 枚も面が出ない。
 *      BRepAlgo.IsValid_1 が false を返すのでここで断る(列挙を引数に取らないので
 *      強制変換なしで呼べる)。
 */
export function makePlanarFace(
  oc: OpenCascadeInstance,
  curves: readonly CurveSpec[],
  options: TessellationOptions = {},
  profileOrigin?: ExtrudeStepSpec['profileOrigin'],
  frame?: MeshCoordinateFrame,
): OcctFaceHandle {
  if (curves.length === 0) {
    throw new Error('面を作るには曲線が 1 本以上必要です。');
  }

  const owned = createAllocations();
  const sharedVertices = createAllocations();
  const edgeOwner = createAllocations();
  // Keep borrowed profile edges/vertices alive through the returned face handle.
  // Main release order is face -> maker -> wire -> wire maker -> edges -> shared vertices.
  owned.keep({ delete: sharedVertices.release });
  owned.keep({ delete: edgeOwner.release });
  const edges: TopoDS_Edge[] = [];
  const boundary: number[] = [];
  const nativeProfileLines: NativeProfileLine[] = [];
  const nativeProfileCurves: NativeProfileCurve[] = [];
  try {
    const wireMaker = owned.keep(new oc.BRepBuilderAPI_MakeWire_1());
    // Shared native vertices keep the four source edges as members of MakeFace.
    // The ordinary edge constructor may let MakeWire replace three of them.
    const fourLines = profileOrigin !== undefined && 'lineFeatureIds' in profileOrigin && curves.length === 4
      && profileOrigin.lineFeatureIds.length === 4
      && curves.every((curve) => curve.kind === 'segment')
      && curves.every((curve, index) => {
        const next = curves[(index + 1) % 4];
        return curve.kind === 'segment' && next?.kind === 'segment'
          && curve.to.every((value, axis) => value === next.from[axis]);
      });
    if (fourLines && profileOrigin !== undefined && 'lineFeatureIds' in profileOrigin) {
      const points = curves.map((curve) => {
        if (curve.kind !== 'segment') throw new Error('線分の輪郭が必要です。');
        const point = sharedVertices.keep(new oc.gp_Pnt_3(...curve.from));
        return point;
      });
      const vertices = points.map((point) => {
        const maker = sharedVertices.keep(new oc.BRepBuilderAPI_MakeVertex(point));
        const vertex = sharedVertices.keep(maker.Vertex());
        return vertex;
      });
      for (let index = 0; index < 4; index += 1) {
        const maker = edgeOwner.keep(new oc.BRepBuilderAPI_MakeEdge_2(vertices[index], vertices[(index + 1) % 4]));
        if (!maker.IsDone()) { throw new Error('線分の稜線を作れませんでした。'); }
        const edge = edgeOwner.keep(maker.Edge());
        edges.push(edge);
        wireMaker.Add_1(edge);
        appendSegments(boundary, discretizeEdge(oc, edge, options, frame));
        nativeProfileLines.push({ edge, anchor: { sketchId: profileOrigin.sketchId,
          faceFeatureId: profileOrigin.faceFeatureId,
          lineFeatureId: profileOrigin.lineFeatureIds[index], role: 'whole-line' } });
      }
    } else if (profileOrigin !== undefined && 'curveFeatureIds' in profileOrigin
      && curves.length >= 3 && curves.length <= 32
      && profileOrigin.curveFeatureIds.length === curves.length
      && new Set(profileOrigin.curveFeatureIds).size === curves.length
      && curves.every(curve => curve.kind === 'segment' || (curve.kind === 'spline'
        && !curve.closed && curve.degree === undefined && curve.knots === undefined))) {
      for (let index = 0; index < curves.length; index++) {
        const handle = edgeOwner.keep(makeCurveEdge(oc, curves[index]));
        edges.push(handle.edge);
        wireMaker.Add_1(handle.edge);
        // MakeWire may replace a coincident vertex in a copied edge. Edge() is
        // the actual last inserted edge, not an ordinal/nearest-geometry guess.
        if (!wireMaker.IsDone()) throw new Error('Saved profile edges are disconnected');
        const inserted = wireMaker.Edge();
        sharedVertices.keep(inserted);
        nativeProfileCurves.push({ edge: inserted, anchor: {
          sketchId: profileOrigin.sketchId, faceFeatureId: profileOrigin.faceFeatureId,
          curveFeatureId: profileOrigin.curveFeatureIds[index], role: 'whole-curve',
        } });
        appendSegments(boundary, discretizeEdge(oc, inserted, options, frame));
      }
    } else {
      for (const curve of continuousCurvePieces(curves)) {
        const handle = edgeOwner.keep(makeCurveEdge(oc, curve));
        edges.push(handle.edge);
        wireMaker.Add_1(handle.edge);
        appendSegments(boundary, discretizeEdge(oc, handle.edge, options, frame));
      }
    }


    if (!wireMaker.IsDone()) {
      throw new Error('選んだ線・円弧がつながっていないため、輪郭を作れませんでした。');
    }

    const wire = owned.keep(wireMaker.Wire());

    if (!wire.Closed_1()) {
      throw new Error('輪郭が閉じていないため、面を張れませんでした。');
    }

    // 第2引数 true は「平面だけを許す」。非平面のループはここで失敗し、FR-312(Could)へ回る。
    const faceMaker = owned.keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));

    if (!faceMaker.IsDone()) {
      throw new Error('輪郭が同じ平面に乗っていないため、面を張れませんでした。');
    }

    const face = owned.keep(faceMaker.Face());

    if (!oc.BRepAlgo.IsValid_1(face)) {
      throw new Error('輪郭が自分自身と交わっているため、面を張れませんでした。');
    }

    return {
      face,
      boundaryPositions: new Float32Array(boundary),
      boundaryEdgeCount: edges.length,
      ...(nativeProfileLines.length === 4 ? { nativeProfileLines } : {}),
      ...(nativeProfileCurves.length === curves.length ? { nativeProfileCurves } : {}),
      delete: owned.release,
    };
  } catch (error) {
    owned.release();
    throw error;
  }
}
