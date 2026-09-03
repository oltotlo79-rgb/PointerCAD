/**
 * 剛体変換と、形をまとめるコンパウンド(計画書 P3 §2.7、タスク9)。
 *
 * パターン(FR-411 / FR-412)は新しい段の種類を作らず、**穴・ねじ穴の工具を
 * この変換で複製して 1 回で差し引く**(§0.a-0.20)。ここに置くのは
 *   ①`RigidTransformSpec` から `gp_Trsf` を作る、
 *   ②形を変換した複製を作る、
 *   ③複数の形を 1 つのコンパウンドへまとめる、
 *   ④OCCT を使わずに点・向きへ同じ変換をかける(ねじの印の位置に使う)、
 * の 4 つだけで、パターンの刻み(間隔・角度・個数)は model 側の責務である。
 */

import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  gp_Trsf,
} from 'opencascade.js/dist/opencascade.full.js';

import type { RigidTransformSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';

/** 変換の数値に NaN・∞ が混ざっていたとき。OCCT へ渡すと C++ 側が落ちうるので手前で弾く。 */
const NOT_FINITE_MESSAGE = '並べる位置や角度が数になっていません。';

/** 回すのに軸の向きが決まらないとき(長さ 0 の軸)。 */
const NO_AXIS_MESSAGE = '並べる向きが決まりません。軸を選び直してください。';

/** まとめる形が 1 つも無いとき。呼び出し側の組み立て誤りの合図。 */
const NO_SHAPE_MESSAGE = '差し引く形がありません。';

/**
 * 何も動かさない変換。
 *
 * パターンでない穴(`transforms` が空)は、これ 1 つを指定されたものとして扱う
 * (計画書 タスク9 手順3)。`rotationAxis` は回転角が 0 なら使われないが、
 * 長さ 0 の向きを既定にすると「軸が決まらない」検査に引っかかるので Z 軸を入れてある。
 */
export const IDENTITY_TRANSFORM: RigidTransformSpec = {
  translation: [0, 0, 0],
  rotationOrigin: [0, 0, 0],
  rotationAxis: [0, 0, 1],
  rotationAngle: 0,
};

function isFiniteTuple(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

/** -0 を +0 へ揃える(subShapes.ts と同じ理由: 指紋と鍵の文字列を揺らさない)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function length(value: Vec3Tuple): number {
  return Math.hypot(value[0], value[1], value[2]);
}

/** 長さ 1 へ揃える。長さが取れない(0・非数)ときは null。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const size = length(value);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return [
    normalizeZero(value[0] / size),
    normalizeZero(value[1] / size),
    normalizeZero(value[2] / size),
  ];
}

/**
 * 変換の値を確かめる。回転角が 0 のときは軸を見ない(平行移動だけなので軸が要らない)。
 * 断るときは日本語の `Error`(FR-504、NFR-RE-1)。
 */
function checkTransform(spec: RigidTransformSpec): void {
  if (
    !isFiniteTuple(spec.translation) ||
    !isFiniteTuple(spec.rotationOrigin) ||
    !isFiniteTuple(spec.rotationAxis) ||
    !Number.isFinite(spec.rotationAngle)
  ) {
    throw new Error(NOT_FINITE_MESSAGE);
  }
  if (spec.rotationAngle !== 0 && toUnit(spec.rotationAxis) === null) {
    throw new Error(NO_AXIS_MESSAGE);
  }
}

/** 何も動かさない変換か(平行移動が 0 で、回転角も 0)。 */
export function isIdentityTransform(spec: RigidTransformSpec): boolean {
  return (
    spec.rotationAngle === 0 &&
    spec.translation[0] === 0 &&
    spec.translation[1] === 0 &&
    spec.translation[2] === 0
  );
}

/**
 * 変換の一覧を「必ず 1 つ以上」にする。空なら恒等 1 つ(計画書 タスク9 手順3)。
 *
 * パターンでない穴は変換を持たないが、工具の作り方を 1 本にしておくと、
 * 「パターンのときだけ通る道」ができず取り違えが起きない。
 */
export function transformsOrIdentity(
  transforms: readonly RigidTransformSpec[],
): readonly RigidTransformSpec[] {
  return transforms.length === 0 ? [IDENTITY_TRANSFORM] : transforms;
}

/**
 * 点へ同じ変換をかける(OCCT を使わない)。**回転してから平行移動**する。
 *
 * ねじの印(`ThreadMarkInfo`)は B-rep を持たない描画だけの情報なので、
 * 形を作らずにこの式で位置を出す(§0.a-0.15)。`makeTransform` と同じ順序・
 * 同じ式であることを検査で固定してある(transformShape.test.ts)。
 *
 * 回転はロドリゲスの式: v' = v cosθ + (k × v) sinθ + k (k·v)(1 − cosθ)。
 */
export function applyTransformToPoint(spec: RigidTransformSpec, point: Vec3Tuple): Vec3Tuple {
  checkTransform(spec);
  const { rotationOrigin, translation } = spec;
  const local: Vec3Tuple = [
    point[0] - rotationOrigin[0],
    point[1] - rotationOrigin[1],
    point[2] - rotationOrigin[2],
  ];
  const turned = rotate(spec, local);
  return [
    normalizeZero(turned[0] + rotationOrigin[0] + translation[0]),
    normalizeZero(turned[1] + rotationOrigin[1] + translation[1]),
    normalizeZero(turned[2] + rotationOrigin[2] + translation[2]),
  ];
}

/**
 * 向きへ同じ変換をかける(OCCT を使わない)。**平行移動は向きを変えないので使わない。**
 * 長さは 1 のまま保たれる(回転だけを受けるため)。
 */
export function applyTransformToDirection(
  spec: RigidTransformSpec,
  direction: Vec3Tuple,
): Vec3Tuple {
  checkTransform(spec);
  const turned = rotate(spec, direction);
  return [normalizeZero(turned[0]), normalizeZero(turned[1]), normalizeZero(turned[2])];
}

/** 回転だけをかける(原点まわり)。checkTransform を通った spec にだけ使う。 */
function rotate(spec: RigidTransformSpec, value: Vec3Tuple): Vec3Tuple {
  if (spec.rotationAngle === 0) {
    return value;
  }
  const axis = toUnit(spec.rotationAxis);
  if (axis === null) {
    throw new Error(NO_AXIS_MESSAGE);
  }
  const cos = Math.cos(spec.rotationAngle);
  const sin = Math.sin(spec.rotationAngle);
  const dot = axis[0] * value[0] + axis[1] * value[1] + axis[2] * value[2];
  const cross: Vec3Tuple = [
    axis[1] * value[2] - axis[2] * value[1],
    axis[2] * value[0] - axis[0] * value[2],
    axis[0] * value[1] - axis[1] * value[0],
  ];
  return [
    value[0] * cos + cross[0] * sin + axis[0] * dot * (1 - cos),
    value[1] * cos + cross[1] * sin + axis[1] * dot * (1 - cos),
    value[2] * cos + cross[2] * sin + axis[2] * dot * (1 - cos),
  ];
}

/**
 * 剛体変換を 1 つ作る。**回転してから平行移動する**(この順序を検査で固定する)。
 *
 * OCCT の `A.Multiplied(B)` は「B をかけてから A をかける」合成なので、
 * 平行移動 × 回転 の順に書くと「回転 → 平行移動」になる。
 *
 * 確保したものは `keep` へ積む(呼び出し側がまとめて解放する)。計画書の
 * 見出しは `makeTransform(oc, spec): gp_Trsf` だが、`gp_Trsf` も OCCT が
 * 確保する実体で解放が要るため、`makeHelixEdge` と同じく控えを引数に取る形にした。
 */
export function makeTransform(
  oc: OpenCascadeInstance,
  spec: RigidTransformSpec,
  keep: Allocations['keep'],
): gp_Trsf {
  checkTransform(spec);

  const moved = keep(new oc.gp_Trsf_1());
  const vector = keep(
    new oc.gp_Vec_4(spec.translation[0], spec.translation[1], spec.translation[2]),
  );
  moved.SetTranslation_1(vector);

  if (spec.rotationAngle === 0) {
    return moved;
  }

  const axis = toUnit(spec.rotationAxis);
  if (axis === null) {
    throw new Error(NO_AXIS_MESSAGE);
  }
  const turned = keep(new oc.gp_Trsf_1());
  const origin = keep(
    new oc.gp_Pnt_3(spec.rotationOrigin[0], spec.rotationOrigin[1], spec.rotationOrigin[2]),
  );
  const direction = keep(new oc.gp_Dir_4(axis[0], axis[1], axis[2]));
  turned.SetRotation_1(keep(new oc.gp_Ax1_2(origin, direction)), spec.rotationAngle);

  // 回転 → 平行移動。Multiplied は新しい gp_Trsf を作るので、これも控えへ積む。
  return keep(moved.Multiplied(turned));
}

/**
 * 形を変換した複製を作る。**もとの形は変えない**(第 3 引数の Copy に true を渡す)。
 *
 * 返した handle の delete() で、複製した形・maker・変換をまとめて解放する。
 * 引数の `shape` には触れない(呼び出し側の持ち物)。
 */
export function transformShape(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  spec: RigidTransformSpec,
): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const trsf = makeTransform(oc, spec, keep);
    // 第 3 引数 Copy = true は「下地の幾何ごと複製する」指定。false だと
    // もとの形と幾何を共有し、もとを解放したときに複製まで壊れる。
    const maker = keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
    if (!maker.IsDone()) {
      throw new Error(NOT_FINITE_MESSAGE);
    }
    // Shape() は maker の中の実体を指すので、控えへ maker の後に積む(解放は逆順)。
    const moved = keep(maker.Shape());
    return { shape: moved, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 形の一覧を 1 つのコンパウンドにまとめる(工具の集合)。
 *
 * **引数の形は解放しない**(呼び出し側の持ち物)。返した handle の delete() は
 * コンパウンドと入れ物だけを解放する。
 *
 * **注意(2026-09-04 実測):** 中身どうしが重なり合っているコンパウンドを
 * ブーリアンの工具に渡すと、OCCT は例外も出さずに「何も削れなかった」結果を返す。
 * 重なる工具(ねじの下穴と溝など)は、コンパウンドではなく先に和(Fuse)で
 * 1 つにまとめてから差し引く(makeThread.ts の注釈を参照)。
 */
export function makeCompound(
  oc: OpenCascadeInstance,
  shapes: readonly TopoDS_Shape[],
): OcctShapeHandle {
  if (shapes.length === 0) {
    throw new Error(NO_SHAPE_MESSAGE);
  }
  const { keep, release } = createAllocations();
  try {
    const builder = keep(new oc.BRep_Builder());
    const compound = keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    for (const shape of shapes) {
      builder.Add(compound, shape);
    }
    return { shape: compound, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
