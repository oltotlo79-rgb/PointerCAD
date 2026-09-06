/**
 * 配置つきの立体の組み立てと境界箱(計画書 P7 §2.4、タスク8)。FR-601 / FR-615 / NFR-PF-1。
 *
 * アセンブリに置いた部品 1 つは、**部品の形 1 つ + 配置(位置 3 数 + 四元数 4 数)**で表す
 * (§0.5、§0.8)。同じ部品を 50 個置いても形は 1 つしか作らない(§0.4)ので、ここが
 * 受け持つのは「持っている形へ配置を掛けた見え方を作る」ことだけである。
 *
 * **四元数 → `gp_Trsf` の橋はこのファイルの `makePlacementTransform` 1 か所だけに置く**
 * (計画書 タスク8 の実装内容)。同じ橋を 2 か所へ書くと、回転と平行移動の順序が
 * 食い違ったときに部品の位置が静かにずれる。既存の `transformShape.ts` は
 * **軸と角**の `RigidTransformSpec` を受ける道具で、こちらは**四元数**を受ける道具である。
 *
 * **形を複製しない。** `transformShape` は `BRepBuilderAPI_Transform`(`Copy = true`)で
 * 幾何ごと複製するが、ここは `TopoDS_Shape.Moved(TopLoc_Location)` で**位置だけを差し替えた
 * 別の入れ物**を返す。部品 50 個ぶん幾何を複製すると §2.13-6(アセンブリを開いて 5 秒)を
 * 割るためで、`Moved` は下地の形を共有するので費用が置き場所の付け替えだけで済む。
 * **引数の形には触れない**(`Moved` はもとの形を書き換えない。`Move` のほうが書き換える版)。
 *
 * **確保したものは必ず `delete()`**(`rules/04`、P5 §7.3)。`gp_Trsf` / `gp_Quaternion` /
 * `gp_Vec` / `Bnd_Box` も対象なので、`createAllocations()` へ積んで作った順の逆に返す。
 */

import type {
  Bnd_Box,
  OpenCascadeInstance,
  TopoDS_Shape,
  gp_Trsf,
} from 'opencascade.js/dist/opencascade.full.js';

import type { PlacementSpec, QuaternionTuple, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';

/** 配置の数値に NaN・∞ が混ざっていたとき。OCCT へ渡すと C++ 側が落ちうるので手前で弾く。 */
const PLACEMENT_NOT_FINITE_MESSAGE = '部品の位置や向きが数になっていません。';

/** 四元数の長さが 0(向きが決まらない)とき。正規化の割り算に入る前に断る。 */
const NO_ROTATION_MESSAGE = '部品の向きが決まりません。';

/** 中身の無い境界箱から角を読もうとしたとき(形が空・null のときに起きる)。 */
const EMPTY_BOX_MESSAGE = '部品の大きさが取れません。';

/** 何も動かさない配置。`w = cos(0) = 1`(§2.4 の四元数の規約)。 */
export const IDENTITY_PLACEMENT: PlacementSpec = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
};

/** 境界箱の角 2 つを数で表したもの。OCCT の実体を持たないので、そのまま持ち回せる。 */
export interface BoundingBoxRange {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

/** OCCT の境界箱と、その解放手続き(`OcctShapeHandle` と同じ形)。 */
export interface OcctBoxHandle {
  readonly box: Bnd_Box;
  delete(): void;
}

function isFiniteTuple(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

function isFiniteQuaternion(value: QuaternionTuple): boolean {
  return (
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2]) &&
    Number.isFinite(value[3])
  );
}

/**
 * 長さ 1 へ揃える。**符号(`w >= 0`)は揃えない。**
 *
 * `q` と `−q` は同じ回転行列になるので、ここで符号を触っても形は 1 ドットも変わらない。
 * 符号を揃えるのは「同じ文書から同じバイト列ができる」ための決めごと(§0.54)で、
 * 保存する値を持つ model 側(`assembly/placementMath.ts` の `normalizeQuaternion`)の
 * 1 か所だけで行う。カーネルは受け取った値をそのまま形にする。
 */
function unitQuaternion(rotation: QuaternionTuple): QuaternionTuple {
  const size = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(NO_ROTATION_MESSAGE);
  }
  return [rotation[0] / size, rotation[1] / size, rotation[2] / size, rotation[3] / size];
}

/**
 * 配置から `gp_Trsf` を 1 つ作る。**回してから移す**(`p' = R(q)·p + t`、§2.4)。
 *
 * `SetRotation_2(gp_Quaternion)` は変換そのものを「原点まわりの回転」に置き換える
 * (平行移動は 0、倍率は 1 に戻る)ので、そのあとの `SetTranslationPart` で入れた `t` は
 * **回転のあとに足される**。この順序は §1.5-4 の実測項目で、`placeBodies.test.ts` が
 * 20³ の箱を Z 軸まわり 90° 回して (10,0,0) へ移した頂点の座標で固定している。
 *
 * 確保したものは `keep` へ積む(`makeTransform` と同じ形。`gp_Trsf` も解放が要るため)。
 */
export function makePlacementTransform(
  oc: OpenCascadeInstance,
  placement: PlacementSpec,
  keep: Allocations['keep'],
): gp_Trsf {
  if (!isFiniteTuple(placement.position) || !isFiniteQuaternion(placement.rotation)) {
    throw new Error(PLACEMENT_NOT_FINITE_MESSAGE);
  }
  const [x, y, z, w] = unitQuaternion(placement.rotation);

  const trsf = keep(new oc.gp_Trsf_1());
  trsf.SetRotation_2(keep(new oc.gp_Quaternion_2(x, y, z, w)));
  trsf.SetTranslationPart(
    keep(new oc.gp_Vec_4(placement.position[0], placement.position[1], placement.position[2])),
  );
  return trsf;
}

/**
 * 形へ配置を掛けた見え方を作る。**もとの形には触れない。**
 *
 * 返した handle の `delete()` で、置いた形・置き場所・変換をまとめて解放する。
 * 引数の `shape` は呼び出し側の持ち物なので解放しない(部品の形は 1 つを使い回す。§0.4)。
 */
export function placeShape(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  placement: PlacementSpec,
): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const trsf = makePlacementTransform(oc, placement, keep);
    const location = keep(new oc.TopLoc_Location_2(trsf));
    // 第 2 引数 true は「置き場所が組み合わせられないときは例外にする」指定
    // (黙って別の位置に置かない。NFR-RE-1)。
    const moved = keep(shape.Moved(location, true));
    return { shape: moved, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 形の境界箱を作る(干渉チェックの 1 段目、§2.7)。
 *
 * 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定(`subShapes.ts` の
 * `boundingDiagonal` と同じ)。`BRepBndLib.Add` は形の許容誤差ぶん(既定 1e-7)だけ箱を
 * 広げるので、`SetGap(0)` で広げぶんを取り除き幾何そのものの大きさにする。
 * **中身の無い形では箱が空のまま**になるので、`SetGap` はそのときだけ飛ばす。
 */
export function boundingBoxOf(oc: OpenCascadeInstance, shape: TopoDS_Shape): OcctBoxHandle {
  const { keep, release } = createAllocations();
  try {
    const box = keep(new oc.Bnd_Box_1());
    oc.BRepBndLib.Add(shape, box, false);
    if (!box.IsVoid()) {
      box.SetGap(0);
    }
    return { box, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 境界箱へ配置を掛けた箱を作る(`Bnd_Box.Transformed`)。
 *
 * **形を作り直さずに置いた先の大きさが分かる**ので、干渉チェックの 1 段目(§2.7)と
 * 「全体が入る箱」の計算はこちらを使う。回転が 90° の倍数でないときは、返る箱は
 * 「回した形にぴったり」ではなく**回した箱を包む軸に平行な箱**になる(必ず形を含むので
 * 絞り込みには使える。ぴったりの箱が要るときは `placeShape` した形から測り直す)。
 *
 * 計画書の見出しは `transformedBoundingBox(box, placement)` だが、`gp_Trsf` を作るのに
 * OCCT の実体が要るので `oc` を第 1 引数に取る形にした(`makeTransform` と同じ流儀)。
 */
export function transformedBoundingBox(
  oc: OpenCascadeInstance,
  box: Bnd_Box,
  placement: PlacementSpec,
): OcctBoxHandle {
  const { keep, release } = createAllocations();
  try {
    const trsf = makePlacementTransform(oc, placement, keep);
    // Transformed は新しい Bnd_Box を作って返すので、これも控えへ積む。
    return { box: keep(box.Transformed(trsf)), delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 境界箱の角 2 つを数で読む。
 *
 * `Bnd_Box.Get(xmin, …)` は数値を参照渡しで返す形なので JS からは受け取れない。
 * 角の点を戻り値で返す `CornerMin()` / `CornerMax()` を使う(§1.4-1、`subShapes.ts` と同じ)。
 * 読んだ `gp_Pnt` は OCCT の実体なので必ず解放する。
 */
export function boundingBoxRange(box: Bnd_Box): BoundingBoxRange {
  if (box.IsVoid()) {
    throw new Error(EMPTY_BOX_MESSAGE);
  }
  const { keep, release } = createAllocations();
  try {
    const low = keep(box.CornerMin());
    const high = keep(box.CornerMax());
    return {
      min: [low.X(), low.Y(), low.Z()],
      max: [high.X(), high.Y(), high.Z()],
    };
  } finally {
    release();
  }
}

/**
 * 2 つの境界箱が重なるか(干渉チェックの 1 段目の判定、§2.7)。
 *
 * `Bnd_Box.IsOut_4(Other)` は「外にある = 重ならない」を返すので、否定して使う。
 * **接している(面がぴったり合う)ときは重なると答える。** 箱の段は「ここから先は
 * 詳しく調べる」を決めるだけの粗い網なので、取りこぼさない側へ倒してある。
 */
export function boundingBoxesOverlap(box: Bnd_Box, other: Bnd_Box): boolean {
  return !box.IsOut_4(other);
}
