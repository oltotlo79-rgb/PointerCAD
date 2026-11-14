import type { PointPlacementSourceAnchor } from '../geometry/subShapeOrigin.js';
/**
 * 基準ジオメトリの解決
 * (任意の作業平面 FR-328、基準軸・基準点・座標系 FR-329)。
 *
 * **解決の順序**:
 *   参照先(スケッチの点・立体の部分形状)→ 基準ジオメトリ → それを使うスケッチ。
 * スケッチは作図面として基準平面を指せるので、両者は互いを呼び合う。そこで
 * 「頼まれたときに解いて覚える」(遅延+記憶)形にし、解いている途中のものを
 * もう一度頼まれたら**循環として日本語で断る**(FR-504。止めずに理由を出す)。
 *
 * **履歴順の制約**: 基準ジオメトリは自分より前に作られたものだけを参照できる。
 * 後ろのものを指した参照は「後で作られたので使えません」と断る(投影・交差と同じ考え方)。
 *
 * 立体の面・辺・頂点は、`deps.subShape` が渡されていればそれで選び直し、無ければ保存された
 * 指紋の位置・向きをそのまま使う(`subShapeFromFingerprint`)。カーネルへの往復を増やさない
 * ため(平面の解決と同じ判断)。
 */

import {
  resolvePlaneSpec,
  subShapeFromFingerprint,
  type AxisFrame,
  type AxisSpec,
  type PlaneErrorKey,
  type PlaneResolveContext,
  type ResolvedPlane,
  type ResolvedSubShape,
} from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  baseWorkPlane,
  WORK_PLANES,
  WORLD_AXIS_DIRECTIONS,
  type WorkPlane,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import { resolveCoordinate, type ResolveContext } from '../sketch/resolveCoordinate.js';
import type {
  CoordinateInput,
  PointReference,
  ResolvedSketch,
} from '../sketch/types.js';
import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  ORIGIN,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../sketch/vec3.js';
import { createReferenceMemo, failed, type ReferenceOutcome } from './referenceResolverMemo.js';
import {
  createSphereLookup,
  pointResolutionAt,
  pointWithIdentityOf,
  type ReferencePointLookups,
} from './referenceResolverPoints.js';
import type {
  PartDocument,
  ReferenceAxisDefinition,
  ReferenceCoordinateSystemFeature,
  ReferenceFeature,
  ReferencePlaneFeature,
  ReferencePointDefinition,
} from './types.js';
import type { FunctionPointResolver as TypeFunctionPointResolver } from '../functionGeometry/functionPointReference.js';


/** 基準ジオメトリが解決できなかった理由。平面の理由(`PlaneErrorKey`)に循環を足したもの。 */
export type ReferenceErrorCode = PlaneErrorKey | 'circularReference';

export interface ReferenceError {
  readonly featureId: string;
  readonly code: ReferenceErrorCode;
  readonly message: string;
}

export interface ResolvedReferencePlane {
  readonly featureId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly plane: ResolvedPlane;
}

export interface ResolvedReferenceAxis {
  readonly featureId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly origin: Vec3;
  /** 単位ベクトル。 */
  readonly direction: Vec3;
}

export interface ResolvedReferencePoint {
  readonly featureId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly position: Vec3;
}

export interface ResolvedReferenceCoordinateSystem {
  readonly featureId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  /** X × Y。保存せず毎回導く(rules/04「導出できるものは保存しない」)。 */
  readonly zAxis: Vec3;
}

/** 基準ジオメトリの解決結果。種類ごとに分けて持つ(UI が引きやすい形)。 */
export interface ResolvedReferences {
  readonly planes: readonly ResolvedReferencePlane[];
  readonly axes: readonly ResolvedReferenceAxis[];
  readonly points: readonly ResolvedReferencePoint[];
  readonly coordinateSystems: readonly ResolvedReferenceCoordinateSystem[];
  readonly errors: readonly ReferenceError[];
}

/** 基準ジオメトリを解くのに要る、外から渡す手掛かり。 */
export interface ReferenceResolveDeps {
  readonly functionPoint?: TypeFunctionPointResolver;
  readonly invalidInputs?: ReadonlyMap<string, string>;
  /**
   * スケッチ 1 本の解決結果。まだ解けない(循環している)ときは null を返す。
   * 呼び出し側(`resolvePart`)が遅延解決と記憶を担う。
   */
  readonly sketch: (sketchId: string) => ResolvedSketch | null;
  /** 部分形状の選び直し。省略時は保存された指紋をそのまま使う。 */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
}

export type ResolvedPointWithIdentity =
  | { readonly state: 'identified'; readonly position: Vec3; readonly identity: PointPlacementSourceAnchor }
  | { readonly state: 'unidentified'; readonly position: Vec3; readonly reason: 'producer-unavailable'; readonly identity?: never };

export interface ReferenceResolver {
  /** 作図面の id から平面を引く(基準 3 面 → 任意の作業平面の順)。 */
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  /** 軸の指定を解決する(回転・パターン・ばねからも使う)。 */
  readonly axis: (spec: AxisSpec) => AxisFrame | null;
  /** 点の参照を解決する。 */
  readonly point: (reference: PointReference) => Vec3 | null;
  /** Same resolution rules, but refuses unavailable logical producer proof. */
  readonly pointWithIdentity: (reference: PointReference) => ResolvedPointWithIdentity | null;
  /** 履歴順にすべて解決する(ツリー・画面表示・失敗の一覧のため)。 */
  readonly resolveAll: () => ResolvedReferences;
}

/** 向きが定まったとみなす最小の長さ(mm)。 */
const DIRECTION_EPSILON = 1e-9;

/** 履歴順の上限を置かない(外から呼ぶとき)。 */
const NO_LIMIT = Number.POSITIVE_INFINITY;

/**
 * 解決器の口の組。基準 → 点 → スケッチ → 基準の呼び合いは、この組を通して結ぶ
 * (`limit` は頼んだ側の履歴上の位置。外からの問い合わせは `NO_LIMIT`)。
 */
interface ReferenceLookups extends ReferencePointLookups {
  readonly point: (reference: PointReference, limit: number) => Vec3 | null;
  readonly axis: (spec: AxisSpec, limit: number) => AxisFrame | null;
  readonly plane: (planeId: WorkPlaneId, limit: number) => ResolvedPlane | null;
}

/**
 * 基準ジオメトリの解決器を作る(FR-328、FR-329)。
 *
 * 返す関数はどれも例外を投げず、解けなければ null か理由つきの失敗を返す(FR-504)。
 * 履歴の順・記憶・循環の印は `referenceResolverMemo.ts`、点の参照と球の引き方は
 * `referenceResolverPoints.ts`、基準の種類ごとの解き方はこのファイルの関数が持ち、
 * ここはそれらを口の組で結ぶだけ。
 */
export function createReferenceResolver(
  document: PartDocument,
  deps: ReferenceResolveDeps,
): ReferenceResolver {
  const memo = createReferenceMemo(document, (feature, limit) => resolveFeature(lookups, feature, limit));
  const subShape = deps.subShape ?? subShapeFromFingerprint;
  const lookups: ReferenceLookups = {
    document,
    deps,
    subShape,
    withinHistory: memo.withinHistory,
    resolveReference: memo.resolve,
    sphere: createSphereLookup({
      document,
      deps,
      subShape,
      point: (reference, limit) => lookups.point(reference, limit),
    }),
    point: (reference, limit) => pointResolutionAt(lookups, reference, limit)?.position ?? null,
    axis: (spec, limit) => axisAt(lookups, spec, limit),
    plane: (planeId, limit) => planeAt(lookups, planeId, limit),
  };
  return {
    workPlane: (planeId) => workPlaneAt(lookups, planeId),
    axis: (spec) => lookups.axis(spec, NO_LIMIT),
    point: (reference) => lookups.point(reference, NO_LIMIT),
    pointWithIdentity: (reference) => pointWithIdentityOf(pointResolutionAt(lookups, reference, NO_LIMIT)),
    resolveAll: () => collectResolvedReferences(document, memo.resolve),
  };
}

/** 作図面の id から平面を引く(基準 3 面 → 任意の作業平面の順)。 */
function workPlaneAt(lookups: ReferenceLookups, planeId: WorkPlaneId): WorkPlane | null {
  const base = baseWorkPlane(planeId);
  if (base !== null) {
    return base;
  }
  const plane = lookups.plane(planeId, NO_LIMIT);
  return plane === null ? null : workPlaneFromResolved(planeId, plane);
}

/** 軸の指定(世界の軸・スケッチの線分・基準軸)を解決する。 */
function axisAt(lookups: ReferenceLookups, spec: AxisSpec, limit: number): AxisFrame | null {
  switch (spec.kind) {
    case 'world':
      return { origin: ORIGIN, direction: WORLD_AXIS_DIRECTIONS[spec.axis] };
    case 'line': {
      const resolved = lookups.deps.sketch(spec.line.sketchId);
      if (resolved === null) {
        return null;
      }
      const segment = resolved.segments.find(
        (candidate) => candidate.featureId === spec.line.lineFeatureId,
      );
      if (segment === undefined) {
        return null;
      }
      const direction = subVec3(segment.to, segment.from);
      if (lengthVec3(direction) <= DIRECTION_EPSILON) {
        return null;
      }
      return { origin: segment.from, direction: normalizeVec3(direction) };
    }
    case 'reference': {
      if (!lookups.withinHistory(spec.referenceFeatureId, limit)) {
        return null;
      }
      const outcome = lookups.resolveReference(spec.referenceFeatureId, limit);
      return outcome.ok && outcome.value.kind === 'referenceAxis' ? outcome.value.frame : null;
    }
  }
}

/** 作図面の id(基準 3 面か、自分より前の基準平面)を平面にする。 */
function planeAt(lookups: ReferenceLookups, planeId: WorkPlaneId, limit: number): ResolvedPlane | null {
  const base = baseWorkPlane(planeId);
  if (base !== null) {
    return { origin: base.origin, axisU: base.axisU, axisV: base.axisV, normal: base.normal };
  }
  if (!lookups.withinHistory(planeId, limit)) {
    return null;
  }
  const outcome = lookups.resolveReference(planeId, limit);
  return outcome.ok && outcome.value.kind === 'referencePlane' ? outcome.value.plane : null;
}

/** 平面の指定(`resolvePlaneSpec`)へ渡す手掛かり。点・軸・作図面は同じ履歴の上限で引く。 */
function planeContext(lookups: ReferenceLookups, limit: number): PlaneResolveContext {
  return {
    point: (reference) => lookups.point(reference, limit),
    subShape: lookups.subShape,
    axis: (spec) => lookups.axis(spec, limit),
    workPlane: (planeId) => lookups.plane(planeId, limit),
  };
}

function resolvePlaneFeature(
  lookups: ReferenceLookups,
  feature: ReferencePlaneFeature,
  limit: number,
): ReferenceOutcome {
  const outcome = resolvePlaneSpec(feature.plane, planeContext(lookups, limit));
  if (!outcome.ok) {
    return failed(feature.id, outcome.reason, outcome.message);
  }
  return { ok: true, value: { kind: 'referencePlane', plane: outcome.plane } };
}

/** 基準軸の 4 通りの作り方(2 点・辺・面の法線・2 面の交線)。 */
function axisFromDefinition(
  lookups: ReferenceLookups,
  featureId: string,
  definition: ReferenceAxisDefinition,
  limit: number,
): ReferenceOutcome {
  switch (definition.kind) {
    case 'twoPoints': {
      const from = lookups.point(definition.from, limit);
      const to = lookups.point(definition.to, limit);
      if (from === null || to === null) {
        return failed(
          featureId,
          'missingPoint',
          '基準軸の 2 点が見つかりません。点を選び直してください。',
        );
      }
      const direction = subVec3(to, from);
      if (lengthVec3(direction) <= DIRECTION_EPSILON) {
        return failed(featureId, 'degenerate', '2 点が同じ位置のため、軸の向きが決まりません。');
      }
      return {
        ok: true,
        value: {
          kind: 'referenceAxis',
          frame: { origin: from, direction: normalizeVec3(direction) },
        },
      };
    }
    case 'edge': {
      const edge = lookups.subShape(definition.edge);
      if (edge === null) {
        return failed(
          featureId,
          'missingSubShape',
          '基準にする辺が見つかりません。形が大きく変わったため、選び直してください。',
        );
      }
      if (edge.kind !== 'edge' || edge.curveKind !== 'line' || edge.axis === null) {
        return failed(featureId, 'notStraightEdge', 'まっすぐな辺を選んでください。');
      }
      return {
        ok: true,
        value: {
          kind: 'referenceAxis',
          frame: { origin: edge.position, direction: normalizeVec3(edge.axis) },
        },
      };
    }
    case 'faceNormal': {
      const face = lookups.subShape(definition.face);
      if (face === null) {
        return failed(
          featureId,
          'missingSubShape',
          '基準にする面が見つかりません。形が大きく変わったため、選び直してください。',
        );
      }
      if (face.kind !== 'face' || face.surfaceKind !== 'plane' || face.axis === null) {
        return failed(featureId, 'notFlatFace', '平らな面を選んでください。');
      }
      return {
        ok: true,
        value: {
          kind: 'referenceAxis',
          frame: { origin: face.position, direction: normalizeVec3(face.axis) },
        },
      };
    }
    case 'faceIntersection':
      return axisFromFaceIntersection(
        featureId,
        lookups.subShape(definition.face1),
        lookups.subShape(definition.face2),
      );
  }
}

/** 2 つの平らな面の交線を基準軸にする。平行な 2 面には交線が無いので断る。 */
function axisFromFaceIntersection(
  featureId: string,
  face1: ResolvedSubShape | null,
  face2: ResolvedSubShape | null,
): ReferenceOutcome {
  if (face1 === null || face2 === null) {
    return failed(
      featureId,
      'missingSubShape',
      '交線にする 2 つの面が見つかりません。形が大きく変わったため、選び直してください。',
    );
  }
  if (
    face1.kind !== 'face' ||
    face2.kind !== 'face' ||
    face1.surfaceKind !== 'plane' ||
    face2.surfaceKind !== 'plane' ||
    face1.axis === null ||
    face2.axis === null
  ) {
    return failed(featureId, 'notFlatFace', '平らな面を 2 つ選んでください。');
  }
  // 交線の向きは 2 面の法線の外積。平行な 2 面では長さ 0 になり交わらない。
  const direction = crossVec3(face1.axis, face2.axis);
  if (lengthVec3(direction) <= DIRECTION_EPSILON) {
    return failed(
      featureId,
      'degenerate',
      '2 つの面が平行なので交線がありません。向きの違う面を選んでください。',
    );
  }
  const unit = normalizeVec3(direction);
  // 交線上の 1 点を求める。面1 の重心から、面1 の中で交線に垂直な向き `inFace1` へ
  // 進んで面2 に当たる位置を解く:
  //   (重心1 + t・inFace1 − 重心2)・法線2 = 0  →  t = −(重心1 − 重心2)・法線2 ÷ (inFace1・法線2)
  // 2 面が平行でなければ inFace1・法線2 は 0 にならない(上で平行は弾いてある)。
  const normal2 = normalizeVec3(face2.axis);
  const inFace1 = crossVec3(unit, normalizeVec3(face1.axis));
  const slope = dotVec3(inFace1, normal2);
  if (Math.abs(slope) <= DIRECTION_EPSILON) {
    return failed(featureId, 'degenerate', '2 つの面の交線が決まりません。');
  }
  const gap = subVec3(face1.position, face2.position);
  const origin = addVec3(face1.position, scaleVec3(inFace1, -dotVec3(gap, normal2) / slope));
  return { ok: true, value: { kind: 'referenceAxis', frame: { origin, direction: unit } } };
}

/** 基準点の作り方(座標の式・立体の頂点・辺の中点・面の中心)。 */
function pointFromDefinition(
  lookups: ReferenceLookups,
  featureId: string,
  definition: ReferencePointDefinition,
  limit: number,
): ReferenceOutcome {
  switch (definition.kind) {
    case 'coordinate': {
      // 部品文書には作図面が無いので、極座標の基準は XY 平面と決める(決定性)。
      // 基準の点は先にここで解決し、`resolveCoordinate` へは「直前の点」として渡す
      // (スケッチの履歴を持たないので、点の探し方をこちらの規則に揃えるため)。
      const at = definition.at;
      const context: ResolveContext = {
        plane: WORK_PLANES.xy,
        points: [],
        previous: null,
        vertices: new Map<string, Vec3>(),
      };
      if (at.mode === 'absolute') {
        const resolved = resolveCoordinate(at, context, featureId);
        if (!resolved.ok) {
          return failed(featureId, 'invalidValue', resolved.error.message);
        }
        return { ok: true, value: { kind: 'referencePoint', position: resolved.value } };
      }
      const base = lookups.point(at.base, limit);
      if (base === null) {
        return failed(featureId, 'missingPoint', '基準の点が見つかりません。');
      }
      const rebased: CoordinateInput =
        at.mode === 'relative'
          ? { mode: 'relative', base: { kind: 'previous' }, dx: at.dx, dy: at.dy, dz: at.dz }
          : {
              mode: 'polar',
              base: { kind: 'previous' },
              distance: at.distance,
              azimuth: at.azimuth,
              elevation: at.elevation,
            };
      const resolved = resolveCoordinate(rebased, { ...context, previous: base }, featureId);
      if (!resolved.ok) {
        // 基準は上で解決済みなので、ここへ来るのは値が数でない場合だけ。
        return failed(featureId, 'invalidValue', resolved.error.message);
      }
      return { ok: true, value: { kind: 'referencePoint', position: resolved.value } };
    }
    case 'vertex':
    case 'edgeMidpoint':
    case 'faceCenter': {
      const reference =
        definition.kind === 'vertex'
          ? definition.vertex
          : definition.kind === 'edgeMidpoint'
            ? definition.edge
            : definition.face;
      const found = lookups.subShape(reference);
      if (found === null) {
        return failed(
          featureId,
          'missingSubShape',
          '基準にする形が見つかりません。形が大きく変わったため、選び直してください。',
        );
      }
      // 指紋の position は、頂点はその位置、辺は中点、面は重心なのでそのまま使える。
      return { ok: true, value: { kind: 'referencePoint', position: found.position } };
    }
  }
}

/** 基準座標系(原点+2 軸)。X を保ち、Z = X × Y、Y = Z × X で直交化する(右手系)。 */
function coordinateSystemFrom(
  lookups: ReferenceLookups,
  feature: ReferenceCoordinateSystemFeature,
  limit: number,
): ReferenceOutcome {
  const origin = lookups.point(feature.origin, limit);
  if (origin === null) {
    return failed(feature.id, 'missingPoint', '座標系の原点が見つかりません。');
  }
  const xFrame = lookups.axis(feature.xAxis, limit);
  const yFrame = lookups.axis(feature.yAxis, limit);
  if (xFrame === null || yFrame === null) {
    return failed(feature.id, 'missingAxis', '座標系の軸が見つかりません。軸を選び直してください。');
  }
  const zAxis = crossVec3(xFrame.direction, yFrame.direction);
  if (lengthVec3(zAxis) <= DIRECTION_EPSILON) {
    return failed(
      feature.id,
      'degenerate',
      '2 つの軸が平行なので座標系が決まりません。向きの違う軸を選んでください。',
    );
  }
  const unitZ = normalizeVec3(zAxis);
  const unitX = normalizeVec3(xFrame.direction);
  return {
    ok: true,
    value: {
      kind: 'referenceCoordinateSystem',
      origin,
      xAxis: unitX,
      yAxis: crossVec3(unitZ, unitX),
      zAxis: unitZ,
    },
  };
}

/** 基準 1 つを解く。値の不正な入力は理由のまま断り、それ以外は種類ごとの作り方へ渡す。 */
function resolveFeature(
  lookups: ReferenceLookups,
  feature: ReferenceFeature,
  limit: number,
): ReferenceOutcome {
  const invalid = lookups.deps.invalidInputs?.get(feature.id);
  if (invalid !== undefined) {
    return failed(feature.id, 'invalidValue', invalid);
  }
  switch (feature.kind) {
    case 'referencePlane':
      return resolvePlaneFeature(lookups, feature, limit);
    case 'referenceAxis':
      return axisFromDefinition(lookups, feature.id, feature.definition, limit);
    case 'referencePoint':
      return pointFromDefinition(lookups, feature.id, feature.definition, limit);
    case 'referenceCoordinateSystem':
      return coordinateSystemFrom(lookups, feature, limit);
  }
}

/** 履歴順にすべて解き、種類ごとに分ける(ツリー・画面表示・失敗の一覧のため)。 */
function collectResolvedReferences(
  document: PartDocument,
  resolve: (featureId: string, limit: number) => ReferenceOutcome,
): ResolvedReferences {
  const planes: ResolvedReferencePlane[] = [];
  const axes: ResolvedReferenceAxis[] = [];
  const points: ResolvedReferencePoint[] = [];
  const coordinateSystems: ResolvedReferenceCoordinateSystem[] = [];
  const errors: ReferenceError[] = [];
  for (const feature of document.references) {
    const outcome = resolve(feature.id, NO_LIMIT);
    if (!outcome.ok) {
      errors.push(outcome.error);
      continue;
    }
    const head = { featureId: feature.id, name: feature.name, visible: feature.visible };
    switch (outcome.value.kind) {
      case 'referencePlane':
        planes.push({ ...head, plane: outcome.value.plane });
        break;
      case 'referenceAxis':
        axes.push({
          ...head,
          origin: outcome.value.frame.origin,
          direction: outcome.value.frame.direction,
        });
        break;
      case 'referencePoint':
        points.push({ ...head, position: outcome.value.position });
        break;
      case 'referenceCoordinateSystem':
        coordinateSystems.push({
          ...head,
          origin: outcome.value.origin,
          xAxis: outcome.value.xAxis,
          yAxis: outcome.value.yAxis,
          zAxis: outcome.value.zAxis,
        });
        break;
    }
  }
  return { planes, axes, points, coordinateSystems, errors };
}

/** 解決した平面へ id を付けて作図面(`WorkPlane`)にする。UI・カーネルへ渡すときに使う。 */
export function workPlaneFromResolved(id: WorkPlaneId, plane: ResolvedPlane): WorkPlane {
  return {
    id,
    origin: plane.origin,
    axisU: plane.axisU,
    axisV: plane.axisV,
    normal: plane.normal,
  };
}
