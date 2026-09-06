/**
 * スケッチの要素を DXF の実体へ写す(要件 FR-813、計画書 docs/plans/P6-入出力.md
 * §2.7・§0.a-0.34、タスク26)。
 *
 * 書き出しの 2 段のうちの 1 段目にあたる(`dxfToSketch.ts` の逆向き)。
 *
 * ```
 * SketchFeature[] → sketchToDxf(…)      : DxfEntity[] … この段(model)
 *                 → writeDxf(entities)  : string      … R12 のテキスト(タスク25。io)
 * ```
 *
 * ## 何を書き、何を書かないか
 *
 * - **書き出すのは「いま編集しているスケッチの要素」**(§0.a-0.34)。図面(投影図・寸法)の
 *   書き出しは P8。
 * - **座標は作図面の上の 2 次元**(作図面の原点と 2 軸で写した X・Y)。Z は書かない。
 * - **構築線(FR-320)は書き出さない**(実体にならない補助線なので。§0.a-0.34)。
 * - **3D スケッチ(FR-330)は書き出さない。** 平面が決まらないので `plane` に `null` が
 *   来たら `DXF_NOT_PLANAR_MESSAGE` で断る。作図面のある要素でも、その作図面が
 *   書き出し先の平面と違って**形が平面から浮いていれば**同じ文言で断る(利用者から見ると
 *   「この形は平らではない」という同じ 1 つの事実のため)。
 * - **円は「開始 0 度・終了 360 度の円弧」**として出す(§0.32。実体の種類を増やさない。
 *   R12 の `CIRCLE` へ落とすのは `io` の `writeDxf` の役目)。
 * - **レイヤーは `0` の 1 枚だけ、色は付けない**(§0.a-0.30。レイヤー・線種は FR-730 で P8)。
 *
 * ## 解決済みの形(`ResolvedSketch`)を受ける理由
 *
 * 履歴(`SketchDocument.features`)には矩形・正多角形・長穴・オフセット・複製・投影のように
 * **1 つで複数の曲線を生む**種類があり、その形は `resolveSketch` が決めている。履歴だけを
 * 見て DXF を組み立てると同じ幾何の規則をここへ写すことになるので、**解決済みの曲線を
 * 受け取り、履歴は「どれが構築線か」と「並び順」を知るためだけに使う。**
 *
 * ## 楕円の角度について
 *
 * `ResolvedEllipse` の開始角・終了角は**媒介変数**(ラジアン)で、DXF の実体が持つのは
 * **長軸から測った方位角**(度)なので、`ellipseParameterToAzimuth` で戻す。これは
 * `resolveSketch.ts` の `azimuthToEllipseParameter` の逆関数で、**逆向きの式はここ 1 か所**に置く
 * (`packages/io/src/dxf/dxfCurves.ts` に同じ式の私的な写しがあるが、`io` は `model` に
 * 依存できるので、そちらをこの輸出へ寄せるのはタスク32 / 44 への申し送り)。
 */

import {
  distanceToPlane,
  radiansToDegrees,
  worldToPlane,
  type WorkPlane,
} from '../sketch/planeMath.js';
import type {
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  ResolvedSpline,
  SketchDocument,
  SketchFeature,
} from '../sketch/types.js';
import { dotVec3, SKETCH_TOLERANCE_MM, type Vec3 } from '../sketch/vec3.js';
import type {
  SketchDxfArcEntity,
  SketchDxfEllipseEntity,
  SketchDxfEntity,
  SketchDxfEntityBase,
  SketchDxfLineEntity,
  SketchDxfPoint2d,
  SketchDxfPointEntity,
  SketchDxfSplineEntity,
} from './dxfTypes.js';

/**
 * 平らでない形を DXF に書き出そうとしたときの断り(計画書 §2.7 の断りの表)。
 * **文言の正本はこの層に置く**(`docs/plans/P6-入出力.md` §2.8 の「文言の正本の層」。
 * kernel / io / model が組み立てる文は `ja.json` に持たない)。
 */
export const DXF_NOT_PLANAR_MESSAGE = 'この形は平らではないので DXF に書き出せません。';

/** 書き出す実体のレイヤー(§0.a-0.30「レイヤーは 1 枚(`0`)だけ」)。 */
const EXPORT_LAYER = '0';

/**
 * 書き出す自由曲線の次数。`model` の曲線は 3 次まで(`sketch/splineMath.ts` の `MAX_DEGREE`)なので、
 * 読み直したときに「次数の高い曲線」の案内が出ない値にする。
 */
const EXPORTED_SPLINE_DEGREE = 3;

const FULL_TURN_DEGREES = 360;

/**
 * 曲線の乗る平面が書き出し先の平面と同じ向きだとみなす許容(法線どうしの内積の 1 からの差)。
 * 法線はどちらも単位ベクトルなので、この差は角度のずれの 2 乗の半分にあたる。
 */
const PLANE_ALIGNMENT_TOLERANCE = 1e-9;

/** `sketchToDxf` の入力。解決済みの形と、履歴と、書き出し先の作図面。 */
export interface SketchToDxfInput {
  /** 履歴。**どれが構築線か**と、実体を並べる順を決めるのに使う。 */
  readonly document: SketchDocument;
  /** `resolveSketch` の結果。曲線の形はすべてここから取る。 */
  readonly resolved: ResolvedSketch;
  /**
   * 書き出し先の作図面。**3D スケッチ(作図面が無い、FR-330)なら `null`** を渡す。
   * 座標はこの作図面の 2 次元へ落とし、角度は第1軸から測る。
   */
  readonly plane: WorkPlane | null;
}

/** `sketchToDxf` の結果。断りは日本語 1 文で返す(NFR-UX-5)。 */
export type SketchToDxfResult =
  | { readonly ok: true; readonly entities: readonly SketchDxfEntity[] }
  | { readonly ok: false; readonly reason: string };

/** `-0` を `0` へ寄せる(`io` の DXF の段と揃える。同じ形から違うバイト列を作らないため)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 度を `[0, 360)` へ畳む。`-0` は作らない。 */
function foldDegrees(degrees: number): number {
  const wrapped = degrees % FULL_TURN_DEGREES;
  return normalizeZero(wrapped < 0 ? wrapped + FULL_TURN_DEGREES : wrapped);
}

/**
 * 楕円の媒介変数を、長軸から測った方位角(ラジアン)へ直す。
 * `resolveSketch.ts` の `azimuthToEllipseParameter` の逆。
 *
 * 楕円上の点は媒介変数 `t` で `(a·cos t, b·sin t)` と書けるので、中心から見た方位角は
 * `atan2(b·sin t, a·cos t)`(`a ≠ b` のときは `t` と一致しない)。`t` が `2π` を超えていても
 * 掃過量を失わないよう、**回った周回数を先に外し**、畳んだ `[0, 2π)` の中で方位角を
 * 求めてから周回数を戻す。こうすると `t = 2π` がちょうど `2π` へ戻り、全周の楕円で
 * 「終了角 − 開始角 = 360 度」が誤差なく成り立つ。
 */
export function ellipseParameterToAzimuth(
  parameter: number,
  majorRadius: number,
  minorRadius: number,
): number {
  const fullTurn = 2 * Math.PI;
  const turns = Math.floor(parameter / fullTurn);
  const folded = parameter - turns * fullTurn;
  const base = Math.atan2(minorRadius * Math.sin(folded), majorRadius * Math.cos(folded));
  const positive = base < 0 ? base + fullTurn : base;
  return positive + turns * fullTurn;
}

/** 構築線(FR-320)か。欄を持たない種類(点・点列・面)は常に false。 */
function isConstruction(feature: SketchFeature): boolean {
  return 'construction' in feature && feature.construction;
}

/** 実体に共通の欄。レイヤーは 1 枚だけ、色は付けない(§0.a-0.30)。 */
const ENTITY_BASE: SketchDxfEntityBase = { layer: EXPORT_LAYER, color: null };

/**
 * ワールド座標を作図面の 2 次元の点へ落とす。**平面から浮いていれば `null`**
 * (落として書くと、読み直したときに違う形になるため)。
 */
function toPlanePoint(plane: WorkPlane, world: Vec3): SketchDxfPoint2d | null {
  if (!Number.isFinite(world[0]) || !Number.isFinite(world[1]) || !Number.isFinite(world[2])) {
    return null;
  }
  if (distanceToPlane(plane, world) > SKETCH_TOLERANCE_MM) {
    return null;
  }
  const [u, v] = worldToPlane(plane, world);
  return { x: normalizeZero(u), y: normalizeZero(v) };
}

/**
 * 曲線が乗る平面の法線と書き出し先の法線の向きが同じか(`+1`)、逆か(`-1`)。
 * どちらでもない(傾いている)なら `null` で、その形は平らでないものとして断る。
 *
 * 逆向きのときは、作図面の上で見ると角度が時計回りに進む。角度の符号を反転して
 * **反時計回りの表し方へ直す**ので、形そのものは変わらない(DXF は向きを書けない)。
 */
function planeAlignment(plane: WorkPlane, normal: Vec3): number | null {
  const alignment = dotVec3(normal, plane.normal);
  if (Math.abs(alignment - 1) <= PLANE_ALIGNMENT_TOLERANCE) {
    return 1;
  }
  if (Math.abs(alignment + 1) <= PLANE_ALIGNMENT_TOLERANCE) {
    return -1;
  }
  return null;
}

/** 作図面の上でのベクトルの向き(度)。第1軸が 0 度で、第1軸から第2軸へ回る向きが正。 */
function directionDegrees(plane: WorkPlane, direction: Vec3): number {
  return radiansToDegrees(
    Math.atan2(dotVec3(direction, plane.axisV), dotVec3(direction, plane.axisU)),
  );
}

function pointEntity(plane: WorkPlane, point: ResolvedPoint): SketchDxfPointEntity | null {
  const position = toPlanePoint(plane, point.position);
  return position === null ? null : { ...ENTITY_BASE, kind: 'point', position };
}

function segmentEntity(plane: WorkPlane, segment: ResolvedSegment): SketchDxfLineEntity | null {
  const start = toPlanePoint(plane, segment.from);
  const end = toPlanePoint(plane, segment.to);
  if (start === null || end === null) {
    return null;
  }
  return { ...ENTITY_BASE, kind: 'line', start, end };
}

/**
 * 円弧。`ResolvedArc` の角度は `xAxis` から `normal` まわりのラジアンなので、
 * **作図面の第1軸から測った度**へ直す(第1軸から `xAxis` までの角 + 符号つきの角度)。
 * 開始角は `[0, 360)` へ畳み、終了角は「開始角 + 符号つきの中心角」にして、
 * 全周(差が ±360)の情報を落とさない。
 */
function arcEntity(plane: WorkPlane, arc: ResolvedArc): SketchDxfArcEntity | null {
  const center = toPlanePoint(plane, arc.center);
  const sign = planeAlignment(plane, arc.normal);
  if (center === null || sign === null || !(arc.radius > 0)) {
    return null;
  }
  const base = directionDegrees(plane, arc.xAxis);
  const start = base + sign * radiansToDegrees(arc.startAngle);
  const end = base + sign * radiansToDegrees(arc.endAngle);
  const startAngle = foldDegrees(start);
  return {
    ...ENTITY_BASE,
    kind: 'arc',
    center,
    radius: arc.radius,
    startAngle,
    endAngle: normalizeZero(startAngle + (end - start)),
  };
}

/**
 * 楕円(弧)。長軸の傾きは作図面の第1軸から測り、開始角・終了角は媒介変数を
 * **方位角**へ戻してから度にする(`SketchDxfEllipseEntity` の約束)。
 */
function ellipseEntity(plane: WorkPlane, ellipse: ResolvedEllipse): SketchDxfEllipseEntity | null {
  const center = toPlanePoint(plane, ellipse.center);
  const sign = planeAlignment(plane, ellipse.normal);
  if (
    center === null ||
    sign === null ||
    !(ellipse.majorRadius > 0) ||
    !(ellipse.minorRadius > 0)
  ) {
    return null;
  }
  const startAzimuth = ellipseParameterToAzimuth(
    ellipse.startAngle,
    ellipse.majorRadius,
    ellipse.minorRadius,
  );
  const endAzimuth = ellipseParameterToAzimuth(
    ellipse.endAngle,
    ellipse.majorRadius,
    ellipse.minorRadius,
  );
  const start = sign * radiansToDegrees(startAzimuth);
  const end = sign * radiansToDegrees(endAzimuth);
  const startAngle = foldDegrees(start);
  return {
    ...ENTITY_BASE,
    kind: 'ellipse',
    center,
    majorRadius: ellipse.majorRadius,
    minorRadius: ellipse.minorRadius,
    rotation: foldDegrees(directionDegrees(plane, ellipse.majorAxis)),
    startAngle,
    endAngle: normalizeZero(startAngle + (end - start)),
  };
}

/** 自由曲線。点をそのまま渡す(閉じるための重複点は入れない約束も同じ)。 */
function splineEntity(plane: WorkPlane, spline: ResolvedSpline): SketchDxfSplineEntity | null {
  const points: SketchDxfPoint2d[] = [];
  for (const point of spline.points) {
    const converted = toPlanePoint(plane, point);
    if (converted === null) {
      return null;
    }
    points.push(converted);
  }
  return {
    ...ENTITY_BASE,
    kind: 'spline',
    mode: spline.mode,
    points,
    closed: spline.closed,
    degree: EXPORTED_SPLINE_DEGREE,
    warnings: [],
  };
}

function curveEntity(plane: WorkPlane, curve: ResolvedCurve): SketchDxfEntity | null {
  switch (curve.kind) {
    case 'segment':
      return segmentEntity(plane, curve);
    case 'arc':
      return arcEntity(plane, curve);
    case 'ellipse':
      return ellipseEntity(plane, curve);
    case 'spline':
      return splineEntity(plane, curve);
  }
}

/** 解決済みの点を、それを生んだフィーチャーごとにまとめる(並びは解決の順のまま)。 */
function groupPoints(
  points: readonly ResolvedPoint[],
): ReadonlyMap<string, readonly ResolvedPoint[]> {
  const grouped = new Map<string, ResolvedPoint[]>();
  for (const point of points) {
    const bucket = grouped.get(point.featureId);
    if (bucket === undefined) {
      grouped.set(point.featureId, [point]);
    } else {
      bucket.push(point);
    }
  }
  return grouped;
}

/**
 * 解決済みの曲線を、それを生んだフィーチャーごとにまとめる。
 *
 * **1 フィーチャーが複数の曲線を生むもの(矩形・長穴・複製など)は `curvesByFeature` が
 * 正本**で、そちらにだけ「1 つの中での並び順」がある(`ResolvedSketch` の注釈)。
 * 種類ごとの配列(`segments` / `arcs` / …)には同じ曲線がもう一度入っているので、
 * `curvesByFeature` にある id は種類ごとの配列から拾わない(二重に書き出さないため)。
 */
function groupCurves(resolved: ResolvedSketch): ReadonlyMap<string, readonly ResolvedCurve[]> {
  const grouped = new Map<string, readonly ResolvedCurve[]>();
  const lists: readonly (readonly ResolvedCurve[])[] = [
    resolved.segments,
    resolved.arcs,
    resolved.ellipses,
    resolved.splines,
  ];
  for (const list of lists) {
    for (const curve of list) {
      if (resolved.curvesByFeature.has(curve.featureId)) {
        continue;
      }
      grouped.set(curve.featureId, [...(grouped.get(curve.featureId) ?? []), curve]);
    }
  }
  for (const [featureId, curves] of resolved.curvesByFeature) {
    grouped.set(featureId, curves);
  }
  return grouped;
}

/**
 * スケッチの要素を DXF の実体へ写す(計画書 §2.7 の表を逆向きにたどる)。
 *
 * 実体の並びは**履歴の順**(同じスケッチからは必ず同じ並びが出る。`writeDxf` の決定性が
 * この並びに乗る)。面(`face`)は書き出さない——面の輪郭は境界に選ばれた要素として
 * 既に出るので、二重に書くことになるため。
 */
export function sketchToDxf(input: SketchToDxfInput): SketchToDxfResult {
  const { document, resolved, plane } = input;
  if (plane === null) {
    return { ok: false, reason: DXF_NOT_PLANAR_MESSAGE };
  }
  const pointsByFeature = groupPoints(resolved.points);
  const curvesByFeature = groupCurves(resolved);
  const entities: SketchDxfEntity[] = [];
  for (const feature of document.features) {
    if (feature.kind === 'face' || isConstruction(feature)) {
      continue;
    }
    for (const point of pointsByFeature.get(feature.id) ?? []) {
      const entity = pointEntity(plane, point);
      if (entity === null) {
        return { ok: false, reason: DXF_NOT_PLANAR_MESSAGE };
      }
      entities.push(entity);
    }
    for (const curve of curvesByFeature.get(feature.id) ?? []) {
      const entity = curveEntity(plane, curve);
      if (entity === null) {
        return { ok: false, reason: DXF_NOT_PLANAR_MESSAGE };
      }
      entities.push(entity);
    }
  }
  return { ok: true, entities };
}
