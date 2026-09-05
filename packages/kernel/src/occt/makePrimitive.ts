/**
 * 基本形状(球・箱・円柱・円錐・トーラス、FR-429、計画書 P5 §2.7.2、タスク13)。
 *
 * スケッチを描かずに、中心・向き(軸)・寸法だけからソリッドを作る。対象を取らず
 * 新しい形を作る「作る」フィーチャー(§0.a-0.19。押し出し・回転・縫合・ばねと同じ)。
 *
 * **5 種すべてを `gp_Ax2` を取る版で作る**(§0.a-0.16)。`gp_Ax2` は「原点 + Z 方向 +
 * X 方向」の直交枠で、これに揃えることで配置の計算を `primitiveAxes` 1 つにまとめられる。
 * 使う版は `BRepPrimAPI_MakeSphere_9(Axis, R)` / `MakeBox_5(Axes, dx, dy, dz)` /
 * `MakeCylinder_3(Axes, R, H)` / `MakeCone_3(Axes, R1, R2, H)` / `MakeTorus_5(Axes, R1, R2)`。
 * どれも列挙(`enum`)を引数に取らないので、強制変換なしで型検査を通る(§1.4-14)。
 *
 * **基準点の意味(§0.a-0.17。統括の決定、利用者確認済み):**
 * - 球・箱・トーラス … 重心(形の中心)
 * - 円柱・円錐 … 底面の中心(`gp_Ax2` の原点そのもの)
 *
 * 円柱・円錐を重心基準にすると、高さを 20 → 40 に変えたときに底面が動いてしまう。
 * 押し出し(「面から距離ぶん伸びる」)との操作の一貫性(NFR-UX-1)を採り、底面の中心にする。
 * 一方 `BRepPrimAPI_MakeBox_5` は `gp_Ax2` の原点を箱の**角**にするので、「中心」と
 * 言われた位置に角が来ないよう、箱だけは原点を 3 方向へ半分ずつ戻す(`boxCornerOrigin`)。
 *
 * **部分角度(何度ぶん作るか)は持たない**(§0.a-0.20)。角度を取る版(`MakeTorus_6` 等)は
 * あるが、FR-429 は角度に触れておらず、部分円柱は円弧の回転(FR-402)で作れる。
 * 必要になれば P6 以降で足す。
 *
 * **基準点を「立体の頂点」にできる**(FR-429、§0.a-0.18、タスク14b)。そのときは
 * `PrimitiveStepSpec.originQuery` に頂点の指紋が入り、`resolvePrimitiveOrigin` が
 * 対象の形から頂点を引いて座標にする。`origin` はその頂点からのオフセットになる。
 * **対象は消費しない**(頂点を借りるだけなので、対象のボディはそのまま残る)。
 *
 * **`PrimitiveStepSpec` / `PrimitiveShapeSpec` は `packages/kernel/src/types.ts` にある**
 * (タスク13 ではこのファイルで仮に宣言し、タスク14 で移した)。段の依頼の型を
 * `SolidStepSpec` の union へ足すのと、`recomputeSolids.ts` の `switch` に節を足すのは
 * 同じタスクで行う必要がある(先に型だけ足すと非網羅で型検査が落ちるため。P3 タスク12 → 13)。
 */

import type {
  BRepBuilderAPI_MakeShape,
  OpenCascadeInstance,
  TopoDS_Shape,
  gp_Ax2,
} from 'opencascade.js/dist/opencascade.full.js';

import type {
  PrimitiveShapeSpec,
  PrimitiveStepSpec,
  SolidVertexInfo,
  SubShapeQuery,
  Vec3Tuple,
} from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { matchVertex } from './matchSubShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { boundingDiagonal } from './subShapes.js';

/** これ未満の体積(mm³)は「立体にならなかった」とみなす(他の make*.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

const CONE_RADIUS_NEGATIVE_MESSAGE = '円錐の半径は 0 以上にしてください。';
const CONE_RADIUS_BOTH_ZERO_MESSAGE = '円錐の半径は、どちらか一方を 0 より大きくしてください。';

/**
 * 上下の半径が同じ円錐(＝円柱)を断る文言。
 *
 * 2026-09-05 に Node で実測したところ、`BRepPrimAPI_MakeCone_3` に R1 = R2 を渡すと
 * `IsDone()` が false になり形が作れない(OCCT が円柱へ読み替えてはくれない)。
 * 「円錐を作れませんでした。寸法を見直してください。」では何を直せばよいか分からないので、
 * OCCT を呼ぶ前に弾いて、円柱を使うよう促す(NFR-UX-5、FR-504)。
 */
const CONE_RADIUS_SAME_MESSAGE = '円錐の上下の半径が同じです。円柱を使ってください。';
const TORUS_MINOR_TOO_LARGE_MESSAGE =
  'トーラスの管の半径は、中心までの半径より小さくしてください。';
const ORIGIN_MESSAGE = '位置または向きの値が正しくありません。';

/**
 * 基準点にする頂点が見つからなかったときの断り(FR-429、FR-504、タスク14b)。
 *
 * 語尾は `makeHole.ts` / `makeFillet.ts` / `makeChamfer.ts` / `pickSubShape.ts` と
 * 揃えてある(model 側の `part/recomputePart.ts` がこの語尾で `missingSubShape` へ
 * 詰め替えるため、揃えないと理由の種類が変わってしまう)。
 *
 * **頂点は当たりにくい.** 頂点の指紋は軸も大きさも持たないので、通し番号が変わると
 * 位置がぴったり同じでも 0.5 にしか届かず、しきい値 0.6 を割る
 * (`matchSubShape.ts` の `MATCH_WEIGHT_VERTEX_INDEX` の説明)。上流を大きく作り替えると
 * この断りが出るのは決めどおりの動きで、利用者には選び直してもらう(§0.a-0.18)。
 */
export const MISSING_PRIMITIVE_VERTEX_MESSAGE =
  '中心にする頂点が見つかりません。形が大きく変わったため、選び直してください。';

/**
 * 面・辺の指紋を基準点に使おうとしたときの断り。
 * FR-429 が基準点に選べるとしているのは「立体の頂点」だけなので、
 * 面や辺に当てはめる意味が無い(外観が面以外を断るのと同じ考え方)。
 */
export const PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE =
  '中心にできるのは立体の頂点だけです。頂点を選び直してください。';
const AXIS_LENGTH_MESSAGE = '向きの長さが 0 です。別の向きを選んでください。';
const NOT_SOLID_MESSAGE = '立体になりませんでした。寸法を見直してください。';

/** 「〜は 0 より大きい数にしてください。」(欄の名前を差し込む)。 */
function positiveMessage(fieldName: string): string {
  return `${fieldName}は 0 より大きい数にしてください。`;
}

/** 「〜を作れませんでした。寸法を見直してください。」(形の名前を差し込む)。 */
function buildFailedMessage(shapeName: string): string {
  return `${shapeName}を作れませんでした。寸法を見直してください。`;
}

/** 形の種類 → 利用者へ見せる名前(断りの文言に使う)。 */
const SHAPE_NAMES: Readonly<Record<PrimitiveShapeSpec['kind'], string>> = {
  sphere: '球',
  box: '箱',
  cylinder: '円柱',
  cone: '円錐',
  torus: 'トーラス',
};

/** 3 つの数がすべて有限か。 */
function isFiniteTuple(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

/** 長さ 1 へ揃える。長さが取れない(0・非数)ときは null(makeSpring.ts の toUnit と同じ考え)。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const size = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return [value[0] / size, value[1] / size, value[2] / size];
}

/** 0 より大きい有限の数でなければ、欄の名前を添えて断る。 */
function requirePositive(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(positiveMessage(fieldName));
  }
}

/**
 * 寸法を確かめる(計画書 タスク13 の断り方の表)。**OCCT を呼ぶ前に弾く**(NFR-UX-5)。
 *
 * 円錐の半径だけは 0 を許す(上半径 0 で尖った円錐になる。§0.a-0.16)ので、
 * 「0 より大きい」ではなく「0 以上」で見て、両方 0 のときだけ別の理由で断る。
 * 上下の半径が同じときは OCCT が形を作れない(実測。CONE_RADIUS_SAME_MESSAGE の注釈)
 * ので、円柱を使うよう促して断る。
 */
function checkShapeSpec(shape: PrimitiveShapeSpec): void {
  switch (shape.kind) {
    case 'sphere':
      requirePositive(shape.radius, '半径');
      return;
    case 'box':
      requirePositive(shape.sizeX, 'X の長さ');
      requirePositive(shape.sizeY, 'Y の長さ');
      requirePositive(shape.sizeZ, 'Z の長さ');
      return;
    case 'cylinder':
      requirePositive(shape.radius, '半径');
      requirePositive(shape.height, '高さ');
      return;
    case 'cone':
      requirePositive(shape.height, '高さ');
      // 非数は「0 以上か」を判定できないので、負と同じ理由で断る。
      if (!Number.isFinite(shape.bottomRadius) || shape.bottomRadius < 0) {
        throw new Error(CONE_RADIUS_NEGATIVE_MESSAGE);
      }
      if (!Number.isFinite(shape.topRadius) || shape.topRadius < 0) {
        throw new Error(CONE_RADIUS_NEGATIVE_MESSAGE);
      }
      if (shape.bottomRadius <= 0 && shape.topRadius <= 0) {
        throw new Error(CONE_RADIUS_BOTH_ZERO_MESSAGE);
      }
      if (shape.bottomRadius === shape.topRadius) {
        throw new Error(CONE_RADIUS_SAME_MESSAGE);
      }
      return;
    case 'torus':
      requirePositive(shape.majorRadius, '主半径');
      requirePositive(shape.minorRadius, '管の半径');
      // 管が中心の穴を食いつぶして自己交差する(体積・面が壊れる)ので実行前に断る。
      if (shape.minorRadius >= shape.majorRadius) {
        throw new Error(TORUS_MINOR_TOO_LARGE_MESSAGE);
      }
      return;
  }
}

/** 依頼全体を確かめる。位置・向き → 寸法の順に見る。 */
function checkPrimitiveSpec(spec: PrimitiveStepSpec): void {
  if (!isFiniteTuple(spec.origin) || !isFiniteTuple(spec.axis)) {
    throw new Error(ORIGIN_MESSAGE);
  }
  if (toUnit(spec.axis) === null) {
    throw new Error(AXIS_LENGTH_MESSAGE);
  }
  checkShapeSpec(spec.shape);
}

/**
 * 5 種すべてに使う配置。`origin` を `gp_Ax2` の原点、`axis` を Z 方向にする。
 *
 * 第 1 軸(X 方向)は `gp_Ax2_3(P, V)` が OCCT の規則で決める。球・円柱・円錐・トーラスは
 * 軸まわりに対称なので X 方向をどちらへ向けても同じ形になり、`makeSpring.ts` の断面と
 * 同じ理由で自分で決める必要が無い。箱だけは X / Y 方向が辺の向きになるので、
 * OCCT が決めた向きを `readAxesFrame` で読み返して使う。
 *
 * 確保したものは `keep` へ積む(呼び出し側がまとめて解放する)。
 */
export function primitiveAxes(
  oc: OpenCascadeInstance,
  origin: Vec3Tuple,
  axis: Vec3Tuple,
  keep: Allocations['keep'],
): gp_Ax2 {
  const unit = toUnit(axis);
  if (unit === null) {
    throw new Error(AXIS_LENGTH_MESSAGE);
  }
  const point = keep(new oc.gp_Pnt_3(origin[0], origin[1], origin[2]));
  const direction = keep(new oc.gp_Dir_4(unit[0], unit[1], unit[2]));
  return keep(new oc.gp_Ax2_3(point, direction));
}

/** `gp_Ax2` が表す直交枠の 3 方向(長さ 1)。 */
export interface AxesFrame {
  readonly xDirection: Vec3Tuple;
  readonly yDirection: Vec3Tuple;
  readonly zDirection: Vec3Tuple;
}

/**
 * `gp_Ax2` から X / Y / Z の 3 方向を読む。
 *
 * X 方向は OCCT が決めるので、自分で同じ規則を書き写して食い違わせるのではなく、
 * 作った `gp_Ax2` から読み返す(箱の中心合わせを厳密にするため)。
 */
export function readAxesFrame(axes: gp_Ax2, keep: Allocations['keep']): AxesFrame {
  const xDirection = keep(axes.XDirection());
  const yDirection = keep(axes.YDirection());
  const zDirection = keep(axes.Direction());
  return {
    xDirection: [xDirection.X(), xDirection.Y(), xDirection.Z()],
    yDirection: [yDirection.X(), yDirection.Y(), yDirection.Z()],
    zDirection: [zDirection.X(), zDirection.Y(), zDirection.Z()],
  };
}

/**
 * 箱の中心指定のために原点をずらす(§0.a-0.17)。
 *
 * `BRepPrimAPI_MakeBox_5` は `gp_Ax2` の原点を箱の角にし、そこから X / Y / Z の 3 方向へ
 * `dx` / `dy` / `dz` だけ伸ばす。中心を `origin` に置くには、3 方向へそれぞれ半分だけ
 * 戻った点を角にすればよい。**軸が Z 以外でも正しく中心になる**(枠の 3 方向を使うため)。
 *
 * 計画書の骨子では引数が `(origin, axis, sizeX, sizeY, sizeZ)` だが、X / Y 方向は
 * `axis` だけからは決まらない(OCCT が `gp_Ax2` の中で決める)ので、読み返した枠を
 * 受け取る形にした。純関数のまま(OCCT を呼ばない)なので検査は同じように書ける。
 */
export function boxCornerOrigin(
  origin: Vec3Tuple,
  frame: AxesFrame,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): Vec3Tuple {
  const halfX = sizeX / 2;
  const halfY = sizeY / 2;
  const halfZ = sizeZ / 2;
  return [
    origin[0] - frame.xDirection[0] * halfX - frame.yDirection[0] * halfY - frame.zDirection[0] * halfZ,
    origin[1] - frame.xDirection[1] * halfX - frame.yDirection[1] * halfY - frame.zDirection[1] * halfZ,
    origin[2] - frame.xDirection[2] * halfX - frame.yDirection[2] * halfY - frame.zDirection[2] * halfZ,
  ];
}

/**
 * 頂点の座標に基準点のオフセットを足す(統括の決定 2026-09-05、タスク14b)。
 *
 * **OCCT を呼ばない純関数。** `origin` を「頂点からのずれ」と決めてあるので、
 * 頂点そのものを基準にしたいときは `[0, 0, 0]` が渡る。ずらせるようにしてあるのは、
 * 「角から 5mm 内側に円柱を立てる」のような指定を、頂点を選び直さずに式で書けるようにするため。
 */
export function offsetFromVertex(vertex: Vec3Tuple, offset: Vec3Tuple): Vec3Tuple {
  return [vertex[0] + offset[0], vertex[1] + offset[1], vertex[2] + offset[2]];
}

/**
 * 立体の頂点を基準にする基本形状の基準点を、対象の形から引く(FR-429、§0.a-0.18、タスク14b)。
 *
 * 採点は P3 の部分形状の参照とまったく同じ `matchVertex`(重み 0.5 / 0.5、しきい値 0.6)で、
 * **基本形状のための別の規約は作らない**。位置を正規化する物差し(`scale`)も加工フィーチャーと
 * 同じ「対象の境界箱の対角長の半分」にするので、同じ指紋からは穴・面取り・投影と必ず同じ
 * 頂点が選ばれる(`pickSubShape.ts` と同じ決め方)。
 *
 * **対象の形には触れない。** 形は形状キャッシュの持ち物なので、ここでは頂点の座標を読むだけで、
 * 解放も変形もしない。対象を消費しないこと(結果に両方のボディが残ること)は
 * 呼び出し側(`recomputeSolids.ts`)の `visible` の扱いがそのまま保つ。
 *
 * @param query 頂点の指紋。頂点以外(面・辺)なら断る。
 * @param offset 頂点からのずれ(mm)。
 * @param shape 頂点を持つ対象の形(物差しを測るためだけに使う)。
 * @param vertices 対象の頂点の一覧(`CachedSolid.mesh.vertices`。作り直さない)。
 */
export function resolvePrimitiveOrigin(
  oc: OpenCascadeInstance,
  query: SubShapeQuery,
  offset: Vec3Tuple,
  shape: TopoDS_Shape,
  vertices: readonly SolidVertexInfo[],
): Vec3Tuple {
  if (query.kind !== 'vertex') {
    throw new Error(PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE);
  }
  const match = matchVertex(vertices, query, boundingDiagonal(oc, shape) * 0.5);
  if (match === null) {
    throw new Error(MISSING_PRIMITIVE_VERTEX_MESSAGE);
  }
  // 一覧は通し番号の順に並ぶ約束だが、並びに頼らず番号で引き当てる
  // (matchSubShape.ts の selectBest が「並びが変わっても答えを変えない」のと同じ理由)。
  const found = vertices.find((vertex) => vertex.index === match.index);
  if (found === undefined) {
    throw new Error(MISSING_PRIMITIVE_VERTEX_MESSAGE);
  }
  return offsetFromVertex(found.position, offset);
}

/**
 * maker を組み立てて形を取り出す。
 *
 * `Build(range)` → `IsDone()` → `Shape()` の順に呼ぶ。**`IsDone()` を見る前に `Shape()` を
 * 呼ばない**(未完成の maker から形を取ると C++ 例外が飛ぶ。P3 §1.3、
 * `docs/報告記録.md` 2026-09-03 06:56 の⑤)。
 *
 * `Shape()` が返す形は maker の中の実体を指すので、控えへ maker より後に積む(解放は逆順)。
 */
function finishMaker(
  oc: OpenCascadeInstance,
  maker: BRepBuilderAPI_MakeShape,
  shapeName: string,
  keep: Allocations['keep'],
): TopoDS_Shape {
  maker.Build(keep(new oc.Message_ProgressRange_1()));
  if (!maker.IsDone()) {
    throw new Error(buildFailedMessage(shapeName));
  }
  return keep(maker.Shape());
}

/** 種類ごとに OCCT の maker を選んで形を作る。基準点の扱いの違いは箱だけ(§0.a-0.17)。 */
function buildPrimitiveShape(
  oc: OpenCascadeInstance,
  spec: PrimitiveStepSpec,
  keep: Allocations['keep'],
): TopoDS_Shape {
  const axes = primitiveAxes(oc, spec.origin, spec.axis, keep);
  const shape = spec.shape;
  const name = SHAPE_NAMES[shape.kind];

  switch (shape.kind) {
    case 'sphere':
      // 球は gp_Ax2 の原点が中心。極が Z 方向、継ぎ目が X 方向に来る。
      return finishMaker(oc, keep(new oc.BRepPrimAPI_MakeSphere_9(axes, shape.radius)), name, keep);
    case 'box': {
      const frame = readAxesFrame(axes, keep);
      const corner = boxCornerOrigin(spec.origin, frame, shape.sizeX, shape.sizeY, shape.sizeZ);
      // 枠の 3 方向はそのままに、原点だけを角へ移す(SetLocation は位置だけを変える)。
      axes.SetLocation(keep(new oc.gp_Pnt_3(corner[0], corner[1], corner[2])));
      return finishMaker(
        oc,
        keep(new oc.BRepPrimAPI_MakeBox_5(axes, shape.sizeX, shape.sizeY, shape.sizeZ)),
        name,
        keep,
      );
    }
    case 'cylinder':
      // 円柱は gp_Ax2 の原点が底面の中心。そのまま渡せば決めどおりになる。
      return finishMaker(
        oc,
        keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, shape.radius, shape.height)),
        name,
        keep,
      );
    case 'cone':
      // 円錐も底面の中心が原点。R2(上半径)が 0 なら尖り、R1 と同じなら円柱になる。
      return finishMaker(
        oc,
        keep(
          new oc.BRepPrimAPI_MakeCone_3(axes, shape.bottomRadius, shape.topRadius, shape.height),
        ),
        name,
        keep,
      );
    case 'torus':
      // トーラスは gp_Ax2 の原点が輪の中心。R1 が中心までの半径、R2 が管の半径。
      return finishMaker(
        oc,
        keep(new oc.BRepPrimAPI_MakeTorus_5(axes, shape.majorRadius, shape.minorRadius)),
        name,
        keep,
      );
  }
}

/**
 * 基本形状を 1 つ作る(FR-429)。対象を取らず、新しい形を作る(§0.a-0.19)。
 *
 * **`spec.origin` は解決済みの世界座標として扱う。** 基準点が立体の頂点のときは、
 * 呼び出し側(`worker/recomputeSolids.ts`)が先に `resolvePrimitiveOrigin` で座標へ直し、
 * `originQuery` / `targetKey` を落とした依頼を渡す(この関数は対象の形を受け取らないので、
 * ここで頂点を引くことはできない)。
 *
 * 断るときは必ず日本語の `Error`(FR-504)。OCCT の C++ 例外は数値で飛んでくるので、
 * `Error` でないものは形ごとの理由へ言い換えてから投げ直す(`makeSpring.ts` と同じ)。
 */
export function makePrimitive(oc: OpenCascadeInstance, spec: PrimitiveStepSpec): OcctShapeHandle {
  checkPrimitiveSpec(spec);

  const { keep, release } = createAllocations();
  try {
    const shape = buildPrimitiveShape(oc, spec, keep);

    if (!hasSolid(oc, shape) || Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME_MM3) {
      throw new Error(NOT_SOLID_MESSAGE);
    }
    if (!isValidShape(oc, shape)) {
      throw new Error(NOT_SOLID_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error instanceof Error
      ? error
      : new Error(buildFailedMessage(SHAPE_NAMES[spec.shape.kind]));
  }
}
