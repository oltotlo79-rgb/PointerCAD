import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { SubShapeQuery, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import type { BooleanResult } from './booleanOp.js';
import { resolveFaceReference } from './matchSubShape.js';
import { OPEN_FACES_NOT_SUPPORTED, shapeBodyKind } from './shapeBodyKind.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, faceAt } from './subShapes.js';

/**
 * 平らな面の移動(EX-18 の限られた一段)。立体の平らな面 1 枚を、その外向き法線の向きへ
 * 符号付きの距離だけ平行に動かす。正は材料を足し、負は削る。
 *
 * **この段が扱うのは「隣の面がすべて動かす面に直角な形」だけ**(板の端面・上面など)。
 * 導入済みの opencascade.js(full 版)には面ごとに距離を与える `BRepOffset_MakeOffset` /
 * `SetOffsetOnFace` が無い(opencascade.full.d.ts で確認)。そこで面そのものを法線の向きへ
 * 押し出した板を足す / 引き、同じ平面の面を 1 枚へまとめる。隣の面が斜め・曲面だと
 * 板の側面がその面とつながらないので、作る前に隣の幾何を確かめて断る。
 *
 * **全体の移動や、書き出し・読み直しで代用しない。** 結果は次をすべて満たすときだけ返す。
 *   - 立体 1 つで、B-rep として妥当。
 *   - 体積 = 元の体積 + 距離 × 面の面積(板がほかの形〔穴・突起〕に当たると合わない)。
 *   - 面の枚数が元と同じ。
 *   - 動かした面が、元の面と同じ面積で、重心が法線の向きへ距離だけ動いた位置にある。
 *   - 動かす面にも隣の面にも当たらない面(関係のない穴など)は、種類・面積・重心・半径が元のまま。
 * 1 つでも外れたら日本語の理由で断る。**引数の `target` は解放も変更もしない**
 * (makeDraft.ts / booleanOp.ts と同じ約束)。断ったときに元の立体が残るのはこのため。
 *
 * 状態: 候補(未実行)。呼び出しの組み合わせは probe/probe-face-offset.mjs の Root の実測で確定する。
 */

/** これ未満の距離(mm)は「動かさない」とみなして断る。 */
export const MIN_FACE_OFFSET_MM = 1e-6;

/** 直角・平行の判定の許容(内積・外積の大きさ)。平面・円柱の軸は gp_Dir で長さ 1。 */
const ANGULAR_TOLERANCE = 1e-9;

/** 長さの許容(mm)。重心の一致に使う。 */
const LINEAR_TOLERANCE_MM = 1e-6;

/** 面積・体積の相対許容。解析的な平面と円柱だけなので、積分の誤差はこれより十分小さい。 */
const RELATIVE_TOLERANCE = 1e-7;

export const FACE_OFFSET_DISTANCE_MESSAGE = '面を動かす距離は 0 でない数で指定してください。';
export const FACE_OFFSET_MISSING_FACE_MESSAGE =
  '動かす面が見つかりません。形が変わったため、面を選び直してください。';
export const FACE_OFFSET_NOT_PLANAR_MESSAGE = '動かせるのは平らな面だけです。';
export const FACE_OFFSET_INVALID_BODY_MESSAGE =
  '元の立体の形が正しくないため、面を動かせません。元の立体を直してください。';
export const FACE_OFFSET_ADJACENT_MESSAGE =
  'この面の隣に、面に直角でない面があるため動かせません。隣の面が直角な平らな面だけ動かせます。';
export const FACE_OFFSET_COLLISION_MESSAGE =
  '面を動かすと、ほかの形(穴や出っ張りなど)に当たるため動かせません。距離を見直してください。';
export const FACE_OFFSET_FAILED_MESSAGE = '面を動かせませんでした。距離を見直してください。';

/** 面の移動 1 段の依頼。 */
export interface FaceOffsetInput {
  /** 動かす平らな面の指紋(保存された参照)。 */
  readonly face: SubShapeQuery;
  /** 符号付きの距離(mm)。正で外向き(材料を足す)、負で内向き(削る)。 */
  readonly offset: number;
}

/** 面の素性の比較用。保存しない。 */
interface FaceSignature {
  readonly kind: 'plane' | 'cylinder' | 'other';
  readonly area: number;
  readonly centroid: Vec3Tuple;
  /** 平面は材料の外向き法線、円柱は軸の向き(符号は問わない)。 */
  readonly direction: Vec3Tuple | null;
  readonly radius: number | null;
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossLength(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function nearlyEqual(a: number, b: number, scale: number): boolean {
  return Math.abs(a - b) <= Math.max(LINEAR_TOLERANCE_MM, Math.abs(scale) * RELATIVE_TOLERANCE);
}

/** 面 1 枚の素性を読む。平面の法線は面の向き(REVERSED)を見て材料の外へ向ける(makeDraft.ts と同じ規則)。 */
function readSignature(oc: OpenCascadeInstance, face: TopoDS_Face, keep: Allocations['keep']): FaceSignature {
  const props = keep(new oc.GProp_GProps_1());
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const centre = keep(props.CentreOfMass());
  const area = props.Mass();
  const centroid: Vec3Tuple = [centre.X(), centre.Y(), centre.Z()];
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const type = adaptor.GetType();
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
    const plane = keep(adaptor.Plane());
    const axis = keep(plane.Axis());
    const normal = keep(axis.Direction());
    const sign = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
    return { kind: 'plane', area, centroid,
      direction: [normal.X() * sign, normal.Y() * sign, normal.Z() * sign], radius: null };
  }
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    const cylinder = keep(adaptor.Cylinder());
    const axis = keep(cylinder.Axis());
    const along = keep(axis.Direction());
    return { kind: 'cylinder', area, centroid, direction: [along.X(), along.Y(), along.Z()],
      radius: cylinder.Radius() };
  }
  return { kind: 'other', area, centroid, direction: null, radius: null };
}

/** 形のすべての面の素性を TopExp.MapShapes の順で読む。 */
function readAllSignatures(oc: OpenCascadeInstance, shape: TopoDS_Shape): readonly FaceSignature[] {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    // 列挙の各値は型定義では空の型 `{}` で引数へ渡せないので、文字列から引く(functionSurfaceBounds.ts と同じ)。
    oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), map);
    const out: FaceSignature[] = [];
    for (let position = 1; position <= map.Size(); position += 1) {
      const face = keep(oc.TopoDS.Face_1(keep(map.FindKey(position))));
      out.push(readSignature(oc, face, keep));
    }
    return out;
  } finally {
    release();
  }
}

/** 動かす面の、`readAllSignatures` と同じ並び(MapShapes_1 の面)での番号と、隣の面の番号。 */
interface FaceNeighbourhood {
  readonly position: number;
  readonly adjacent: readonly number[];
}

/**
 * 動かす面の番号と、辺を共有する面の番号(重複なし・昇順)を、同じ MapShapes_1 の並びで返す。
 * `tables` の番号(MapShapes_2 の並び)とは並べ方の出どころが違うので、比較用の素性は必ずこちらの
 * 番号で引く。面が見つからない、または隣の無い辺(閉じていない縁)があれば null。
 * 一覧の巡回は subShapeHistory.ts の readList と同じく、写しを作って先頭から外していく
 * (この版には TopTools_ListIteratorOfListOfShape と FindFromKey の束縛が無い)。
 */
function faceNeighbourhood(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  face: TopoDS_Face,
): FaceNeighbourhood | null {
  const { keep, release } = createAllocations();
  try {
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
    const position = faces.FindIndex(face) - 1;
    if (position < 0) return null;
    const ancestors = keep(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      shape, oc.TopAbs.ShapeTypeFromString_1('EDGE'), oc.TopAbs.ShapeTypeFromString_1('FACE'), ancestors);
    const edges = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(face, oc.TopAbs.ShapeTypeFromString_1('EDGE'), edges);
    const found = new Set<number>();
    for (let edgePosition = 1; edgePosition <= edges.Size(); edgePosition += 1) {
      const edge = keep(edges.FindKey(edgePosition));
      const ancestorIndex = ancestors.FindIndex(edge);
      if (ancestorIndex < 1) return null;
      const owners = keep(new oc.TopTools_ListOfShape_3(keep(ancestors.FindFromIndex(ancestorIndex))));
      let other = false;
      while (owners.Size() > 0) {
        const owner = keep(owners.First_1());
        owners.RemoveFirst();
        if (owner.IsSame(face)) continue;
        const index = faces.FindIndex(owner);
        if (index > 0) {
          found.add(index - 1);
          other = true;
        }
      }
      if (!other) return null;
    }
    return { position, adjacent: [...found].sort((left, right) => left - right) };
  } finally {
    release();
  }
}

/**
 * 隣の面が「板の側面とつながる」幾何かを確かめる。平面は法線が動かす向きに直角、
 * 円柱は軸が動かす向きに平行(穴や角の丸みが面を貫く場合)。それ以外は断る。
 * 面の枚数が同じでも、斜めの隣の面では面の移動の意味(隣の面を延ばす / 縮める)が成り立たない。
 */
function assertOrthogonalNeighbours(signatures: readonly FaceSignature[], adjacent: readonly number[], normal: Vec3Tuple): void {
  for (const index of adjacent) {
    const neighbour = signatures[index];
    if (neighbour === undefined || neighbour.direction === null) throw new Error(FACE_OFFSET_ADJACENT_MESSAGE);
    const ok = neighbour.kind === 'plane'
      ? Math.abs(dot(neighbour.direction, normal)) <= ANGULAR_TOLERANCE
      : neighbour.kind === 'cylinder' && crossLength(neighbour.direction, normal) <= ANGULAR_TOLERANCE;
    if (!ok) throw new Error(FACE_OFFSET_ADJACENT_MESSAGE);
  }
}

function sameSignature(left: FaceSignature, right: FaceSignature): boolean {
  if (left.kind !== right.kind) return false;
  if (!nearlyEqual(left.area, right.area, left.area)) return false;
  if (distance(left.centroid, right.centroid) > LINEAR_TOLERANCE_MM) return false;
  if ((left.radius === null) !== (right.radius === null)) return false;
  if (left.radius !== null && right.radius !== null && !nearlyEqual(left.radius, right.radius, left.radius)) return false;
  if (left.direction === null || right.direction === null) return left.direction === right.direction;
  return left.kind === 'plane'
    ? dot(left.direction, right.direction) >= 1 - ANGULAR_TOLERANCE
    : crossLength(left.direction, right.direction) <= ANGULAR_TOLERANCE;
}

/** 同じ平面を 1 枚へまとめる(unifySheetFlat.ts と同じ設定)。結果は keep 済み。 */
function unifyPlanes(oc: OpenCascadeInstance, shape: TopoDS_Shape, keep: Allocations['keep']): TopoDS_Shape {
  const maker = keep(new oc.ShapeUpgrade_UnifySameDomain_1());
  maker.SetSafeInputMode(true);
  maker.Initialize(shape, true, true, false);
  maker.SetLinearTolerance(1e-7);
  maker.SetAngularTolerance(1e-10);
  maker.AllowInternalEdges(false);
  maker.Build();
  return keep(maker.Shape());
}

/** 例外(embind 越しの数値を含む)を日本語へ揃える。自分で投げた Error はそのまま通す。 */
function toJapaneseFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error(FACE_OFFSET_FAILED_MESSAGE);
}

/** 面の移動の結果。体積は判定のために測ったもの(BooleanResult と同じ流儀)。 */
export type FaceOffsetResult = BooleanResult;

/**
 * 平らな面を符号付きの距離だけ動かす。**`target` は解放も変更もしない。**
 * 断るときは日本語の Error を投げ、途中で作ったものはすべて解放する。
 */
export function editSolidFace(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: FaceOffsetInput,
): FaceOffsetResult {
  if (!Number.isFinite(input.offset) || Math.abs(input.offset) < MIN_FACE_OFFSET_MM) {
    throw new Error(FACE_OFFSET_DISTANCE_MESSAGE);
  }
  if (target.IsNull() || shapeBodyKind(oc, target) !== 'solid') throw new Error(OPEN_FACES_NOT_SUPPORTED);
  if (countSolidShapes(oc, target, 2) !== 1 || !isValidShape(oc, target)) {
    throw new Error(FACE_OFFSET_INVALID_BODY_MESSAGE);
  }
  if (input.face.kind !== 'face') throw new Error(FACE_OFFSET_MISSING_FACE_MESSAGE);
  const scale = boundingDiagonal(oc, target) * 0.5;
  const match = resolveFaceReference(tables.faces, input.face, scale, tables.origins);
  if (match.status !== 'matched') throw new Error(FACE_OFFSET_MISSING_FACE_MESSAGE);
  const faceIndex = match.match.index;
  const info = tables.faces.find((candidate) => candidate.index === faceIndex);
  if (info === undefined) throw new Error(FACE_OFFSET_MISSING_FACE_MESSAGE);
  if (info.surfaceKind !== 'plane') throw new Error(FACE_OFFSET_NOT_PLANAR_MESSAGE);

  const owned = createAllocations();
  let combined: BooleanResult | undefined;
  const releaseAll = (): void => {
    owned.release();
    combined?.delete();
  };
  try {
    // 面だけの複製では、後続処理が共有する辺・下地の幾何への更新を防ぎ切れない。
    // 借用した target 全体を幾何ごと複製し、以降の処理を複製側に閉じる。
    // Copy と Shape() は、成功時も例外時も owned で逆順に解放する。
    const copy = owned.keep(new oc.BRepBuilderAPI_Copy_2(target, true, false));
    const copiedTarget = owned.keep(copy.Shape());
    const face = faceAt(oc, copiedTarget, faceIndex);
    if (face === null) throw new Error(FACE_OFFSET_MISSING_FACE_MESSAGE);
    owned.keep(face);

    const neighbourhood = faceNeighbourhood(oc, copiedTarget, face);
    if (neighbourhood === null) throw new Error(FACE_OFFSET_INVALID_BODY_MESSAGE);
    const { position, adjacent } = neighbourhood;
    const before = readAllSignatures(oc, copiedTarget);
    const moved = before[position];
    if (moved === undefined || moved.kind !== 'plane' || moved.direction === null) {
      throw new Error(FACE_OFFSET_NOT_PLANAR_MESSAGE);
    }
    // 指紋の一覧(tables)と実体の面が同じ面を指すことを面積で確かめる(別の形の一覧を渡された合図)。
    if (!nearlyEqual(moved.area, info.area, info.area)) throw new Error(FACE_OFFSET_MISSING_FACE_MESSAGE);
    const normal = moved.direction;
    assertOrthogonalNeighbours(before, adjacent, normal);

    const offset = input.offset;
    const volumeBefore = measureVolume(oc, copiedTarget);
    const expectedVolume = volumeBefore + offset * moved.area;
    if (!(expectedVolume > 0)) throw new Error(FACE_OFFSET_COLLISION_MESSAGE);

    const vector = owned.keep(new oc.gp_Vec_4(normal[0] * offset, normal[1] * offset, normal[2] * offset));
    const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(face, vector, false, true));
    if (!prism.IsDone()) throw new Error(FACE_OFFSET_FAILED_MESSAGE);
    const slab = owned.keep(prism.Shape());
    // 板の体積は |距離| × 面積。向きが裏返った板(負の体積)は和・差に渡さない。
    if (!nearlyEqual(measureVolume(oc, slab), Math.abs(offset) * moved.area, Math.abs(offset) * moved.area)) {
      throw new Error(FACE_OFFSET_FAILED_MESSAGE);
    }

    combined = offset > 0
      ? booleanOp(oc, 'union', copiedTarget, slab)
      : booleanOp(oc, 'subtract', copiedTarget, slab, undefined, undefined, { requireRemoval: true });
    const shape = unifyPlanes(oc, combined.shape, owned.keep);
    if (shape.IsNull() || countSolidShapes(oc, shape, 2) !== 1 || !isValidShape(oc, shape)) {
      throw new Error(FACE_OFFSET_FAILED_MESSAGE);
    }
    const volume = measureVolume(oc, shape);
    if (!nearlyEqual(volume, expectedVolume, Math.max(volumeBefore, Math.abs(offset) * moved.area))) {
      throw new Error(FACE_OFFSET_COLLISION_MESSAGE);
    }

    const after = readAllSignatures(oc, shape);
    if (after.length !== before.length) throw new Error(FACE_OFFSET_COLLISION_MESSAGE);
    const movedExpected: FaceSignature = {
      ...moved,
      centroid: [
        moved.centroid[0] + normal[0] * offset,
        moved.centroid[1] + normal[1] * offset,
        moved.centroid[2] + normal[2] * offset,
      ],
    };
    if (!after.some((candidate) => sameSignature(candidate, movedExpected))) {
      throw new Error(FACE_OFFSET_FAILED_MESSAGE);
    }
    const touched = new Set<number>([position, ...adjacent]);
    for (const [index, signature] of before.entries()) {
      if (touched.has(index)) continue;
      if (!after.some((candidate) => sameSignature(candidate, signature))) {
        throw new Error(FACE_OFFSET_COLLISION_MESSAGE);
      }
    }

    return { shape, volume, delete: releaseAll };
  } catch (error) {
    releaseAll();
    throw toJapaneseFailure(error);
  }
}
