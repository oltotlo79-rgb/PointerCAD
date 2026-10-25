import type {
  OpenCascadeInstance,
  TopTools_IndexedMapOfShape,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  gp_Pln,
} from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import type { BooleanResult } from './booleanOp.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';

/**
 * 平らな面を、その面の縁の直線の辺(蝶番)のまわりに回す(EX-18 W16 R1)。
 *
 * **有限の面を剛体のまま回す操作ではない。** 面の支持平面を蝶番の直線のまわりに回し、
 * 隣の 4 枚の平面は動かさずに、その交線で面を切り直す(W16 のプローブで成立した手順:
 * 立体全体の深い複製へ `BRepOffsetAPI_DraftAngle` を掛ける。中立面 = 蝶番を共有するもう 1 枚の面、
 * 抜き方向 = 中立面の外向き法線)。蝶番の 2 頂点と、回す面に触れない頂点は動かない。
 *
 * **符号の規約:** 回転軸の向き h は、蝶番の辺の下地の直線をパラメータの増える向きにたどる向き
 * (`BRepAdaptor_Curve` の FirstParameter の点 → LastParameter の点。`SolidEdgeInfo` の
 * start → end・axis と同じ)。TopoDS の向き(FORWARD / REVERSED、`edge.Reversed()`)は見ない。
 * 正の角は h のまわりの右手系で、回した面の外向き法線は n' = n·cosθ + (h×n)·sinθ になる。
 * 例: 0≤x≤40・0≤y≤30・0≤z≤8 の箱の上面を、y=0・z=8 の辺(h = +X)のまわりに +5° 回すと
 * 上面は z = 8 + y·tan5° になり(材料が増える)、−5° では z = 8 − y·tan5° になる。
 * 同じ位置の辺でも向きが −X なら、同じ +5° で逆に倒れる。editSolidFace の「正は外向き」と違い、
 * 符号は材料の増減ではなく辺の向きで決まる。
 *
 * **この段(R1)が扱うのは直方体だけ**(立体 1・殻 1・平面 6・直線の辺 12・頂点 8 で、8 頂点が
 * 蝶番に沿う直交枠の角に一致するもの。寸法と剛体の配置は問わない)。曲面の隣・穴・段差などの
 * 一般の形の判定と断り方の網羅は R2 で足す。結果は次をすべて満たすときだけ返す。
 *   - 立体 1 つで B-rep として妥当、面 6・辺 12・頂点 8 の直方体の位相のまま。
 *   - 8 頂点が解析値と 1e-9 mm で 1 対 1 に一致(蝶番の 2 点と反対側の面の 4 点は不動、
 *     蝶番から遠い 2 点は回す前の面の法線の向きへ W·s·tanθ だけ動く。W = 蝶番から遠い縁までの幅、
 *     s = (h×n)·m = ±1、m = 中立面の外向き法線)。
 *   - 回した面の法線が n'、他の 5 面の法線が元のまま。
 *   - 体積 = L·W·(H + W·s·tanθ/2)(相対 1e-9。L = 蝶番の長さ、H = 回す面から反対の面までの高さ)。
 *
 * **所有:** `solid`・`planarFace`・`hingeEdge` は借用で、解放も変更もしない(rules/06 §10.16・§10.424。
 * builder へ渡すのは深い複製だけ)。読む前に、面と辺が本当に `solid` に属すること、辺が面の縁に
 * あることを確かめる(同じ形の別の立体の面・辺は断る)。ここで作る wrapper(複製・一覧・
 * 読み取りの値・DraftAngle と結果)はすべて createAllocations の控えへ積み、断ったとき・
 * 例外のときはその場で、成功したときは結果の delete()(2 回目は何もしない)で逆順に解放する。
 * 使う戻り値はすべて embind の複製(`Shape()`・`ModifiedShape()`・`FindKey()`・`Face_1`/`Edge_1`/
 * `Vertex_1`・`Plane()`・`Axis()`・`Direction()`・`Value()`・`Line()`・`BRep_Tool.Pnt`)で、
 * Handle.get() の借用は無い(rules/06 §10.13。同じ呼び出しは editSolidFace・moveSolidHole・makeDraft・
 * subShapes で実測済み)。保存された参照(SubShapeQuery)からの解決はこの入口の外(K1)で行う。
 */

/** 入力の直方体の頂点・寸法の照合の許容(mm)。OCCT の Precision::Confusion と同じ大きさ。 */
const BOX_TOLERANCE_MM = 1e-7;
/** 結果の頂点を解析値と照合する許容(mm)。 */
const RESULT_TOLERANCE_MM = 1e-9;
/** 向きの許容(単位ベクトルの差・内積)。 */
const ANGULAR_TOLERANCE = 1e-9;
/** 体積の相対許容。 */
const VOLUME_RELATIVE_TOLERANCE = 1e-9;
/** 遠い縁の動きがこれ未満(mm)の角は「回さない」とみなして断る(editSolidFace の最小距離と同じ)。 */
const MIN_EDGE_TRAVEL_MM = 1e-6;
/** 内向きに倒したあと遠い側に残る高さの下限(mm)。これ以下は反対の面に届くとみなす。 */
const MIN_REMAINING_HEIGHT_MM = 1e-6;

export const FACE_ROTATION_ANGLE_MESSAGE =
  '面を回す角度は、0 度でなく、絶対値が 90 度より小さい値にしてください。';
export const FACE_ROTATION_INVALID_BODY_MESSAGE =
  '元の立体の形が正しくないため、面を回せません。元の立体を直してください。';
export const FACE_ROTATION_FOREIGN_FACE_MESSAGE =
  '選んだ面は対象の立体に属していません。回す面を選び直してください。';
export const FACE_ROTATION_FOREIGN_EDGE_MESSAGE =
  '選んだ辺は対象の立体に属していません。回転の軸にする辺を選び直してください。';
export const FACE_ROTATION_EDGE_NOT_ON_FACE_MESSAGE =
  '回転の軸には、回す面の縁にある辺を選んでください。';
export const FACE_ROTATION_NOT_PLANAR_MESSAGE = '回せるのは平らな面だけです。';
export const FACE_ROTATION_CURVED_EDGE_MESSAGE = '回転の軸にできるのは直線の辺だけです。';
export const FACE_ROTATION_BOX_MESSAGE =
  'この操作は、六つの平面からなる直方体の面だけに対応しています。';
export const FACE_ROTATION_COLLISION_MESSAGE =
  '面を回すと反対側の面に届くため回せません。角度を小さくしてください。';
export const FACE_ROTATION_FAILED_MESSAGE = '面を回せませんでした。面・辺・角度を見直してください。';

/** 結果の形と、判定のために測った体積。delete() で作ったものを全部返す(BooleanResult と同じ流儀)。 */
export type FaceRotationResult = BooleanResult;

interface PlanarFaceRecord {
  readonly face: TopoDS_Face;
  /** 材料の外を向く法線。 */
  readonly normal: Vec3Tuple;
  readonly plane: gp_Pln;
  readonly edges: TopTools_IndexedMapOfShape;
}

interface LineEdgeRecord {
  readonly start: Vec3Tuple;
  readonly end: Vec3Tuple;
  /** 下地の直線のパラメータの増える向き(長さ 1)。 */
  readonly direction: Vec3Tuple;
  readonly length: number;
}

interface BoxTopology {
  readonly faces: readonly PlanarFaceRecord[];
  readonly edges: readonly LineEdgeRecord[];
  readonly vertices: readonly Vec3Tuple[];
}

/** 蝶番に沿う直交枠。角は start + h·a − m·b − n·c(a∈{0,L}, b∈{0,W}, c∈{0,H})。 */
interface HingeFrame {
  readonly n: Vec3Tuple;
  readonly m: Vec3Tuple;
  readonly h: Vec3Tuple;
  readonly start: Vec3Tuple;
  /** (h×n)·m の符号。DraftAngle に渡す角は θ·sign。 */
  readonly sign: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(a: Vec3Tuple, b: Vec3Tuple, scale: number): Vec3Tuple {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function separation(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function negate(a: Vec3Tuple): Vec3Tuple {
  return [-a[0], -a[1], -a[2]];
}

/** 断りの Error。detail は利用者へ見せない検査用の手掛かり(どの段で何が合わなかったか)。 */
function refusal(message: string, detail: Readonly<Record<string, unknown>>): Error {
  return new Error(message, { cause: detail });
}

function shapesOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  type: 'SHELL' | 'FACE' | 'WIRE' | 'EDGE' | 'VERTEX',
  owned: Allocations,
): TopTools_IndexedMapOfShape {
  const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  // 列挙の各値は型定義では空の型なので、文字列から引く(editSolidFace.ts と同じ)。
  oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1(type), map);
  return map;
}

/** 平面なら外向きの法線と平面を読む。平面でなければ null。法線は面の向きで材料の外へ向ける。 */
function readPlanarFace(oc: OpenCascadeInstance, face: TopoDS_Face, owned: Allocations): PlanarFaceRecord | null {
  const { keep } = owned;
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
  const plane = keep(adaptor.Plane()), axis = keep(plane.Axis()), direction = keep(axis.Direction());
  const sign = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
  return {
    face, plane, edges: shapesOf(oc, face, 'EDGE', owned),
    normal: [sign * direction.X(), sign * direction.Y(), sign * direction.Z()],
  };
}

/** 直線なら両端・向き・長さを読む。直線でなければ null。両端は辺の向きで入れ替えない(subShapes.ts と同じ)。 */
function readLineEdge(oc: OpenCascadeInstance, edge: TopoDS_Edge, owned: Allocations): LineEdgeRecord | null {
  const { keep } = owned;
  const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
  if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) return null;
  const first = keep(curve.Value(curve.FirstParameter())), last = keep(curve.Value(curve.LastParameter()));
  const along = keep(keep(curve.Line()).Direction());
  const start: Vec3Tuple = [first.X(), first.Y(), first.Z()], end: Vec3Tuple = [last.X(), last.Y(), last.Z()];
  return { start, end, direction: [along.X(), along.Y(), along.Z()], length: separation(start, end) };
}

/** 直方体の位相(殻 1・平面 6・直線の辺 12・頂点 8、各辺を 2 面が共有、各面は 4 辺 1 輪)を読む。 */
function readBox(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations, message: string): BoxTopology {
  const { keep } = owned;
  const faceMap = shapesOf(oc, shape, 'FACE', owned), edgeMap = shapesOf(oc, shape, 'EDGE', owned);
  const vertexMap = shapesOf(oc, shape, 'VERTEX', owned);
  const counts = { shells: shapesOf(oc, shape, 'SHELL', owned).Size(), faces: faceMap.Size(),
    edges: edgeMap.Size(), vertices: vertexMap.Size() };
  if (counts.shells !== 1 || counts.faces !== 6 || counts.edges !== 12 || counts.vertices !== 8) {
    throw refusal(message, { stage: 'box-counts', ...counts });
  }
  const faces: PlanarFaceRecord[] = [];
  for (let position = 1; position <= counts.faces; position += 1) {
    const face = keep(oc.TopoDS.Face_1(keep(faceMap.FindKey(position))));
    const record = readPlanarFace(oc, face, owned);
    if (record === null || record.edges.Size() !== 4 || shapesOf(oc, face, 'WIRE', owned).Size() !== 1) {
      throw refusal(message, { stage: 'box-face', position });
    }
    faces.push(record);
  }
  const edges: LineEdgeRecord[] = [];
  for (let position = 1; position <= counts.edges; position += 1) {
    const edge = keep(oc.TopoDS.Edge_1(keep(edgeMap.FindKey(position))));
    const record = readLineEdge(oc, edge, owned);
    const owners = faces.filter(face => face.edges.Contains(edge)).length;
    if (record === null || owners !== 2) throw refusal(message, { stage: 'box-edge', position, owners });
    edges.push(record);
  }
  const vertices: Vec3Tuple[] = [];
  for (let position = 1; position <= counts.vertices; position += 1) {
    const point = keep(oc.BRep_Tool.Pnt(keep(oc.TopoDS.Vertex_1(keep(vertexMap.FindKey(position))))));
    vertices.push([point.X(), point.Y(), point.Z()]);
  }
  return { faces, edges, vertices };
}

/** 角 (a, b, c) の位置。a は蝶番に沿う長さ、b は中立面から奥への幅、c は回す面から反対への高さ。 */
function corner(frame: HingeFrame, a: number, b: number, c: number): Vec3Tuple {
  return addScaled(addScaled(addScaled(frame.start, frame.h, a), frame.m, -b), frame.n, -c);
}

function corners(frame: HingeFrame): readonly { readonly far: boolean; readonly onFace: boolean; readonly point: Vec3Tuple }[] {
  const out: { far: boolean; onFace: boolean; point: Vec3Tuple }[] = [];
  for (const a of [0, frame.length]) {
    for (const b of [0, frame.width]) {
      for (const c of [0, frame.height]) out.push({ far: b > 0, onFace: c === 0, point: corner(frame, a, b, c) });
    }
  }
  return out;
}

/** 各点に、許容内の実頂点がちょうど 1 つずつあるか。最大の誤差も返す(手掛かり用)。 */
function matchPoints(expected: readonly Vec3Tuple[], actual: readonly Vec3Tuple[], tolerance: number) {
  let worst = 0;
  const ok = expected.every((point) => {
    const distances = actual.map(other => separation(point, other));
    worst = Math.max(worst, Math.min(...distances));
    return distances.filter(distance => distance <= tolerance).length === 1;
  });
  return { ok, worst };
}

/** 6 面の法線が、期待の 6 方向へ 1 枚ずつ対応するか。 */
function matchNormals(faces: readonly PlanarFaceRecord[], expected: readonly Vec3Tuple[]): boolean {
  return expected.every(direction =>
    faces.filter(face => separation(face.normal, direction) <= ANGULAR_TOLERANCE).length === 1);
}

/** 回す面・中立面・蝶番から直交枠を作り、元の形がその枠の直方体であることを確かめる。 */
function hingeFrame(
  oc: OpenCascadeInstance, copied: TopoDS_Shape, box: BoxTopology, selected: PlanarFaceRecord,
  neutral: PlanarFaceRecord, hinge: LineEdgeRecord,
): HingeFrame {
  const n = selected.normal, m = neutral.normal, h = hinge.direction;
  const handedness = dot(cross(h, n), m);
  if (Math.abs(dot(n, m)) > ANGULAR_TOLERANCE || Math.abs(dot(h, n)) > ANGULAR_TOLERANCE
    || Math.abs(dot(h, m)) > ANGULAR_TOLERANCE || Math.abs(Math.abs(handedness) - 1) > ANGULAR_TOLERANCE) {
    throw refusal(FACE_ROTATION_BOX_MESSAGE, { stage: 'frame-axes', handedness });
  }
  const start = hinge.start;
  const width = Math.max(...box.vertices.map(vertex => -dot(subtract(vertex, start), m)));
  const height = Math.max(...box.vertices.map(vertex => -dot(subtract(vertex, start), n)));
  const frame: HingeFrame = { n, m, h, start, sign: Math.sign(handedness), length: hinge.length, width, height };
  const fit = matchPoints(corners(frame).map(entry => entry.point), box.vertices, BOX_TOLERANCE_MM);
  if (!(width > BOX_TOLERANCE_MM) || !(height > BOX_TOLERANCE_MM) || !(hinge.length > BOX_TOLERANCE_MM) || !fit.ok
    || !matchNormals(box.faces, [n, negate(n), m, negate(m), h, negate(h)])) {
    throw refusal(FACE_ROTATION_BOX_MESSAGE, { stage: 'frame-corners', width, height, worst: fit.worst });
  }
  // 平面だけの形なので、三角形近似ではなく厳密な面で積分する(knownPlanar)。
  const volume = measureVolume(oc, copied, true), expected = hinge.length * width * height;
  if (!(Math.abs(volume - expected) <= expected * VOLUME_RELATIVE_TOLERANCE)) {
    throw refusal(FACE_ROTATION_BOX_MESSAGE, { stage: 'frame-volume', volume, expected });
  }
  return frame;
}

/** 結果が解析値どおりの形かを確かめ、測った体積を返す。外れたら断る。 */
function checkResult(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, frame: HingeFrame, angle: number, owned: Allocations,
): number {
  if (shape.IsNull() || countSolidShapes(oc, shape, 2) !== 1 || !isValidShape(oc, shape)) {
    throw refusal(FACE_ROTATION_FAILED_MESSAGE, { stage: 'result-validity' });
  }
  const after = readBox(oc, shape, owned, FACE_ROTATION_FAILED_MESSAGE);
  const lift = frame.width * frame.sign * Math.tan(angle);
  const expectedVertices = corners(frame).map(entry =>
    entry.far && entry.onFace ? addScaled(entry.point, frame.n, lift) : entry.point);
  const vertices = matchPoints(expectedVertices, after.vertices, RESULT_TOLERANCE_MM);
  const { n, m, h } = frame;
  const rotated = addScaled(addScaled([0, 0, 0], n, Math.cos(angle)), cross(h, n), Math.sin(angle));
  const hingeEnd = addScaled(frame.start, h, frame.length);
  const hingeKept = after.edges.filter(edge =>
    (separation(edge.start, frame.start) <= RESULT_TOLERANCE_MM && separation(edge.end, hingeEnd) <= RESULT_TOLERANCE_MM)
    || (separation(edge.start, hingeEnd) <= RESULT_TOLERANCE_MM && separation(edge.end, frame.start) <= RESULT_TOLERANCE_MM));
  if (!vertices.ok || hingeKept.length !== 1
    || !matchNormals(after.faces, [rotated, negate(n), m, negate(m), h, negate(h)])) {
    throw refusal(FACE_ROTATION_FAILED_MESSAGE, { stage: 'result-geometry', worstVertex: vertices.worst,
      hingeEdges: hingeKept.length });
  }
  const volume = measureVolume(oc, shape, true);
  const expected = frame.length * frame.width * (frame.height + lift / 2);
  if (!(Math.abs(volume - expected) <= expected * VOLUME_RELATIVE_TOLERANCE)) {
    throw refusal(FACE_ROTATION_FAILED_MESSAGE, { stage: 'result-volume', volume, expected });
  }
  return volume;
}

/**
 * 平らな面 `planarFace` を、その縁の直線の辺 `hingeEdge` のまわりに `angleRad`(ラジアン。符号は
 * 上の規約)だけ回した新しい立体を返す。**`solid`・`planarFace`・`hingeEdge` は解放も変更もしない。**
 * 断るときは日本語の Error を投げ、途中で作ったものはすべて解放する。結果は呼び出し側が delete() する。
 */
export function rotateSolidFace(
  oc: OpenCascadeInstance,
  solid: TopoDS_Shape,
  planarFace: TopoDS_Face,
  hingeEdge: TopoDS_Edge,
  angleRad: number,
): FaceRotationResult {
  if (!Number.isFinite(angleRad) || angleRad === 0 || Math.abs(angleRad) >= Math.PI / 2) {
    throw new Error(FACE_ROTATION_ANGLE_MESSAGE);
  }
  const owned = createAllocations(), { keep } = owned;
  try {
    if (solid.IsNull() || countSolidShapes(oc, solid, 2) !== 1 || !isValidShape(oc, solid)) {
      throw new Error(FACE_ROTATION_INVALID_BODY_MESSAGE);
    }
    // 借用の 3 つは一覧で引くだけ(IsSame の照合。向きは見ない)。builder へは渡さない。
    if (planarFace.IsNull() || planarFace.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE
      || shapesOf(oc, solid, 'FACE', owned).FindIndex(planarFace) < 1) {
      throw new Error(FACE_ROTATION_FOREIGN_FACE_MESSAGE);
    }
    if (hingeEdge.IsNull() || hingeEdge.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE
      || shapesOf(oc, solid, 'EDGE', owned).FindIndex(hingeEdge) < 1) {
      throw new Error(FACE_ROTATION_FOREIGN_EDGE_MESSAGE);
    }
    if (shapesOf(oc, planarFace, 'EDGE', owned).FindIndex(hingeEdge) < 1) {
      throw new Error(FACE_ROTATION_EDGE_NOT_ON_FACE_MESSAGE);
    }

    // 以降は全体の深い複製の上だけで読む・作る。ModifiedShape は複製側の同じ部分形状を指すが
    // 立体の中での向きを持たないので、複製の一覧から向き付きで取り直す(moveSolidHole.ts と同じ)。
    const copier = keep(new oc.BRepBuilderAPI_Copy_2(solid, true, false));
    const copied = keep(copier.Shape());
    const copiedFaces = shapesOf(oc, copied, 'FACE', owned), copiedEdges = shapesOf(oc, copied, 'EDGE', owned);
    const facePosition = copiedFaces.FindIndex(keep(copier.ModifiedShape(planarFace)));
    const edgePosition = copiedEdges.FindIndex(keep(copier.ModifiedShape(hingeEdge)));
    if (facePosition < 1 || edgePosition < 1) {
      throw refusal(FACE_ROTATION_FAILED_MESSAGE, { stage: 'copy', facePosition, edgePosition });
    }
    const face = keep(oc.TopoDS.Face_1(keep(copiedFaces.FindKey(facePosition))));
    const edge = keep(oc.TopoDS.Edge_1(keep(copiedEdges.FindKey(edgePosition))));
    if (readPlanarFace(oc, face, owned) === null) throw new Error(FACE_ROTATION_NOT_PLANAR_MESSAGE);
    const hinge = readLineEdge(oc, edge, owned);
    if (hinge === null) throw new Error(FACE_ROTATION_CURVED_EDGE_MESSAGE);

    const box = readBox(oc, copied, owned, FACE_ROTATION_BOX_MESSAGE);
    const selected = box.faces.find(record => record.face.IsSame(face));
    const sharing = box.faces.filter(record => record.edges.Contains(edge));
    const neutral = sharing.find(record => !record.face.IsSame(face));
    if (selected === undefined || neutral === undefined || sharing.length !== 2) {
      throw refusal(FACE_ROTATION_BOX_MESSAGE, { stage: 'neutral', sharing: sharing.length });
    }
    const frame = hingeFrame(oc, copied, box, selected, neutral, hinge);
    const lift = frame.width * frame.sign * Math.tan(angleRad);
    if (!(Math.abs(lift) >= MIN_EDGE_TRAVEL_MM)) throw new Error(FACE_ROTATION_ANGLE_MESSAGE);
    if (!(frame.height + lift > MIN_REMAINING_HEIGHT_MM)) throw new Error(FACE_ROTATION_COLLISION_MESSAGE);

    // 正の DraftAngle は、中立面から見て抜き方向の逆側(材料の側)で面を外へ広げる(makeDraft.ts の実測)。
    // 抜き方向 = m のとき、蝶番から奥へ d の位置の面は n の向きへ d·tan(角) 動くので、角 = θ·s。
    const pull = keep(new oc.gp_Dir_4(frame.m[0], frame.m[1], frame.m[2]));
    const draft = keep(new oc.BRepOffsetAPI_DraftAngle_2(copied));
    draft.Add(selected.face, pull, frame.sign * angleRad, neutral.plane, true);
    if (!draft.AddDone()) throw refusal(FACE_ROTATION_FAILED_MESSAGE, { stage: 'draft-add' });
    draft.Build(keep(new oc.Message_ProgressRange_1()));
    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ(makeDraft.ts と同じ)。
    if (!draft.IsDone()) throw refusal(FACE_ROTATION_FAILED_MESSAGE, { stage: 'draft-build' });
    const shape = keep(draft.Shape());
    const volume = checkResult(oc, shape, frame, angleRad, owned);
    return { shape, volume, delete: owned.release };
  } catch (error) {
    owned.release();
    // embind 越しの C++ 例外は数値で届くので、利用者へ見せる日本語へ揃える。
    throw error instanceof Error ? error : new Error(FACE_ROTATION_FAILED_MESSAGE);
  }
}
