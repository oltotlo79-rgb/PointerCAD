/**
 * 面と面をつなぐ立体(罫線面、FR-430)とロフト(FR-410)。計画書 P5 §2.9、タスク24。
 *
 * **1 つの道具で 2 つの機能をまかなう。** `BRepOffsetAPI_ThruSections` は
 * `ruled` の真偽で「直線で結ぶ(罫線面)」と「なめらかに結ぶ(ロフト)」を切り替えられる
 * (§0.a-0.25)。利用者から見て別の道具なので**フィーチャーの種類は model 側で分ける**が、
 * カーネルの段は 1 種類(`thruSections`)にまとめてある。
 *
 * **列挙を 1 つも触らない。** `SetParType`(`Approx_ParametrizationType`)と
 * `SetContinuity`(`GeomAbs_Shape`)は呼ばない(§1.2-B)。`Shape()` はこのクラスに無く、
 * 親 `BRepBuilderAPI_MakeShape` のものを使う。
 *
 * **`IsDone()` を見る前に `Shape()` を呼ばない**(`docs/報告記録.md` 2026-09-03 06:56 の⑤。
 * `makeThread.ts` / `makeSpring.ts` と同じ扱い)。空の結果でも `IsDone()` は true になりうるので、
 * 立体になっているかは `hasSolid` と体積で別に確かめる(同 ④)。
 *
 * ---
 *
 * ## 球が選ばれたとき(§2.9.3、§0.a-0.26)
 *
 * 球の輪郭は「縁」を持たないので、`ThruSections` にそのまま渡せない。球に外接する直線
 * (= 接する円錐面)で結ぶ必要があり、**2 つの経路**を持つ(判定と数値は `sphereTangent.ts`)。
 *
 * ### (a) 軸対称(輪郭が円で、その中心が球の中心を通る軸の上にある)
 *
 * `tangentConeThroughCircle` が円錐を 1 つに決めるので、**円錐台の側面 + 接触円より上の球冠 +
 * 輪郭の平らな面**の 3 枚を縫合(`BRepBuilderAPI_Sewing`)して立体にする。解析的に解けるので
 * 体積が手計算と一致する(検証: 球 r=10・円 r=20 @ z=−30 で 24741.124688560、実測
 * 24741.124688560027、相対差 2e-16)。
 *
 * ### (b) 一般の輪郭(軸対称でないもの)
 *
 * 輪郭を点に割り、点ごとに `tangentPointOnSphere` で接点を求めて、**輪郭の折れ線 → 接点の
 * 折れ線**を `ThruSections`(`ruled = true`)で結ぶ。接点の列より先(球冠にあたる側)は、
 * 接点を球面上で「帽の中心」へ寄せた輪(`SPHERE_CAP_RINGS` 本)と頂点 1 つを足した
 * `ThruSections`(なめらか)で閉じ、輪郭の平らな面と合わせて 3 つの部品を縫合する。
 *
 * **ブーリアン(和)を使わない理由(2026-09-05 実測)。** 「罫線の立体 ∪ 球」で作る案を試すと、
 * 接する面どうしのブーリアンになるため極端に遅く、結果も壊れた。実測(球 r=10・円 r=20 @ z=−30):
 *
 * | 作り方 | 所要 | 結果 |
 * |---|---|---|
 * | 折れ線 8 点の立体 ∪ 球 | 4252ms | 体積 −9.2%(点が少ないぶん) |
 * | 折れ線 36 点の立体 ∪ 球 | 14407ms | 体積 −0.48% |
 * | 折れ線 72 点の立体 ∪ 球 | 21957ms | **体積 0(壊れる)** |
 * | スプライン 1 本の立体 ∪ 球 | 743〜1279ms | **体積 +11% / −83%(壊れる)** |
 * | **縫合(この実装)** | **220〜470ms** | **正しい立体(下の実測表)** |
 *
 * NFR-PF-2(単一フィーチャー 500ms)を満たせるのは縫合だけである。
 *
 * **点の数(`SPHERE_SECTION_POINTS = 24`)の選び方(2026-09-05 実測、3 回ずつ)。**
 * 計画書 §2.9.3 の既定は 72 点だが、72 点では NFR-PF-2 を超えるため 24 点を採る。
 * (a) の経路が使える軸対称の入力を、あえて (b) の経路で作って解析値 24741.124688560 と
 * 比べた表(輪の数は 1 本):
 *
 * | 点の数 | 体積の相対差 | 面の数 | 軸対称の所要 | 軸から外れた輪郭の所要 |
 * |---|---|---|---|---|
 * | 24(採用) | −1.18% | 49 | 235〜467ms | 218〜258ms |
 * | 32 | −0.69% | 65 | 291〜864ms | 478〜616ms |
 * | 36 | −0.55% | 73 | 233〜269ms | 544〜614ms |
 * | 72 | −0.12% | 145 | 932〜971ms | 5340〜5901ms |
 *
 * 体積が必ず少なめに出るのは、輪郭を内接する多角形で近似しているためである
 * (24 点の内接多角形の面積比 0.99093 = −0.91% とほぼ一致する)。**軸対称の入力は (a) の
 * 経路で厳密に作られる**ので、この近似が効くのは (b)(軸から外れた輪郭)だけである。
 *
 * **輪の数(`SPHERE_CAP_RINGS = 1`)の選び方(同じ実測)。** 球冠を張るなめらかな面は、
 * 輪を増やすと所要が跳ね上がり(軸から外れた輪郭・32 点で 1 本 478ms → 3 本 2138ms →
 * 5 本 4008ms)、**境界箱は 1 本のときが最も球に近い**(軸対称では球の半径ちょうどの 10.000、
 * 3 本では 10.003)。所要と形の両方で 1 本が最良だった。
 *
 * **限界(統括へ報告済み)。** 球冠が半球より広くなる配置(接点の列が球の大円に近づくとき)では、
 * なめらかな面が球の外へ最大 0.9mm ほど膨らむ(球 r=10・円 r=8 @ (5,0,−20) で境界箱の上端が
 * 10.935)。球に外接する直線そのもの(接点の位置)は厳密なので、膨らむのは球冠の側だけである。
 */

import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Shell,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import type {
  CurveSpec,
  TessellationOptions,
  ThruSectionSpec,
  ThruSectionsStepSpec,
  Vec3Tuple,
} from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { tangentConeThroughCircle, tangentPointOnSphere } from './sphereTangent.js';

/** つなぐには断面が 2 つ要る。 */
const MINIMUM_SECTION_COUNT = 2;

/** これ未満の体積(mm³)は「立体にならなかった」とみなす(他の make*.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 縫合のつなぎ目とみなす許容量(mm)。`ThruSections` の `pres3d` と同じ値に揃える。 */
const SEWING_TOLERANCE = 1.0e-6;

/** 幾何の判定に使う許容誤差。長さ 0 のベクトル・平面でない輪郭を見分けるのに使う。 */
const TOLERANCE = 1e-9;

/** 角度の幅がこの値だけ 2π に足りなくても全周とみなす(`makeSketchEdges.ts` と同じ約束)。 */
const FULL_TURN = 2 * Math.PI;
const FULL_TURN_EPSILON = 1e-9;

/**
 * (b) で輪郭を割る点の数。ファイル冒頭の実測表のとおり、NFR-PF-2(500ms)に収まる
 * いちばん細かい値として 24 を採る(計画書 §2.9.3 の既定 72 では 5〜6 秒かかる)。
 */
const SPHERE_SECTION_POINTS = 24;

/** (b) で球冠を張るときに間へ挟む輪の数。ファイル冒頭の実測表のとおり 1 本が最良。 */
const SPHERE_CAP_RINGS = 1;

/**
 * 球冠の広がりの上限(ラジアン)。これを超えると輪を「帽の中心」へ寄せる筋道が
 * 球の裏側へ回り込み、面が自分自身と交わる。実行する前に断る(NFR-UX-5)。
 */
const MAX_CAP_ANGLE = (170 * Math.PI) / 180;

const TOO_FEW_SECTIONS_MESSAGE = 'つなぐ面を 2 つ選んでください。';
const OPEN_PROFILE_MESSAGE = 'つなぐ輪郭は閉じている必要があります。';
const TWO_SPHERES_MESSAGE = '球どうしを直線でつなぐことはできません。';
const SPHERE_NEEDS_ONE_PROFILE_MESSAGE = '球とつなげる輪郭は 1 つだけにしてください。';
const NO_TANGENT_MESSAGE =
  '球を直線でつなぐには、丸い輪郭の中心が球の中心の真上か真下にある必要があります。';
const BUILD_FAILED_MESSAGE = '面と面をつなげませんでした。輪郭の形を見直してください。';
const NOT_SOLID_MESSAGE = '立体になりませんでした。輪郭の位置を見直してください。';
const TWIST_MESSAGE = 'ひねりの数は整数にしてください。';
const SPHERE_SIZE_MESSAGE = '球の半径は 0 より大きい数にしてください。';

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function magnitude(value: Vec3Tuple): number {
  return Math.hypot(value[0], value[1], value[2]);
}

/** 長さが取れない(0・非数)ときは null。他の make*.ts の toUnit と同じ考え。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const size = magnitude(value);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return [value[0] / size, value[1] / size, value[2] / size];
}

/** 球面上の 2 つの向きの間を、球面に沿って補間する(球冠の輪を作るのに使う)。 */
function slerp(from: Vec3Tuple, to: Vec3Tuple, ratio: number): Vec3Tuple {
  const cosine = Math.min(1, Math.max(-1, dot(from, to)));
  const angle = Math.acos(cosine);
  if (angle < TOLERANCE) {
    return from;
  }
  const scaleFrom = Math.sin((1 - ratio) * angle) / Math.sin(angle);
  const scaleTo = Math.sin(ratio * angle) / Math.sin(angle);
  return [
    from[0] * scaleFrom + to[0] * scaleTo,
    from[1] * scaleFrom + to[1] * scaleTo,
    from[2] * scaleFrom + to[2] * scaleTo,
  ];
}

/**
 * 断面の曲線から閉じたワイヤを 1 本作る。
 * `makePlanarFace.ts` と同じ順(稜線 → ワイヤ)で組み立て、閉じているかも同じように確かめる。
 */
function makeSectionWire(
  oc: OpenCascadeInstance,
  curves: readonly CurveSpec[],
  keep: Allocations['keep'],
): TopoDS_Wire {
  if (curves.length === 0) {
    throw new Error(OPEN_PROFILE_MESSAGE);
  }
  const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (const curve of curves) {
    wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
  }
  if (!wireMaker.IsDone()) {
    throw new Error('選んだ線・円弧がつながっていないため、輪郭を作れませんでした。');
  }
  const wire = keep(wireMaker.Wire());
  if (!wire.Closed_1()) {
    throw new Error(OPEN_PROFILE_MESSAGE);
  }
  return wire;
}

/** 点の列から閉じた折れ線のワイヤを作る。列挙を 1 つも取らない `MakePolygon` を使う。 */
function makePolygonWire(
  oc: OpenCascadeInstance,
  points: readonly Vec3Tuple[],
  keep: Allocations['keep'],
): TopoDS_Wire {
  const polygon = keep(new oc.BRepBuilderAPI_MakePolygon_1());
  for (const point of points) {
    polygon.Add_1(keep(new oc.gp_Pnt_3(point[0], point[1], point[2])));
  }
  polygon.Close();
  if (!polygon.IsDone()) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  return keep(polygon.Wire());
}

/**
 * `twist` のぶんだけ曲線の並びを回す(§0.a-0.28)。
 *
 * ワイヤの始点は「最初に足した稜線の始点」で決まるので、足す順を n 本ぶん回すと
 * 2 つの輪郭の対応がずれ、ねじれを目で直せる。並びを回すだけで形そのものは変えない。
 */
function rotateCurves(curves: readonly CurveSpec[], twist: number): readonly CurveSpec[] {
  if (curves.length <= 1) {
    return curves;
  }
  const shift = ((twist % curves.length) + curves.length) % curves.length;
  if (shift === 0) {
    return curves;
  }
  return [...curves.slice(shift), ...curves.slice(0, shift)];
}

/**
 * 縫合した形の中から殻を 1 つ取り出す。無ければ null。
 *
 * 取り出し方は `sewSolid.ts` の `findShell` と同じ(殻がそのまま返る場合と、入れ物
 * (COMPOUND)に入って返る場合の両方を扱う)。`sewSolid.ts` の関数は外へ出していないので、
 * ここでは同じ実測(2026-09-03、計画書 §1.2 の未確認点 3)に基づく最小のものを置く。
 */
function findShell(oc: OpenCascadeInstance, shape: TopoDS_Shape): TopoDS_Shell | null {
  const shellType = oc.TopAbs_ShapeEnum.TopAbs_SHELL;
  if (shape.ShapeType() === shellType) {
    return oc.TopoDS.Shell_1(shape);
  }
  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const count = Number(subShapes.Size());
    for (let index = 1; index <= count; index += 1) {
      const subShape = subShapes.FindKey(index);
      if (subShape.ShapeType() === shellType) {
        return oc.TopoDS.Shell_1(subShape);
      }
    }
    return null;
  } finally {
    subShapes.delete();
  }
}

/**
 * 面・殻をまとめて縫い、閉じた立体にする。
 *
 * 向きの直し(体積が負なら `Reversed()`)は `sewSolid.ts` と同じ理由による。
 * `BRepBuilderAPI_Sewing` は面の向きを揃えるが、揃える先が内側になることがある。
 */
function sewToSolid(
  oc: OpenCascadeInstance,
  parts: readonly TopoDS_Shape[],
  keep: Allocations['keep'],
): TopoDS_Shape {
  // 第 2〜第 5 引数は OCCT の既定の組み合わせ(sewSolid.ts と同じ)。
  const sewing = keep(new oc.BRepBuilderAPI_Sewing(SEWING_TOLERANCE, true, true, true, false));
  for (const part of parts) {
    sewing.Add(part);
  }
  sewing.Perform(keep(new oc.Message_ProgressRange_1()));
  // 個数を返すメソッドの戻り型 Graphic3d_ZLayerId は型定義に無いので整数へ直す。
  if (Number(sewing.NbFreeEdges()) !== 0) {
    throw new Error(NOT_SOLID_MESSAGE);
  }
  const shell = findShell(oc, keep(sewing.SewedShape()));
  if (shell === null) {
    throw new Error(NOT_SOLID_MESSAGE);
  }
  keep(shell);
  const solidMaker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell));
  if (!solidMaker.IsDone()) {
    throw new Error(NOT_SOLID_MESSAGE);
  }
  const solid = keep(solidMaker.Solid());
  return measureVolume(oc, solid) < 0 ? keep(solid.Reversed()) : solid;
}

/** 出来上がった形が閉じた立体になっているかを確かめる(空の結果を通さないための最後の網)。 */
function checkSolid(oc: OpenCascadeInstance, shape: TopoDS_Shape): void {
  if (!hasSolid(oc, shape) || Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME_MM3) {
    throw new Error(NOT_SOLID_MESSAGE);
  }
  if (!isValidShape(oc, shape)) {
    throw new Error(NOT_SOLID_MESSAGE);
  }
}

/** 断面が「全周の円」1 本ならその素性を返す((a) の経路が使えるかの判定に使う)。 */
function circleOfSection(curves: readonly CurveSpec[]): {
  readonly center: Vec3Tuple;
  readonly normal: Vec3Tuple;
  readonly radius: number;
} | null {
  if (curves.length !== 1) {
    return null;
  }
  const curve = curves[0];
  if (curve.kind !== 'arc') {
    return null;
  }
  if (Math.abs(curve.endAngle - curve.startAngle) < FULL_TURN - FULL_TURN_EPSILON) {
    return null;
  }
  return { center: curve.center, normal: curve.normal, radius: curve.radius };
}

/**
 * (a) 軸対称の罫線立体(§0.a-0.26-(a))。
 * 円錐台の側面 + 接触円より上の球冠 + 輪郭の平らな面 の 3 枚を縫合する。
 *
 * `BRepPrimAPI_MakeCone` / `BRepPrimAPI_MakeSphere` の `Face()`(親
 * `BRepPrimAPI_MakeOneAxis` のもの)は**側面 1 枚だけ**を返すので、円錐台の底と蓋、
 * 球冠の切り口は入ってこない(2026-09-05 実測で確認)。
 */
function makeAxialSphereSolid(
  oc: OpenCascadeInstance,
  sphereCenter: Vec3Tuple,
  sphereRadius: number,
  circle: { readonly center: Vec3Tuple; readonly normal: Vec3Tuple; readonly radius: number },
  bottom: TopoDS_Face,
  keep: Allocations['keep'],
): TopoDS_Shape | null {
  const cone = tangentConeThroughCircle(
    sphereCenter,
    sphereRadius,
    circle.normal,
    circle.center,
    circle.radius,
  );
  if (cone === null) {
    return null;
  }
  // 頂点の側(球の中心 → 頂点)が円錐と球冠の共通の軸になる。
  const apexDirection = toUnit(subtract(cone.apex, sphereCenter));
  if (apexDirection === null) {
    return null;
  }
  const height = magnitude(subtract(circle.center, cone.contactCenter));
  if (!(height > TOLERANCE)) {
    return null;
  }

  // 円錐台の側面。接触円を底(R1)、輪郭の円を蓋(R2)にし、軸は頂点と反対の向きへ取る。
  const coneOrigin = keep(
    new oc.gp_Pnt_3(cone.contactCenter[0], cone.contactCenter[1], cone.contactCenter[2]),
  );
  const coneDirection = keep(
    new oc.gp_Dir_4(-apexDirection[0], -apexDirection[1], -apexDirection[2]),
  );
  // gp_Ax2_3(P, V) は第 1 軸を OCCT に任せる版。回転体なので第 1 軸はどこを向いてもよい。
  const coneAxes = keep(new oc.gp_Ax2_3(coneOrigin, coneDirection));
  const coneMaker = keep(
    new oc.BRepPrimAPI_MakeCone_3(coneAxes, cone.contactRadius, circle.radius, height),
  );
  coneMaker.Build(keep(new oc.Message_ProgressRange_1()));
  if (!coneMaker.IsDone()) {
    return null;
  }
  const coneFace = keep(coneMaker.Face());

  // 球冠。緯度は接触円の位置 asin((r²/z₀)/r) = asin(r/z₀) = 円錐の半角に等しい。
  const sphereOrigin = keep(new oc.gp_Pnt_3(sphereCenter[0], sphereCenter[1], sphereCenter[2]));
  const sphereDirection = keep(
    new oc.gp_Dir_4(apexDirection[0], apexDirection[1], apexDirection[2]),
  );
  const sphereAxes = keep(new oc.gp_Ax2_3(sphereOrigin, sphereDirection));
  const capMaker = keep(
    new oc.BRepPrimAPI_MakeSphere_11(sphereAxes, sphereRadius, cone.halfAngle, Math.PI / 2),
  );
  capMaker.Build(keep(new oc.Message_ProgressRange_1()));
  if (!capMaker.IsDone()) {
    return null;
  }
  const capFace = keep(capMaker.Face());

  return sewToSolid(oc, [coneFace, capFace, bottom], keep);
}

/**
 * 輪郭のワイヤを、長さの等しい間隔で `count` 点に割る(§2.9.3-(b) の離散化)。
 *
 * `BRepAdaptor_CompCurve` はワイヤ全体を 1 本の曲線として扱えるので、稜線が何本あっても
 * 同じ数の点に割れる。`GCPnts_QuasiUniformAbscissa` は列挙を 1 つも取らない。
 * 閉じたワイヤでは最後の点が最初の点と重なるので、`count + 1` 点を求めて末尾を落とす。
 */
function samplePoints(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  count: number,
  keep: Allocations['keep'],
): readonly Vec3Tuple[] {
  const adaptor = keep(new oc.BRepAdaptor_CompCurve_2(wire, false));
  const sampler = keep(new oc.GCPnts_QuasiUniformAbscissa_2(adaptor, count + 1));
  if (!sampler.IsDone() || Number(sampler.NbPoints()) < count + 1) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  const points: Vec3Tuple[] = [];
  for (let index = 1; index <= count; index += 1) {
    const point = keep(adaptor.Value(sampler.Parameter(index)));
    points.push([point.X(), point.Y(), point.Z()]);
  }
  return points;
}

/**
 * 輪郭の平面の法線を、点の列から求める(ニューウェルの方法)。
 *
 * **向きは「輪郭から球へ向かう側」に揃える。** `tangentPointOnSphere` は法線の側にある
 * 接点を選ぶので、球を挟んで輪郭と反対側の接点(= 球冠を残せる側)を取るには、
 * 法線が球の中心の側を向いている必要がある(2026-09-05 実測で、逆向きにすると
 * 球の手前だけの小さな立体になることを確認した)。
 */
function contourNormal(points: readonly Vec3Tuple[], sphereCenter: Vec3Tuple): Vec3Tuple | null {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    nx += (current[1] - next[1]) * (current[2] + next[2]);
    ny += (current[2] - next[2]) * (current[0] + next[0]);
    nz += (current[0] - next[0]) * (current[1] + next[1]);
    cx += current[0];
    cy += current[1];
    cz += current[2];
  }
  const normal = toUnit([nx, ny, nz]);
  if (normal === null) {
    return null;
  }
  const centroid: Vec3Tuple = [cx / points.length, cy / points.length, cz / points.length];
  const toContour = subtract(centroid, sphereCenter);
  return dot(normal, toContour) > 0
    ? [-normal[0], -normal[1], -normal[2]]
    : normal;
}

/**
 * (b) 一般の輪郭の罫線立体(§0.a-0.26-(b))。
 * 罫線の殻(輪郭 → 接点)+ 球冠を張る殻(接点 → 輪 → 頂点)+ 輪郭の平らな面 を縫合する。
 *
 * **輪郭の平らな面は、元の曲線ではなく割った折れ線から張る。** 罫線の殻の縁は折れ線なので、
 * 元の曲線(円など)から張った面とはつなぎ目が合わず、縫合に隙間が残る(2026-09-05 実測で
 * 自由辺が 0 にならなかった)。(a) の経路では罫線の面が厳密な円錐なので元の曲線をそのまま使う。
 */
function makeGeneralSphereSolid(
  oc: OpenCascadeInstance,
  sphereCenter: Vec3Tuple,
  sphereRadius: number,
  contourWire: TopoDS_Wire,
  keep: Allocations['keep'],
): TopoDS_Shape | null {
  const contour = samplePoints(oc, contourWire, SPHERE_SECTION_POINTS, keep);
  const normal = contourNormal(contour, sphereCenter);
  if (normal === null) {
    return null;
  }
  // 輪郭の平面が球を切っていると、輪郭の平らな面が球の中を通ってしまい、
  // 「罫線の面 + 球冠 + 平らな面」では立体にならない((a) の経路と同じ断り方)。
  if (Math.abs(dot(normal, subtract(contour[0], sphereCenter))) + TOLERANCE < sphereRadius) {
    return null;
  }

  const tangents: Vec3Tuple[] = [];
  /** 接点の向き(球の中心から見た単位ベクトル)。球冠の輪を作るのに使い回す。 */
  const tangentDirections: Vec3Tuple[] = [];
  /** 球冠の中心の向き。輪郭から球を見る向きの逆(= 輪郭から最も遠い側)。 */
  let apexX = 0;
  let apexY = 0;
  let apexZ = 0;
  for (const point of contour) {
    const tangent = tangentPointOnSphere(sphereCenter, sphereRadius, normal, point);
    if (tangent === null) {
      return null;
    }
    tangents.push(tangent);
    tangentDirections.push([
      (tangent[0] - sphereCenter[0]) / sphereRadius,
      (tangent[1] - sphereCenter[1]) / sphereRadius,
      (tangent[2] - sphereCenter[2]) / sphereRadius,
    ]);
    const toPoint = toUnit(subtract(point, sphereCenter));
    if (toPoint === null) {
      return null;
    }
    apexX -= toPoint[0];
    apexY -= toPoint[1];
    apexZ -= toPoint[2];
  }
  const apexDirection = toUnit([apexX, apexY, apexZ]);
  if (apexDirection === null) {
    return null;
  }
  // 帽が広がりすぎると、輪を中心へ寄せる筋道が球の裏側へ回り込んで面が交わる。
  for (const direction of tangentDirections) {
    if (Math.acos(Math.min(1, Math.max(-1, dot(direction, apexDirection)))) > MAX_CAP_ANGLE) {
      return null;
    }
  }

  const contourPolygon = makePolygonWire(oc, contour, keep);
  const tangentPolygon = makePolygonWire(oc, tangents, keep);

  // 罫線の殻。輪郭の点と接点が同じ数・同じ並びなので、対応の付け直しは要らない
  // (`CheckCompatibility` を呼ぶと余計な分割が起きて遅くなる。2026-09-05 実測)。
  const lateral = keep(new oc.BRepOffsetAPI_ThruSections(false, true, SEWING_TOLERANCE));
  lateral.AddWire(contourPolygon);
  lateral.AddWire(tangentPolygon);
  lateral.Build(keep(new oc.Message_ProgressRange_1()));
  if (!lateral.IsDone()) {
    return null;
  }

  // 球冠を張る殻。接点の列を球面に沿って帽の中心へ寄せた輪を挟み、頂点で閉じる。
  const cap = keep(new oc.BRepOffsetAPI_ThruSections(false, false, SEWING_TOLERANCE));
  cap.AddWire(tangentPolygon);
  for (let ring = 1; ring <= SPHERE_CAP_RINGS; ring += 1) {
    const ratio = ring / (SPHERE_CAP_RINGS + 1);
    const ringPoints = tangentDirections.map((direction) => {
      const moved = slerp(direction, apexDirection, ratio);
      return [
        sphereCenter[0] + moved[0] * sphereRadius,
        sphereCenter[1] + moved[1] * sphereRadius,
        sphereCenter[2] + moved[2] * sphereRadius,
      ] as Vec3Tuple;
    });
    cap.AddWire(makePolygonWire(oc, ringPoints, keep));
  }
  const apexPoint = keep(
    new oc.gp_Pnt_3(
      sphereCenter[0] + apexDirection[0] * sphereRadius,
      sphereCenter[1] + apexDirection[1] * sphereRadius,
      sphereCenter[2] + apexDirection[2] * sphereRadius,
    ),
  );
  cap.AddVertex(keep(keep(new oc.BRepBuilderAPI_MakeVertex(apexPoint)).Vertex()));
  cap.Build(keep(new oc.Message_ProgressRange_1()));
  if (!cap.IsDone()) {
    return null;
  }

  // 輪郭の平らな面(折れ線から張る。この関数の冒頭の注釈)。
  const bottomMaker = keep(new oc.BRepBuilderAPI_MakeFace_15(contourPolygon, true));
  if (!bottomMaker.IsDone()) {
    return null;
  }

  return sewToSolid(
    oc,
    [keep(lateral.Shape()), keep(cap.Shape()), keep(bottomMaker.Face())],
    keep,
  );
}

/** 球の断面と、相手の輪郭の断面に分ける。球が 2 つ以上あれば断る。 */
function splitSphereSection(sections: readonly ThruSectionSpec[]): {
  readonly sphere: Extract<ThruSectionSpec, { kind: 'sphere' }> | null;
  readonly curves: readonly CurveSpec[];
} {
  let sphere: Extract<ThruSectionSpec, { kind: 'sphere' }> | null = null;
  const profiles: (readonly CurveSpec[])[] = [];
  for (const section of sections) {
    if (section.kind === 'sphere') {
      if (sphere !== null) {
        throw new Error(TWO_SPHERES_MESSAGE);
      }
      sphere = section;
      continue;
    }
    profiles.push(section.curves);
  }
  if (sphere !== null && profiles.length !== 1) {
    throw new Error(SPHERE_NEEDS_ONE_PROFILE_MESSAGE);
  }
  return { sphere, curves: sphere === null ? [] : profiles[0] };
}

/**
 * 球と輪郭を、球に外接する直線で結んだ立体(FR-430)。
 * (a) 軸対称 → (b) 一般の輪郭 の順に試し、どちらも成り立たなければ断る。
 */
function makeSphereRuledSolid(
  oc: OpenCascadeInstance,
  sphere: Extract<ThruSectionSpec, { kind: 'sphere' }>,
  curves: readonly CurveSpec[],
  options: TessellationOptions,
  keep: Allocations['keep'],
): TopoDS_Shape {
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    throw new Error(SPHERE_SIZE_MESSAGE);
  }
  const wire = makeSectionWire(oc, curves, keep);

  const circle = circleOfSection(curves);
  if (circle !== null) {
    // (a) は罫線の面が厳密な円錐なので、輪郭の面も元の曲線から厳密に張る。
    // 閉じていない・自己交差・非平面は makePlanarFace が理由つきで断る。
    const bottom = keep(makePlanarFace(oc, curves, options)).face;
    const axial = makeAxialSphereSolid(oc, sphere.center, sphere.radius, circle, bottom, keep);
    if (axial !== null) {
      return axial;
    }
  }
  const general = makeGeneralSphereSolid(oc, sphere.center, sphere.radius, wire, keep);
  if (general === null) {
    throw new Error(NO_TANGENT_MESSAGE);
  }
  return general;
}

/** 輪郭どうしをつなぐ立体(罫線面・ロフトの基本の場合、§2.9.2)。 */
function makePlainThruSections(
  oc: OpenCascadeInstance,
  spec: ThruSectionsStepSpec,
  keep: Allocations['keep'],
): TopoDS_Shape {
  const maker = keep(new oc.BRepOffsetAPI_ThruSections(spec.closed, spec.ruled, SEWING_TOLERANCE));
  // 辺の数と向きを揃える(§2.9.2)。輪郭ごとに稜線の数が違っても対応が付く。
  //
  // **ひねりを指定したときは揃え直さない**(2026-09-05 実測)。`CheckCompatibility` は
  // 「各断面の始点と向きを決め直して揃える」処理なので、`twist` でずらした始点も
  // 元へ戻してしまい、体積が 1e-3 の桁まで同じになった(ひねりが効かない)。
  // ずらすときは並び順どおりの対応に任せる(§0.a-0.28。ねじれは目で見て直す)。
  maker.CheckCompatibility(spec.twist === 0);
  for (let index = 0; index < spec.sections.length; index += 1) {
    const section = spec.sections[index];
    // 球はこの経路へ来ない(makeThruSections が先に振り分ける)。
    const curves = section.kind === 'sphere' ? [] : section.curves;
    // ひねりは 2 つ目以降の輪郭にだけ効かせる(片方の始点だけをずらす。§0.a-0.28)。
    maker.AddWire(makeSectionWire(oc, index === 0 ? curves : rotateCurves(curves, spec.twist), keep));
  }
  maker.Build(keep(new oc.Message_ProgressRange_1()));
  // IsDone() を見る前に Shape() を呼ばない(makeSpring.ts と同じ扱い)。
  if (!maker.IsDone()) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * 面と面をつなぐ立体(罫線面、FR-430)とロフト(FR-410)を作る。
 *
 * **対象を消費しない「作る」フィーチャー**(§0.a-0.27)。輪郭の材料になった立体は
 * そのまま画面に残るので、1 つにまとめたければ利用者が和(FR-404)を取る。
 *
 * 断るときは利用者へそのまま見せられる日本語の Error を投げ、呼び出し側
 * (`recomputeSolids`)が理由として拾う(FR-504、NFR-RE-1。止めずに理由を出す)。
 */
export function makeThruSections(
  oc: OpenCascadeInstance,
  spec: ThruSectionsStepSpec,
  options: TessellationOptions = {},
): OcctShapeHandle {
  if (spec.sections.length < MINIMUM_SECTION_COUNT) {
    throw new Error(TOO_FEW_SECTIONS_MESSAGE);
  }
  if (!Number.isInteger(spec.twist)) {
    throw new Error(TWIST_MESSAGE);
  }
  const { sphere, curves } = splitSphereSection(spec.sections);

  const { keep, release } = createAllocations();
  try {
    const shape =
      sphere === null
        ? makePlainThruSections(oc, spec, keep)
        : makeSphereRuledSolid(oc, sphere, curves, options, keep);
    checkSolid(oc, shape);
    return { shape, delete: release };
  } catch (error) {
    release();
    // OCCT の C++ 例外は数値で飛んでくる(makeFillet.ts / makeSpring.ts と同じ)。
    throw error instanceof Error ? error : new Error(BUILD_FAILED_MESSAGE);
  }
}
