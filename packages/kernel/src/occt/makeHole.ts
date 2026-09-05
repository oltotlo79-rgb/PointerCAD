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
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { booleanOp, type BooleanResult } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { matchFace } from './matchSubShape.js';
import { measureVolume } from './solidMesh.js';
import { boundingDiagonal, faceAt } from './subShapes.js';
import { isIdentityTransform, transformShape, transformsOrIdentity } from './transformShape.js';

/** 面が選び直せなかったとき(FR-504、§2.2.5)。 */
const MISSING_FACE_MESSAGE =
  '穴をあけるもとの面が見つかりません。形が大きく変わったため、選び直してください。';

/** P3 の制限。曲がった面への穴は、面の平面が決まらないので扱わない。 */
const NOT_PLANAR_MESSAGE = '穴をあけられるのは平らな面だけです。平らな面を選び直してください。';

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
 * これ未満(mm³)しか削れていなければ「何も削れなかった」とみなす。
 * `booleanOp` の「立体が残らなかった」の判定と同じ大きさに揃えてある。
 */
const MIN_REMOVED_VOLUME_MM3 = 1e-9;

/**
 * 貫通穴の余裕(§0.a-0.12)。対象の境界箱の対角長 L に対し `L × 0.01 + 1mm`。
 *
 * 面とちょうど接する円柱は OCCT のブーリアンが最も苦手とする形(接触面ができる)なので、
 * 口の外側へこのぶん伸ばした位置から掘り始め、長さも両側へこのぶん足す。
 * 割合(1%)と下限(1mm)の 2 本立てにしてあるのは、部品が大きいときは比例して、
 * 小さいときでも必ず 1mm 以上の余裕を取るためである。
 */
const MARGIN_RATIO = 0.01;
const MARGIN_MIN_MM = 1;

/**
 * 穴の入口の形(FR-422、計画書 P5 §0.a-0.39)。
 *
 * 穴の種類を増やすのではなく**同じ穴の入口だけを広げる**指定にしてある(§0.a-0.39 の承認)。
 * 既定は `plain`(広げない)で、読み手が古い文書へ補う値もこれになる。
 *
 * - `counterbore`(ざぐり): 径 `diameter`・深さ `depth` の円柱で入口を広げる。
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

/** 面の向きから求めた、穴をあけるための座標系(§2.4.2)。 */
export interface HoleFrame {
  /** 掘り進む向き(単位ベクトル)。傾きを適用した後。 */
  readonly direction: Vec3Tuple;
  /** 面の平面へ投影した中心点。centers と同じ並び。 */
  readonly origins: readonly Vec3Tuple[];
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
): TopoDS_Face {
  if (query.kind !== 'face') {
    // 面以外(辺・頂点)の指紋が来るのは model 側の取り違えだが、
    // 利用者に見せるのは「面が見つからない」で足りる(直し方は同じ = 面を選び直す)。
    throw new Error(MISSING_FACE_MESSAGE);
  }

  // 位置の点は「候補全体の境界箱の対角長の半分」で正規化する(§2.2.3)。
  const scale = diagonal * 0.5;
  const match = matchFace(faces, query, scale);
  if (match === null) {
    throw new Error(MISSING_FACE_MESSAGE);
  }

  // 一覧は通し番号の順で来る約束だが、番号で引き直して並びに依存しないようにする。
  const info = faces.find((candidate) => candidate.index === match.index);
  if (info === undefined) {
    throw new Error(MISSING_FACE_MESSAGE);
  }
  if (info.surfaceKind !== 'plane') {
    throw new Error(NOT_PLANAR_MESSAGE);
  }

  const face = faceAt(oc, shape, match.index);
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
export function resolveHoleFrame(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
  spec: Pick<HoleStepSpec, 'face' | 'centers' | 'tiltAngle' | 'tiltAzimuth'>,
): HoleFrame {
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
  const face = resolvePlanarFace(oc, shape, faces, spec.face, diagonal);
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
): TopoDS_Shape | null {
  switch (entry.kind) {
    case 'plain':
      return null;
    case 'counterbore': {
      const maker = keep(
        new oc.BRepPrimAPI_MakeCylinder_3(axes, entry.diameter / 2, entry.depth + margin),
      );
      return keep(maker.Shape());
    }
    case 'countersink': {
      // 半角の正接。90 度皿なら tan(45°) = 1 で、深さは (頭径 − 穴の径)/2 になる。
      const tangent = Math.tan(entry.angle / 2);
      const depth = (entry.diameter - diameter) / 2 / tangent;
      const maker = keep(
        new oc.BRepPrimAPI_MakeCone_3(
          axes,
          entry.diameter / 2 + margin * tangent,
          diameter / 2,
          depth + margin,
        ),
      );
      return keep(maker.Shape());
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
): TopoDS_Shape {
  if (entryTool === null) {
    return drill;
  }
  try {
    return keep(booleanOp(oc, 'union', drill, entryTool)).shape;
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
export function makeHoleTools(
  oc: OpenCascadeInstance,
  frame: HoleFrame,
  diameter: number,
  depth: number | null,
  transforms: readonly RigidTransformSpec[],
  entry: HoleEntrySpec = PLAIN_ENTRY,
): OcctShapeHandle {
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

  const margin = diagonal * MARGIN_RATIO + MARGIN_MIN_MM;
  const length = depth === null ? diagonal + 2 * margin : depth + margin;
  const { direction } = frame;
  const placements = transformsOrIdentity(transforms);
  const { keep, release } = createAllocations();

  try {
    const builder = keep(new oc.BRep_Builder());
    const compound = keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);

    for (const origin of frame.origins) {
      // 口の外側へ margin だけ戻った位置から掘り始める(接触面を作らない)。
      const base = keep(
        new oc.gp_Pnt_3(
          origin[0] - direction[0] * margin,
          origin[1] - direction[1] * margin,
          origin[2] - direction[2] * margin,
        ),
      );
      const axisDirection = keep(new oc.gp_Dir_4(direction[0], direction[1], direction[2]));
      const axes = keep(new oc.gp_Ax2_3(base, axisDirection));
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, diameter / 2, length));
      // Shape() は maker の中の実体を指すので、控えへ maker の後に積む(解放は逆順)。
      const cylinder = keep(maker.Shape());
      const tool = fuseEntryTool(oc, cylinder, makeEntryTool(oc, entry, axes, diameter, margin, keep), keep);

      for (const placement of placements) {
        if (isIdentityTransform(placement)) {
          builder.Add(compound, tool);
          continue;
        }
        const moved = transformShape(oc, tool, placement);
        // handle は「複製した形 → maker → 変換」をまとめて解放する。控えへ積んで
        // 円柱より後に置くと、解放が逆順(複製 → 円柱)になり順序が保たれる。
        keep(moved);
        builder.Add(compound, moved.shape);
      }
    }

    return { shape: compound, delete: release };
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
): BooleanResult {
  try {
    return booleanOp(oc, 'subtract', target, tools);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason.includes('立体が残りませんでした') ? NOTHING_LEFT_MESSAGE : HOLE_FAILED_MESSAGE, {
      cause: error,
    });
  }
}

/**
 * 穴をあける(FR-405)。対象は消費せず、新しい形を返す。
 *
 * 引数の `target` は解放しない(形状キャッシュの持ち物。`booleanOp` と同じ約束)。
 * `faces` は `target` から作った面の一覧(`collectSubShapes` の `faces`)で、
 * 別の形から作った一覧を渡すと「面が見つからない」で断る。
 *
 * 工具(円柱のコンパウンド)は差し引いた直後にこの関数が解放する。
 * 差し引きが終われば結果の形は工具と切り離されている(2026-09-03 に Node で実測:
 * 工具の解放後も体積・面数・妥当性・三角形分割がすべて解放前と同じだった)。
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
): BooleanResult {
  const frame = resolveHoleFrame(oc, target, faces, spec);
  const tools = makeHoleTools(oc, frame, spec.diameter, spec.depth, spec.transforms, entry);

  let result: BooleanResult;
  try {
    result = cutHoles(oc, target, tools.shape);
  } finally {
    tools.delete();
  }

  try {
    // 何も削れていないなら断る(NOTHING_REMOVED_MESSAGE の説明を参照)。
    // hasSolid と体積 0 は booleanOp が済ませてあるので、ここでは減った量だけを見る。
    // 結果の体積は booleanOp がすでに測ってあるので測り直さない。
    const removed = measureVolume(oc, target) - result.volume;
    if (!(removed >= MIN_REMOVED_VOLUME_MM3)) {
      throw new Error(NOTHING_REMOVED_MESSAGE);
    }
    return result;
  } catch (error) {
    result.delete();
    throw error;
  }
}
