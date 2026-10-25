/**
 * 穴あけ(FR-405、計画書 P3 §2.4、タスク6)と、入口の形(ざぐり・皿もみ。FR-422、
 * 計画書 P5 §0.a-0.39、タスク40)。
 *
 * 面を指紋で選び直し、その平面へ中心の点を投影し、面の法線の逆向き(必要なら傾けた向き)へ
 * 円柱を伸ばして対象から差し引く。円柱は 1 つのコンパウンドへまとめ、**ブーリアンは 1 回**で行う。
 *
 * **§1.4-⑧ の実測(2026-09-03、Node、板 40×30×10 と 200×200×10)。**
 * `BRepFeat_MakeCylindricalHole`(②)と「円柱+ブーリアン差」(①)を比べた結果、
 * 体積はどちらも解析値と一致したが、次の 3 点で①を採った。
 *   - 速さ: 穴 20 個で ①(コンパウンド 1 回差)150ms に対し、②(1 穴ずつ)450ms、
 *     ①を 1 穴ずつ順に差し引く書き方でも 486ms。②は穴の数だけブーリアンを回すため。
 *   - 正確さ: 傾き 20 度の穴で ① の誤差 3.1e-11 mm³ に対し ② は 9.7e-8 mm³。
 *   - 断り方: 材料に当たらない穴・板より大きい径の穴で、② は `BRepFeat_InvalidPlacement` を
 *     返すだけで「何が起きたか」を区別できない。① は「何も削れなかった」「立体が残らなかった」を
 *     体積で見分けられ、利用者へ違う直し方を案内できる(FR-504)。
 * さらに②は軸 1 本ずつしか受け取れないので、パターン(§0.a-0.20)で工具を複製する作りに合わない。
 */

import type {
  BRepAdaptor_Surface,
  BRepPrim_Cylinder, BRepPrim_Cone,
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
  gp_Ax2,
} from 'opencascade.js/dist/opencascade.full.js';

import type {
  HoleStepSpec,
  RigidTransformSpec,
  SolidFaceInfo,
  SubShapeQuery,
  Vec3Tuple,
} from '../types.js';
import type { CurrentOriginIndex, HoleCenterAnchor, HolePlacementRole, HoleFaceOrigin } from '../subShapeOrigin.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { HoleOriginMapError, rebindHoleToolFaces, rebindTransformedHoleFaces, rebindTransformedOrigins, type NativeHoleToolFace } from './subShapeOrigins.js';
import { OriginHistoryLimitError } from './subShapeHistory.js';
import { booleanOp, type BooleanResult, type BooleanSemanticContext } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { resolveFaceReference } from './matchSubShape.js';
import { hasSolid, measureVolume } from './solidMesh.js';
import { buildBooleanShape } from './buildBooleanShape.js';
import { booleanMargin, boundingDiagonal, faceAt } from './subShapes.js';
import { isIdentityTransform, transformShape, transformsOrIdentity } from './transformShape.js';

/** 面が選び直せなかったとき(FR-504、§2.2.5)。 */
const MISSING_FACE_MESSAGE =
  '穴をあけるもとの面が見つかりません。形が大きく変わったため、選び直してください。';

/** P3 の制限。曲がった面への穴は、面の平面が決まらないので扱わない。 */
const NOT_PLANAR_MESSAGE = '穴をあけられるのは平らな面だけです。平らな面を選び直してください。';

/** 円筒の側面の穴(EX05)で、選び直した面が円筒でなかったとき。 */
const NOT_CYLINDRICAL_MESSAGE = '円筒の側面の穴をあけられるのは円筒の面だけです。円筒の面を選び直してください。';

/** 円筒の側面の穴の位置が 1 つも無いとき。 */
const NO_CYLINDER_LOCATION_MESSAGE = '円筒の側面の穴の位置(高さと角度)が 1 つもありません。';

/** 高さか角度が数でない(NaN・∞)とき。 */
const CYLINDER_LOCATION_NOT_FINITE_MESSAGE = '円筒の側面の穴の高さと角度は数にしてください。';

/** 位置が選んだ円筒の面の境界(トリム)の外、または境界の上にあるとき。 */
const CYLINDER_OUTSIDE_MESSAGE = '穴の位置が選んだ円筒の面の外です。高さか角度を見直してください。';

/**
 * 円筒の側面の穴で、まだ正しく扱えない組み合わせを頼まれたとき。
 * 曲面の上の傾き・皿もみの意味(どこから測るか)をまだ決めていないので、
 * **黙って平面の穴やまっすぐな穴にせず断る**。
 */
const CYLINDER_UNSUPPORTED_MESSAGE =
  '円筒の側面の穴では、中心の点・傾き・皿もみはまだ使えません。位置は高さと角度で指定してください。';

/** 円筒の面の座標系が読めない・拡大縮小を含む・計算した点と OCCT の点が食い違うとき(fail closed)。 */
const CYLINDER_FRAME_MESSAGE = '円筒の面の向きを確かめられませんでした。面を選び直してください。';

/** 管の内面から、内側の空洞より太い穴をあけようとした(刃物が空洞に入らない)。 */
const CYLINDER_BORE_TOO_SMALL_MESSAGE =
  '穴またはざぐりの直径が、選んだ円筒の内面の直径以上です。径を小さくするか、外側の面を選んでください。';

/** 中心の点が 1 つも無いとき。 */
const NO_CENTER_MESSAGE = '穴の中心になる点が選ばれていません。';

/** 中心の座標に数でない値(NaN・∞)が混ざっているとき。 */
const CENTER_NOT_FINITE_MESSAGE = '穴の中心の位置が数になっていません。';

const DIAMETER_MESSAGE = '穴の直径は 0 より大きい数にしてください。';

const DEPTH_MESSAGE = '穴の深さは 0 より大きい数にしてください。';

/** ざぐりの径が下穴の径以下のとき(広げる場所が無い)。 */
const COUNTERBORE_DIAMETER_MESSAGE = 'ざぐりの径は穴の径より大きくしてください。';

/** ざぐりの深さが 0 以下・非数のとき。 */
const COUNTERBORE_DEPTH_MESSAGE = 'ざぐりの深さは 0 より大きい数にしてください。';

/**
 * 皿もみの角度が範囲の外のとき。角度は**円錐の開き角**(90 度皿なら半角 45 度)で、
 * ラジアンで受け取る(度からの換算は model の責務。makeHole の傾き角と同じ約束)。
 */
const COUNTERSINK_ANGLE_MESSAGE = '皿もみの角度は 0 度より大きく 180 度未満にしてください。';

/** 皿もみの頭径が下穴の径以下のとき(円錐が作れない)。 */
const COUNTERSINK_DIAMETER_MESSAGE = '皿もみの頭の径は穴の径より大きくしてください。';

/** 入口の形を下穴と 1 つにまとめられなかったとき。 */
const ENTRY_FAILED_MESSAGE = '穴の入口の形を作れませんでした。ざぐり・皿もみの寸法を見直してください。';

/** 傾き角は面に垂直(0 度)から、面と平行になる手前(90 度)まで。 */
const TILT_ANGLE_MESSAGE = '穴の傾きは 0 度以上 90 度未満にしてください。';

/** 方位角には範囲が無い(何周しても同じ向きになる)ので、数であることだけを確かめる。 */
const TILT_AZIMUTH_MESSAGE = '穴の傾きの向きは数にしてください。';

/** ブーリアンそのものが成立しなかったとき。 */
const HOLE_FAILED_MESSAGE = '穴をあけられませんでした。位置や径を見直してください。';

/** 対象が丸ごと削れてしまったとき。 */
const NOTHING_LEFT_MESSAGE = '穴をあけたら立体が残りませんでした。径か深さを小さくしてください。';

/**
 * 削れた量が 0 だったとき(中心が材料から外れている、向きが材料をかすめない)。
 *
 * **黙って通さずに断る**のは、通すと「穴の段があるのに形が 1 つも変わらない」立体が
 * ツリーに並び、利用者が理由を知る手立てが無くなるためである(NFR-UX-5 の
 * 「理由提示」、FR-504)。断れば P2 の作り(ツリーの赤い印・プロパティの理由・
 * ステータスバー)がそのまま働き、どの段を直せばよいかが分かる。
 * パターン(§0.a-0.20)で一部の穴だけが材料を外れる場合は、他の穴が削れていれば
 * 削れた量が 0 にならないので、この断りには当たらない。
 */
const NOTHING_REMOVED_MESSAGE = '穴が材料に当たりませんでした。中心の位置や向きを見直してください。';

/**
 * 体積差だけで切削ありと判定する閾値(mm³)。これ未満や負の差は積分誤差と区別できないため、
 * 対象と結果の差で得た除去立体を調べる。微小な実切削をこの閾値だけで拒否しない。
 */
const MIN_REMOVED_VOLUME_MM3 = 1e-9;

/**
 * 穴の入口の形(FR-422、計画書 P5 §0.a-0.39)。
 *
 * 穴の種類を増やすのではなく**同じ穴の入口だけを広げる**指定にしてある(§0.a-0.39 の承認)。
 * 既定は `plain`(広げない)で、読み手が古い文書へ補う値もこれになる。
 *
 * - `counterbore`(ざぐり): 径 `diameter`・深さ `depth` の円柱で入口を広げる。
 *   円筒面では高さ・角度で決まる入口から放射方向へ測った深さで、底は穴の軸に垂直な平面。
 * - `countersink`(皿もみ): 頭径 `diameter`・開き角 `angle`(**ラジアン**)の円錐で広げる。
 *   円錐の深さは `(頭径 − 穴の径) / 2 / tan(angle / 2)` で**カーネルが決める**
 *   (model には計算させない。計画書 タスク46 手順4)。
 */
export type HoleEntrySpec =
  | { readonly kind: 'plain' }
  | { readonly kind: 'counterbore'; readonly diameter: number; readonly depth: number }
  | { readonly kind: 'countersink'; readonly diameter: number; readonly angle: number };

/** 入口を広げない指定。引数を省いた呼び出しと、古い文書の既定値がこれになる。 */
const PLAIN_ENTRY: HoleEntrySpec = { kind: 'plain' };

/**
 * 入口の形が材料へ食い込む深さ(mm)。広げない指定(と省略)は 0。
 *
 * **皿もみの深さの式 `(頭径 − 穴の径) / 2 / tan(角度/2)` はここ 1 か所だけに置く。**
 * 工具を作る `makeEntryTool` と、**ねじの山を入口の底から始める `makeThread.ts`**
 * が同じ値を要るので、同じ規則を 2 か所に書かないための輸出である(タスク42c)。
 * 値の正しさ(角度が 0 度より大きく 180 度未満、頭径が穴の径より大きい)は
 * `checkHoleEntry` が先に確かめる約束で、ここは式だけを持つ。
 */
export function holeEntryDepth(entry: HoleEntrySpec | undefined, diameter: number): number {
  if (entry === undefined) {
    return 0;
  }
  switch (entry.kind) {
    case 'plain':
      return 0;
    case 'counterbore':
      return entry.depth;
    case 'countersink':
      // 半角の正接。90 度皿なら tan(45°) = 1 で、深さは (頭径 − 穴の径)/2 になる。
      return (entry.diameter - diameter) / 2 / Math.tan(entry.angle / 2);
  }
}

/** 面の向きから求めた、穴をあけるための座標系(§2.4.2)。 */
export interface HoleFrame {
  /** 掘り進む向き(単位ベクトル)。傾きを適用した後。円筒の側面の穴では最初の位置の向き。 */
  readonly direction: Vec3Tuple;
  /** 面の平面へ投影した中心点。centers と同じ並び。円筒の側面の穴では面の上の入口の点。 */
  readonly origins: readonly Vec3Tuple[];
  /**
   * 円筒の側面の穴(EX05)だけが持つ、`origins` と同じ並びの**位置ごとの**掘る向き。
   * 平面の穴では省く(すべての穴が `direction` へ掘る。今までの作りと 1 命令も変わらない)。
   */
  readonly directions?: readonly Vec3Tuple[];
  /**
   * 円筒の側面の穴(EX05)だけが持つ、`origins` と同じ並びの**凹んだ面(管の内面)の半径**。
   * 凸の面(外面)の位置は null。刃物を口の外側へ戻す量を、内側の空洞の中に収めるために使う。
   */
  readonly concaveRadii?: readonly (number | null)[];
  /**
   * もとの立体の境界箱の対角長(mm)。
   *
   * 面の指紋の位置を正規化する物差し(§2.2.3、この半分)と、貫通穴の長さ・口の余裕
   * (§0.a-0.12)の両方がこの値を使う。**同じ立体から 2 回測ると同じ値になるので、
   * `resolveHoleFrame` が測った 1 回ぶんを `makeHoleTools` へ持ち回る**
   * (以前は段ごとに 2 回測っていた)。
   */
  readonly diagonal: number;
}

/** 数値 3 つがすべて有限か。NaN・∞ を OCCT へ渡すと C++ 側が落ちうるので手前で弾く。 */
function isFiniteTuple(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

/** -0 を +0 へ揃える(subShapes.ts と同じ理由: 指紋と鍵の文字列を揺らさない)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 長さ 1 へ揃える。長さが取れない(0・非数)ときは null。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [
    normalizeZero(value[0] / length),
    normalizeZero(value[1] / length),
    normalizeZero(value[2] / length),
  ];
}

/**
 * 面の平面から、外向きの法線 n・第 1 軸 x・第 2 軸 y と、平面上の 1 点を読む。
 *
 * **法線の向き:** `gp_Pln` が持つ軸は面の向き(Orientation)を見ていないので、
 * 面が `TopAbs_REVERSED` のときは符号を反転して**必ず材料の外を向く**ようにする
 * (`subShapes.ts` の `readFaceGeometry` と同じ規則)。これを入れないと、
 * 掘る向き(法線の逆)が材料の外へ向いて何も削れない。
 *
 * **第 2 軸:** `y = n × x` を、**反転を済ませた n** から作る。こうすると (x, y, n) が
 * 常に右手系になり、方位角は「材料の外から面を見て、第 1 軸から反時計回り」という
 * 一つの意味になる(裏の面でも表の面でも同じ見え方になる)。
 */
interface PlaneFrame {
  readonly normal: Vec3Tuple;
  readonly xAxis: Vec3Tuple;
  readonly yAxis: Vec3Tuple;
  readonly pointOnPlane: Vec3Tuple;
}

function readPlaneFrame(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  keep: Allocations['keep'],
): PlaneFrame {
  // 第 2 引数 false は「面の境界(トリム)を読み込まない」指定(subShapes.ts と同じ)。
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const plane = keep(adaptor.Plane());
  const axis = keep(plane.Axis());
  const normalDirection = keep(axis.Direction());
  const reversed = face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;
  const sign = reversed ? -1 : 1;
  const normal = toUnit([
    normalDirection.X() * sign,
    normalDirection.Y() * sign,
    normalDirection.Z() * sign,
  ]);

  const xAxisLine = keep(plane.XAxis());
  const xDirection = keep(xAxisLine.Direction());
  const xAxis = toUnit([xDirection.X(), xDirection.Y(), xDirection.Z()]);

  const location = keep(plane.Location());

  // gp_Dir は構築時に長さ 1 へ揃うので、ここが null になるのは下地の平面が壊れている場合だけ。
  // 起きたときは利用者に見せられる理由へ変えて止める(NFR-RE-1: 落とさない)。
  if (normal === null || xAxis === null) {
    throw new Error(HOLE_FAILED_MESSAGE);
  }

  return {
    normal,
    xAxis,
    yAxis: cross(normal, xAxis),
    pointOnPlane: [location.X(), location.Y(), location.Z()],
  };
}

/**
 * 掘り進む向き(§2.4.2 の手順 4)。
 *
 * 傾き 0 なら面の法線の逆向き(材料の中へ)。傾けるときは、
 * **方位角が「倒す先の向き」**で、第 1 軸から第 2 軸へ回る向きに測る(§0.a-0.10)。
 *
 *   d = sin(傾き角) × (cos(方位角) x + sin(方位角) y) − cos(傾き角) n
 *
 * 計画書 §2.4.2 の手順 4 は「軸 = cos(方位角)x + sin(方位角)y のまわりに −n を回す」と
 * 書いてあるが、その式だと方位角 0 で倒れる先が**第 2 軸**になり、
 * 「方位角の基準は面の第 1 軸」(§0.a-0.10)と 90 度食い違う。ここでは決定(§0.a-0.10)の
 * 意味を採り、**方位角 0 で第 1 軸へ倒れる**式にした(統括へ報告済み)。
 * 回す軸で言えば `sin(方位角)x − cos(方位角)y` のまわりに −n を回したものと同じで、
 * 傾き 0 のとき d = −n、|d| = 1 はどちらの読み方でも変わらない。
 */
function drillDirection(
  frame: PlaneFrame,
  tiltAngle: number,
  tiltAzimuth: number,
): Vec3Tuple | null {
  const lean = Math.sin(tiltAngle);
  const along = Math.cos(tiltAngle);
  const ax = Math.cos(tiltAzimuth);
  const ay = Math.sin(tiltAzimuth);
  const { normal, xAxis, yAxis } = frame;
  return toUnit([
    lean * (ax * xAxis[0] + ay * yAxis[0]) - along * normal[0],
    lean * (ax * xAxis[1] + ay * yAxis[1]) - along * normal[1],
    lean * (ax * xAxis[2] + ay * yAxis[2]) - along * normal[2],
  ]);
}

/** 点を面の平面へ落とす(§2.4.2 の手順 5)。p' = p − ((p − q)·n) n。 */
function projectOntoPlane(point: Vec3Tuple, frame: PlaneFrame): Vec3Tuple {
  const { normal, pointOnPlane } = frame;
  const gap = dot(
    [point[0] - pointOnPlane[0], point[1] - pointOnPlane[1], point[2] - pointOnPlane[2]],
    normal,
  );
  return [
    normalizeZero(point[0] - gap * normal[0]),
    normalizeZero(point[1] - gap * normal[1]),
    normalizeZero(point[2] - gap * normal[2]),
  ];
}

/** 面の指紋から面 1 枚を選び直す。見つからない・平面でないときは日本語の Error。 */
function resolvePlanarFace(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
  query: SubShapeQuery,
  diagonal: number,
  origins?: CurrentOriginIndex,
): TopoDS_Face {
  return resolveFaceOfKind(oc, shape, faces, query, diagonal, 'plane', NOT_PLANAR_MESSAGE, origins);
}

/**
 * 面の指紋から、決まった種類(平面・円筒)の面 1 枚を選び直す。照合の規則と断り方は平面の穴と同じ
 * (指紋が当たらない・一覧と形が食い違う・番号が消えた = 古い参照は「見つかりません」)。
 * 当たった面が違う種類なら `wrongKindMessage` で断る(曲面へ黙って平面の穴をあけない)。
 */
function resolveFaceOfKind(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
  query: SubShapeQuery,
  diagonal: number,
  surfaceKind: 'plane' | 'cylinder',
  wrongKindMessage: string,
  origins?: CurrentOriginIndex,
): TopoDS_Face {
  if (query.kind !== 'face') {
    // 面以外(辺・頂点)の指紋が来るのは model 側の取り違えだが、
    // 利用者に見せるのは「面が見つからない」で足りる(直し方は同じ = 面を選び直す)。
    throw new Error(MISSING_FACE_MESSAGE);
  }

  // 位置の点は「候補全体の境界箱の対角長の半分」で正規化する(§2.2.3)。
  const scale = diagonal * 0.5;
  const match = resolveFaceReference(faces, query, scale, origins);
  if (match.status !== 'matched') {
    throw new Error(MISSING_FACE_MESSAGE);
  }

  // 一覧は通し番号の順で来る約束だが、番号で引き直して並びに依存しないようにする。
  const info = faces.find((candidate) => candidate.index === match.match.index);
  if (info === undefined) {
    throw new Error(MISSING_FACE_MESSAGE);
  }
  if (info.surfaceKind !== surfaceKind) {
    throw new Error(wrongKindMessage);
  }

  const face = faceAt(oc, shape, match.match.index);
  if (face === null) {
    // 一覧と形が食い違っている(別の形から作った一覧を渡している)合図。
    throw new Error(MISSING_FACE_MESSAGE);
  }
  return face;
}

/**
 * 面の指紋から穴の座標系を求める(§2.4.2 の手順 1〜5)。
 * 面が見つからない・平面でないときは日本語の Error を投げる。
 *
 * 引数の `shape` は解放しない(呼び出し側=形状キャッシュの持ち物)。
 */
/** 円筒の側面の位置の許容(mm)。cylindricalFaceSpan.ts の LINEAR_TOLERANCE と同じ大きさ(OCCT の許容は広げない)。 */
const CYLINDER_LINEAR_TOLERANCE = 1e-7;

/**
 * 選んだ円筒の面の座標系(EX05)。すべて OCCT の解析曲面(`BRepAdaptor_Surface_2(face, true)` の
 * `Cylinder()` と、面の境界を読み込んだパラメーターの範囲)から読む。三角形分割は使わない。
 */
interface CylinderFrame {
  readonly adaptor: BRepAdaptor_Surface;
  /** 軸の上の点(v = 0 の点)。 */
  readonly location: Vec3Tuple;
  /** 面自身の軸の向き(高さの向き)。面の Orientation では反転しない。 */
  readonly zAxis: Vec3Tuple;
  /** 角度 0 の向き(`Position().XDirection()`)。 */
  readonly xAxis: Vec3Tuple;
  /** 角度の正の向きの第 2 軸 `zAxis × xAxis`(右手の回り。Ax3 が左手系でも同じ)。 */
  readonly yAxis: Vec3Tuple;
  readonly radius: number;
  /** OCCT の u は Ax3 が右手系なら角度と同じ向き、左手系なら逆向きに進む。 */
  readonly direct: boolean;
  readonly uFirst: number;
  readonly uLast: number;
  readonly vFirst: number;
  readonly vLast: number;
  /** 面の向きが FORWARD なら +1、REVERSED なら −1(材料の外を向く法線の符号)。 */
  readonly orientationSign: 1 | -1;
}

function readCylinderFrame(oc: OpenCascadeInstance, face: TopoDS_Face, keep: Allocations['keep']): CylinderFrame {
  const orientation = face.Orientation_1();
  if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
    throw new Error(CYLINDER_FRAME_MESSAGE);
  }
  // 第 2 引数 true: 面の境界(トリム)を読み込み、パラメーターの範囲を面の実際の範囲にする。
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    throw new Error(NOT_CYLINDRICAL_MESSAGE);
  }
  // 高さは mm で測るので、拡大縮小を含む形は断る(パラメーター v が mm にならない)。
  const scale = keep(adaptor.Trsf()).ScaleFactor();
  if (!Number.isFinite(scale) || Math.abs(Math.abs(scale) - 1) > 1e-12) {
    throw new Error(CYLINDER_FRAME_MESSAGE);
  }
  const cylinder = keep(adaptor.Cylinder());
  const position = keep(cylinder.Position());
  const zDirection = keep(position.Direction());
  const xDirection = keep(position.XDirection());
  const location = keep(position.Location());
  const zAxis = toUnit([zDirection.X(), zDirection.Y(), zDirection.Z()]);
  const xAxis = toUnit([xDirection.X(), xDirection.Y(), xDirection.Z()]);
  const radius = cylinder.Radius();
  const bounds = [adaptor.FirstUParameter(), adaptor.LastUParameter(), adaptor.FirstVParameter(), adaptor.LastVParameter()];
  const point: Vec3Tuple = [location.X(), location.Y(), location.Z()];
  if (zAxis === null || xAxis === null || !Number.isFinite(radius) || radius <= 0 || !bounds.every(Number.isFinite)
    || !isFiniteTuple(point) || Math.abs(dot(zAxis, xAxis)) > 1e-9) {
    throw new Error(CYLINDER_FRAME_MESSAGE);
  }
  const uFirst = adaptor.FirstUParameter(), uLast = adaptor.LastUParameter();
  const vFirst = adaptor.FirstVParameter(), vLast = adaptor.LastVParameter();
  if (!(uLast > uFirst) || !(vLast > vFirst)) throw new Error(CYLINDER_FRAME_MESSAGE);
  return { adaptor, location: point, zAxis, xAxis, yAxis: cross(zAxis, xAxis), radius, direct: position.Direct(),
    uFirst, uLast, vFirst, vLast, orientationSign: orientation === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1 };
}

/**
 * 位置 1 つの入口の点と掘る向き(EX05)。
 *
 * 1. 高さ・角度を OCCT のパラメーターへ: v = vFirst + 高さ、u = 角度(右手系)または −角度(左手系)を
 *    [uFirst, uFirst + 2π) へ畳む。
 * 2. 境界の判定は `BRepClass_FaceClassifier` の TopAbs_IN だけを通す(外・境界の上・不明は断る。
 *    部分円筒・窓のある面も実際の境界で判定する)。
 * 3. 入口の点と法線は OCCT の `D1(u, v)` から: 法線 = D1U × D1V を面の向き(REVERSED なら反転)で
 *    材料の外へ向け、掘る向きはその逆(材料の中)。管の内面(REVERSED)なら外側の肉へ向かって掘る。
 * 4. 自前の定義 `location + v·z + R(cos 角度·x + sin 角度·y)` と OCCT の点が食い違う、または法線が
 *    その点の放射方向と平行でないときは断る(座標系の読み違いを黙って通さない)。
 */
function cylinderLocationFrame(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  frame: CylinderFrame,
  height: number,
  angle: number,
  keep: Allocations['keep'],
): { readonly origin: Vec3Tuple; readonly direction: Vec3Tuple; readonly concave: boolean } {
  if (!Number.isFinite(height) || !Number.isFinite(angle)) {
    throw new Error(CYLINDER_LOCATION_NOT_FINITE_MESSAGE);
  }
  const period = 2 * Math.PI;
  const v = frame.vFirst + height;
  const turned = frame.direct ? angle : -angle;
  const u = frame.uFirst + (((turned - frame.uFirst) % period) + period) % period;
  if (v < frame.vFirst || v > frame.vLast || u > frame.uLast) {
    throw new Error(CYLINDER_OUTSIDE_MESSAGE);
  }
  const classify = (uu: number) => keep(new oc.BRepClass_FaceClassifier_3(face, keep(new oc.gp_Pnt2d_3(uu, v)),
    CYLINDER_LINEAR_TOLERANCE, false, CYLINDER_LINEAR_TOLERANCE)).State();
  const state = classify(u);
  if (state !== oc.TopAbs_State.TopAbs_IN) {
    // 全周の面の継ぎ目(u = uFirst、角度 0 など)は分類器が境界の上(ON)と答える。継ぎ目なら左右どちらも
    // 面の中(周期で [uFirst, uFirst + 2π) へ畳む)。本物の境界(上下の端・部分円筒の端)は片側が外なので断る。
    const delta = Math.max(1e-6, (1e3 * CYLINDER_LINEAR_TOLERANCE) / frame.radius);
    const fold = (uu: number) => frame.uFirst + (((uu - frame.uFirst) % period) + period) % period;
    const neighbours = [fold(u + delta), fold(u - delta)];
    if (state !== oc.TopAbs_State.TopAbs_ON
      || neighbours.some((uu) => uu > frame.uLast || classify(uu) !== oc.TopAbs_State.TopAbs_IN)) {
      throw new Error(CYLINDER_OUTSIDE_MESSAGE);
    }
  }
  const point = keep(new oc.gp_Pnt_1()), du = keep(new oc.gp_Vec_1()), dv = keep(new oc.gp_Vec_1());
  frame.adaptor.D1(u, v, point, du, dv);
  const natural = toUnit(cross([du.X(), du.Y(), du.Z()], [dv.X(), dv.Y(), dv.Z()]));
  const origin: Vec3Tuple = [normalizeZero(point.X()), normalizeZero(point.Y()), normalizeZero(point.Z())];
  if (natural === null || !isFiniteTuple(origin)) throw new Error(CYLINDER_FRAME_MESSAGE);
  const outward: Vec3Tuple = [natural[0] * frame.orientationSign, natural[1] * frame.orientationSign, natural[2] * frame.orientationSign];
  const radial: Vec3Tuple = [
    Math.cos(angle) * frame.xAxis[0] + Math.sin(angle) * frame.yAxis[0],
    Math.cos(angle) * frame.xAxis[1] + Math.sin(angle) * frame.yAxis[1],
    Math.cos(angle) * frame.xAxis[2] + Math.sin(angle) * frame.yAxis[2],
  ];
  const { location, zAxis, radius } = frame;
  const expected: Vec3Tuple = [
    location[0] + v * zAxis[0] + radius * radial[0],
    location[1] + v * zAxis[1] + radius * radial[1],
    location[2] + v * zAxis[2] + radius * radial[2],
  ];
  // 許容は位置の大きさに比例させる(1e-7 mm を 1 mm あたりの基準にする。OCCT の許容は広げない)。
  const scale = Math.max(1, radius, Math.abs(v), Math.hypot(location[0], location[1], location[2]));
  if (Math.hypot(origin[0] - expected[0], origin[1] - expected[1], origin[2] - expected[2]) > CYLINDER_LINEAR_TOLERANCE * scale
    || Math.abs(Math.abs(dot(outward, radial)) - 1) > 1e-9) {
    throw new Error(CYLINDER_FRAME_MESSAGE);
  }
  // 材料の外向きが軸の側を向く(放射方向と逆)なら凹んだ面(管の内面)。
  return { origin, direction: [normalizeZero(-outward[0]), normalizeZero(-outward[1]), normalizeZero(-outward[2])],
    concave: dot(outward, radial) < 0 };
}

/**
 * 円筒の側面の穴の座標系(EX05)。平面の穴の `resolveHoleFrame` と同じ照合・断り方で面を選び直し、
 * 位置ごとに入口の点と掘る向きを返す。中心の点・傾きは受け付けない(`CYLINDER_UNSUPPORTED_MESSAGE`)。
 */
function resolveCylindricalHoleFrame(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
  spec: Pick<HoleStepSpec, 'face' | 'centers' | 'tiltAngle' | 'tiltAzimuth'> & { readonly cylindrical: NonNullable<HoleStepSpec['cylindrical']> },
  origins?: CurrentOriginIndex,
): HoleFrame {
  if (spec.cylindrical.kind !== 'cylinder-face' || spec.centers.length !== 0 || spec.tiltAngle !== 0 || spec.tiltAzimuth !== 0) {
    throw new Error(CYLINDER_UNSUPPORTED_MESSAGE);
  }
  if (spec.cylindrical.locations.length === 0) {
    throw new Error(NO_CYLINDER_LOCATION_MESSAGE);
  }
  for (const location of spec.cylindrical.locations) {
    if (!Number.isFinite(location.height) || !Number.isFinite(location.angle)) {
      throw new Error(CYLINDER_LOCATION_NOT_FINITE_MESSAGE);
    }
  }
  const diagonal = boundingDiagonal(oc, shape);
  const face = resolveFaceOfKind(oc, shape, faces, spec.face, diagonal, 'cylinder', NOT_CYLINDRICAL_MESSAGE, origins);
  const { keep, release } = createAllocations();
  try {
    keep(face);
    const frame = readCylinderFrame(oc, face, keep);
    const placed = spec.cylindrical.locations.map(location =>
      cylinderLocationFrame(oc, face, frame, location.height, location.angle, keep));
    const first = placed[0];
    if (first === undefined) throw new Error(NO_CYLINDER_LOCATION_MESSAGE);
    return { direction: first.direction, origins: placed.map(row => row.origin), directions: placed.map(row => row.direction),
      concaveRadii: placed.map(row => (row.concave ? frame.radius : null)), diagonal };
  } finally {
    release();
  }
}

export function resolveHoleFrame(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
  spec: Pick<HoleStepSpec, 'face' | 'centers' | 'tiltAngle' | 'tiltAzimuth' | 'cylindrical'>,
  origins?: CurrentOriginIndex,
): HoleFrame {
  if (spec.cylindrical !== undefined) {
    return resolveCylindricalHoleFrame(oc, shape, faces, { ...spec, cylindrical: spec.cylindrical }, origins);
  }
  if (spec.centers.length === 0) {
    throw new Error(NO_CENTER_MESSAGE);
  }
  for (const center of spec.centers) {
    if (!isFiniteTuple(center)) {
      throw new Error(CENTER_NOT_FINITE_MESSAGE);
    }
  }
  // 角度はラジアン(度からの換算は model の責務。docs/報告記録.md 2026-09-02 18:23)。
  if (!Number.isFinite(spec.tiltAngle) || spec.tiltAngle < 0 || spec.tiltAngle >= Math.PI / 2) {
    throw new Error(TILT_ANGLE_MESSAGE);
  }
  if (!Number.isFinite(spec.tiltAzimuth)) {
    throw new Error(TILT_AZIMUTH_MESSAGE);
  }

  // 境界箱の対角長は、指紋の物差しと工具の長さの両方が使う。段で 1 回だけ測って持ち回る
  // (`HoleFrame.diagonal` の注釈)。
  const diagonal = boundingDiagonal(oc, shape);
  const face = resolvePlanarFace(oc, shape, faces, spec.face, diagonal, origins);
  const { keep, release } = createAllocations();

  try {
    keep(face);
    const planeFrame = readPlaneFrame(oc, face, keep);
    const direction = drillDirection(planeFrame, spec.tiltAngle, spec.tiltAzimuth);
    if (direction === null) {
      throw new Error(HOLE_FAILED_MESSAGE);
    }
    return {
      direction,
      origins: spec.centers.map((center) => projectOntoPlane(center, planeFrame)),
      diagonal,
    };
  } finally {
    release();
  }
}

/**
 * 入口の形の値を確かめる(FR-504)。**OCCT を呼ぶ前に済ませる**(NaN・∞ を C++ へ渡さない)。
 * 各節は return で閉じる(no-fallthrough)。
 */
function checkHoleEntry(entry: HoleEntrySpec, diameter: number): void {
  switch (entry.kind) {
    case 'plain':
      return;
    case 'counterbore':
      if (!Number.isFinite(entry.diameter) || entry.diameter <= diameter) {
        throw new Error(COUNTERBORE_DIAMETER_MESSAGE);
      }
      if (!Number.isFinite(entry.depth) || entry.depth <= 0) {
        throw new Error(COUNTERBORE_DEPTH_MESSAGE);
      }
      return;
    case 'countersink':
      // 角度を先に見るのは、深さの式 `(頭径 − 穴の径)/2 / tan(角度/2)` が
      // 角度の正しさに乗っているためである(0 度なら 0 除算、180 度なら深さ 0)。
      if (!Number.isFinite(entry.angle) || entry.angle <= 0 || entry.angle >= Math.PI) {
        throw new Error(COUNTERSINK_ANGLE_MESSAGE);
      }
      if (!Number.isFinite(entry.diameter) || entry.diameter <= diameter) {
        throw new Error(COUNTERSINK_DIAMETER_MESSAGE);
      }
      return;
  }
}

/**
 * 入口の形(ざぐりの円柱・皿もみの円錐)を 1 つ作る。広げない指定なら null。
 *
 * 下穴と同じ `axes`(口の外側へ margin だけ戻った点と、掘り進む向き)を使うので、
 * 軸は必ず下穴と一致する。**口の外側へも margin だけ伸ばす**のは下穴と同じ理由で、
 * 材料の面とちょうど接する平らな面(ざぐりの底の側ではなく口の側)を作らないためである。
 *
 * 皿もみの円錐は、**同じ開き角のまま口の外側へ伸ばす**(伸ばしたぶん半径が
 * `margin × tan(角度/2)` だけ大きくなる)。材料の外の部分なので削れる量は変わらない。
 */
function makeEntryTool(
  oc: OpenCascadeInstance,
  entry: HoleEntrySpec,
  axes: gp_Ax2,
  diameter: number,
  margin: number,
  keep: Allocations['keep'],
  capture?: (primitive: BRepPrim_Cylinder | BRepPrim_Cone, stage: HoleFaceOrigin['stage']) => void,
): TopoDS_Shape | null {
  switch (entry.kind) {
    case 'plain':
      return null;
    case 'counterbore': {
      const maker = keep(
        new oc.BRepPrimAPI_MakeCylinder_3(axes, entry.diameter / 2, entry.depth + margin),
      );
      const shape = keep(maker.Shape());
      capture?.(keep(maker.Cylinder()), 'counterbore');
      return shape;
    }
    case 'countersink': {
      // 半角の正接。口の外側へ伸ばしたぶんだけ半径を広げるのに要る(深さの式は
      // `holeEntryDepth` に 1 つだけ置いてあるので、ここでは呼ぶだけにする)。
      const tangent = Math.tan(entry.angle / 2);
      const depth = holeEntryDepth(entry, diameter);
      const maker = keep(
        new oc.BRepPrimAPI_MakeCone_3(
          axes,
          entry.diameter / 2 + margin * tangent,
          diameter / 2,
          depth + margin,
        ),
      );
      const shape = keep(maker.Shape());
      capture?.(keep(maker.Cone()), 'countersink');
      return shape;
    }
  }
}

/**
 * 下穴の円柱と入口の形を**和で 1 つの立体にまとめる**。広げない指定なら円柱をそのまま返す。
 *
 * **重なり合う形をコンパウンドのままブーリアンの工具に渡してはいけない**(makeThread.ts の
 * 冒頭の注釈と同じ制限)。2026-09-05 に Node で実測したところ、下穴の円柱とざぐりの円柱を
 * 1 つのコンパウンドへ入れて差し引くと、例外も出さずに**下穴だけが削れた結果**が返った
 * (板 12000 に φ6 貫通 + φ11 深さ 4 ざぐりで 11717.256… = 下穴だけの値)。
 * 先に和で 1 つにまとめると期待どおり 11450.221285621785 になる。
 *
 * 中心が離れた穴どうしは重ならないので、**まとめるのは 1 つの中心の中だけ**で足りる。
 * コンパウンドと Cut は今までどおり 1 回のままである(§1.4-⑧ の実測を壊さない)。
 */
function fuseEntryTool(
  oc: OpenCascadeInstance,
  drill: TopoDS_Shape,
  entryTool: TopoDS_Shape | null,
  keep: Allocations['keep'],
  onBuilt?: Parameters<typeof booleanOp>[5],
): TopoDS_Shape {
  if (entryTool === null) {
    return drill;
  }
  try {
    return keep(booleanOp(oc, 'union', drill, entryTool, undefined, onBuilt)).shape;
  } catch (error) {
    throw new Error(ENTRY_FAILED_MESSAGE, { cause: error });
  }
}

/**
 * 穴の工具(円柱の集まり)を作る。変換(パターン)もここで適用する。
 *
 * 貫通(`depth === null`)は対象の境界箱の対角長から長さを決める(§0.a-0.12)。
 * 止まり穴は平底で、深さは面から測る(§0.a-0.11。ドリルの 118 度の先端は
 * 図面の簡略図示と合わせて P8 で判断する)。
 *
 * **変換(パターン、§0.a-0.20)の決め:** 円柱は「中心の数 × 変換の数」だけ作る。
 * `transforms` が空なら恒等 1 つとして扱う(計画書 タスク9 手順3)ので、
 * パターンでない穴はもとの位置に 1 本ずつ立つ。パターンのときに model が渡すのは
 * **もとの位置ぶんを除いた n−1 個**で、もとの穴はすでに対象のボディに開いている
 * (§2.7 の畳み方の手順 4)。恒等の変換は複製を作らずにもとの円柱をそのまま使う
 * (要らない複製を作らないため。結果は同じ)。
 *
 * **入口の形(`entry`、FR-422):** ざぐりの円柱・皿もみの円錐は、中心ごとに下穴の円柱と
 * 和でまとめてから複合へ足す(`fuseEntryTool` の注釈)。既定は `plain` で、
 * そのときの作りは今までと 1 命令も変わらない(穴 20 個の板の費用を増やさない)。
 *
 * 返した handle の delete() で、円柱・軸・複製・コンパウンドをまとめて解放する。
 * もとの立体そのものは要らない(`frame.diagonal` にその境界箱の対角長が入っている)。
 */
interface HoleToolNaming {
  readonly featureId: string;
  readonly centerAnchors: readonly HoleCenterAnchor[];
  readonly placementRoles: readonly HolePlacementRole[];
}
interface HoleToolsHandle extends OcctShapeHandle {
  readonly newHoleFaces: readonly NativeHoleToolFace[];
  readonly originProofLimitExceeded: boolean;
  readonly originProofMissingNativeMap: boolean;
}

export function makeHoleTools(
  oc: OpenCascadeInstance,
  frame: HoleFrame,
  diameter: number,
  depth: number | null,
  transforms: readonly RigidTransformSpec[],
  entry: HoleEntrySpec = PLAIN_ENTRY,
  naming?: HoleToolNaming,
): HoleToolsHandle {
  if (!Number.isFinite(diameter) || diameter <= 0) {
    throw new Error(DIAMETER_MESSAGE);
  }
  if (depth !== null && (!Number.isFinite(depth) || depth <= 0)) {
    throw new Error(DEPTH_MESSAGE);
  }
  checkHoleEntry(entry, diameter);
  if (frame.origins.length === 0) {
    throw new Error(NO_CENTER_MESSAGE);
  }

  const { diagonal } = frame;
  if (!Number.isFinite(diagonal) || diagonal <= 0) {
    // 中身の無い形。ここまで来ることは無い想定だが、0 長の円柱を作らせない。
    throw new Error(HOLE_FAILED_MESSAGE);
  }

  // 貫通穴の余裕(§0.a-0.12)。面とちょうど接する円柱は OCCT のブーリアンが最も苦手と
  // する形(接触面ができる)なので、口の外側へこのぶん伸ばした位置から掘り始め、
  // 長さも両側へこのぶん足す。
  const margin = booleanMargin(diagonal);
  const length = depth === null ? diagonal + 2 * margin : depth + margin;
  // 円筒の側面の穴(EX05)は位置ごとに向きが違う。並びが食い違えば作らない(取り違えた向きで掘らない)。
  if (frame.directions !== undefined && (frame.directions.length !== frame.origins.length || entry.kind === 'countersink')) {
    throw new Error(frame.directions.length !== frame.origins.length ? HOLE_FAILED_MESSAGE : CYLINDER_UNSUPPORTED_MESSAGE);
  }
  if (frame.concaveRadii !== undefined && frame.concaveRadii.length !== frame.origins.length) {
    throw new Error(HOLE_FAILED_MESSAGE);
  }
  const placements = transformsOrIdentity(transforms);
  if (naming !== undefined && (naming.centerAnchors.length !== frame.origins.length
    || naming.placementRoles.length !== transforms.length)) throw new Error('Hole producer roles do not match the operation');
  const placementRoles: readonly HolePlacementRole[] = transforms.length === 0
    ? [{ kind: 'original' }] : naming?.placementRoles ?? [];
  // Bound new proof allocation without lowering the existing geometry input scale.
  let originProofLimitExceeded = frame.origins.length > 100_000 / (placements.length * (entry.kind === 'plain' ? 3 : 6));
  let originProofMissingNativeMap = false;
  const newHoleFaces: NativeHoleToolFace[] = [];
  const { keep, release } = createAllocations();

  try {
    const builder = keep(new oc.BRep_Builder());
    const compound = keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);

    for (const [centerOffset, origin] of frame.origins.entries()) {
      const direction = frame.directions?.[centerOffset] ?? frame.direction;
      // 管の内面(凹んだ面、EX05)では、戻る量を内側の空洞の中に収める。最大刃径を検査してから
      // 戻り量を決める。平面・外面の工具は今までの値を保つ。
      const concaveRadius = frame.concaveRadii?.[centerOffset] ?? null;
      const largestToolRadius = (entry.kind === 'counterbore' ? entry.diameter : diameter) / 2;
      if (concaveRadius !== null && largestToolRadius >= concaveRadius) {
        throw new Error(CYLINDER_BORE_TOO_SMALL_MESSAGE);
      }
      // 内面では plain でも太い刃物の入口が margin より盛り上がる。始点を空洞の軸まで戻せば、最大刃径が Ri 未満のとき
      // 入口全体を空洞内へ収め、反対側の壁には届かない。深さは戻り量ではなく入口から測る。
      const backoff = concaveRadius ?? margin;
      const toolLength = backoff === margin ? length : depth === null ? diagonal + margin + backoff : depth + backoff;
      // 口の外側へ backoff(ふつうは margin)だけ戻った位置から掘り始める(接触面を作らない)。
      const base = keep(
        new oc.gp_Pnt_3(
          origin[0] - direction[0] * backoff,
          origin[1] - direction[1] * backoff,
          origin[2] - direction[2] * backoff,
        ),
      );
      const axisDirection = keep(new oc.gp_Dir_4(direction[0], direction[1], direction[2]));
      const axes = keep(new oc.gp_Ax2_3(base, axisDirection));
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, diameter / 2, toolLength));
      // Shape() は maker の中の実体を指すので、控えへ maker の後に積む(解放は逆順)。
      const cylinder = keep(maker.Shape());
      const center = naming?.centerAnchors[centerOffset];
      const stageFaces: NativeHoleToolFace[] = [];
      const capture = (primitive: BRepPrim_Cylinder | BRepPrim_Cone, stage: HoleFaceOrigin['stage']): void => {
        for (const [role, face] of [
          ['wall', keep(primitive.LateralFace())], ['floor', keep(primitive.TopFace())],
          ['entry-cap', keep(primitive.BottomFace())],
        ] as const) {
          stageFaces.push(naming === undefined || center === undefined ? { face, reason: 'unsupported-producer' } : { face, origin: { version: 1, shapeKind: 'face', identity: {
            kind: 'hole-face', featureId: naming.featureId, center, placement: { kind: 'original' }, stage, role,
          } } });
        }
      };
      if (!originProofLimitExceeded && !originProofMissingNativeMap) capture(keep(maker.Cylinder()), 'bore');
      const entryTool = makeEntryTool(oc, entry, axes, diameter, backoff, keep, originProofLimitExceeded || originProofMissingNativeMap ? undefined : capture);
      let fusedFaces: readonly NativeHoleToolFace[] = stageFaces;
      const tool = fuseEntryTool(oc, cylinder, entryTool, keep, originProofLimitExceeded || originProofMissingNativeMap ? undefined : (fuse, output) => {
        try { fusedFaces = rebindHoleToolFaces(oc, fuse, output, stageFaces, keep); }
        catch (error) {
          if (error instanceof OriginHistoryLimitError) originProofLimitExceeded = true;
          else if (error instanceof HoleOriginMapError) originProofMissingNativeMap = true;
          else throw error;
          fusedFaces = []; newHoleFaces.length = 0;
        }
      });

      for (const [placementOffset, placement] of placements.entries()) {
        const role = placementRoles[placementOffset];
        const placedFaces: NativeHoleToolFace[] = fusedFaces.map((producer): NativeHoleToolFace => {
          if (producer.origin === undefined || role === undefined) return { face: producer.face, reason: 'unsupported-producer' };
          if (producer.origin.identity.kind !== 'hole-face') throw new Error('Unexpected hole tool producer');
          return { face: producer.face, origin: { ...producer.origin, identity: { ...producer.origin.identity, placement: role } } };
        });
        if (isIdentityTransform(placement)) {
          builder.Add(compound, tool);
          newHoleFaces.push(...placedFaces);
          continue;
        }
        const moved = transformShape(oc, tool, placement, originProofLimitExceeded || originProofMissingNativeMap ? undefined : (transform, output) => {
          try { newHoleFaces.push(...rebindTransformedHoleFaces(oc, transform, output, placedFaces, keep)); }
          catch (error) {
            if (error instanceof OriginHistoryLimitError) originProofLimitExceeded = true;
            else if (error instanceof HoleOriginMapError) originProofMissingNativeMap = true;
            else throw error;
            newHoleFaces.length = 0;
          }
        });
        // handle は「複製した形 → maker → 変換」をまとめて解放する。控えへ積んで
        // 円柱より後に置くと、解放が逆順(複製 → 円柱)になり順序が保たれる。
        keep(moved);
        builder.Add(compound, moved.shape);
      }
    }

    return { shape: compound, newHoleFaces, originProofLimitExceeded, originProofMissingNativeMap, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 工具を差し引く。`booleanOp` の断りを、穴の言葉へ言い換える。
 *
 * `booleanOp` は理由を日本語の文言でしか返さない(機械で読める符号を持たない)。
 * 「立体が残らなかった」だけは利用者への直し方が違う(径か深さを小さくする)ので
 * 言い回しで見分け、外れたときは一般の理由にする。文言が変わったときは
 * makeHole.test.ts の「φ100 の貫通穴」の検査が落ちて気づける。
 */
function cutHoles(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tools: TopoDS_Shape,
  semantic?: BooleanSemanticContext,
): BooleanResult {
  try {
    return booleanOp(oc, 'subtract', target, tools, semantic);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason.includes('立体が残りませんでした') ? NOTHING_LEFT_MESSAGE : HOLE_FAILED_MESSAGE, {
      cause: error,
    });
  }
}

/**
 * A difference of two large, fixed-quadrature volumes can be negative for a real tiny cut.
 * In that ambiguous case measure the actual removed solid, not target/tool overlap (which
 * would also accept an erroneous no-op cut). Exact tangency has no removed solid.
 * Both inputs are borrowed: even a no-op boolean must only see independently copied topology.
 */
export function hasHoleMaterialRemoval(
  oc: OpenCascadeInstance, target: TopoDS_Shape, result: TopoDS_Shape, volumeDifference: number,
): boolean {
  if (Number.isFinite(volumeDifference) && volumeDifference >= MIN_REMOVED_VOLUME_MM3) return true;
  const owned = createAllocations();
  try {
    const copy = (shape: TopoDS_Shape): TopoDS_Shape => {
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(shape, true, true));
      if (!copier.IsDone()) throw new Error(HOLE_FAILED_MESSAGE);
      const copied = owned.keep(copier.Shape());
      if (copied.IsNull() || copied.IsSame(shape)) throw new Error(HOLE_FAILED_MESSAGE);
      return copied;
    };
    const removed = buildBooleanShape(oc, 'subtract', copy(target), [copy(result)],
      owned.keep(new oc.Message_ProgressRange_1()), owned);
    if (!hasSolid(oc, removed)) return false;
    const properties = owned.keep(new oc.GProp_GProps_1());
    const error = oc.BRepGProp.VolumeProperties_2(removed, properties, 1e-9, false, false);
    const volume = properties.Mass();
    return Number.isFinite(error) && Math.abs(error) < 1e-8 && Number.isFinite(volume) && volume > 0;
  } finally { owned.release(); }
}

/**
 * 穴をあける(FR-405)。対象は消費せず、新しい形を返す。
 *
 * 引数の `target` は解放しない(形状キャッシュの持ち物。`booleanOp` と同じ約束)。
 * `faces` は `target` から作った面の一覧(`collectSubShapes` の `faces`)で、
 * 別の形から作った一覧を渡すと「面が見つからない」で断る。
 *
 * 工具、対象の独立した複製、差の結果は、返す handle の delete() まで所有する。
 * 途中で断った場合は同じ控えを解放する。借りた対象の形やフラグには書き戻さない。
 *
 * 返す値は `booleanOp` の結果そのもので、**測り済みの体積を持ったまま**返る
 * (`BooleanResult` の注釈。呼び出し側の `buildSolidBodyMesh` が測り直さずに使う)。
 *
 * `entry` は入口の形(FR-422)。**省くと今までどおりの真っ直ぐな穴**になるので、
 * 段の型(`HoleStepSpec`)へ欄が増えるまで(タスク42)は呼び出し側を変えずに済む。
 */
export function makeHole(
  oc: OpenCascadeInstance,
  spec: HoleStepSpec,
  target: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
  entry: HoleEntrySpec = PLAIN_ENTRY,
  origins?: CurrentOriginIndex,
  featureId?: string,
): BooleanResult {
  const frame = resolveHoleFrame(oc, target, faces, spec, origins);
  const naming = featureId !== undefined && spec.centerAnchors !== undefined && spec.placementRoles !== undefined
    ? { featureId, centerAnchors: spec.centerAnchors, placementRoles: spec.placementRoles } : undefined;
  const owned = createAllocations();
  try {
    const tools = owned.keep(makeHoleTools(oc, frame, spec.diameter, spec.depth, spec.transforms, entry, naming));
    // A no-op native cut may reuse its input solid in an output compound and
    // freeze that TShape even in non-destructive mode. Work on independently
    // copied topology, geometry and mesh; never restore flags on shared input.
    const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(target, true, true));
    if (!copier.IsDone()) throw new Error(HOLE_FAILED_MESSAGE);
    const workingTarget = owned.keep(copier.Shape());
    if (workingTarget.IsNull() || workingTarget.IsSame(target)) throw new Error(HOLE_FAILED_MESSAGE);
    const workingOrigins = origins === undefined ? undefined
      : rebindTransformedOrigins(oc, origins, target, copier, workingTarget);
    const result = owned.keep(cutHoles(oc, workingTarget, tools.shape,
      featureId !== undefined && workingOrigins !== undefined
        ? { featureId, target: workingOrigins, newHoleFaces: tools.newHoleFaces } : undefined));

    // Ambiguous volume differences require checking the actual removed solid.
    const removed = measureVolume(oc, target) - result.volume;
    if (!hasHoleMaterialRemoval(oc, workingTarget, result.shape, removed)) {
      throw new Error(NOTHING_REMOVED_MESSAGE);
    }
    return { ...result, delete: owned.release,
      ...(tools.originProofLimitExceeded
        ? { origins: { version: 1 as const, state: 'untracked' as const, reason: 'limit' as const } }
        : tools.originProofMissingNativeMap
          ? { origins: { version: 1 as const, state: 'untracked' as const, reason: 'missing-native-map' as const } } : {}),
    };
  } catch (error) {
    owned.release();
    throw error;
  }
}
