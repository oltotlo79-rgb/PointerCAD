import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, TessellationOptions, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeOffsetWire } from './makeOffsetWire.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { measureVolume } from './solidMesh.js';

/**
 * 薄板押し出し(FR-416。計画書 P5 §2.12・§0.a-0.46、タスク53)。
 *
 * 輪郭を「線」ではなく「厚みのある壁」と見なして押し出す。閉じた輪郭なら
 * **中身の詰まった柱ではなく、壁だけの筒**になり、開いた輪郭なら 1 枚の薄い板になる。
 *
 * **作り方(3 段):**
 *   ① 輪郭を厚みぶんオフセットして、壁の**内側の境界**と**外側の境界**を作る
 *      (`makeOffsetWire`。P4 で作った FR-321 の道具をそのまま使い、
 *       同じ手順を 2 か所に書かない)。
 *   ② 2 本の境界から、押し出す断面を作る。
 *      - 閉じた輪郭: 境界それぞれから面を張って押し出し、**大きいほうから小さいほうを引く**。
 *      - 開いた輪郭: 2 本の境界の端どうしを線分でつないで 1 本の閉じた輪郭にし、面を張る。
 *   ③ 断面を `direction` へ `distance` だけ押し出す。
 *
 * **リブ(`makeRib.ts`)の帯の作り方は使えない。** リブは輪郭の**平面の法線**へ厚みを付けて
 * 帯を作り、その帯を平面の中の向きへ伸ばす。薄板押し出しは逆で、厚みが輪郭の**平面の中**、
 * 伸ばす向きが平面の法線である。円弧を含む輪郭では厚みの向きが場所ごとに変わるため、
 * リブのような平行移動+押し出しでは作れず、平面上のオフセットが要る(だから①を使う)。
 *
 * **2026-09-05 に Node で実測したこと:**
 *   - 閉じた輪郭を押し出した「筒(面だけの形)」を `MakeThickSolidByJoin` で厚み付けしても
 *     立体にならない(ソリッドが 0 個のまま面がずれるだけ)。だから②の差を取る手順が要る。
 *   - `BRepOffsetAPI_MakeOffset` の符号は**輪郭の並び順(時計回り/反時計回り)によらず**、
 *     正が外側・負が内側になった(40×30 の矩形を両方の並びで試し、+2 で面積 1492.566、
 *     −2 で 936 = 36×26)。それでも**この関数は符号に頼らず、2 つの境界から作った立体の
 *     体積を比べて大きいほうから小さいほうを引く**(向きの取り違えで穴と柱が入れ替わらない)。
 */

/** 「厚みが出た」とみなす体積の下限(mm³)。makeSolidSweep.ts と同じ考え方。 */
const MIN_SOLID_VOLUME = 1e-9;

/** 厚みの付け方。 */
export type ThinExtrudeSide =
  /** 輪郭を壁の外側の境界にする(材料は輪郭の内側へ付く)。 */
  | 'inner'
  /** 輪郭を壁の内側の境界にする(材料は輪郭の外側へ付く)。 */
  | 'outer'
  /** 輪郭を壁の中心にして、両側へ半分ずつ付ける。 */
  | 'both';

/** 薄板押し出し 1 段の依頼(計画書 §2.12)。 */
export interface ThinExtrudeInput {
  /** 輪郭。閉じていても開いていてもよい。並んだ順につながっていること。 */
  readonly profile: readonly CurveSpec[];
  /** 押し出す向き(輪郭の平面の法線)。 */
  readonly direction: Vec3Tuple;
  /** 押し出す長さ(mm)。 */
  readonly distance: number;
  /** 壁の厚み(mm)。 */
  readonly thickness: number;
  /** 厚みをどちら側へ付けるか。 */
  readonly side: ThinExtrudeSide;
}

/** 輪郭が 1 本も選ばれていないとき。 */
const NO_PROFILE_MESSAGE = '薄い板にする輪郭が選ばれていません。';

/** 厚みが 0 以下・非数のとき(makeRib.ts と同じ文言に揃える)。 */
const THICKNESS_MESSAGE = '厚みは 0 より大きい数にしてください。';

/** 押し出す長さが 0 以下・非数のとき(makeSolidSweep.ts と同じ文言)。 */
const DISTANCE_MESSAGE = '押し出す長さは 0 より大きい数にしてください。';

/** 押し出す向きが決まらないとき(makeSolidSweep.ts と同じ文言)。 */
const NO_DIRECTION_MESSAGE = '押し出す向きが決まりません。断面が平らかどうかを確かめてください。';

/** 輪郭がつながっていないとき(makePlanarFace / makeOffsetWire と同じ文言)。 */
const NOT_CONNECTED_MESSAGE = '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。';

/** 開いた輪郭の厚みが 2 本以上に分かれたとき。 */
const SPLIT_CONTOUR_MESSAGE =
  '厚みを付けた輪郭が分かれてしまい、薄い板にできませんでした。厚みを小さくしてください。';

/** 押し出しても厚みが出なかったとき。 */
const NO_THICKNESS_MESSAGE = '薄い板に厚みが出ませんでした。厚みと長さを見直してください。';

/** 厚みを付けた結果が立体にならなかったとき。 */
const NOT_SOLID_MESSAGE = '薄い板を作れませんでした。厚みを小さくしてください。';

/** 向きを長さ 1 に揃える。長さが 0 のときや数でないときは null を返す。 */
function normalizeDirection(vector: Vec3Tuple): Vec3Tuple | null {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [x / length, y / length, z / length];
}

/**
 * 壁の 2 つの境界を作るオフセットの距離(mm)。並びは「片方」「もう片方」で、
 * どちらが内側かはここでは決めない(体積を比べて決める。上の注釈)。
 */
function boundaryDistances(side: ThinExtrudeSide, thickness: number): readonly [number, number] {
  if (side === 'inner') {
    return [-thickness, 0];
  }
  if (side === 'outer') {
    return [0, thickness];
  }
  return [-thickness / 2, thickness / 2];
}

/** 外積(a × b)。輪郭の平面の中で厚みを付ける向きを出すのに使う。 */
function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * 線分 1 本だけの輪郭を、平面の中で距離ぶん平行移動した線分を作る。
 *
 * **なぜ特別扱いが要るか(2026-09-05 に Node で実測):** `BRepOffsetAPI_MakeOffset` は
 * 輪郭の平面を自分で探すので、**線分 1 本の輪郭では平面が決まらず、距離の正負に関わらず
 * `IsDone()` が偽になった**(線分 2 本・円弧 1 本・折れ線ではどちらの符号でも成功する)。
 * 薄板押し出しでは押し出す向き `direction` が平面の法線そのものなので、この場合だけは
 * 自分で向きを出せる。ずらす向きは `direction × 輪郭の進む向き`(右手系)で、
 * 正の距離がその側になる。
 */
function offsetSingleSegment(
  segment: Extract<CurveSpec, { kind: 'segment' }>,
  direction: Vec3Tuple,
  distance: number,
): CurveSpec {
  const tangent: Vec3Tuple = [
    segment.to[0] - segment.from[0],
    segment.to[1] - segment.from[1],
    segment.to[2] - segment.from[2],
  ];
  const sideways = normalizeDirection(cross(direction, tangent));
  if (sideways === null) {
    // 線分が押し出す向きと平行で、平面の中に厚みを付ける余地が無い。
    throw new Error(NO_DIRECTION_MESSAGE);
  }
  const shift: Vec3Tuple = [
    sideways[0] * distance,
    sideways[1] * distance,
    sideways[2] * distance,
  ];
  return {
    kind: 'segment',
    from: [segment.from[0] + shift[0], segment.from[1] + shift[1], segment.from[2] + shift[2]],
    to: [segment.to[0] + shift[0], segment.to[1] + shift[1], segment.to[2] + shift[2]],
  };
}

/**
 * 距離 1 つぶんの境界を、輪郭 1 本以上として求める。
 *
 * 距離 0 のときは元の輪郭そのものなので、オフセットを呼ばない
 * (呼ぶと線分・円弧しか返せない制約が効いてしまい、楕円やスプラインの輪郭が使えなくなる)。
 */
function boundaryContours(
  oc: OpenCascadeInstance,
  profile: readonly CurveSpec[],
  direction: Vec3Tuple,
  distance: number,
): readonly (readonly CurveSpec[])[] {
  if (distance === 0) {
    return [profile];
  }
  const only = profile.length === 1 ? profile[0] : null;
  if (only !== null && only.kind === 'segment') {
    return [[offsetSingleSegment(only, direction, distance)]];
  }
  // オフセットが作れないとき(内側へ寄せすぎて輪郭が消えるとき等)の断りの文言は
  // makeOffsetWire.ts が用意しているものをそのまま利用者へ見せる。
  return makeOffsetWire(oc, { curves: profile, distance, joinType: 'arc' }).map(
    (contour) => contour.curves,
  );
}

/** 輪郭の両端の点(mm)。開いた輪郭のつなぎ目を作るのに使う。 */
interface ContourEnds {
  readonly start: Vec3Tuple;
  readonly end: Vec3Tuple;
}

/**
 * 輪郭の始点と終点を OCCT に聞く。
 *
 * 曲線の種類ごとに端点の式を書き分けると、線分・円弧・楕円・スプラインで 4 通りになり
 * 取り違えの種になる。`makeCurveEdge` が作った辺の径数の端(`FirstParameter` /
 * `LastParameter`)を読めば、どの種類でも同じ 1 通りで済む。
 */
function contourEnds(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  curves: readonly CurveSpec[],
): ContourEnds {
  const first = keep(makeCurveEdge(oc, curves[0]));
  const last = keep(makeCurveEdge(oc, curves[curves.length - 1]));
  const firstCurve = keep(new oc.BRepAdaptor_Curve_2(first.edge));
  const lastCurve = keep(new oc.BRepAdaptor_Curve_2(last.edge));
  const startPoint = keep(firstCurve.Value(firstCurve.FirstParameter()));
  const endPoint = keep(lastCurve.Value(lastCurve.LastParameter()));
  return {
    start: [startPoint.X(), startPoint.Y(), startPoint.Z()],
    end: [endPoint.X(), endPoint.Y(), endPoint.Z()],
  };
}

/** 2 点の距離(mm)。 */
function pointDistance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 開いた輪郭の 2 つの境界を、1 本の閉じた輪郭へつなぐ。
 *
 * 片方を始点 → 終点にたどり、そこから**近いほうの端**へ線分で渡り、もう片方を逆向きにたどって、
 * 最後に始点へ戻る線分で閉じる。近いほうを選ぶのは、2 本の境界は厚みぶんしか離れていないのに対し、
 * 反対の端までは輪郭の長さぶん離れているため(取り違えると輪郭が交差して面が張れない)。
 *
 * **曲線の向きは直さなくてよい。** `BRepBuilderAPI_MakeWire` は足した稜線の向きを自分で
 * 揃えるので、並び順だけを保証すればよい(`makePlanarFace.ts` の注釈)。
 */
function joinOpenBoundaries(
  first: readonly CurveSpec[],
  firstEnds: ContourEnds,
  second: readonly CurveSpec[],
  secondEnds: ContourEnds,
): readonly CurveSpec[] {
  const towardsStart =
    pointDistance(firstEnds.end, secondEnds.start) <= pointDistance(firstEnds.end, secondEnds.end);
  const bridgeTo = towardsStart ? secondEnds.start : secondEnds.end;
  const bridgeBack = towardsStart ? secondEnds.end : secondEnds.start;
  const secondOrder = towardsStart ? second : [...second].reverse();

  return [
    ...first,
    { kind: 'segment', from: firstEnds.end, to: bridgeTo },
    ...secondOrder,
    { kind: 'segment', from: bridgeBack, to: firstEnds.start },
  ];
}

/** 面を向きへ長さ length だけ押し出す。 */
function extrudeFace(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  face: TopoDS_Shape,
  direction: Vec3Tuple,
  length: number,
): TopoDS_Shape {
  const vector = keep(
    new oc.gp_Vec_4(direction[0] * length, direction[1] * length, direction[2] * length),
  );
  // 第 3・4 引数は Copy / Canonize。makeSolidSweep.ts で実測ずみの決めに合わせる。
  const maker = keep(new oc.BRepPrimAPI_MakePrism_1(face, vector, false, true));
  if (!maker.IsDone()) {
    throw new Error(NO_THICKNESS_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * 境界 1 組(1 本以上の閉じた輪郭)から、押し出した立体を 1 つ作る。
 * 輪郭が 2 本以上に分かれているとき(内側へ寄せて輪が割れたとき)は、和を取って 1 つにまとめる。
 */
function extrudeContours(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  contours: readonly (readonly CurveSpec[])[],
  direction: Vec3Tuple,
  distance: number,
  options: TessellationOptions,
): TopoDS_Shape {
  let solid: TopoDS_Shape | null = null;
  for (const contour of contours) {
    const face = keep(makePlanarFace(oc, contour, options));
    const prism = extrudeFace(oc, keep, face.face, direction, distance);
    solid = solid === null ? prism : keep(booleanOp(oc, 'union', solid, prism)).shape;
  }
  if (solid === null) {
    throw new Error(NOT_SOLID_MESSAGE);
  }
  return solid;
}

/**
 * 閉じた輪郭の壁を作る。2 つの境界を別々に押し出し、**大きいほうから小さいほうを引く**。
 *
 * どちらが外側かを体積で決めるのは、オフセットの符号がどちら側に働くかを
 * 呼び出し側に約束させないためである(上の注釈の実測)。
 */
function buildClosedWall(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  firstBoundary: readonly (readonly CurveSpec[])[],
  secondBoundary: readonly (readonly CurveSpec[])[],
  direction: Vec3Tuple,
  distance: number,
  options: TessellationOptions,
): TopoDS_Shape {
  const firstSolid = extrudeContours(oc, keep, firstBoundary, direction, distance, options);
  const secondSolid = extrudeContours(oc, keep, secondBoundary, direction, distance, options);
  const firstIsOuter =
    Math.abs(measureVolume(oc, firstSolid)) >= Math.abs(measureVolume(oc, secondSolid));
  const outer = firstIsOuter ? firstSolid : secondSolid;
  const inner = firstIsOuter ? secondSolid : firstSolid;
  return keep(booleanOp(oc, 'subtract', outer, inner)).shape;
}

/**
 * 開いた輪郭の壁を作る。2 つの境界を線分でつないで 1 本の閉じた輪郭にしてから押し出す。
 *
 * 境界が 2 本以上に分かれるのは、輪郭の曲がりに対して厚みが大きすぎるとき。
 * どの端とどの端を結ぶかが決まらないので、理由をつけて断る。
 */
function buildOpenWall(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  firstBoundary: readonly (readonly CurveSpec[])[],
  secondBoundary: readonly (readonly CurveSpec[])[],
  direction: Vec3Tuple,
  distance: number,
  options: TessellationOptions,
): TopoDS_Shape {
  if (firstBoundary.length !== 1 || secondBoundary.length !== 1) {
    throw new Error(SPLIT_CONTOUR_MESSAGE);
  }
  const joined = joinOpenBoundaries(
    firstBoundary[0],
    contourEnds(oc, keep, firstBoundary[0]),
    secondBoundary[0],
    contourEnds(oc, keep, secondBoundary[0]),
  );
  const face = keep(makePlanarFace(oc, joined, options));
  return extrudeFace(oc, keep, face.face, direction, distance);
}

/**
 * 輪郭に厚みを付けて押し出す(FR-416)。**新しい形を返す。**
 *
 * 向きは model 側で決めて渡す約束(計画書 §0.a-0.8)なので、ここでは輪郭の平面を推し量らない。
 * 失敗は必ず日本語の理由を持つ `Error` で返し、アプリを落とさない(NFR-RE-1、FR-504)。
 */
export function makeThinExtrude(
  oc: OpenCascadeInstance,
  input: ThinExtrudeInput,
  options: TessellationOptions = {},
): OcctShapeHandle {
  if (input.profile.length === 0) {
    throw new Error(NO_PROFILE_MESSAGE);
  }
  if (!Number.isFinite(input.thickness) || input.thickness <= 0) {
    throw new Error(THICKNESS_MESSAGE);
  }
  if (!Number.isFinite(input.distance) || input.distance <= 0) {
    throw new Error(DISTANCE_MESSAGE);
  }

  const direction = normalizeDirection(input.direction);
  if (direction === null) {
    throw new Error(NO_DIRECTION_MESSAGE);
  }

  const { keep, release } = createAllocations();

  try {
    // 輪郭が閉じているかどうかは、組み立てたワイヤ自身に聞く(makeOffsetWire.ts と同じ)。
    const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
    for (const curve of input.profile) {
      wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
    }
    if (!wireMaker.IsDone()) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }
    const closed = keep(wireMaker.Wire()).Closed_1();

    const [firstDistance, secondDistance] = boundaryDistances(input.side, input.thickness);
    const firstBoundary = boundaryContours(oc, input.profile, direction, firstDistance);
    const secondBoundary = boundaryContours(oc, input.profile, direction, secondDistance);

    const shape = closed
      ? buildClosedWall(oc, keep, firstBoundary, secondBoundary, direction, input.distance, options)
      : buildOpenWall(oc, keep, firstBoundary, secondBoundary, direction, input.distance, options);

    if (Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME) {
      throw new Error(NO_THICKNESS_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
