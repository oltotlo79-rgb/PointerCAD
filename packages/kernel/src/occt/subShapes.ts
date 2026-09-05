import type {
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Vertex,
  gp_Dir,
  gp_Pnt,
} from 'opencascade.js/dist/opencascade.full.js';

import type {
  EdgeCurveKind,
  FaceSurfaceKind,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidVertexInfo,
  Vec3Tuple,
} from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { EdgeSegmentRange } from './extractEdges.js';
import type { FaceTriangleRange } from './tessellate.js';

/**
 * 形の中の面・辺・頂点の一覧。並びはすべて TopExp.MapShapes_2 の順(0 始まりの通し番号)。
 *
 * tessellate の faceRanges・extractEdges の edgeRanges と同じ並びで、
 * faces[i] の三角形の範囲は faceRanges[i]、edges[i] の線分の範囲は edgeRanges[i] になる。
 */
export interface SubShapeTables {
  readonly faces: readonly SolidFaceInfo[];
  readonly edges: readonly SolidEdgeInfo[];
  readonly vertices: readonly SolidVertexInfo[];
}

/**
 * -0 を +0 へ揃える。
 *
 * 指紋(計画書 §2.2)は「形が同じなら必ず同じ値になる」ことが前提なので、
 * 見た目が同じで符号だけ違う 0 が混ざらないようにする。JavaScript の === では
 * -0 === 0 が真になるが、Object.is や JSON の文字列では別物になり、
 * 鍵(cacheKeyFor)の文字列が揺れて要らない再計算を招くため。
 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 点を数値 3 つのタプルへ直す(-0 は +0 に揃える)。 */
function pointToTuple(point: gp_Pnt): Vec3Tuple {
  return [normalizeZero(point.X()), normalizeZero(point.Y()), normalizeZero(point.Z())];
}

/**
 * 向きを長さ 1 のタプルへ直す。reverse が真なら符号を反転する。
 *
 * gp_Dir は OCCT が構築時に長さ 1 へ揃えるが、指紋の採点(matchSubShape.ts)が
 * 内積をそのまま点数に使うため、こちらでも長さで割って念を入れる
 * (長さがちょうど 1 のときは IEEE754 の除算が値を変えないので副作用が無い)。
 * 長さが取れない向きは null を返し、採点では「軸が無い」として扱われる。
 */
function directionToTuple(direction: gp_Dir, reverse: boolean): Vec3Tuple | null {
  const sign = reverse ? -1 : 1;
  const x = direction.X() * sign;
  const y = direction.Y() * sign;
  const z = direction.Z() * sign;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [normalizeZero(x / length), normalizeZero(y / length), normalizeZero(z / length)];
}

/** 面の下地の曲面から取れる素性(種類・軸・半径)。 */
interface FaceGeometry {
  readonly surfaceKind: FaceSurfaceKind;
  readonly axis: Vec3Tuple | null;
  readonly radius: number | null;
}

/**
 * 面の種類・軸・半径を読む。
 *
 * **軸の向きの決め:** 下地の曲面が持つ軸は面の向き(Orientation)を見ていないので、
 * そのままでは材料の内側を向くことがある。2026-09-03 に Node で実測したところ、
 * 10×20×30 の箱の 6 面の法線は下地のままだと (1,0,0)(1,0,0)(0,1,0)(0,1,0)(0,0,1)(0,0,1)
 * の 3 方向しか出ず、x=0・y=0・z=0 の 3 面が TopAbs_REVERSED だった。
 * そこで **面が反転しているときは軸の符号を反転する**。平面ではこれが「外向きの法線」
 * そのものになり、箱の上面が [0,0,1]、下面が [0,0,-1] と別物になるので、
 * 指紋の採点(裏の面を内積 -1 で落とす、計画書 §2.2.3)が働く。
 *
 * 円柱・円錐・トーラスの軸は「外向き」という意味を持たないが、同じ規則で符号を揃える。
 * 面の向きは同じ形なら常に同じなので決定性は保たれ、そのうえで
 * 「内側の穴の面」と「外側の出っ張りの面」が逆向きの軸になって区別できる利点がある。
 *
 * 球は軸の向きを一意に決められない(どの向きも同等)ので null にする。
 * トーラスは半径が 2 つ(主半径と管半径)あってどちらか一方では形を言い表せないため、
 * radius は null にして軸・面積・位置で照合する(types.ts の SolidFaceInfo.radius の
 * 説明どおり、半径を持つのは円柱・円錐・球だけ)。
 */
function readFaceGeometry(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  allocations: Allocations,
): FaceGeometry {
  const { keep } = allocations;
  // 第 2 引数 false は「面の境界(トリム)を読み込まない」指定。種類・軸・半径だけが要るので
  // 境界の読み込みを省く(面積と重心は BRepGProp が別に測る)。
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const surfaceType = adaptor.GetType();
  const kinds = oc.GeomAbs_SurfaceType;
  const reversed = face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;

  // 列挙の各値は型定義では空の型 `{}` なので、引数に渡すことはできないが
  // 戻り値どうしの比較はできる(2026-09-03 実測。tessellate.ts の ShapeType と同じ仕組み)。
  if (surfaceType === kinds.GeomAbs_Plane) {
    const plane = keep(adaptor.Plane());
    const axis = keep(plane.Axis());
    const direction = keep(axis.Direction());
    return { surfaceKind: 'plane', axis: directionToTuple(direction, reversed), radius: null };
  }
  if (surfaceType === kinds.GeomAbs_Cylinder) {
    const cylinder = keep(adaptor.Cylinder());
    const axis = keep(cylinder.Axis());
    const direction = keep(axis.Direction());
    return {
      surfaceKind: 'cylinder',
      axis: directionToTuple(direction, reversed),
      radius: normalizeZero(cylinder.Radius()),
    };
  }
  if (surfaceType === kinds.GeomAbs_Cone) {
    const cone = keep(adaptor.Cone());
    const axis = keep(cone.Axis());
    const direction = keep(axis.Direction());
    // 円錐の半径は場所によって変わるので、基準の平面での半径(RefRadius)を採る。
    // 同じ形なら常に同じ値になり、円錐どうしを見分ける材料になる。
    return {
      surfaceKind: 'cone',
      axis: directionToTuple(direction, reversed),
      radius: normalizeZero(cone.RefRadius()),
    };
  }
  if (surfaceType === kinds.GeomAbs_Sphere) {
    const sphere = keep(adaptor.Sphere());
    return { surfaceKind: 'sphere', axis: null, radius: normalizeZero(sphere.Radius()) };
  }
  if (surfaceType === kinds.GeomAbs_Torus) {
    const torus = keep(adaptor.Torus());
    const axis = keep(torus.Axis());
    const direction = keep(axis.Direction());
    return { surfaceKind: 'torus', axis: directionToTuple(direction, reversed), radius: null };
  }
  return { surfaceKind: 'other', axis: null, radius: null };
}

/** 辺の下地の曲線から取れる素性(種類・軸・半径・両端)。 */
interface EdgeGeometry {
  readonly curveKind: EdgeCurveKind;
  readonly axis: Vec3Tuple | null;
  readonly radius: number | null;
  readonly start: Vec3Tuple;
  readonly end: Vec3Tuple;
}

/**
 * 辺の種類・軸・半径・両端を読む。
 *
 * 両端は曲線のパラメータの下端・上端の点で取る。辺の向き(Orientation)では入れ替えない。
 * BRepAdaptor_Curve は向きを見ずに下地の曲線をそのまま渡すので、
 * 同じ辺なら向きが反転していても同じ 2 点が出る(決定性。2026-09-03 実測)。
 * 面の軸と違って辺の向きには「外向き」に当たる意味が無いため、符号も反転しない。
 */
function readEdgeGeometry(
  oc: OpenCascadeInstance,
  edge: TopoDS_Edge,
  allocations: Allocations,
): EdgeGeometry {
  const { keep } = allocations;
  // 3D 曲線を持たない辺ではこの構築が C++ の例外を投げる。その例外は段の失敗として
  // recomputeSolids が受け止めるので、アプリは落ちない(NFR-RE-1)。
  const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
  const curveType = curve.GetType();
  const kinds = oc.GeomAbs_CurveType;
  const start = pointToTuple(keep(curve.Value(curve.FirstParameter())));
  const end = pointToTuple(keep(curve.Value(curve.LastParameter())));

  if (curveType === kinds.GeomAbs_Line) {
    const line = keep(curve.Line());
    const direction = keep(line.Direction());
    return {
      curveKind: 'line',
      axis: directionToTuple(direction, false),
      radius: null,
      start,
      end,
    };
  }
  if (curveType === kinds.GeomAbs_Circle) {
    const circle = keep(curve.Circle());
    const axis = keep(circle.Axis());
    const direction = keep(axis.Direction());
    return {
      curveKind: 'circle',
      axis: directionToTuple(direction, false),
      radius: normalizeZero(circle.Radius()),
      start,
      end,
    };
  }
  if (curveType === kinds.GeomAbs_Ellipse) {
    const ellipse = keep(curve.Ellipse());
    const axis = keep(ellipse.Axis());
    const direction = keep(axis.Direction());
    // 楕円の半径は長半径と短半径の 2 つあり、どちらか一方では形を言い表せないので持たない
    // (types.ts の SolidEdgeInfo.radius の説明どおり、半径を持つのは円だけ)。
    return { curveKind: 'ellipse', axis: directionToTuple(direction, false), radius: null, start, end };
  }
  return { curveKind: 'other', axis: null, radius: null, start, end };
}

/** 面 1 枚の素性を組み立てる。 */
function buildFaceInfo(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  index: number,
  range: FaceTriangleRange,
  allocations: Allocations,
): SolidFaceInfo {
  const geometry = readFaceGeometry(oc, face, allocations);
  const properties = allocations.keep(new oc.GProp_GProps_1());
  // 第 3・第 4 引数は SkipShared と UseTriangulation。共有面を飛ばさず、
  // 三角形近似ではなく厳密な面で積分する(solidMesh.ts の体積の測り方と同じ)。
  oc.BRepGProp.SurfaceProperties_1(face, properties, false, false);
  const centre = allocations.keep(properties.CentreOfMass());

  return {
    index,
    surfaceKind: geometry.surfaceKind,
    area: normalizeZero(properties.Mass()),
    centroid: pointToTuple(centre),
    axis: geometry.axis,
    radius: geometry.radius,
    triangleOffset: range.triangleOffset,
    triangleCount: range.triangleCount,
  };
}

/** 辺 1 本の素性を組み立てる。 */
function buildEdgeInfo(
  oc: OpenCascadeInstance,
  edge: TopoDS_Edge,
  index: number,
  range: EdgeSegmentRange,
  allocations: Allocations,
): SolidEdgeInfo {
  const geometry = readEdgeGeometry(oc, edge, allocations);
  const properties = allocations.keep(new oc.GProp_GProps_1());
  oc.BRepGProp.LinearProperties(edge, properties, false, false);
  const length = normalizeZero(properties.Mass());

  // 長さ 0 の辺(円錐の頂点にできる「退化した辺」など)では、重心の計算が
  // 質量 0 の割り算になって原点 (0,0,0) が返る(2026-09-03 実測)。
  // 原点は形と無関係な場所なので、そのまま指紋にすると遠くの辺と取り違える。
  // 両端の中点(退化した辺では両端が同じ点なので、その点そのもの)で置き換える。
  const midpoint: Vec3Tuple =
    length > 0
      ? pointToTuple(allocations.keep(properties.CentreOfMass()))
      : [
          normalizeZero((geometry.start[0] + geometry.end[0]) / 2),
          normalizeZero((geometry.start[1] + geometry.end[1]) / 2),
          normalizeZero((geometry.start[2] + geometry.end[2]) / 2),
        ];

  return {
    index,
    curveKind: geometry.curveKind,
    length,
    midpoint,
    start: geometry.start,
    end: geometry.end,
    axis: geometry.axis,
    radius: geometry.radius,
    segmentOffset: range.segmentOffset,
    segmentCount: range.segmentCount,
  };
}

/** 頂点 1 つの素性を組み立てる。 */
function buildVertexInfo(
  oc: OpenCascadeInstance,
  vertex: TopoDS_Vertex,
  index: number,
  allocations: Allocations,
): SolidVertexInfo {
  const point = allocations.keep(oc.BRep_Tool.Pnt(vertex));
  return { index, position: pointToTuple(point) };
}

/**
 * 面・辺・頂点の素性を集める(計画書 §2.2)。
 *
 * faceRanges / edgeRanges は tessellate / extractEdges が返したもので、
 * ここで数える順と 1 対 1 に対応する(対応が崩れると指紋の照合が別の形を指す)。
 * どちらも同じ TopExp.MapShapes_2(shape, map, true, true) の並びなので、
 * 同じ形から呼んでいる限り枚数・本数は必ず一致する。一致しないときは
 * 別の形から作った範囲表を渡している合図なので、理由をつけて断る。
 *
 * 面の取り出しに TopExp_Explorer を使わない理由は tessellate.ts の説明と同じで、
 * 列挙を引数に取る API が強制変換なしでは型検査を通らないためである。
 */
export function collectSubShapes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faceRanges: readonly FaceTriangleRange[],
  edgeRanges: readonly EdgeSegmentRange[],
): SubShapeTables {
  const faces: SolidFaceInfo[] = [];
  const edges: SolidEdgeInfo[] = [];
  const vertices: SolidVertexInfo[] = [];

  const shared = createAllocations();

  try {
    // 第 3・第 4 引数は「向きと位置を親からたどって積み上げる」指定で、
    // tessellate.ts / extractEdges.ts と同じ並びになる。
    const subShapes = shared.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    const subShapeCount = subShapes.Size();

    // 1 周目: どの位置が面・辺・頂点かを数えるだけ。範囲表と食い違うなら、
    // 重い素性の計算を始める前に断る。
    const facePositions: number[] = [];
    const edgePositions: number[] = [];
    const vertexPositions: number[] = [];
    for (let position = 1; position <= subShapeCount; position += 1) {
      const subShape = subShapes.FindKey(position);
      const shapeType = subShape.ShapeType();
      if (shapeType === faceType) {
        facePositions.push(position);
      } else if (shapeType === edgeType) {
        edgePositions.push(position);
      } else if (shapeType === vertexType) {
        vertexPositions.push(position);
      }
      subShape.delete();
    }

    if (facePositions.length !== faceRanges.length) {
      throw new Error(
        `面の枚数(${facePositions.length})と三角形の範囲表の長さ(${faceRanges.length})が食い違います。同じ形から tessellate と collectSubShapes を呼んでください。`,
      );
    }
    if (edgePositions.length !== edgeRanges.length) {
      throw new Error(
        `辺の本数(${edgePositions.length})と線分の範囲表の長さ(${edgeRanges.length})が食い違います。同じ形から extractEdges と collectSubShapes を呼んでください。`,
      );
    }

    // 2 周目: 素性を読む。1 つぶんの確保はその場で作った順の逆に返し、
    // 面が数百枚ある形でも控えが伸び続けないようにする。
    for (const [index, position] of facePositions.entries()) {
      const perItem = createAllocations();
      try {
        const subShape = perItem.keep(subShapes.FindKey(position));
        const face = perItem.keep(oc.TopoDS.Face_1(subShape));
        faces.push(buildFaceInfo(oc, face, index, faceRanges[index], perItem));
      } finally {
        perItem.release();
      }
    }

    for (const [index, position] of edgePositions.entries()) {
      const perItem = createAllocations();
      try {
        const subShape = perItem.keep(subShapes.FindKey(position));
        const edge = perItem.keep(oc.TopoDS.Edge_1(subShape));
        edges.push(buildEdgeInfo(oc, edge, index, edgeRanges[index], perItem));
      } finally {
        perItem.release();
      }
    }

    for (const [index, position] of vertexPositions.entries()) {
      const perItem = createAllocations();
      try {
        const subShape = perItem.keep(subShapes.FindKey(position));
        const vertex = perItem.keep(oc.TopoDS.Vertex_1(subShape));
        vertices.push(buildVertexInfo(oc, vertex, index, perItem));
      } finally {
        perItem.release();
      }
    }
  } finally {
    shared.release();
  }

  return { faces, edges, vertices };
}

/**
 * 通し番号が index 番目の部分形状を取り出す。範囲の外なら null。
 *
 * 種類は列挙を引数に取らずに済むよう、呼び出し側が渡す判定の関数で決める
 * (列挙の各値は型定義では空の型 `{}` で、引数の型 TopAbs_ShapeEnum へ渡せないため)。
 * 戻り値は embind が作った複製なので、map を解放したあとも生きている(2026-09-03 実測)。
 */
function findSubShapeAt(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  index: number,
  matches: (candidate: TopoDS_Shape) => boolean,
): TopoDS_Shape | null {
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }

  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const subShapeCount = subShapes.Size();
    let found = 0;
    for (let position = 1; position <= subShapeCount; position += 1) {
      const subShape = subShapes.FindKey(position);
      if (matches(subShape)) {
        if (found === index) {
          // 見つかったものだけは解放せずに返す(解放は呼び出し側の責任)。
          return subShape;
        }
        found += 1;
      }
      subShape.delete();
    }
    return null;
  } finally {
    subShapes.delete();
  }
}

/** 通し番号から面の実体を取り出す。範囲の外なら null。呼び出し側が delete() する。 */
export function faceAt(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  index: number,
): TopoDS_Face | null {
  const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const found = findSubShapeAt(oc, shape, index, (candidate) => candidate.ShapeType() === faceType);
  if (found === null) {
    return null;
  }
  try {
    return oc.TopoDS.Face_1(found);
  } finally {
    found.delete();
  }
}

/** 通し番号から辺の実体を取り出す。範囲の外なら null。呼び出し側が delete() する。 */
export function edgeAt(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  index: number,
): TopoDS_Edge | null {
  const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const found = findSubShapeAt(oc, shape, index, (candidate) => candidate.ShapeType() === edgeType);
  if (found === null) {
    return null;
  }
  try {
    return oc.TopoDS.Edge_1(found);
  } finally {
    found.delete();
  }
}

/** 通し番号から頂点の実体を取り出す。範囲の外なら null。呼び出し側が delete() する。 */
export function vertexAt(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  index: number,
): TopoDS_Vertex | null {
  const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
  const found = findSubShapeAt(
    oc,
    shape,
    index,
    (candidate) => candidate.ShapeType() === vertexType,
  );
  if (found === null) {
    return null;
  }
  try {
    return oc.TopoDS.Vertex_1(found);
  } finally {
    found.delete();
  }
}

/**
 * 辺に接する面の通し番号を、並びの順に返す(C 面取りの基準面、計画書 §0.a-0.18)。
 * 辺の番号が範囲の外なら空の配列を返す。
 *
 * 面ごとに部分形状の一覧を作り、その中に同じ辺があるかを Contains で見る。
 * Contains の照合は向きを無視する(IsSame と同じ規則。2026-09-03 実測で
 * FindIndex(edge.Reversed()) が同じ辺を指すことを確かめた)ので、
 * 面の側で辺が反転して現れていても取りこぼさない。
 */
export function facesTouchingEdge(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  edgeIndex: number,
): readonly number[] {
  const edge = edgeAt(oc, shape, edgeIndex);
  if (edge === null) {
    return [];
  }

  const result: number[] = [];
  const shared = createAllocations();

  try {
    shared.keep(edge);
    const subShapes = shared.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const subShapeCount = subShapes.Size();
    let faceIndex = 0;

    for (let position = 1; position <= subShapeCount; position += 1) {
      const perFace = createAllocations();
      try {
        const subShape = perFace.keep(subShapes.FindKey(position));
        if (subShape.ShapeType() !== faceType) {
          continue;
        }
        const faceParts = perFace.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(subShape, faceParts, true, true);
        if (faceParts.Contains(edge)) {
          result.push(faceIndex);
        }
        faceIndex += 1;
      } finally {
        perFace.release();
      }
    }

    return result;
  } finally {
    shared.release();
  }
}

/**
 * 頂点に集まる辺の通し番号を、並びの順に返す(R 面取りの頂点、計画書 §0.a-0.17)。
 * 頂点の番号が範囲の外なら空の配列を返す。
 *
 * 辺ごとに両端の頂点を取り、対象の頂点と同じかを IsSame で見る。
 * 第 2 引数 false は「辺の向きを反映しない」指定で、下地の曲線の
 * パラメータの下端側が必ず FirstVertex になる(start / end と同じ並び)。
 * 円のように両端が同じ頂点になる辺は、1 本として 1 回だけ数える。
 */
export function edgesTouchingVertex(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  vertexIndex: number,
): readonly number[] {
  const vertex = vertexAt(oc, shape, vertexIndex);
  if (vertex === null) {
    return [];
  }

  const result: number[] = [];
  const shared = createAllocations();

  try {
    shared.keep(vertex);
    const subShapes = shared.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const subShapeCount = subShapes.Size();
    let edgeIndex = 0;

    for (let position = 1; position <= subShapeCount; position += 1) {
      const perEdge = createAllocations();
      try {
        const subShape = perEdge.keep(subShapes.FindKey(position));
        if (subShape.ShapeType() !== edgeType) {
          continue;
        }
        const edge = perEdge.keep(oc.TopoDS.Edge_1(subShape));
        const first = perEdge.keep(oc.TopExp.FirstVertex(edge, false));
        const last = perEdge.keep(oc.TopExp.LastVertex(edge, false));
        const touches =
          (!first.IsNull() && first.IsSame(vertex)) || (!last.IsNull() && last.IsSame(vertex));
        if (touches) {
          result.push(edgeIndex);
        }
        edgeIndex += 1;
      } finally {
        perEdge.release();
      }
    }

    return result;
  } finally {
    shared.release();
  }
}

/**
 * 形の境界箱の対角長(mm)。貫通穴の長さ(§0.a-0.12)と、指紋の位置の正規化(§2.2.3)に使う。
 * 中身の無い形では 0 を返す。
 *
 * BRepBndLib.Add は形の許容誤差ぶん(既定 1e-7)だけ箱を広げるので、
 * そのままだと 10×20×30 の箱の対角長が √1400 から 3e-7 ほどずれる(2026-09-03 実測)。
 * ずれは形ではなく許容誤差に由来する見かけの値なので、SetGap(0) で広げぶんを取り除き、
 * 幾何そのものの大きさを返す。
 *
 * Bnd_Box.Get(xmin, ..., zmax) は数値を参照渡しで返す形なので JS からは値を受け取れない。
 * 角の点を返す CornerMin() / CornerMax() を使う(計画書 §1.3)。
 */
export function boundingDiagonal(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const { keep, release } = createAllocations();

  try {
    const box = keep(new oc.Bnd_Box_1());
    // 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定。
    oc.BRepBndLib.Add(shape, box, false);
    if (box.IsVoid()) {
      return 0;
    }
    box.SetGap(0);
    const low = keep(box.CornerMin());
    const high = keep(box.CornerMax());
    return Math.hypot(high.X() - low.X(), high.Y() - low.Y(), high.Z() - low.Z());
  } finally {
    release();
  }
}

/** 余裕の割合(境界箱の対角長に対する 1%)。`booleanMargin` の中だけで使う。 */
const BOOLEAN_MARGIN_RATIO = 0.01;

/** 余裕の下限(mm)。部品が小さくても必ずこれだけは離す。 */
const BOOLEAN_MARGIN_MIN_MM = 1;

/**
 * ブーリアンで「面と面がぴったり重なる」配置を避けるための余裕(mm)。§0.a-0.12。
 *
 * 対象の境界箱の対角長 L に対し `L × 0.01 + 1mm` を返す。割合(1%)と下限(1mm)の
 * 2 本立てにしてあるのは、部品が大きいときは比例して、小さいときでも必ず 1mm 以上の
 * 余裕を取るためである。OCCT のブーリアンが最も苦手とするのは接触面ができる配置なので、
 * 工具はこのぶんだけ対象より大きく・遠くに取って必ず突き抜けさせる。
 *
 * **同じ式が `makeHole.ts` / `makeEmboss.ts` / `makeRib.ts` / `makeCut.ts` /
 * `makeSolidSweep.ts` の 5 か所に写されていたので、ここ 1 か所へまとめた**
 * (P5 §0.a-0.78、タスク42b)。値は 5 か所とまったく同じで、振る舞いは変えていない。
 *
 * 対角長が数でない・0 以下のときは呼び出し側がすでに断っている前提だが、
 * ここでも下限だけは返せるように、そのまま式を通す(NaN はそのまま NaN になる)。
 */
export function booleanMargin(diagonal: number): number {
  return diagonal * BOOLEAN_MARGIN_RATIO + BOOLEAN_MARGIN_MIN_MM;
}
