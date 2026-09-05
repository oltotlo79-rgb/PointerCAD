/**
 * 測定と質量特性(FR-1101、FR-1102、計画書 P5 §2.10、タスク28)。
 *
 * ここに置くのは**形を変えない読み取りだけ**で、どの関数も引数の形に触れない
 * (キャッシュの持ち物をそのまま渡せる)。測った値は丸めずにそのまま返し、
 * 桁をどう見せるかは表示側が決める(`rules/04-設計の規律.md` の数値精度)。
 *
 * **単位.** 長さ mm、面積 mm²、体積 mm³、角度は度。質量特性のうち密度を掛けないもの
 * (`measureMassProperties`)の慣性モーメントは体積の 2 次モーメントなので mm⁵ で、
 * 密度(g/cm³)を掛けたもの(`massProperties`)は質量 g・慣性モーメント g·mm² になる
 * (§0.a-0.32 の「質量 g・重心 mm・慣性 g·mm²、密度の入力は g/cm³」)。
 *
 * **慣性モーメントの基準は重心**(§0.a-0.32)。重心を通る主軸まわりの 3 つを返す。
 * 主軸は `GProp_PrincipalProps` が決めた第 1・第 2・第 3 の順で、
 * `principalMoments[i]` は `principalAxes[i]` まわりの値である(並びは形しだいで、
 * 大きい順とは限らない)。
 *
 * **out 引数(C++ の参照渡し)は 1 つも使わない**(計画書 §1.4-12)。
 * `GProp_PrincipalProps.Moments(Ixx, Iyy, Izz)` は JavaScript の数値を値渡しするだけで
 * 書き換えが返らないため、戻り値を返す `GProp_GProps.MomentOfInertia(gp_Ax1)` を
 * 主軸ごとに 3 回呼ぶ(実測は `measureShape.test.ts` の「out 引数」の検査に残してある)。
 *
 * **列挙を引数に取る API も使わない**(§1.4)。距離は `BRepExtrema_DistShapeShape_1()` の
 * 既定構築 + `LoadS1` / `LoadS2` / `Perform` で、面・辺の種類の判定は
 * `BRepAdaptor_Surface_2` / `BRepAdaptor_Curve_2` の `GetType()` の**値どうしの比較**で行う。
 */

import type {
  GProp_GProps,
  OpenCascadeInstance,
  TopoDS_Shape,
  gp_Pnt,
  gp_Vec,
} from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { measureArea } from './solidMesh.js';

/** 2 つの形の最短距離を測れなかったとき(FR-504、NFR-RE-1)。 */
export const DISTANCE_FAILED_MESSAGE = '2 つの形の間の距離を測れませんでした。';

/** 質量特性を測れなかったとき(FR-504、NFR-RE-1)。 */
export const MASS_PROPERTIES_FAILED_MESSAGE = '体積と重心を測れませんでした。';

/**
 * 体積を測るときの OnlyClosed の指定。
 * `solidMesh.ts` の `measureVolume`(`VOLUME_ONLY_CLOSED`)と同じ false で、
 * 閉じ切らなかった形でも 0 ではなく途中までの値が出るようにする
 * (同じ形を 2 通りの指定で測って値が食い違うことが無いように揃えてある)。
 */
const VOLUME_ONLY_CLOSED = false;

/** g/cm³ を g/mm³ へ直す係数(1 cm³ = 1000 mm³)。単位の変換はこの 1 か所だけで行う。 */
export const GRAM_PER_CM3_TO_GRAM_PER_MM3 = 1e-3;

/** 2 つの形の最短距離と、その距離を与える点(FR-1102)。 */
export interface ShapeDistance {
  /** 最短距離(mm)。交わっているときは 0。 */
  readonly distance: number;
  /** 1 つ目の形の上の最近点(mm)。 */
  readonly pointA: Vec3Tuple;
  /** 2 つ目の形の上の最近点(mm)。 */
  readonly pointB: Vec3Tuple;
  /** 一方が他方の内側にある(交わっている)か。OCCT の `InnerSolution()` そのまま。 */
  readonly inner: boolean;
}

/** 密度を掛けない質量特性(FR-1101)。密度に依らない、形そのものの量。 */
export interface ShapeVolumeProperties {
  /** 体積(mm³)。 */
  readonly volume: number;
  /** 表面積(mm²)。 */
  readonly area: number;
  /** 重心(mm)。 */
  readonly centreOfMass: Vec3Tuple;
  /** 重心を通る主軸まわりの体積の 2 次モーメント(mm⁵)。並びは主軸と同じ。 */
  readonly principalMoments: readonly [number, number, number];
  /** 主軸の向き(長さ 1)。第 1・第 2・第 3 の順。 */
  readonly principalAxes: readonly [Vec3Tuple, Vec3Tuple, Vec3Tuple];
}

/** 密度(g/cm³)を掛けた質量特性(FR-1101)。 */
export interface ShapeMassProperties {
  /** 体積(mm³)。 */
  readonly volume: number;
  /** 表面積(mm²)。 */
  readonly area: number;
  /** 質量(g)。 */
  readonly mass: number;
  /** 重心(mm)。密度は一様なので、密度を掛けても重心は動かない。 */
  readonly centreOfMass: Vec3Tuple;
  /** 重心を通る主軸まわりの慣性モーメント(g·mm²)。並びは主軸と同じ。 */
  readonly principalMoments: readonly [number, number, number];
  /** 主軸の向き(長さ 1)。第 1・第 2・第 3 の順。 */
  readonly principalAxes: readonly [Vec3Tuple, Vec3Tuple, Vec3Tuple];
}

/** 点を数値 3 つのタプルへ直す。 */
function pointToTuple(point: gp_Pnt): Vec3Tuple {
  return [point.X(), point.Y(), point.Z()];
}

/** 向きを長さ 1 のタプルへ直す。長さが取れなければ null。 */
function vectorToUnitTuple(vector: gp_Vec): Vec3Tuple | null {
  const x = vector.X();
  const y = vector.Y();
  const z = vector.Z();
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [x / length, y / length, z / length];
}

/**
 * 2 つの形の最短距離と最近点(FR-1102)。
 *
 * 面・辺・頂点・立体のどの組み合わせでも測れる(`BRepExtrema_DistShapeShape` が
 * 種類を見て使い分ける)。交わっている形どうしでは距離 0・`inner` true になる。
 * 測れなかったときは日本語の `Error` を投げ、呼び出し側(`kernelApi.measure`)が
 * 断りの文言へ言い換える(アプリは落とさない。NFR-RE-1)。
 */
export function distanceBetween(
  oc: OpenCascadeInstance,
  shapeA: TopoDS_Shape,
  shapeB: TopoDS_Shape,
): ShapeDistance {
  const { keep, release } = createAllocations();
  try {
    const extrema = keep(new oc.BRepExtrema_DistShapeShape_1());
    extrema.LoadS1(shapeA);
    extrema.LoadS2(shapeB);
    // 進捗の範囲は既定(中止しない)。測定は 1 回が短いので途中で止める口を作らない。
    const range = keep(new oc.Message_ProgressRange_1());
    extrema.Perform(range);
    // 個数を返すメソッドの戻り型 Graphic3d_ZLayerId はどこにも定義が無いので
    // Number() で整数へ直してから比べる(計画書 §1.3)。
    if (!extrema.IsDone() || Number(extrema.NbSolution()) === 0) {
      throw new Error(DISTANCE_FAILED_MESSAGE);
    }
    // 解の番号は 1 始まり。最短の組は 1 番に入る。
    const pointA = pointToTuple(keep(extrema.PointOnShape1(1)));
    const pointB = pointToTuple(keep(extrema.PointOnShape2(1)));
    return { distance: extrema.Value(), pointA, pointB, inner: extrema.InnerSolution() };
  } finally {
    release();
  }
}

/** 辺 1 本の長さ(mm)。FR-1102 の「辺の長さ」。 */
export function edgeLength(oc: OpenCascadeInstance, edge: TopoDS_Shape): number {
  const properties = new oc.GProp_GProps_1();
  try {
    // LinearProperties に番号は付かない(計画書 §1.4-4)。第 3・第 4 引数は
    // SkipShared と UseTriangulation で、subShapes.ts の辺の長さと同じ指定にする
    // (同じ辺を 2 か所で測って値が食い違うことが無いように揃えてある)。
    oc.BRepGProp.LinearProperties(edge, properties, false, false);
    return properties.Mass();
  } finally {
    properties.delete();
  }
}

/**
 * 平らな面の法線、または直線の辺の向き(長さ 1)。求まらなければ null。
 *
 * 面の向き(Orientation)による符号の反転は行わない。なす角は
 * 内積の絶対値から求める(下の `angleBetween`)ので符号が結果を変えないためで、
 * 指紋の軸(`subShapes.ts` の `readFaceGeometry`)とは別の用途である。
 */
function straightDirectionOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  allocations: Allocations,
): Vec3Tuple | null {
  const { keep } = allocations;
  const shapeType = shape.ShapeType();
  const types = oc.TopAbs_ShapeEnum;

  if (shapeType === types.TopAbs_FACE) {
    const face = keep(oc.TopoDS.Face_1(shape));
    // 第 2 引数 false は「面の境界(トリム)を読み込まない」指定(subShapes.ts と同じ)。
    const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
    if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      // 曲面には 1 つの法線が無いので、なす角も決まらない(FR-1102 は面と面のなす角)。
      return null;
    }
    const plane = keep(adaptor.Plane());
    const axis = keep(plane.Axis());
    const direction = keep(axis.Direction());
    return [direction.X(), direction.Y(), direction.Z()];
  }

  if (shapeType === types.TopAbs_EDGE) {
    const edge = keep(oc.TopoDS.Edge_1(shape));
    const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
    if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) {
      // 円弧・スプラインは場所ごとに向きが変わるので、辺どうしのなす角が決まらない。
      return null;
    }
    const line = keep(curve.Line());
    const direction = keep(line.Direction());
    return [direction.X(), direction.Y(), direction.Z()];
  }

  return null;
}

/**
 * 2 つの平らな面、または 2 本の直線の辺のなす角(度、FR-1102)。
 *
 * 求まらない組み合わせ(曲面・曲線・立体)では null を返し、呼び出し側が
 * 「この組み合わせでは角度を測れません」と伝える(投げない。NFR-RE-1)。
 *
 * **0〜90 度で返す。** 面の法線・辺の向きは形の作り方しだいで 180 度反転しうるので、
 * 内積の絶対値から求めて、平行なら 0 度、直交なら 90 度になるようにする
 * (計画書 §2.10.2 の `acos(|n₁·n₂|)`)。**丸めない**ので、直角は浮動小数の
 * 都合で 90.00000000000001 のような値になりうる(桁は表示側が決める)。
 */
export function angleBetween(
  oc: OpenCascadeInstance,
  shapeA: TopoDS_Shape,
  shapeB: TopoDS_Shape,
): number | null {
  const allocations = createAllocations();
  const { release } = allocations;
  try {
    const directionA = straightDirectionOf(oc, shapeA, allocations);
    const directionB = straightDirectionOf(oc, shapeB, allocations);
    if (directionA === null || directionB === null) {
      return null;
    }
    const dot =
      directionA[0] * directionB[0] +
      directionA[1] * directionB[1] +
      directionA[2] * directionB[2];
    // 丸め誤差で |dot| が 1 をわずかに超えると acos が NaN になるので、そこだけ抑える。
    const clamped = Math.min(1, Math.abs(dot));
    return (Math.acos(clamped) * 180) / Math.PI;
  } finally {
    release();
  }
}

/** 主軸 1 本ぶんの向きと、その軸まわりのモーメント。 */
interface AxisMoment {
  readonly axis: Vec3Tuple;
  readonly moment: number;
}

/**
 * 重心を通り `vector` の向きを持つ軸まわりのモーメントを、戻り値を返す
 * `MomentOfInertia(gp_Ax1)` で求める(out 引数の `Moments` を使わない。§1.4-12)。
 */
function momentAboutAxis(
  oc: OpenCascadeInstance,
  properties: GProp_GProps,
  centre: gp_Pnt,
  vector: gp_Vec,
  allocations: Allocations,
): AxisMoment {
  const { keep } = allocations;
  const axis = vectorToUnitTuple(vector);
  if (axis === null) {
    // 主軸の向きが取れない形(体積 0 など)。理由をつけて断る(FR-504)。
    throw new Error(MASS_PROPERTIES_FAILED_MESSAGE);
  }
  const direction = keep(new oc.gp_Dir_2(vector));
  const line = keep(new oc.gp_Ax1_2(centre, direction));
  return { axis, moment: properties.MomentOfInertia(line) };
}

/**
 * 密度に依らない質量特性(FR-1101)。体積・表面積・重心と、
 * 重心を通る主軸まわりの体積の 2 次モーメント(mm⁵)を返す。
 *
 * 表面積は `solidMesh.ts` の `measureArea` が正本で、ここでは測り直さずそれを呼ぶ。
 * 体積は重心・モーメントと同じ `GProp_GProps` から読むので、`measureVolume` と
 * 同じ指定(OnlyClosed=false・厳密な面での積分)にしてある。
 */
export function measureMassProperties(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): ShapeVolumeProperties {
  const allocations = createAllocations();
  const { keep, release } = allocations;
  try {
    const properties = keep(new oc.GProp_GProps_1());
    // 第 4・第 5 引数は SkipShared と UseTriangulation。共有面を飛ばさず、
    // 三角形近似ではなく厳密な面で積分する(solidMesh.ts の measureVolume と同じ)。
    oc.BRepGProp.VolumeProperties_1(shape, properties, VOLUME_ONLY_CLOSED, false, false);
    const centre = keep(properties.CentreOfMass());
    const principal = keep(properties.PrincipalProperties());

    const first = momentAboutAxis(
      oc,
      properties,
      centre,
      keep(principal.FirstAxisOfInertia()),
      allocations,
    );
    const second = momentAboutAxis(
      oc,
      properties,
      centre,
      keep(principal.SecondAxisOfInertia()),
      allocations,
    );
    const third = momentAboutAxis(
      oc,
      properties,
      centre,
      keep(principal.ThirdAxisOfInertia()),
      allocations,
    );

    return {
      volume: properties.Mass(),
      area: measureArea(oc, shape),
      centreOfMass: pointToTuple(centre),
      principalMoments: [first.moment, second.moment, third.moment],
      principalAxes: [first.axis, second.axis, third.axis],
    };
  } finally {
    release();
  }
}

/**
 * 密度(g/cm³)つきの質量特性(FR-1101)。
 *
 * 体積 mm³ と表面積 mm² はそのまま、質量は g、慣性モーメントは g·mm² で返す
 * (§0.a-0.32)。密度が一様なので重心と主軸は密度に依らず、体積の 2 次モーメント
 * (mm⁵)へ g/mm³ を掛けたものが慣性モーメントになる。
 */
export function massProperties(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  densityGPerCm3: number,
): ShapeMassProperties {
  if (!(densityGPerCm3 > 0)) {
    throw new Error(`密度は正の数である必要があります: ${densityGPerCm3}`);
  }
  const base = measureMassProperties(oc, shape);
  const densityGPerMm3 = densityGPerCm3 * GRAM_PER_CM3_TO_GRAM_PER_MM3;
  const [firstMoment, secondMoment, thirdMoment] = base.principalMoments;

  return {
    volume: base.volume,
    area: base.area,
    mass: base.volume * densityGPerMm3,
    centreOfMass: base.centreOfMass,
    principalMoments: [
      firstMoment * densityGPerMm3,
      secondMoment * densityGPerMm3,
      thirdMoment * densityGPerMm3,
    ],
    principalAxes: base.principalAxes,
  };
}
