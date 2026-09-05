/**
 * 球面グリッドの組み立てと交点への吸着(計画書 docs/plans/P5-高度なソリッド・外観と測定.md
 * §2.8.2、タスク20)。
 *
 * 対応要件: FR-431(球の緯度・経度の案内グリッドと、その交点から作る球面上の点)、
 * FR-107(吸着の判定は画面座標で 12 画素)、NFR-PF-1(ビューポート操作で 60fps)。
 *
 * ここは DOM にも three.js にも触れない純関数だけを置く(`snapMath.ts` / `pickMath.ts` と
 * 同じ流儀)。描画(`LineSegments`)と配線はタスク21、緯度・経度の入力と点の作成はタスク22。
 *
 * 【軸の規約】タスク19(`model` の `PointReference.sphereGrid`)と**必ず同じ**にする。
 *   - 北極は +Z、経度 0 は +X、+X → +Y の向きが経度の正。
 *   - 位置 = C + r(cos φ cos λ, cos φ sin λ, sin φ)   φ = 緯度、λ = 経度(どちらも度)
 *   - 緯度は [−90, 90]、経度は 360 で回る。
 *   - 基本形状の向き(`PrimitiveFeature.axis`)は見ない(緯度・経度の基準は世界の軸に固定)。
 * 描画と吸着が別の規約を持つと、案内線の交点と実際に作られる点がずれるため、
 * この規約は 1 か所(このファイルの `sphereGridPointAt`)だけで表す。
 *
 * 【model の型に依存しない理由】球そのもの(`PrimitiveFeature`)や `PointReference.sphereGrid`
 * ではなく、**中心と半径の数値**で受ける。組み立ても吸着も中心と半径しか要らず、
 * 数値で受けておけば予告表示(まだ文書に無い球)にもそのまま使えるため。
 */

import {
  addVec3, degreesToRadians, dotVec3, radiansToDegrees, subVec3, type Vec3,
} from '@pointercad/model';

import { SNAP_RADIUS_PIXELS, type ProjectToScreen } from '../sketch/snapMath.js';
import type { PointerRay } from '../sketch/trackMath.js';

/** 緯線・経線の間隔(度)の下限・上限と既定(§0.a-0.21)。 */
export const MIN_SPHERE_GRID_STEP_DEGREES = 1;
export const MAX_SPHERE_GRID_STEP_DEGREES = 90;
export const DEFAULT_SPHERE_GRID_STEP_DEGREES = 5;

/** 間隔が範囲外のときの断り(計画書 §2.8.3)。 */
export const SPHERE_GRID_STEP_RANGE_MESSAGE =
  'グリッドの間隔は 1 度以上 90 度以下にしてください。';

/**
 * 1 本の線(緯線 1 周・経線 1 本)を折れ線にするときの分割数。**間隔が変わっても 72 固定**
 * (計画書 タスク20 手順2)。5° の経線 72 本に合わせた値で、緯線は 1 周 360° を 5° ずつ、
 * 経線は南極から北極までの 180° を 2.5° ずつに割る。
 */
export const SPHERE_GRID_DIVISIONS = 72;

/** 球面グリッドを決めるもの。球は中心と半径の数値だけで受ける(冒頭の注釈)。 */
export interface SphereGridSpec {
  readonly center: Vec3;
  readonly radius: number;
  /** 緯線・経線の間隔(度)。1 以上 90 以下。 */
  readonly stepDegrees: number;
}

/** 格子点 1 つ。緯度・経度は度で、位置はその緯度・経度から求めた球面上の点。 */
export interface SphereGridPoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly position: Vec3;
}

/** 組み立てた球面グリッド。描画に使う線分列と、交点の一覧。 */
export interface SphereGrid {
  readonly spec: SphereGridSpec;
  /** 緯線・経線をまとめた線分列(1 本の `LineSegments` 用。1 線分あたり 6 個の数値)。 */
  readonly positions: Float32Array;
  /** 格子点(緯線と経線の交点 + 極 2 点)。 */
  readonly points: readonly SphereGridPoint[];
}

/** 間隔が使える値か(1 以上 90 以下の有限の数)。 */
export function isValidSphereGridStep(stepDegrees: number): boolean {
  return (
    Number.isFinite(stepDegrees) &&
    stepDegrees >= MIN_SPHERE_GRID_STEP_DEGREES &&
    stepDegrees <= MAX_SPHERE_GRID_STEP_DEGREES
  );
}

/**
 * 組み立ての入口で間隔を確かめる。1° 未満は線分が 25 万本を超えて実用にならず、
 * 90° 超は緯線が 1 本も引けない(§0.a-0.21)。
 *
 * **組み立てだけが例外を投げ、吸着(`nearestSphereGridPoint`)は null を返す。**
 * 吸着は `pointermove` ごとに呼ばれるので、範囲外の間隔で例外を投げ続けると操作が
 * 止まってしまうため(FR-504「止めずに警告する」)。
 */
function assertSphereGridStep(stepDegrees: number): void {
  if (!isValidSphereGridStep(stepDegrees)) {
    throw new Error(SPHERE_GRID_STEP_RANGE_MESSAGE);
  }
}

/** 角度を 0 以上 360 未満へ回す。 */
function normalizeLongitude(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * 緯度・経度(度)から球面上の点を求める(冒頭の軸の規約)。
 *
 * 極(緯度 ±90)だけは三角関数を通さず軸の上の点をそのまま返す。`Math.cos(π/2)` は
 * 厳密には 0 にならず 6.1e-17 なので、そのまま掛けると経線ごとに 1e-15 ほど違う「極」が
 * できてしまう。**極は 1 点に集約する**(§2.8.2)ので、ここで厳密に揃える。
 */
export function sphereGridPointAt(
  spec: SphereGridSpec,
  latitudeDegrees: number,
  longitudeDegrees: number,
): Vec3 {
  if (Math.abs(latitudeDegrees) === 90) {
    return addVec3(spec.center, [0, 0, Math.sign(latitudeDegrees) * spec.radius]);
  }
  const latitude = degreesToRadians(latitudeDegrees);
  const longitude = degreesToRadians(longitudeDegrees);
  const ring = spec.radius * Math.cos(latitude);
  return addVec3(spec.center, [
    ring * Math.cos(longitude),
    ring * Math.sin(longitude),
    spec.radius * Math.sin(latitude),
  ]);
}

/**
 * 球面上(またはその向き)の点から緯度・経度(度)を求める。`sphereGridPointAt` の逆で、
 * 半径には依らない(向きだけで決まる)ので、光線と球の交点にもそのまま使える。
 *
 * 中心とまったく同じ点は向きが決まらないので、緯度・経度とも 0 を返す(呼び出し側は
 * 交点として使わない)。
 */
export function sphereGridLatLonOf(
  position: Vec3,
  center: Vec3,
): { readonly latitude: number; readonly longitude: number } {
  const delta = subVec3(position, center);
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  if (length === 0) {
    return { latitude: 0, longitude: 0 };
  }
  // 丸めで 1 をわずかに超えると asin が NaN になるので挟み込む。
  const sine = Math.min(Math.max(delta[2] / length, -1), 1);
  return {
    latitude: radiansToDegrees(Math.asin(sine)),
    longitude: normalizeLongitude(radiansToDegrees(Math.atan2(delta[1], delta[0]))),
  };
}

/**
 * 緯線を引く緯度の一覧(度、南から北へ)。**極は含まない**(極は緯線ではなく点)。
 * 5° なら 35 本(`180/5 − 1`)、15° なら 11 本(−75〜75)。
 */
export function sphereGridLatitudes(stepDegrees: number): readonly number[] {
  assertSphereGridStep(stepDegrees);
  // 90 ちょうどは極なので含めない(90 未満の倍数まで)。割り算の丸めで 90 を拾わないよう 1e-9 引く。
  const ringCount = Math.ceil(90 / stepDegrees - 1e-9) - 1;
  const latitudes: number[] = [];
  for (let index = -ringCount; index <= ringCount; index += 1) {
    // −0 は 0 と同じ緯度なので +0 へ揃える(比較・表示が値の中身と食い違わないように。
    // model の `cleanZeroVec3` と同じ理由)。
    const latitude = index * stepDegrees;
    latitudes.push(latitude === 0 ? 0 : latitude);
  }
  return latitudes;
}

/**
 * 経線を引く経度の一覧(度、0 から東回り)。5° なら 72 本、15° なら 24 本。
 * 360 を割り切れない間隔(例: 7°)では 0° の手前だけ間が狭くなるが、
 * 吸着の丸め(`nearestSphereGridPoint`)も同じ一覧の上へ丸めるので食い違わない。
 */
export function sphereGridLongitudes(stepDegrees: number): readonly number[] {
  assertSphereGridStep(stepDegrees);
  // 360 未満の倍数まで(0° と 360° は同じ経線なので 1 本だけ)。割り切れる間隔では
  // ちょうど 360/間隔 本になり、割り切れない間隔でも最後の 1 本が 360° を越えない。
  const meridianCount = Math.ceil(360 / stepDegrees - 1e-9);
  const longitudes: number[] = [];
  for (let index = 0; index < meridianCount; index += 1) {
    longitudes.push(index * stepDegrees);
  }
  return longitudes;
}

/**
 * 格子点(緯線と経線の交点)の一覧。末尾に極 2 点(南・北)を足す。
 * 15° なら `11 × 24 + 2 = 266` 個。
 */
export function sphereGridPoints(spec: SphereGridSpec): readonly SphereGridPoint[] {
  const latitudes = sphereGridLatitudes(spec.stepDegrees);
  const longitudes = sphereGridLongitudes(spec.stepDegrees);
  const points: SphereGridPoint[] = [];
  for (const latitude of latitudes) {
    for (const longitude of longitudes) {
      points.push({ latitude, longitude, position: sphereGridPointAt(spec, latitude, longitude) });
    }
  }
  // 極は経度を持たない 1 点なので、経度 0 として 1 つずつだけ持つ。
  points.push({ latitude: -90, longitude: 0, position: sphereGridPointAt(spec, -90, 0) });
  points.push({ latitude: 90, longitude: 0, position: sphereGridPointAt(spec, 90, 0) });
  return points;
}

/** 線分 1 本(6 個の数値)を書き込み、次の書き込み位置を返す。 */
function writeSegment(target: Float32Array, offset: number, from: Vec3, to: Vec3): number {
  target[offset] = from[0];
  target[offset + 1] = from[1];
  target[offset + 2] = from[2];
  target[offset + 3] = to[0];
  target[offset + 4] = to[1];
  target[offset + 5] = to[2];
  return offset + 6;
}

/**
 * 緯線・経線をまとめた線分列(1 本の `LineSegments` 用)。
 *
 * 緯線 1 本は 1 周 360° を、経線 1 本は南極から北極までの 180° を、それぞれ
 * `SPHERE_GRID_DIVISIONS`(72)に割る。線分の総本数は `(緯線 + 経線) × 72`
 * (5° なら `35×72 + 72×72 = 7704` 本、数値は 46,224 個)。
 */
export function buildSphereGridPositions(spec: SphereGridSpec): Float32Array {
  const latitudes = sphereGridLatitudes(spec.stepDegrees);
  const longitudes = sphereGridLongitudes(spec.stepDegrees);
  const segmentCount = (latitudes.length + longitudes.length) * SPHERE_GRID_DIVISIONS;
  const positions = new Float32Array(segmentCount * 6);
  let offset = 0;

  // 緯線: 緯度を固定して経度を 1 周する。
  const longitudeStep = 360 / SPHERE_GRID_DIVISIONS;
  for (const latitude of latitudes) {
    let from = sphereGridPointAt(spec, latitude, 0);
    for (let index = 1; index <= SPHERE_GRID_DIVISIONS; index += 1) {
      // 最後の 1 本は始点へ戻して輪を閉じる(360° は 0° と同じ点だが、丸めで
      // わずかにずれるので同じ値を使う)。
      const to =
        index === SPHERE_GRID_DIVISIONS ? sphereGridPointAt(spec, latitude, 0)
          : sphereGridPointAt(spec, latitude, index * longitudeStep);
      offset = writeSegment(positions, offset, from, to);
      from = to;
    }
  }

  // 経線: 経度を固定して南極(−90)から北極(+90)まで。両端は極に集まる。
  const latitudeStep = 180 / SPHERE_GRID_DIVISIONS;
  for (const longitude of longitudes) {
    let from = sphereGridPointAt(spec, -90, longitude);
    for (let index = 1; index <= SPHERE_GRID_DIVISIONS; index += 1) {
      const to = sphereGridPointAt(spec, -90 + index * latitudeStep, longitude);
      offset = writeSegment(positions, offset, from, to);
      from = to;
    }
  }

  return positions;
}

/** 線分列と格子点をまとめて組み立てる(描画はタスク21、点の作成はタスク22が使う)。 */
export function buildSphereGrid(spec: SphereGridSpec): SphereGrid {
  return {
    spec,
    positions: buildSphereGridPositions(spec),
    points: sphereGridPoints(spec),
  };
}

/**
 * 光線と球の手前の交点までの道のり(`ray.origin + t·ray.direction`)。交わらなければ null。
 *
 * |o + t·d − c|² = r² を t について解く(2 次方程式)。
 *   a = d·d、b = (o − c)·d、c₀ = (o − c)·(o − c) − r²
 *   判別式 = b² − a·c₀
 * 手前(t が小さい方)から順に、**進む向き(t ≥ 0)にある最初の交点**を採る。
 * 視点が球の中に入っているときは奥側の交点だけが t ≥ 0 になるので、それを採る。
 */
function raySphereHit(spec: SphereGridSpec, ray: PointerRay): number | null {
  const toOrigin = subVec3(ray.origin, spec.center);
  const a = dotVec3(ray.direction, ray.direction);
  if (a === 0) {
    return null;
  }
  const b = dotVec3(toOrigin, ray.direction);
  const c0 = dotVec3(toOrigin, toOrigin) - spec.radius * spec.radius;
  const discriminant = b * b - a * c0;
  if (discriminant < 0) {
    return null;
  }
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / a;
  if (near >= 0) {
    return near;
  }
  const far = (-b + root) / a;
  return far >= 0 ? far : null;
}

/**
 * ポインタの光線から、最も近い格子点(緯度・経度を間隔で丸めたもの)を求める(§2.8.2)。
 *
 * **候補を全部回さない。** 光線と球の交点を解いて緯度・経度へ直し、間隔で丸めるだけなので、
 * 費用は交点の数(5° で 2,522 個)に依らず一定になる。`pointermove` ごとに呼んでも
 * NFR-PF-1(60fps)を割らない。
 *
 * 光線が球を外れる・後ろ向き・間隔が範囲外のときは null(例外は投げない。FR-504)。
 */
export function nearestSphereGridPoint(
  spec: SphereGridSpec,
  ray: PointerRay,
): SphereGridPoint | null {
  if (!isValidSphereGridStep(spec.stepDegrees) || !(spec.radius > 0)) {
    return null;
  }
  const distance = raySphereHit(spec, ray);
  if (distance === null) {
    return null;
  }
  const hit: Vec3 = [
    ray.origin[0] + ray.direction[0] * distance,
    ray.origin[1] + ray.direction[1] * distance,
    ray.origin[2] + ray.direction[2] * distance,
  ];
  const { latitude, longitude } = sphereGridLatLonOf(hit, spec.center);

  // 緯度は最寄りの緯線へ。±90 を超えたら極へ寄せる(極も格子点)。
  const roundedLatitude = Math.min(
    Math.max(Math.round(latitude / spec.stepDegrees) * spec.stepDegrees, -90),
    90,
  );
  // 極では経度が意味を持たないので 0 に揃える(`sphereGridPoints` の極と同じ形)。
  const roundedLongitude =
    Math.abs(roundedLatitude) === 90
      ? 0
      : normalizeLongitude(Math.round(longitude / spec.stepDegrees) * spec.stepDegrees);

  return {
    latitude: roundedLatitude,
    longitude: roundedLongitude,
    position: sphereGridPointAt(spec, roundedLatitude, roundedLongitude),
  };
}

/**
 * 球面グリッドの交点への吸着(FR-431、FR-107)。
 *
 * 丸めで決めた格子点(`nearestSphereGridPoint`)が、**画面上でポインタから判定半径
 * (既定 12 画素、`SNAP_RADIUS_PIXELS`)の中にあるとき**だけ返す。判定を画面座標で行うのは
 * `snapMath.ts` と同じ理由(ワールド座標で測ると遠くの球にも近くと同じ距離で吸い付く)。
 * ワールド → 画面の写しは呼び出し側(ビューポート)から関数で注入する。
 *
 * 位置そのものは光線の最近点(球との交点)から決まるので、視点が斜めでも案内の交点と
 * ポインタがずれない(P4b 仕上げ (a) と同じ考え方)。
 */
export function snapToSphereGrid(
  spec: SphereGridSpec,
  ray: PointerRay,
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number = SNAP_RADIUS_PIXELS,
): SphereGridPoint | null {
  const candidate = nearestSphereGridPoint(spec, ray);
  if (candidate === null) {
    return null;
  }
  const screen = project(candidate.position);
  if (screen === null) {
    return null;
  }
  const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
  return distance <= radiusPixels ? candidate : null;
}
