/**
 * スイープ(経路に沿った押し出し、FR-409)。計画書 P5 §2.9、タスク37。
 *
 * 閉じた断面(スケッチの輪郭)を、開いた経路(スケッチの線・円弧・スプラインの連なり)に
 * 沿って `BRepOffsetAPI_MakePipeShell` で掃引して立体にする。道具は P3 のばね
 * (`makeSpring.ts`)・ねじ(`makeThread.ts`)で実運用中のものと同じで、違いは
 * 「経路が利用者の描いた曲線であること」と「断面が円とは限らないこと」の 2 点だけである。
 *
 * ---
 *
 * ## 向きの規則(§0.a-0.43 の承認どおり)
 *
 * - `frenet = true`(既定): `SetMode_1(true)`。断面が経路の接線に垂直な面を保つ。
 * - `frenet = false`(「ねじれを抑える」): `SetMode_3(gp_Dir(0,0,1))`。副法線を上下方向へ
 *   固定するので、経路が上下に振れても断面が接線まわりに回らない。
 *
 * `SetMode_2`(空間に固定した平面)は**使わない**。ばねの実測(`makeSpring.ts` の冒頭)で、
 * 断面が接線から大きく傾いて自己交差したほぼ潰れた形になることが分かっている。
 *
 * `SetMode_3` は副法線が接線と平行になると成り立たないので、**経路の出だしが上下方向と
 * 平行なときは実行する前に断る**(NFR-UX-5)。
 *
 * ---
 *
 * ## 断面の置き方(タスク37 手順 3)
 *
 * 利用者は断面のスケッチと経路のスケッチを別々に描くので、断面が経路の始点に乗って
 * いるとは限らない。そこで**断面を経路の始点へ移し、経路の接線に垂直な向きへ回してから**
 * 掃引する(`makeSpring.ts` の `makeSpringProfile` が円について行っているのと同じこと)。
 *
 * 回し方は**最小回転**(断面の法線を接線へ重ねる最短の回転)を採る。断面の面内での向き
 * (長方形の長辺がどちらを向くか)が、利用者の描いたままにいちばん近く保たれるためである。
 * 断面の法線が接線と逆向きのときは、法線を裏返してから最小回転を取る ── 面そのものは
 * 同じなので、裏返した側を選べば回さずに済む。
 *
 * 経路の始点へ重ねるのは断面の**重心**である。重心が経路に乗るので、体積はパップスの
 * 定理どおり「断面の面積 × 経路の長さ」になり、期待値を手で検算できる(検査表を参照)。
 *
 * ---
 *
 * ## 実測(makeSweep.test.ts が検査として残す)
 *
 * | 経路 | 断面 | 計算値 | 実測 | 相対差 |
 * |---|---|---|---|---|
 * | 長さ 50 の直線 | 円 r=2 | 628.3185307179587 | 628.318531 | 0.0000% |
 * | 長さ 30 の直線 | 20×10 の長方形 | 6000 | 6000.000000 | 0.0000% |
 * | 半径 20 の 1/4 円弧 | 円 r=2 | 394.7841760435743 | 394.784176 | 0.0000% |
 * | 長さ 50 の直線 | 円 r=5 | 3926.9908169872417 | 3926.990817 | 0.0000% |
 * | 半径 20 の 1/4 円弧 | 円 r=5 | 2467.4011002723395 | 2467.401100 | 0.0000% |
 *
 * 所要は `makeSweep.test.ts` が測り、NFR-PF-2(単一フィーチャー 500ms)に収まることを
 * 検査で固定する(実測値はテストのログに出る)。
 *
 * ---
 *
 * ## 閉じた経路(輪)
 *
 * 計画書 §0.a はこの場合を決めていない。**実測して通せることを確かめたうえで通す**
 * (半径 20 の全周の円に円 r=2 を沿わせるとトーラス 1579.1367 が正しく出る)。
 * 断るのは「立体にならなかった」ときだけで、経路が閉じていること自体は理由にしない。
 *
 * ---
 *
 * ## 断る 2 つの場合 ── どちらも実測で決めた(2026-09-05)
 *
 * ### (a) 経路に丸めていない角があるとき ── 留め継ぎでつなぐ
 *
 * **既定のままでは角で掃引が止まる。** 直角に曲がる 2 本の線分(30 + 20)を経路にすると、
 * `MakePipeShell` は例外も出さずに**最初の 1 本ぶんだけ**を掃引した立体を返す
 * (`IsDone()` も `BRepCheck_Analyzer` も「正しい」と答えてしまう)。`SetDiscreteMode()` を
 * 足しても同じ、`BRepOffsetAPI_MakePipe` に替えると 251.327412 でしかも妥当でない形になった。
 *
 * **角の継ぎ方を「留め継ぎ」に変えると最後までつながる。** 30 + 20 の直角(断面 円 r=2)の実測:
 *
 * | `SetTransitionMode` | 体積(mm³) | 面 | 妥当 |
 * |---|---|---|---|
 * | `BRepBuilderAPI_Transformed`(OCCT の既定) | 376.991118(= π·2²·30。**1 本目だけ**) | 4 | true |
 * | **`BRepBuilderAPI_RightCorner`(採用)** | **628.318531**(= π·2²·50。計算値と一致) | 4 | true |
 * | `BRepBuilderAPI_RoundCorner` | 626.029444(留め継ぎより 2.289087 少ない) | 5 | true |
 *
 * **留め継ぎ(`RightCorner`)を採る。** 角の外側のとがりを 45 度で切り落とし、その分を
 * もう一方へ足す継ぎ方なので、体積は**曲がる角度によらず** π·r²·(L₁+L₂) になる
 * (片方の断面ごとの長さが L+y、もう片方が L−y で 1 次の項が打ち消し合うため。
 * 実測でも 90 度・135 度の折り返しがどちらも 628.318531 で一致した)。`RoundCorner` は
 * 角の外側を丸めるぶん体積が変わり、面も 1 枚増えるので、寸法どおりの立体にならない。
 *
 * `SetTransitionMode` は列挙を引数に取るので、下の `isTransitionMode` の**述語ガード 1 か所**で
 * 渡す(統括が 2026-09-05 に承認。`as` / `any` は使わない)。
 *
 * **それでも作れないほど鋭い角は断る。** 30 の線分から 174 度折り返す経路(断面 円 r=2)は、
 * 留め継ぎの面が自分自身と交わって立体にならない(実測)。この場合は「角を丸める」ことを
 * 添えて断る。半径 5 で角を丸めた経路(直線 25 + 1/4 円弧 R5 + 直線 35)は 852.678281 で
 * 計算値と完全に一致するので、逃げ道は用意されている(P4 の 2 次元の R 面取り)。
 *
 * **「掃引できた長さ」の検査は網として残す。** 断面の重心が経路に乗り、断面が接線に垂直で
 * あれば、体積は必ず **断面の面積 × 経路の長さ** になる(断面の重心まわりの 1 次モーメントが
 * 0 なので、曲がりの効果が打ち消し合う)。実測では直線・円弧・閉じた輪・丸めた角・留め継ぎの
 * すべてで相対差 0.0000% だった。既定の継ぎ方で起きた「黙って途中で止まる」失敗を二度と
 * 通さないための検査で、上の `Transformed` の 376.991118 は計算値と 57% 食い違うので確実に捕まる。
 *
 * ### (b) 断面が経路の曲がりに対して大きすぎるとき
 *
 * 半径 2 の円弧に半径 5 の円の断面を沿わせると、掃引面が裏返って自分自身と交わる。
 * ところが OCCT は例外を出さず、`BRepCheck_Analyzer` も体積(246.740110 = 面積 × 長さ)も
 * 正常に見えるので、**出来上がりからは見分けられない**(実測)。そこで**作る前に**、
 * 断面の重心からの最大の広がりと、経路のいちばんきつい曲がりの半径を比べて断る。
 *
 * **限界:** 広がりは向きを問わず測るので、曲がる向きには薄いが横に広い断面(細長い板を
 * 平たく寝かせて曲げるなど)を、実際には作れるのに断ることがある。安全側に倒してある。
 */

import type {
  BRepBuilderAPI_TransitionMode,
  BRepFill_TypeOfContact,
  BRepOffsetAPI_MakePipeShell,
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, RigidTransformSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { addGuidedSections, prepareSweepGuide } from './sweepGuide.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { transformShape } from './transformShape.js';

/** これ未満の体積(mm³)は「立体にならなかった」とみなす(他の make*.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 向きの計算に使う許容誤差。長さ 0 のベクトル・平行な 2 つの向きを見分けるのに使う。 */
const TOLERANCE = 1e-9;

/** 「ねじれを抑える」ときに副法線を固定する向き(上下方向)。§0.a-0.43。 */
const BINORMAL: Vec3Tuple = [0, 0, 1];

const NO_PATH_MESSAGE = '掃引する道筋が選ばれていません。';
const NO_PROFILE_MESSAGE = '掃引する断面が選ばれていません。';
const OPEN_PROFILE_MESSAGE = '掃引する断面は閉じている必要があります。';
const PATH_NOT_CONNECTED_MESSAGE = '選んだ線・円弧がつながっていないため、道筋を作れませんでした。';
const NON_PLANAR_PROFILE_MESSAGE = '掃引する断面が同じ平面に乗っていません。';
const SELF_INTERSECTING_PROFILE_MESSAGE = '掃引する断面が自分自身と交わっています。';
const NO_TANGENT_MESSAGE = '道筋の向きが決まりません。道筋を選び直してください。';

/** 「ねじれを抑える」ときに、経路の出だしが副法線(上下方向)と平行だった。 */
const BINORMAL_PARALLEL_MESSAGE =
  'ねじれを抑える指定は、道筋が上下方向と平行なときには使えません。';

/** 掃引そのものが成立しなかったとき(計画書 タスク37 の検証表の文言)。 */
const BUILD_FAILED_MESSAGE = '掃引できませんでした。断面と道筋の位置を見直してください。';

/**
 * 掃引はできたが、閉じた立体になっていないとき。
 *
 * 留め継ぎでもつなげないほど鋭い角(実測: 174 度の折り返し)がいちばん多い原因なので、
 * 直し方として「角を丸める」を先に挙げる(冒頭の注釈 (a)、NFR-UX-5)。
 */
const NOT_SOLID_MESSAGE =
  '掃引した形が立体になりませんでした。道筋の角を丸めるか、断面と道筋の位置を見直してください。';

/** 掃引が経路の途中で止まったとき(冒頭の注釈 (a) の「掃引できた長さ」の網)。 */
const INCOMPLETE_MESSAGE =
  '道筋の全体を掃引できませんでした。道筋の角を丸めるか、断面と道筋の位置を見直してください。';

/** 述語ガードが偽になったとき(`isTransitionMode` の注釈を参照)。`makeOffsetWire.ts` と同じ文言。 */
const KERNEL_NOT_READY_MESSAGE =
  '幾何カーネルの準備ができていません。アプリを再読み込みしてください。';

/** 断面が経路の曲がりに対して大きすぎるとき(冒頭の注釈 (b))。 */
const TOO_TIGHT_MESSAGE =
  '断面が道筋の曲がりに対して大きすぎます。断面を小さくするか、道筋の曲がりを緩めてください。';

/**
 * 「掃引できた長さ」の判定に使う相対の許容差。
 *
 * 掃引面を B スプラインで近似する誤差を吸収する幅で、実測(直線・円弧・閉じた輪・
 * 丸めた角)ではいずれも 0.0000% だった。角で切れた場合は 57% ずれるので、
 * この幅で取り違えることはない。
 */
const SWEPT_LENGTH_TOLERANCE = 0.01;

/** 断面の広がり・経路の曲がりを測るときに割る点の数(`makeThruSections.ts` と同じ道具立て)。 */
const SAMPLE_COUNT = 64;

/** スイープ 1 つ分の入力(計画書 タスク37 の見出し)。 */
export interface SweepInput {
  /** 断面。閉じた輪郭 1 本を作る曲線の並び。 */
  readonly profile: readonly CurveSpec[];
  /** 経路。つながった曲線の並び。閉じていなくてよい。 */
  readonly path: readonly CurveSpec[];
  /** true なら `SetMode_1`(Frenet)、false なら `SetMode_3`(副法線を上下方向へ固定)。 */
  readonly frenet: boolean;
  /** 断面の向きと相似倍率を指定する案内線。対応は両線の同じ弧長比。 */
  readonly guide?: readonly CurveSpec[];
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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

/** 長さが取れない(0・非数)ときは null。他の make*.ts の toUnit と同じ考え。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const size = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return [value[0] / size, value[1] / size, value[2] / size];
}

/**
 * つながった曲線の並びから 1 本のワイヤを作る。
 * `makeThruSections.ts` の `makeSectionWire` と同じ順(稜線 → ワイヤ)で組み立てるが、
 * 閉じているかは呼び出し側が場面ごとに判断する(経路は閉じていなくてよい)。
 */
function makeWire(
  oc: OpenCascadeInstance,
  curves: readonly CurveSpec[],
  notConnectedMessage: string,
  keep: Allocations['keep'],
): TopoDS_Wire {
  const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (const curve of curves) {
    wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
  }
  if (!wireMaker.IsDone()) {
    throw new Error(notConnectedMessage);
  }
  return keep(wireMaker.Wire());
}

/**
 * ワイヤを長さの等しい間隔で `count` 点に割る(`makeThruSections.ts` の `samplePoints` と同じ)。
 *
 * `BRepAdaptor_CompCurve` はワイヤ全体を 1 本の曲線として扱えるので、稜線が何本あっても
 * 同じ数の点に割れる。`GCPnts_QuasiUniformAbscissa` は列挙を 1 つも取らない。
 */
function samplePoints(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  count: number,
  keep: Allocations['keep'],
): readonly Vec3Tuple[] {
  const adaptor = keep(new oc.BRepAdaptor_CompCurve_2(wire, false));
  const sampler = keep(new oc.GCPnts_QuasiUniformAbscissa_2(adaptor, count));
  if (!sampler.IsDone() || Number(sampler.NbPoints()) < count) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  const points: Vec3Tuple[] = [];
  for (let index = 1; index <= count; index += 1) {
    const point = keep(adaptor.Value(sampler.Parameter(index)));
    points.push([point.X(), point.Y(), point.Z()]);
  }
  return points;
}

/** ワイヤの長さ(mm)。`BRepGProp.LinearProperties` は稜線の長さの合計を返す。 */
function wireLength(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  keep: Allocations['keep'],
): number {
  const properties = keep(new oc.GProp_GProps_1());
  // 第 3・第 4 引数は SkipShared と UseTriangulation(solidMesh.ts の測り方と同じ指定)。
  oc.BRepGProp.LinearProperties(wire, properties, false, false);
  return properties.Mass();
}

/**
 * 経路のいちばんきつい曲がりの半径(mm)。まっすぐな経路では `Infinity`。
 *
 * 曲率は κ = |r′ × r″| / |r′|³ で、その最大値の逆数を返す。線分と円弧では曲率が
 * 稜線ごとに一定なので、割る点の数によらず厳密な値になる。
 */
function minimumCurvatureRadius(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  keep: Allocations['keep'],
): number {
  const adaptor = keep(new oc.BRepAdaptor_CompCurve_2(wire, false));
  const first = adaptor.FirstParameter();
  const last = adaptor.LastParameter();
  const point = keep(new oc.gp_Pnt_1());
  const firstDerivative = keep(new oc.gp_Vec_1());
  const secondDerivative = keep(new oc.gp_Vec_1());

  let maxCurvature = 0;
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    // 稜線の継ぎ目そのものは避けて内側を測る(継ぎ目では 2 階微分が定まらない)。
    const ratio = (index + 0.5) / SAMPLE_COUNT;
    adaptor.D2(first + (last - first) * ratio, point, firstDerivative, secondDerivative);
    const speed: Vec3Tuple = [
      firstDerivative.X(),
      firstDerivative.Y(),
      firstDerivative.Z(),
    ];
    const acceleration: Vec3Tuple = [
      secondDerivative.X(),
      secondDerivative.Y(),
      secondDerivative.Z(),
    ];
    const speedSize = Math.hypot(speed[0], speed[1], speed[2]);
    if (!(speedSize > TOLERANCE)) {
      continue;
    }
    const turn = cross(speed, acceleration);
    maxCurvature = Math.max(
      maxCurvature,
      Math.hypot(turn[0], turn[1], turn[2]) / speedSize ** 3,
    );
  }
  return maxCurvature > TOLERANCE ? 1 / maxCurvature : Infinity;
}

/** 断面の面から取り出した、置き直しと事前の検査に要る 4 つの値。 */
interface ProfileFrame {
  /** 断面の重心(面積の重心)。ここを経路の始点へ重ねる。 */
  readonly centre: Vec3Tuple;
  /** 断面の平面の法線(単位ベクトル)。ここを経路の接線へ向ける。 */
  readonly normal: Vec3Tuple;
  /** 断面の面積(mm²)。掃引できた長さの判定に使う。 */
  readonly area: number;
  /** 重心からいちばん遠い縁までの距離(mm)。曲がりに対する大きさの判定に使う。 */
  readonly radius: number;
}

/**
 * 断面のワイヤから平らな面を張り、重心と法線を取る。
 *
 * 断り方は `makePlanarFace.ts` と同じ 3 段階(閉じていない → 平面でない → 自分自身と交わる)
 * だが、**文言は掃引の場面のものに差し替える**(計画書 タスク37 の検証表。NFR-UX-5)。
 * 面そのものは掃引には渡さない ── `MakePipeShell` が受け取るのは断面のワイヤで、
 * 面は「重心と法線を測るため」だけに作る。
 */
function readProfileFrame(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  keep: Allocations['keep'],
): ProfileFrame {
  if (!wire.Closed_1()) {
    throw new Error(OPEN_PROFILE_MESSAGE);
  }
  // 第 2 引数 true は「平面だけを許す」(makePlanarFace.ts と同じ)。
  const faceMaker = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
  if (!faceMaker.IsDone()) {
    throw new Error(NON_PLANAR_PROFILE_MESSAGE);
  }
  const face = keep(faceMaker.Face());
  if (!oc.BRepAlgo.IsValid_1(face)) {
    throw new Error(SELF_INTERSECTING_PROFILE_MESSAGE);
  }

  const properties = keep(new oc.GProp_GProps_1());
  // 第 3・第 4 引数は SkipShared と UseTriangulation(solidMesh.ts の measureArea と同じ指定)。
  oc.BRepGProp.SurfaceProperties_1(face, properties, false, false);
  const centreOfMass = keep(properties.CentreOfMass());

  // 面は MakeFace_15(wire, true) で作った平面なので、GetType を確かめずに Plane() を呼べる
  // (列挙 GeomAbs_SurfaceType の各値は空の型なので、比較には強制変換が要る。§1.2-B)。
  const surface = keep(new oc.BRepAdaptor_Surface_2(face, true));
  const direction = keep(keep(keep(surface.Plane()).Axis()).Direction());
  const normal = toUnit([direction.X(), direction.Y(), direction.Z()]);
  if (normal === null) {
    throw new Error(NON_PLANAR_PROFILE_MESSAGE);
  }

  const centre: Vec3Tuple = [centreOfMass.X(), centreOfMass.Y(), centreOfMass.Z()];
  let radius = 0;
  for (const point of samplePoints(oc, wire, SAMPLE_COUNT, keep)) {
    const offset = subtract(point, centre);
    radius = Math.max(radius, Math.hypot(offset[0], offset[1], offset[2]));
  }
  return { centre, normal, area: properties.Mass(), radius };
}

/** 経路の始点と、そこでの接線(単位ベクトル)。 */
interface PathStart {
  readonly point: Vec3Tuple;
  readonly tangent: Vec3Tuple;
}

/**
 * 経路の始点と接線を測る。
 *
 * `BRepAdaptor_CompCurve` はワイヤ全体を 1 本の曲線として扱えるので、経路が何本の
 * 線・円弧でできていても同じ書き方で始点の接線が取れる(`makeThruSections.ts` の
 * `samplePoints` と同じ道具立て)。`D1` は点と 1 次微分を**引数へ書き込む**ので、
 * 受け皿を先に作って渡す。
 */
function readPathStart(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  keep: Allocations['keep'],
): PathStart {
  const adaptor = keep(new oc.BRepAdaptor_CompCurve_2(wire, false));
  const point = keep(new oc.gp_Pnt_1());
  const derivative = keep(new oc.gp_Vec_1());
  adaptor.D1(adaptor.FirstParameter(), point, derivative);
  const tangent = toUnit([derivative.X(), derivative.Y(), derivative.Z()]);
  if (tangent === null) {
    throw new Error(NO_TANGENT_MESSAGE);
  }
  return { point: [point.X(), point.Y(), point.Z()], tangent };
}

/**
 * 断面を経路の始点へ移し、接線に垂直へ向ける剛体変換を組み立てる(このファイル冒頭の注釈)。
 *
 * 断面の法線が接線と逆を向いているときは法線を裏返してから最小回転を取る。面そのものは
 * 裏返しても同じ位置にあるので、こうすると「すでに垂直な断面」を余計に 180 度回さずに済む。
 */
function placementOf(profile: ProfileFrame, path: PathStart): RigidTransformSpec {
  const facing: Vec3Tuple =
    dot(profile.normal, path.tangent) < 0
      ? [-profile.normal[0], -profile.normal[1], -profile.normal[2]]
      : profile.normal;
  const axis = toUnit(cross(facing, path.tangent));
  // 法線と接線が平行なら回さない(axis が取れない = 外積の長さが 0)。
  const angle =
    axis === null
      ? 0
      : Math.atan2(
          Math.hypot(...cross(facing, path.tangent)),
          dot(facing, path.tangent),
        );
  return {
    translation: subtract(path.point, profile.centre),
    rotationOrigin: profile.centre,
    // 回転角が 0 のときも軸は「長さのある向き」でなければならない(transformShape.ts の約束)。
    rotationAxis: axis ?? [0, 0, 1],
    rotationAngle: angle,
  };
}

/**
 * `SetTransitionMode` は列挙(`BRepBuilderAPI_TransitionMode`)を引数に取り、型定義では
 * 「3 つの値をまとめた入れ物の型」(`{ BRepBuilderAPI_Transformed: {};
 * BRepBuilderAPI_RightCorner: {}; BRepBuilderAPI_RoundCorner: {} }`)になっている。
 * 渡したい値 `oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner` の型は
 * **空の型 `{}`** なので、そのままでは引数の型に合わず型検査を通らない
 * (`makeOffsetWire.ts` の `GeomAbs_JoinType`、`makeFillet.ts` の `ChFi3d_FilletShape` と同じ壁)。
 *
 * **2026-09-05 に Node で実測した結果:** 実行時には
 * `pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)` が
 * そのまま働き、直角に曲がる経路が留め継ぎで最後までつながる(下の表)。つまり**壁は型検査だけ**である。
 * そこで **`unknown` を経由する述語ガード 1 つ**で絞る。これは**統括が 2026-09-05 に承認した
 * `makeSweep.ts` の 1 か所**で、`as` / `any` / `@ts-ignore` / `eslint-disable` は 1 つも使っていない。
 *
 * **この判定が確かめられること:** 「値が null でないオブジェクトであること」だけ。
 * **確かめられないこと(限界):** それが本当に `BRepBuilderAPI_TransitionMode` の列挙値かどうか。
 * embind が作る列挙値は中身の見えない空のオブジェクトなので、形を見て見分ける手立てが無い。
 * したがってこのガードは「OCCT の読み込みが済んでいない/壊れている」ことだけを捕まえる網である。
 *
 * **他の箇所へ広げない。** 別の API で同じ壁に当たったら、写す前に統括へ諮る。
 */
function isTransitionMode(value: unknown): value is BRepBuilderAPI_TransitionMode {
  return typeof value === 'object' && value !== null;
}

/** 角の継ぎ方に「留め継ぎ」を選び、述語ガードで絞る(`isTransitionMode` の注釈を参照)。 */
function rightCornerMode(oc: OpenCascadeInstance): BRepBuilderAPI_TransitionMode {
  const value: unknown = oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner;
  if (!isTransitionMode(value)) {
    throw new Error(KERNEL_NOT_READY_MESSAGE);
  }
  return value;
}

/**
 * P11b §0.a-0.4で承認された列挙型の補完。embindの宣言は各値を{}とするため必要。
 * 値は読み込んだOCCTのNoContactそのものとの同一性で検証し、他の列挙/任意オブジェクトは通さない。
 * TypeScript上の列挙構造までは検証できない。実OCCTで方向と断面倍率の結果を別に確認する。
 */
function isGuideNoContact(value: unknown, oc: OpenCascadeInstance): value is BRepFill_TypeOfContact {
  return value !== undefined && value === oc.BRepFill_TypeOfContact.BRepFill_NoContact;
}

function applyGuideMode(oc: OpenCascadeInstance, pipe: BRepOffsetAPI_MakePipeShell, guide: TopoDS_Wire): void {
  const mode: unknown = oc.BRepFill_TypeOfContact.BRepFill_NoContact;
  if (!isGuideNoContact(mode, oc)) throw new Error(KERNEL_NOT_READY_MESSAGE);
  // ContactOnBorderは円断面で成功する一方、矩形/楕円では失敗する実証結果がある。
  // NoContactの向き＋明示的な相似断面で幅も合わせる。補助spineと非互換のSetLawは使わない。
  pipe.SetMode_5(guide, true, mode);
}

/** 掃引の向きの指定を `MakePipeShell` へ渡す(§0.a-0.43)。 */
function applySweepMode(
  oc: OpenCascadeInstance,
  pipe: BRepOffsetAPI_MakePipeShell,
  frenet: boolean,
  tangent: Vec3Tuple,
  keep: Allocations['keep'],
): void {
  if (frenet) {
    pipe.SetMode_1(true);
    return;
  }
  // 副法線が接線と平行だと三面体が決まらない。実行する前に断る(NFR-UX-5)。
  if (Math.hypot(...cross(BINORMAL, tangent)) < TOLERANCE) {
    throw new Error(BINORMAL_PARALLEL_MESSAGE);
  }
  pipe.SetMode_3(keep(new oc.gp_Dir_4(BINORMAL[0], BINORMAL[1], BINORMAL[2])));
}

/**
 * スイープ(FR-409)。断面を経路に沿って掃引した立体を 1 つ作る。
 *
 * **対象を消費しない「作る」フィーチャー**(押し出し・回転・ばね・ロフトと同じ扱い)。
 * 断るときは利用者へそのまま見せられる日本語の `Error` を投げ、呼び出し側
 * (`recomputeSolids`)が理由として拾う(FR-504、NFR-RE-1。止めずに理由を出す)。
 *
 * 計画書の見出しは `options?: TessellationOptions` を持つが、掃引そのものは
 * テッセレーションの粗さを使わない(粗さは段の種類ごとに `recomputeSolids.ts` が
 * 掛ける)ので受け取らない。`makeSpring.ts` / `makeHole.ts` と同じ判断。
 */
export function makeSweep(oc: OpenCascadeInstance, input: SweepInput): OcctShapeHandle {
  if (input.path.length === 0) {
    throw new Error(NO_PATH_MESSAGE);
  }
  if (input.profile.length === 0) {
    throw new Error(NO_PROFILE_MESSAGE);
  }

  const { keep, release } = createAllocations();
  try {
    const spine = makeWire(oc, input.path, PATH_NOT_CONNECTED_MESSAGE, keep);
    const profileWire = makeWire(
      oc,
      input.profile,
      '選んだ線・円弧がつながっていないため、断面を作れませんでした。',
      keep,
    );

    const frame = readProfileFrame(oc, profileWire, keep);
    const start = readPathStart(oc, spine, keep);

    // 断面が経路の曲がりを追い越すと掃引面が裏返る。出来上がりからは見分けられないので、
    // 作る前に断る(冒頭の注釈 (b)、NFR-UX-5)。
    const minimumRadius = minimumCurvatureRadius(oc, spine, keep);
    if (frame.radius >= minimumRadius) {
      throw new Error(TOO_TIGHT_MESSAGE);
    }
    // Copy = true で複製を作るので、もとの断面のワイヤは触られない。
    const moved = keep(transformShape(oc, profileWire, placementOf(frame, start)));
    const placed = keep(oc.TopoDS.Wire_1(moved.shape));

    const guideWire = input.guide === undefined ? null : makeWire(oc, input.guide,
      '案内線は1本につながった線を選んでください。', keep);
    const guidePlan = guideWire === null ? null : prepareSweepGuide(oc, spine, guideWire, placed, keep);
    if (guidePlan !== null && frame.radius * guidePlan.maxScale >= minimumRadius) throw new Error(TOO_TIGHT_MESSAGE);

    const pipe = keep(new oc.BRepOffsetAPI_MakePipeShell(spine));
    if (guideWire === null) applySweepMode(oc, pipe, input.frenet, start.tangent, keep);
    else applyGuideMode(oc, pipe, guideWire);
    // 角は留め継ぎでつなぐ(冒頭の注釈 (a))。既定の `Transformed` は角で掃引が止まる。
    pipe.SetTransitionMode(rightCornerMode(oc));
    // 断面はすでに正しい位置と向きにあるので、OCCT 側の寄せ(WithContact)と
    // 向き直し(WithCorrection)は使わない。WithContact は断面を経路へ「接する」
    // まで平行移動する指定で、重心を経路に乗せる置き方(冒頭の注釈)と食い違う。
    if (guidePlan === null) pipe.Add_1(placed, false, false);
    else addGuidedSections(oc, pipe, placed, guidePlan, keep);
    if (!pipe.IsReady()) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }
    pipe.Build(keep(new oc.Message_ProgressRange_1()));
    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ
    // (docs/報告記録.md 2026-09-03 06:56 の⑤。makeSpring.ts と同じ扱い)。
    if (!pipe.IsDone()) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }

    let shape: TopoDS_Shape;
    if (pipe.MakeSolid()) {
      shape = keep(pipe.Shape());
    } else {
      // 掃引した殻が閉じていなかったとき(P3 §1.4-5)。殻をソリッドで包む。
      const shell = keep(oc.TopoDS.Shell_1(keep(pipe.Shape())));
      const solidMaker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell));
      if (!solidMaker.IsDone()) {
        throw new Error(BUILD_FAILED_MESSAGE);
      }
      shape = keep(solidMaker.Shape());
    }

    // 閉経路の複数断面では内向きの殻が返ることがある。絶対値だけで通すと
    // 表裏や後続ブーリアンが逆になるため、縫合と同じく生成した形の向きを直す。
    const signedVolume = measureVolume(oc, shape);
    if (signedVolume < 0) shape = keep(shape.Reversed());
    const volume = Math.abs(signedVolume);
    if (!hasSolid(oc, shape) || volume < MIN_SOLID_VOLUME_MM3) {
      throw new Error(NOT_SOLID_MESSAGE);
    }
    if (!isValidShape(oc, shape)) {
      throw new Error(NOT_SOLID_MESSAGE);
    }
    // 掃引できた長さの検査(冒頭の注釈 (a))。角で途中まで止まっていても OCCT は
    // 「正しい立体」と答えるので、体積 = 断面の面積 × 経路の長さ からずれていないかで見る。
    // 案内線では断面積が変わるため A0×∫scale(s)²ds と照合する。
    // 全経路を作れたかの1%基準は同じまま保つ。
    const expectedVolume = frame.area * (guidePlan?.volumePerArea ?? wireLength(oc, spine, keep));
    if (Math.abs(volume - expectedVolume) > expectedVolume * SWEPT_LENGTH_TOLERANCE) {
      throw new Error(INCOMPLETE_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    // OCCT の C++ 例外は数値で飛んでくる(makeFillet.ts / makeSpring.ts と同じ)。
    throw error instanceof Error ? error : new Error(BUILD_FAILED_MESSAGE);
  }
}
