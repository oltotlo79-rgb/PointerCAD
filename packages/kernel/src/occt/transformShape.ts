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
 *
 * **P5 の追加(計画書 タスク35、FR-419 / FR-424):**
 *   ⑤`mirrorShape`: 平面に対する鏡像(FR-419)、
 *   ⑥`scaleShape`: 全体倍率と軸ごと倍率の拡大縮小(FR-424)。
 *
 * **FR-424 の「移動/回転」に新しい関数は作らない。** 上の②`transformShape` が
 * `RigidTransformSpec`(平行移動+軸まわりの回転)そのもので、計画書 §2.12 の表も
 * 「`transformShape.ts` をそのまま」と書いている。同じ変換の作り方を 2 か所へ
 * 書くと、パターン(FR-411)と移動/回転(FR-424)で回転の順序が食い違いうる。
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
 * 鏡・拡大縮小の位置や向きに NaN・∞ が混ざっていたとき。
 *
 * パターンの `NOT_FINITE_MESSAGE`(「並べる位置や角度」)とは道具が違い、
 * 利用者が見る画面も違うので、文言を分けてある(NFR-UX-5)。
 */
const PLACE_NOT_FINITE_MESSAGE = '位置や向きが数になっていません。';

/** 鏡にする平面の法線の長さが 0 のとき。面の向きが取れなければ鏡が決まらない。 */
const NO_MIRROR_NORMAL_MESSAGE = '鏡にする面の向きが決まりません。面を選び直してください。';

/** 倍率が 0 以下・非数のとき。負の倍率は鏡像になるので、ミラー(FR-419)へ誘導する。 */
const BAD_SCALE_MESSAGE = '倍率は 0 より大きい数にしてください。';

/** 「全体」と「軸ごと」の両方、またはどちらも指定されなかったとき。 */
const SCALE_CHOICE_MESSAGE = '倍率は「全体」か「軸ごと」のどちらか一方を指定してください。';

/** OCCT が変換を組み立てられなかったとき(実測では起きないが、無言で通さない)。 */
const TRANSFORM_FAILED_MESSAGE = '形を変換できませんでした。指定を見直してください。';

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

/** 鏡にする平面(FR-419)。`origin` を通り、`normal` を法線とする平面。 */
export interface MirrorPlaneSpec {
  /** 平面上の 1 点(基準平面なら原点、立体の平らな面ならその面の 1 点)。 */
  readonly origin: Vec3Tuple;
  /** 平面の法線。長さは 1 でなくてよい(ここで揃える)。 */
  readonly normal: Vec3Tuple;
}

/**
 * 鏡像の変換を 1 つ作る。確保したものは `keep` へ積む(`makeTransform` と同じ形)。
 *
 * `gp_Ax2_3(P, V)` は「P を通り V を主方向とする座標系」で、`SetMirror_3(gp_Ax2)` は
 * **その主方向に垂直な平面**(座標系の XY 平面)に対する対称変換にする。
 * つまり `V` に平面の**法線**を渡せばよい(`SetMirror_2(gp_Ax1)` は軸まわりの
 * 180 度回転、`SetMirror_1(gp_Pnt)` は点対称なので、どちらも鏡像ではない)。
 */
export function makeMirrorTransform(
  oc: OpenCascadeInstance,
  plane: MirrorPlaneSpec,
  keep: Allocations['keep'],
): gp_Trsf {
  if (!isFiniteTuple(plane.origin) || !isFiniteTuple(plane.normal)) {
    throw new Error(PLACE_NOT_FINITE_MESSAGE);
  }
  const normal = toUnit(plane.normal);
  if (normal === null) {
    throw new Error(NO_MIRROR_NORMAL_MESSAGE);
  }
  const mirror = keep(new oc.gp_Trsf_1());
  const origin = keep(new oc.gp_Pnt_3(plane.origin[0], plane.origin[1], plane.origin[2]));
  const direction = keep(new oc.gp_Dir_4(normal[0], normal[1], normal[2]));
  mirror.SetMirror_3(keep(new oc.gp_Ax2_3(origin, direction)));
  return mirror;
}

/**
 * 平面に対する鏡像を作る(FR-419)。**もとの形は変えない**(`Copy = true`)。
 *
 * ミラーのフィーチャーは対象のボディを**消費しない**(計画書 §0.a-0.36)。
 * 鏡像を作ったあと元と鏡像を和でつなぐのが普通の使い方で、元を消すと和が取れない。
 * 「元を残すか」は段の側(model)の話なので、ここは複製を 1 つ返すだけにしてある。
 */
export function mirrorShape(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  plane: MirrorPlaneSpec,
): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const trsf = makeMirrorTransform(oc, plane, keep);
    // Copy = true。false だともとの形と幾何を共有し、もとを解放したときに鏡像まで壊れる。
    const maker = keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
    if (!maker.IsDone()) {
      throw new Error(TRANSFORM_FAILED_MESSAGE);
    }
    const mirrored = keep(maker.Shape());
    return { shape: mirrored, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 拡大縮小の指定(FR-424)。`uniform` と `perAxis` は**どちらか一方だけ**を入れる。
 *
 * 画面の「全体 / 軸ごと」の切り替え(計画書 §2.12 の `ScaleFeature`)をそのまま
 * 写した形で、両方 null・両方非 null はどちらも組み立ての誤りとして断る。
 */
export interface ScaleSpec {
  /** 拡大縮小の中心。この点は動かない。 */
  readonly origin: Vec3Tuple;
  /** 全体の倍率(一様)。軸ごとのときは null。 */
  readonly uniform: number | null;
  /** 軸ごとの倍率 [X, Y, Z]。全体のときは null。 */
  readonly perAxis: readonly [number, number, number] | null;
}

/** 倍率として使える数か(0 以下と非数を断る)。負は鏡像になるので mirrorShape へ回す。 */
function checkFactor(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(BAD_SCALE_MESSAGE);
  }
}

/**
 * 拡大縮小した複製を作る(FR-424)。**もとの形は変えない**(`Copy = true`)。
 *
 * 一様なときは `gp_Trsf.SetScale(gp_Pnt, s)` で済むが、軸ごとのときは倍率が
 * 軸で違って剛体変換にならないため、`gp_Trsf` では表せない。一般変換
 * `gp_GTrsf_3(gp_Mat, gp_XYZ)` と `BRepBuilderAPI_GTransform_2` を使う。
 */
export function scaleShape(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  spec: ScaleSpec,
): OcctShapeHandle {
  if (!isFiniteTuple(spec.origin)) {
    throw new Error(PLACE_NOT_FINITE_MESSAGE);
  }
  if ((spec.uniform === null) === (spec.perAxis === null)) {
    throw new Error(SCALE_CHOICE_MESSAGE);
  }
  const { keep, release } = createAllocations();
  try {
    if (spec.uniform !== null) {
      checkFactor(spec.uniform);
      const trsf = keep(new oc.gp_Trsf_1());
      const center = keep(new oc.gp_Pnt_3(spec.origin[0], spec.origin[1], spec.origin[2]));
      trsf.SetScale(center, spec.uniform);
      const maker = keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
      if (!maker.IsDone()) {
        throw new Error(TRANSFORM_FAILED_MESSAGE);
      }
      return { shape: keep(maker.Shape()), delete: release };
    }

    const perAxis = spec.perAxis;
    if (perAxis === null) {
      // 上の分岐で必ずどちらかが非 null になるが、型を絞るために書いてある。
      throw new Error(SCALE_CHOICE_MESSAGE);
    }
    checkFactor(perAxis[0]);
    checkFactor(perAxis[1]);
    checkFactor(perAxis[2]);

    // gp_GTrsf は X' = M·X + V の形なので、中心 O まわりの拡大縮小
    // X' = M·(X − O) + O は V = O − M·O、つまり成分ごとに o(1 − s) になる。
    // 「平行移動を前後に挟む」計算をここで済ませてある(行列の合成を 1 回に減らす)。
    const matrix = keep(
      new oc.gp_Mat_2(perAxis[0], 0, 0, 0, perAxis[1], 0, 0, 0, perAxis[2]),
    );
    const shift = keep(
      new oc.gp_XYZ_2(
        spec.origin[0] * (1 - perAxis[0]),
        spec.origin[1] * (1 - perAxis[1]),
        spec.origin[2] * (1 - perAxis[2]),
      ),
    );
    const gtrsf = keep(new oc.gp_GTrsf_3(matrix, shift));
    const maker = keep(new oc.BRepBuilderAPI_GTransform_2(shape, gtrsf, true));
    if (!maker.IsDone()) {
      throw new Error(TRANSFORM_FAILED_MESSAGE);
    }
    return { shape: keep(maker.Shape()), delete: release };
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
