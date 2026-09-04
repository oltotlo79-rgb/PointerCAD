/**
 * 平面の決め方(FR-328 の任意の作業平面)と、その解決(P4 計画書 §2.8、タスク9)。
 *
 * **P5 の切断(FR-432)と共有する型**(P5 計画書 §0.a-0.56、§2.9b.1、P4 §0.a-0.13 の追記)。
 * 「面を確定できる要素の組み合わせ」を 2 か所に書かないため、切断も作業平面もここの
 * `PlaneSpec` を使う。
 *
 * 数値はすべて式(`ExpressionValue`)で持ち、解決のときだけ数へ直す(FR-202、rules/04)。
 * 立体の面・辺・頂点は指紋つきの参照(`SubShapeRef`)で指す。上流が変わったときに
 * 選び直した位置・向きを使えるよう、**部分形状の解決は呼び出し側が渡す関数に任せる**
 * (`PlaneResolveContext.subShape`)。渡されなければ保存された指紋の位置・向きを使う
 * (`subShapeFromFingerprint`)。カーネルへの往復を増やさないためで、P5 計画書 §2.9b.1 の
 * 「UI が持っているボディの一覧から向きを引いて model 側で解決する」と同じ考え方。
 *
 * 例外を投げず、失敗も戻り値で返す(FR-504、NFR-RE-1)。文言は日本語で、利用者が次に
 * 何をすればよいか分かる形にする。
 *
 * 置き場について: `part`(立体)にも `sketch`(スケッチ)にも実体として依存させたくないので、
 * `geometry/subShapeRef.ts` と同じ中立の置き場に置く(P4 §0.a-0.7 と同じ判断)。
 * `part/types.ts` からは型だけを import する(実体を輸入しないので循環しない)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import { keyNumber } from '../part/cacheKey.js';
import type { SketchLineRef } from '../part/types.js';
import {
  degreesToRadians,
  planeAxesFor,
  tiltedDirection,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import type { PointReference } from '../sketch/types.js';
import {
  addVec3,
  crossVec3,
  lengthVec3,
  normalizeVec3,
  rotateAboutAxis,
  rotateDirection,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../sketch/vec3.js';
import type { EdgeCurveKind, FaceSurfaceKind, SubShapeKind, SubShapeRef } from './subShapeRef.js';

/**
 * 軸の指定(FR-329)。回転軸(`RevolveAxis`)の 2 種に、基準軸フィーチャーへの参照を
 * 足したもの。基準軸は「2 点 / 辺 / 面の法線 / 2 面の交線」で作れるので、この 1 種を
 * 通せば辺や面の法線もそのまま軸として使える。
 *
 * `RevolveAxis`(回転・ばね)と `PatternDirection`(パターン)はこの型と同じ形で、
 * どちらの値もそのままここへ渡せる(`reference` を使うのは平面と基準座標系だけ)。
 */
export type AxisSpec =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly line: SketchLineRef }
  | { readonly kind: 'reference'; readonly referenceFeatureId: string };

/** 軸(原点+単位ベクトル)。`RevolveAxisFrame`(resolvePart.ts)と同じ形。 */
export interface AxisFrame {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/**
 * 解決した平面。原点・第 1 軸・第 2 軸・法線を持つ。
 *
 * `WorkPlane`(planeMath.ts)から `id` を除いた形で、カーネルの
 * `SketchPlaneFrame { origin, axisU, normal }`(`packages/kernel/src/occt/makeProjection.ts`)
 * をそのまま含む。投影・交差(タスク25・26)と P5 の切断がこの値をそのまま渡せる。
 */
export interface ResolvedPlane {
  readonly origin: Vec3;
  /** 平面内の第 1 軸。極座標・円弧の角度 0 の向き。 */
  readonly axisU: Vec3;
  /** 平面内の第 2 軸。角度は U から V へ向かう向きが正。 */
  readonly axisV: Vec3;
  /** 単位法線。U × V に等しい(右手系)。 */
  readonly normal: Vec3;
}

/**
 * 選び直したあとの部分形状(面・辺・頂点)の位置と向き。
 * カーネルが指紋で選び直した結果を、呼び出し側がこの形へ詰め替えて渡す。
 */
export interface ResolvedSubShape {
  readonly kind: SubShapeKind;
  /** 面は重心、辺は中点、頂点はその位置。 */
  readonly position: Vec3;
  /** 面は法線、直線の辺は向き、円の辺は軸。無ければ null。 */
  readonly axis: Vec3 | null;
  /** 面の曲面の種類。面以外は null。 */
  readonly surfaceKind: FaceSurfaceKind | null;
  /** 辺の曲線の種類。辺以外は null。 */
  readonly curveKind: EdgeCurveKind | null;
}

/**
 * 平面の決め方(FR-328)。
 *
 * 要件の 6 通り(3 点 / 点+辺 / 点+軸と角度 / 点+既存面に平行 / 既存の平らな面 /
 * 基準平面のオフセット)に、FR-328 v1.0 からの「既存の辺を軸に指定角度だけ傾けた平面」
 * (`tilted`)を足した 7 種。点はすべて `PointReference`(座標の式・スケッチの点・
 * 要素の端点。3D スケッチの点と立体の頂点はタスク10 が同じ型へ 1 種足す)。
 */
export type PlaneSpec =
  /** 3 点を通る。法線は p1→p2 と p1→p3 の外積(右ねじ)、第 1 軸は p1→p2 の向き。 */
  | {
      readonly kind: 'threePoints';
      readonly p1: PointReference;
      readonly p2: PointReference;
      readonly p3: PointReference;
    }
  /** 点+辺。`perpendicular` なら辺に垂直、`containing` なら辺と点の両方を含む。 */
  | {
      readonly kind: 'pointAndEdge';
      readonly point: PointReference;
      readonly edge: SubShapeRef;
      readonly mode: 'perpendicular' | 'containing';
    }
  /** 点+軸。軸に垂直な平面を、傾き角・方位角(いずれも度)だけ倒したもの。 */
  | {
      readonly kind: 'pointAndAxis';
      readonly point: PointReference;
      readonly axis: AxisSpec;
      readonly tilt: ExpressionValue;
      readonly azimuth: ExpressionValue;
    }
  /** 点を通り、既存の平らな面に平行。 */
  | {
      readonly kind: 'pointAndParallelFace';
      readonly point: PointReference;
      readonly face: SubShapeRef;
    }
  /** 既存の平らな面そのもの(`offset` が 0)、またはそこから法線方向へ離した平面。 */
  | { readonly kind: 'face'; readonly face: SubShapeRef; readonly offset: ExpressionValue }
  /** 基準の 3 面や他の作業平面そのもの(`offset` が 0)、またはそこから離した平面。 */
  | {
      readonly kind: 'workPlane';
      readonly planeId: WorkPlaneId;
      readonly offset: ExpressionValue;
    }
  /** 既存の平面を、軸(基準軸・スケッチの線分・ワールドの軸)まわりに角度(度)傾けたもの。 */
  | {
      readonly kind: 'tilted';
      readonly base: WorkPlaneId;
      readonly axis: AxisSpec;
      readonly angle: ExpressionValue;
    };

/** 平面が決まらなかった理由。文言は `resolvePlaneSpec` が日本語で添える。 */
export type PlaneErrorKey =
  /** 基準の点が見つからない。 */
  | 'missingPoint'
  /** 面・辺・頂点の参照が見つからない(形が変わって選び直せない)。 */
  | 'missingSubShape'
  /** 軸が見つからない。 */
  | 'missingAxis'
  /** 基準にする平面が見つからない。 */
  | 'missingPlane'
  /** 3 点が一直線で平面が定まらない。 */
  | 'collinear'
  /** 辺がまっすぐでない。 */
  | 'notStraightEdge'
  /** 面が平らでない。 */
  | 'notFlatFace'
  /** 角度・距離が数でない、または範囲の外。 */
  | 'invalidValue'
  /** 向きが定まらない(点が辺の上にある、長さ 0 のベクトルなど)。 */
  | 'degenerate';

export type PlaneOutcome =
  | { readonly ok: true; readonly plane: ResolvedPlane }
  | { readonly ok: false; readonly reason: PlaneErrorKey; readonly message: string };

/** 平面を解くのに要る手掛かり。呼び出し側(`resolveReferences.ts`)が組み立てて渡す。 */
export interface PlaneResolveContext {
  /** 点の参照をワールド座標へ。解決できなければ null。 */
  readonly point: (reference: PointReference) => Vec3 | null;
  /** 部分形状の位置と向き。省略時は保存された指紋をそのまま使う。 */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
  /** 軸。解決できなければ null。 */
  readonly axis: (spec: AxisSpec) => AxisFrame | null;
  /** 作図面の id から平面を引く。解決できなければ null。 */
  readonly workPlane: (planeId: WorkPlaneId) => ResolvedPlane | null;
}

/** 向きが定まったとみなす最小の長さ(mm)。外積の退化を見る。 */
const DIRECTION_EPSILON = 1e-9;

/** 傾き角の上限(度、含まない)。180 度以上は裏返るだけで新しい平面にならない。 */
const MAX_TILT_DEGREES = 180;

function failure(reason: PlaneErrorKey, message: string): PlaneOutcome {
  return { ok: false, reason, message };
}

/**
 * 保存された指紋から部分形状の位置・向きを取り出す(選び直しの関数が無いときの既定)。
 *
 * 指紋は「選んだ瞬間」の値なので、上流が変わっていれば古い。選び直した値を使うには
 * `PlaneResolveContext.subShape` を渡す(タスク25 と P5 の切断が配線する)。
 */
export function subShapeFromFingerprint(reference: SubShapeRef): ResolvedSubShape {
  const { fingerprint } = reference;
  switch (fingerprint.kind) {
    case 'face':
      return {
        kind: 'face',
        position: fingerprint.position,
        axis: fingerprint.axis,
        surfaceKind: fingerprint.surfaceKind,
        curveKind: null,
      };
    case 'edge':
      return {
        kind: 'edge',
        position: fingerprint.position,
        axis: fingerprint.axis,
        surfaceKind: null,
        curveKind: fingerprint.curveKind,
      };
    case 'vertex':
      return {
        kind: 'vertex',
        position: fingerprint.position,
        axis: null,
        surfaceKind: null,
        curveKind: null,
      };
  }
}

/**
 * 原点と法線から平面を組み立てる。法線の長さが 0 に近ければ null。
 * `xHint` を渡すと、その向き(法線に垂直な成分)を第 1 軸にする。
 */
export function planeFromNormal(
  origin: Vec3,
  normal: Vec3,
  xHint: Vec3 | null = null,
): ResolvedPlane | null {
  if (lengthVec3(normal) <= DIRECTION_EPSILON) {
    return null;
  }
  const unit = normalizeVec3(normal);
  const axes = planeAxesFor(unit, xHint);
  return { origin, axisU: axes.axisU, axisV: axes.axisV, normal: unit };
}

/** 平面を法線方向へ平行移動する(`face` / `workPlane` のオフセット)。 */
function offsetPlane(plane: ResolvedPlane, distance: number): ResolvedPlane {
  return { ...plane, origin: addVec3(plane.origin, scaleVec3(plane.normal, distance)) };
}

type ValueOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly outcome: PlaneOutcome };

function stopWith(reason: PlaneErrorKey, message: string): ValueOutcome<never> {
  return { ok: false, outcome: failure(reason, message) };
}

function takePoint(
  context: PlaneResolveContext,
  reference: PointReference,
  label: string,
): ValueOutcome<Vec3> {
  const point = context.point(reference);
  if (point === null) {
    return stopWith('missingPoint', `${label}が見つかりません。点を選び直してください。`);
  }
  return { ok: true, value: point };
}

function takeSubShape(
  context: PlaneResolveContext,
  reference: SubShapeRef,
  label: string,
): ValueOutcome<ResolvedSubShape> {
  const resolve = context.subShape ?? subShapeFromFingerprint;
  const found = resolve(reference);
  if (found === null) {
    return stopWith(
      'missingSubShape',
      `${label}が見つかりません。形が大きく変わったため、選び直してください。`,
    );
  }
  return { ok: true, value: found };
}

function takeAxis(context: PlaneResolveContext, spec: AxisSpec): ValueOutcome<AxisFrame> {
  const frame = context.axis(spec);
  if (frame === null) {
    return stopWith('missingAxis', '基準にする軸が見つかりません。軸を選び直してください。');
  }
  if (lengthVec3(frame.direction) <= DIRECTION_EPSILON) {
    return stopWith('degenerate', '軸の向きが定まりません。長さのある軸を選んでください。');
  }
  return { ok: true, value: frame };
}

function takeWorkPlane(
  context: PlaneResolveContext,
  planeId: WorkPlaneId,
): ValueOutcome<ResolvedPlane> {
  const plane = context.workPlane(planeId);
  if (plane === null) {
    return stopWith('missingPlane', `基準にする平面が見つかりません: ${planeId}`);
  }
  return { ok: true, value: plane };
}

function takeFiniteNumber(value: number, label: string): ValueOutcome<number> {
  if (!Number.isFinite(value)) {
    return stopWith('invalidValue', `${label}の値が数になっていません。`);
  }
  return { ok: true, value };
}

/** 面が平らで法線を持つことを確かめ、その法線を返す。 */
function flatFaceNormal(face: ResolvedSubShape): ValueOutcome<Vec3> {
  if (face.kind !== 'face' || face.surfaceKind !== 'plane' || face.axis === null) {
    return stopWith('notFlatFace', '平らな面を選んでください。曲がった面では平面が決まりません。');
  }
  return { ok: true, value: face.axis };
}

/** 辺がまっすぐで向きを持つことを確かめ、その向きを返す。 */
function straightEdgeDirection(edge: ResolvedSubShape): ValueOutcome<Vec3> {
  if (edge.kind !== 'edge' || edge.curveKind !== 'line' || edge.axis === null) {
    return stopWith(
      'notStraightEdge',
      'まっすぐな辺を選んでください。円や曲がった辺では平面が決まりません。',
    );
  }
  return { ok: true, value: edge.axis };
}

function resolveThreePoints(
  spec: Extract<PlaneSpec, { readonly kind: 'threePoints' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const p1 = takePoint(context, spec.p1, '1 点目');
  if (!p1.ok) {
    return p1.outcome;
  }
  const p2 = takePoint(context, spec.p2, '2 点目');
  if (!p2.ok) {
    return p2.outcome;
  }
  const p3 = takePoint(context, spec.p3, '3 点目');
  if (!p3.ok) {
    return p3.outcome;
  }
  const along = subVec3(p2.value, p1.value);
  const normal = crossVec3(along, subVec3(p3.value, p1.value));
  if (lengthVec3(normal) <= DIRECTION_EPSILON) {
    return failure(
      'collinear',
      '3 点が一直線に並んでいるため、平面が決まりません。3 点目を線から外してください。',
    );
  }
  // 第 1 軸は 1 点目 → 2 点目の向き(角度 0 の意味を利用者が予測できるようにする)。
  const plane = planeFromNormal(p1.value, normal, along);
  return plane === null
    ? failure('degenerate', '平面の向きが定まりません。')
    : { ok: true, plane };
}

function resolvePointAndEdge(
  spec: Extract<PlaneSpec, { readonly kind: 'pointAndEdge' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const point = takePoint(context, spec.point, '基準の点');
  if (!point.ok) {
    return point.outcome;
  }
  const edge = takeSubShape(context, spec.edge, '基準の辺');
  if (!edge.ok) {
    return edge.outcome;
  }
  const direction = straightEdgeDirection(edge.value);
  if (!direction.ok) {
    return direction.outcome;
  }
  if (spec.mode === 'perpendicular') {
    // 辺に垂直な平面。法線は辺の向きそのもの。
    const plane = planeFromNormal(point.value, direction.value);
    return plane === null
      ? failure('degenerate', '辺の向きが定まりません。')
      : { ok: true, plane };
  }
  // 辺を含む平面。辺の向きと「辺の中点 → 点」の外積が法線になる。
  const toPoint = subVec3(point.value, edge.value.position);
  const normal = crossVec3(direction.value, toPoint);
  if (lengthVec3(normal) <= DIRECTION_EPSILON) {
    return failure(
      'degenerate',
      '点が辺の延長線の上にあるため、平面が決まりません。線から外れた点を選んでください。',
    );
  }
  // 第 1 軸は辺の向き(平面の中で辺が角度 0 になる)。
  const plane = planeFromNormal(point.value, normal, direction.value);
  return plane === null ? failure('degenerate', '平面の向きが定まりません。') : { ok: true, plane };
}

function resolvePointAndAxis(
  spec: Extract<PlaneSpec, { readonly kind: 'pointAndAxis' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const point = takePoint(context, spec.point, '基準の点');
  if (!point.ok) {
    return point.outcome;
  }
  const frame = takeAxis(context, spec.axis);
  if (!frame.ok) {
    return frame.outcome;
  }
  const tilt = takeFiniteNumber(spec.tilt.value, '傾き角');
  if (!tilt.ok) {
    return tilt.outcome;
  }
  if (tilt.value < 0 || tilt.value >= MAX_TILT_DEGREES) {
    return failure(
      'invalidValue',
      `傾き角は 0 度以上 ${String(MAX_TILT_DEGREES)} 度未満にしてください。`,
    );
  }
  const azimuth = takeFiniteNumber(spec.azimuth.value, '方位角');
  if (!azimuth.ok) {
    return azimuth.outcome;
  }
  // 傾き 0 なら軸そのままが法線(= 軸に垂直な平面)。方位角 0 の基準は planeAxesFor の第 1 軸で、
  // 穴・ばね(resolvePart.ts の resolveTiltedDirection)と同じ規約になる。
  const normal = tiltedDirection(
    frame.value.direction,
    degreesToRadians(tilt.value),
    degreesToRadians(azimuth.value),
  );
  const plane = planeFromNormal(point.value, normal);
  return plane === null ? failure('degenerate', '平面の向きが定まりません。') : { ok: true, plane };
}

function resolvePointAndParallelFace(
  spec: Extract<PlaneSpec, { readonly kind: 'pointAndParallelFace' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const point = takePoint(context, spec.point, '基準の点');
  if (!point.ok) {
    return point.outcome;
  }
  const face = takeSubShape(context, spec.face, '基準の面');
  if (!face.ok) {
    return face.outcome;
  }
  const normal = flatFaceNormal(face.value);
  if (!normal.ok) {
    return normal.outcome;
  }
  const plane = planeFromNormal(point.value, normal.value);
  return plane === null ? failure('degenerate', '面の法線が定まりません。') : { ok: true, plane };
}

function resolveFacePlane(
  spec: Extract<PlaneSpec, { readonly kind: 'face' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const face = takeSubShape(context, spec.face, '基準の面');
  if (!face.ok) {
    return face.outcome;
  }
  const normal = flatFaceNormal(face.value);
  if (!normal.ok) {
    return normal.outcome;
  }
  const offset = takeFiniteNumber(spec.offset.value, '距離');
  if (!offset.ok) {
    return offset.outcome;
  }
  const plane = planeFromNormal(face.value.position, normal.value);
  return plane === null
    ? failure('degenerate', '面の法線が定まりません。')
    : { ok: true, plane: offsetPlane(plane, offset.value) };
}

function resolveWorkPlaneSpec(
  spec: Extract<PlaneSpec, { readonly kind: 'workPlane' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const base = takeWorkPlane(context, spec.planeId);
  if (!base.ok) {
    return base.outcome;
  }
  const offset = takeFiniteNumber(spec.offset.value, '距離');
  if (!offset.ok) {
    return offset.outcome;
  }
  return { ok: true, plane: offsetPlane(base.value, offset.value) };
}

function resolveTiltedPlane(
  spec: Extract<PlaneSpec, { readonly kind: 'tilted' }>,
  context: PlaneResolveContext,
): PlaneOutcome {
  const base = takeWorkPlane(context, spec.base);
  if (!base.ok) {
    return base.outcome;
  }
  const frame = takeAxis(context, spec.axis);
  if (!frame.ok) {
    return frame.outcome;
  }
  const angle = takeFiniteNumber(spec.angle.value, '角度');
  if (!angle.ok) {
    return angle.outcome;
  }
  const radians = degreesToRadians(angle.value);
  const { origin, direction } = frame.value;
  // 平面ごと軸のまわりに回す。原点は軸の線を中心に動かし、向きは回転だけを受ける。
  return {
    ok: true,
    plane: {
      origin: rotateAboutAxis(base.value.origin, origin, direction, radians),
      axisU: rotateDirection(base.value.axisU, direction, radians),
      axisV: rotateDirection(base.value.axisV, direction, radians),
      normal: rotateDirection(base.value.normal, direction, radians),
    },
  };
}

/**
 * 平面の指定を解決する(FR-328、FR-432)。例外を投げず、断る理由を戻り値で返す(FR-504)。
 *
 * 法線の向きは指定の種類ごとに一意に決まる(下の各関数の注釈)。P5 の切断はこの向きで
 * 「残す側」の意味を決めるので、同じ指定からは必ず同じ法線が出ること(決定性)が要る。
 */
export function resolvePlaneSpec(spec: PlaneSpec, context: PlaneResolveContext): PlaneOutcome {
  switch (spec.kind) {
    case 'threePoints':
      return resolveThreePoints(spec, context);
    case 'pointAndEdge':
      return resolvePointAndEdge(spec, context);
    case 'pointAndAxis':
      return resolvePointAndAxis(spec, context);
    case 'pointAndParallelFace':
      return resolvePointAndParallelFace(spec, context);
    case 'face':
      return resolveFacePlane(spec, context);
    case 'workPlane':
      return resolveWorkPlaneSpec(spec, context);
    case 'tilted':
      return resolveTiltedPlane(spec, context);
  }
}

/**
 * 点の参照を鍵の材料の文字列にする。同じ参照からは常に同じ文字列が出る(決定性)。
 *
 * 立体の部分形状(FR-330 の 3D スケッチの点、タスク10)は指紋そのものを材料にする。
 * 指紋の文字列は呼び出し側が渡す(`fingerprintKeyText`。循環 import を避けるため、
 * `planeSpecKeyText` と同じ約束)。位置・大きさが変われば鍵も変わるので、
 * 上流の立体が変わったときに古い形状キャッシュを拾わない。
 */
function pointReferenceKeyText(
  reference: PointReference,
  fingerprintText: (reference: SubShapeRef) => string,
): string {
  switch (reference.kind) {
    case 'origin':
      return 'origin';
    case 'previous':
      return 'previous';
    case 'point':
      return `point:${reference.pointId}`;
    case 'vertex':
      return `vertex:${reference.featureId}:${reference.vertex}`;
    case 'subShape':
      return `subShape:${fingerprintText(reference.ref)}`;
  }
}

/** 軸の指定を鍵の材料の文字列にする。 */
function axisSpecKeyText(spec: AxisSpec): string {
  switch (spec.kind) {
    case 'world':
      return `world:${spec.axis}`;
    case 'line':
      return `line:${spec.line.sketchId}/${spec.line.lineFeatureId}`;
    case 'reference':
      return `reference:${spec.referenceFeatureId}`;
  }
}

/**
 * 平面の指定を鍵の材料の文字列にする(P5 のタスク27c の `cacheKey.ts` が呼ぶ)。
 *
 * 指紋の文字列は呼び出し側が `fingerprintKeyText` を渡す(循環 import を避けるため。
 * `docs/報告記録.md` 2026-09-04 01:40 の①と同じ約束)。数は `keyNumber` で丸め、
 * 丸めの規則を 2 か所に書かない。
 */
export function planeSpecKeyText(
  spec: PlaneSpec,
  fingerprintText: (reference: SubShapeRef) => string,
): string {
  switch (spec.kind) {
    case 'threePoints':
      return (
        `threePoints{p1=${pointReferenceKeyText(spec.p1, fingerprintText)}` +
        `;p2=${pointReferenceKeyText(spec.p2, fingerprintText)}` +
        `;p3=${pointReferenceKeyText(spec.p3, fingerprintText)}}`
      );
    case 'pointAndEdge':
      return (
        `pointAndEdge{point=${pointReferenceKeyText(spec.point, fingerprintText)}` +
        `;edge=${fingerprintText(spec.edge)};mode=${spec.mode}}`
      );
    case 'pointAndAxis':
      return (
        `pointAndAxis{point=${pointReferenceKeyText(spec.point, fingerprintText)}` +
        `;axis=${axisSpecKeyText(spec.axis)}` +
        `;tilt=${keyNumber(spec.tilt.value)};azimuth=${keyNumber(spec.azimuth.value)}}`
      );
    case 'pointAndParallelFace':
      return (
        `pointAndParallelFace{point=${pointReferenceKeyText(spec.point, fingerprintText)}` +
        `;face=${fingerprintText(spec.face)}}`
      );
    case 'face':
      return `face{face=${fingerprintText(spec.face)};offset=${keyNumber(spec.offset.value)}}`;
    case 'workPlane':
      return `workPlane{planeId=${spec.planeId};offset=${keyNumber(spec.offset.value)}}`;
    case 'tilted':
      return (
        `tilted{base=${spec.base};axis=${axisSpecKeyText(spec.axis)}` +
        `;angle=${keyNumber(spec.angle.value)}}`
      );
  }
}
