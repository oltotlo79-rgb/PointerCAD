/**
 * 原点の再設定(FR-331)で座標の式を平行移動する道具
 * (計画書 docs/plans/P4-スケッチ拡張.md §0.a-0.25 ②・タスク35 ②)。
 *
 * 書き換えるのは**絶対座標**と、**ワールド原点を基準にした相対・極座標**である。原点そのものが
 * 動くので、原点を基準にした指定も同じだけ動かないと模型がばらける(統括の差し戻し ①)。
 * 他の点を基準にした相対・極や `PointReference` は「別の要素に対して定まっている座標」なので、
 * 参照先が動けば自動的に追従する(FR-331、§0.a-0.25 ②)。
 *
 * 作図面のある 2D スケッチでは、世界のシフトを `planeMath.ts` の `WORK_PLANES` の基底
 * (`axisU` / `axisV` / `normal`)で面内成分と法線成分に分ける。**法線成分が 0 でないときは
 * 作図面ごと動かす**ので世界の 3 成分をそのまま引き(呼び出し側 `part/shiftOrigin.ts` が
 * 基準面からオフセットした作業平面へ付け替える)、0 のときは面内の 2 軸へ写したぶんだけ引く
 * (このとき両者は一致する)。3D スケッチ(FR-330)には作図面が無いので世界の 3 成分を引く。
 *
 * 式は文字列のまま組み替え、**丸めない**(rules/04-設計の規律.md の数値精度)。
 */

import {
  addExpression,
  exactExpressionValueFromNumber,
  subtractExpression,
  type ExpressionValue,
} from '@pointercad/expression';

import { polarOffset, type WorkPlane } from './planeMath.js';
import type { Vec3 } from './vec3.js';
import type {
  CoordinateInput,
  PointArrayLayout,
  SketchDocument,
  SketchFeature,
} from './types.js';

/** 世界の x / y / z にかける平行移動の量(式のまま)。原点にした点の座標がそのまま入る。 */
export interface OriginShift {
  readonly x: ExpressionValue;
  readonly y: ExpressionValue;
  readonly z: ExpressionValue;
}

/**
 * 世界の 1 成分にかかる平行移動。
 *
 * `keep` はその成分を動かさない(作図面の法線方向など)。`subtract` は元の式から引き、
 * `add` は足す(基底が世界の軸の**負**の向きを指す場合。XZ 面の法線は −Y)。
 */
export type AxisShift =
  | { readonly kind: 'keep' }
  | { readonly kind: 'subtract'; readonly amount: ExpressionValue }
  | { readonly kind: 'add'; readonly amount: ExpressionValue };

/** 世界の x / y / z それぞれにかかる平行移動。 */
export type ShiftAxes = readonly [AxisShift, AxisShift, AxisShift];

/** 1 点の指定を平行移動するのに要るもの。 */
export interface CoordinateShift {
  readonly axes: ShiftAxes;
  /**
   * 原点を基準にした極座標(角度と距離)を書き換えるときの角度の基準になる作図面。
   * 基準面からオフセットした作業平面でも軸は基準面と同じなので、基準面をそのまま渡してよい
   * (`polarOffset` は平面の原点を見ない)。3D スケッチと部品文書の外では null。
   */
  readonly plane: WorkPlane | null;
}

const KEEP: AxisShift = { kind: 'keep' };

/** 軸に沿った基底とみなす係数のずれ。基底は 0 / ±1 の成分しか持たない前提を確かめる。 */
const AXIS_EPSILON = 1e-12;

function shiftAmount(shift: OriginShift, index: number): ExpressionValue | null {
  if (index === 0) {
    return shift.x;
  }
  if (index === 1) {
    return shift.y;
  }
  return index === 2 ? shift.z : null;
}

/**
 * 係数の並び(世界の 3 成分にかかる重み)から 1 成分ぶんの平行移動を作る。
 *
 * 係数が 0 / ±1 の 1 項だけになるとき(基準の 3 面の基底と法線はすべてこの形)にだけ
 * 式のまま書き換えられる。そうでない基底は式を掛け算で増やすことになるので断る(null)。
 */
function axisShiftFrom(
  coefficients: readonly [number, number, number],
  shift: OriginShift,
): AxisShift | null {
  let found: AxisShift | null = null;
  for (let index = 0; index < coefficients.length; index += 1) {
    const coefficient = coefficients[index];
    if (Math.abs(coefficient) < AXIS_EPSILON) {
      continue;
    }
    if (found !== null || Math.abs(Math.abs(coefficient) - 1) > AXIS_EPSILON) {
      return null;
    }
    const amount = shiftAmount(shift, index);
    if (amount === null) {
      return null;
    }
    found = coefficient > 0 ? { kind: 'subtract', amount } : { kind: 'add', amount };
  }
  return found ?? KEEP;
}

/** 3D スケッチ(作図面なし)と部品文書の座標。世界の 3 成分をそのまま引く。 */
export function worldShiftAxes(shift: OriginShift): ShiftAxes {
  return [
    { kind: 'subtract', amount: shift.x },
    { kind: 'subtract', amount: shift.y },
    { kind: 'subtract', amount: shift.z },
  ];
}

/**
 * 世界のシフトを作図面の 2 軸へ写す(法線方向の成分は落とす)。
 *
 * 面内のずれは `axisU·(shift·axisU) + axisV·(shift·axisV)` で、その世界成分ごとの係数を
 * 取り出して式へ当てる。基底が世界の軸に沿っていない平面(任意の作業平面)は式のままでは
 * 写せないので null を返し、呼び出し側はその要素を書き換えない。
 */
export function planeShiftAxes(shift: OriginShift, plane: WorkPlane): ShiftAxes | null {
  const axes: AxisShift[] = [];
  for (let component = 0; component < 3; component += 1) {
    const coefficients: [number, number, number] = [0, 0, 0];
    for (let source = 0; source < 3; source += 1) {
      coefficients[source] =
        plane.axisU[component] * plane.axisU[source] + plane.axisV[component] * plane.axisV[source];
    }
    const axis = axisShiftFrom(coefficients, shift);
    if (axis === null) {
      return null;
    }
    axes.push(axis);
  }
  return [axes[0], axes[1], axes[2]];
}

/**
 * 平面の法線方向にかかる平行移動(基準面からのオフセットで定義した作業平面のため)。
 *
 * 平面の位置は「基準面の原点 + 法線 × オフセット」なので(`geometry/planeSpec.ts` の
 * `offsetPlane`)、模型が `-shift` だけ動けばオフセットは `shift·normal` だけ減る。
 */
export function normalShiftAxis(shift: OriginShift, plane: WorkPlane): AxisShift | null {
  return axisShiftFrom([plane.normal[0], plane.normal[1], plane.normal[2]], shift);
}

/** 1 つの式へ平行移動を当てる。 */
export function shiftExpression(value: ExpressionValue, axis: AxisShift): ExpressionValue {
  switch (axis.kind) {
    case 'keep':
      return value;
    case 'subtract':
      return subtractExpression(value, axis.amount);
    case 'add':
      return addExpression(value, axis.amount);
  }
}

/** 平行移動が何も動かさないか(すべて `keep`、または量が 0)。 */
function movesNothing(axes: ShiftAxes): boolean {
  return axes.every((axis) => axis.kind === 'keep' || axis.amount.value === 0);
}

/**
 * 原点を基準にした極座標(距離と角度)を平行移動する(FR-331)。
 *
 * 極座標のままでは平行移動を表せない(距離・角度に平行移動を足す式が書けず、この式の文法に
 * 三角関数も無い)。基準を「動いた後の原点」にすることもできない——`PointReference` に
 * 座標の式を持つ種類が無く、`origin` は常にワールド原点を指すためである。そこで**同じ点を
 * 指す「原点からのずれ」へ書き換える**: ずれの成分は倍精度で求めて丸めずに式にし
 * (`exactExpressionValueFromNumber`)、そこからシフトを引く。位置は寸分変わらず、
 * 以後は普通の相対座標として編集できる。
 */
function shiftPolarFromOrigin(
  input: Extract<CoordinateInput, { mode: 'polar' }>,
  shift: CoordinateShift,
): CoordinateInput {
  const plane = shift.plane;
  if (plane === null) {
    // 3D スケッチには角度の基準が無く、この極座標はもともと解決できない(`resolveCoordinate`)。
    return input;
  }
  const values = [input.distance.value, input.azimuth.value, input.elevation.value];
  if (!values.every((value) => Number.isFinite(value))) {
    // 値が数になっていない式を書き換えると、直せる式まで失う(FR-504)。
    return input;
  }
  const offset = polarOffset(plane, values[0], values[1], values[2]);
  return {
    mode: 'relative',
    base: { kind: 'origin' },
    dx: shiftExpression(exactExpressionValueFromNumber(offset[0]), shift.axes[0]),
    dy: shiftExpression(exactExpressionValueFromNumber(offset[1]), shift.axes[1]),
    dz: shiftExpression(exactExpressionValueFromNumber(offset[2]), shift.axes[2]),
  };
}

/**
 * 1 点の指定を平行移動する(FR-331)。
 *
 * 書き換えるのは**絶対座標**と、**ワールド原点を基準にした相対・極座標**である。原点そのものが
 * 動くので、原点を基準にした指定は絶対座標と同じだけ動かないと模型がばらける(統括の差し戻し
 * 2026-09-04 ①)。他の点を基準にした相対・極座標は、基準が動けば追従するので触らない。
 *
 * 向きベクトルとして解かれる欄(複製のずれ・配列の向き・3D 円弧の向き)には使わない。
 * 呼び出し側が位置の欄だけをここへ渡す。
 */
export function shiftCoordinateInput(
  input: CoordinateInput,
  shift: CoordinateShift,
): CoordinateInput {
  const axes = shift.axes;
  if (input.mode === 'absolute') {
    return {
      mode: 'absolute',
      x: shiftExpression(input.x, axes[0]),
      y: shiftExpression(input.y, axes[1]),
      z: shiftExpression(input.z, axes[2]),
    };
  }
  if (input.base.kind !== 'origin' || movesNothing(axes)) {
    return input;
  }
  if (input.mode === 'relative') {
    return {
      mode: 'relative',
      base: input.base,
      dx: shiftExpression(input.dx, axes[0]),
      dy: shiftExpression(input.dy, axes[1]),
      dz: shiftExpression(input.dz, axes[2]),
    };
  }
  return shiftPolarFromOrigin(input, shift);
}

/**
 * 解決済みの座標(立体の頂点など、式を持たない点)からシフト量を作る(タスク35 ③)。
 *
 * 桁は 1 つも落とさない。倍精度を過不足なく表す最短の 10 進表記を式にするので
 * (`exactExpressionValueFromNumber`)、読み直すと必ず同じ座標に戻る(統括の差し戻し ②)。
 */
export function originShiftFromPosition(position: Vec3): OriginShift {
  return {
    x: exactExpressionValueFromNumber(position[0]),
    y: exactExpressionValueFromNumber(position[1]),
    z: exactExpressionValueFromNumber(position[2]),
  };
}

/**
 * 点列の並べ方(FR-327)の平行移動。並べ方を決める基準点だけが位置で、間隔・角度・個数は
 * 位置ではないので触らない。
 */
function shiftPointArrayLayout(
  layout: PointArrayLayout,
  shift: CoordinateShift,
): PointArrayLayout {
  switch (layout.kind) {
    case 'linear':
      return { ...layout, base: shiftCoordinateInput(layout.base, shift) };
    case 'circular':
      return { ...layout, center: shiftCoordinateInput(layout.center, shift) };
    case 'grid':
      return { ...layout, base: shiftCoordinateInput(layout.base, shift) };
  }
}

/**
 * スケッチのフィーチャー 1 つを平行移動する(FR-331)。
 *
 * **位置の欄だけ**を書き換える。次の欄は座標指定(`CoordinateInput`)の形をしているが
 * 「原点から見た向きベクトル」または「ずれ」なので、原点を動かしても変わらない。
 *   - 円弧の 3D スケッチ用の向き(`freeOrientation` の `normal` / `xAxis`)
 *   - 複製の移動量(`translate` の `delta`)と配列の向き(`linearArray` の `direction`)
 * 半径・角度・幅・間隔・個数などの寸法も、原点の位置とは無関係なので変えない(FR-331)。
 */
export function shiftSketchFeature(feature: SketchFeature, shift: CoordinateShift): SketchFeature {
  switch (feature.kind) {
    case 'point':
      return { ...feature, at: shiftCoordinateInput(feature.at, shift) };
    case 'line':
      return {
        ...feature,
        from: shiftCoordinateInput(feature.from, shift),
        to: shiftCoordinateInput(feature.to, shift),
      };
    case 'arc':
      return { ...feature, center: shiftCoordinateInput(feature.center, shift) };
    case 'pointArray':
      return { ...feature, layout: shiftPointArrayLayout(feature.layout, shift) };
    case 'face':
      // 面は境界の参照と色だけ(座標を持たない)。
      return feature;
    case 'rectangle':
      return {
        ...feature,
        corner1: shiftCoordinateInput(feature.corner1, shift),
        corner2: shiftCoordinateInput(feature.corner2, shift),
      };
    case 'polygon':
      return { ...feature, center: shiftCoordinateInput(feature.center, shift) };
    case 'slot':
      return {
        ...feature,
        center1: shiftCoordinateInput(feature.center1, shift),
        center2: shiftCoordinateInput(feature.center2, shift),
      };
    case 'ellipse':
      return { ...feature, center: shiftCoordinateInput(feature.center, shift) };
    case 'spline':
      return {
        ...feature,
        points: feature.points.map((point) => shiftCoordinateInput(point, shift)),
      };
    case 'offset':
      // オフセットが持つのは元の要素の参照と距離だけ(位置を持たない)。
      return feature;
    case 'copy':
      return feature.placement.kind === 'circularArray'
        ? {
            ...feature,
            placement: {
              ...feature.placement,
              center: shiftCoordinateInput(feature.placement.center, shift),
            },
          }
        : // 鏡像は軸・平面の参照だけ、移動と直線状の配列は向き(ずれ)なので動かさない。
          feature;
    case 'projectedCurve':
    case 'planeSection':
      // 投影・交差が持つのは立体への参照だけ(座標を持たない)。形は立体の側が動けば
      // 一緒に動くので、ここで書き換えるものは無い(FR-325、FR-331)。
      return feature;
  }
}

/**
 * フィーチャー 1 つの動かし方。`planeId` があれば作図面を付け替える
 * (基準面の上のスケッチを、基準面からオフセットした作業平面へ移すとき。統括の差し戻し ③)。
 */
export interface FeatureShiftPlan {
  readonly shift: CoordinateShift;
  readonly planeId?: string;
}

/**
 * スケッチ 1 本を平行移動する。作図面ごとに動かし方が変わるので、フィーチャーごとに
 * `planFor` へ作図面の id を渡して決める。null が返った作図面(3 点や面から定義した
 * 任意の作業平面。平面自体が別の要素を基準に定まる)のフィーチャーは書き換えない。
 */
export function shiftSketchDocument(
  document: SketchDocument,
  planFor: (planeId: string) => FeatureShiftPlan | null,
): SketchDocument {
  return {
    ...document,
    features: document.features.map((feature) => {
      const plan = planFor(feature.planeId);
      if (plan === null) {
        return feature;
      }
      const moved = shiftSketchFeature(feature, plan.shift);
      return plan.planeId === undefined ? moved : { ...moved, planeId: plan.planeId };
    }),
  };
}
