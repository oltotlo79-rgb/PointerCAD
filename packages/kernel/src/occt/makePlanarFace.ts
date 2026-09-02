import type { OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, TessellationOptions } from '../types.js';
import { discretizeEdge, makeCurveEdge, type OcctEdgeHandle } from './makeSketchEdges.js';

/** OCCT の面と、そのために確保した領域の解放手続き。 */
export interface OcctFaceHandle {
  readonly face: TopoDS_Face;
  /**
   * 面の外周の稜線。線分1本あたり 6 個(始点 xyz + 終点 xyz)並ぶ。
   * MeshData.edgePositions と同じ並びなので、面の縁を稜線と同じ描き方で出せる(FR-105)。
   */
  readonly boundaryPositions: Float32Array;
  /** 外周を作っている曲線の本数(線分・円弧を合わせた数)。 */
  readonly boundaryEdgeCount: number;
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
): OcctFaceHandle {
  if (curves.length === 0) {
    throw new Error('面を作るには曲線が 1 本以上必要です。');
  }

  const edges: OcctEdgeHandle[] = [];
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const boundary: number[] = [];

  const deleteParts = (): void => {
    wireMaker.delete();
    for (const handle of edges) {
      handle.delete();
    }
  };

  try {
    for (const curve of curves) {
      const handle = makeCurveEdge(oc, curve);
      edges.push(handle);
      wireMaker.Add_1(handle.edge);
      appendSegments(boundary, discretizeEdge(oc, handle.edge, options));
    }
  } catch (error) {
    deleteParts();
    throw error;
  }

  if (!wireMaker.IsDone()) {
    deleteParts();
    throw new Error('選んだ線・円弧がつながっていないため、輪郭を作れませんでした。');
  }

  const wire = wireMaker.Wire();
  const deleteWire = (): void => {
    wire.delete();
    deleteParts();
  };

  if (!wire.Closed_1()) {
    deleteWire();
    throw new Error('輪郭が閉じていないため、面を張れませんでした。');
  }

  // 第2引数 true は「平面だけを許す」。非平面のループはここで失敗し、FR-312(Could)へ回る。
  const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  const deleteMaker = (): void => {
    faceMaker.delete();
    deleteWire();
  };

  if (!faceMaker.IsDone()) {
    deleteMaker();
    throw new Error('輪郭が同じ平面に乗っていないため、面を張れませんでした。');
  }

  const face = faceMaker.Face();
  const deleteAll = (): void => {
    face.delete();
    deleteMaker();
  };

  if (!oc.BRepAlgo.IsValid_1(face)) {
    deleteAll();
    throw new Error('輪郭が自分自身と交わっているため、面を張れませんでした。');
  }

  return {
    face,
    boundaryPositions: new Float32Array(boundary),
    boundaryEdgeCount: edges.length,
    delete: deleteAll,
  };
}
