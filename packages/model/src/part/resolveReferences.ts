/**
 * 基準ジオメトリ(任意の作業平面 FR-328、基準軸・基準点・座標系 FR-329)の解決
 * (P4 計画書 §2.8、タスク9)。
 *
 * **解決の順序**(統括の指示):
 *   参照先(スケッチの点・立体の部分形状)→ 基準ジオメトリ → それを使うスケッチ。
 * スケッチは作図面として基準平面を指せるので、両者は互いを呼び合う。そこで
 * 「頼まれたときに解いて覚える」(遅延+記憶)形にし、解いている途中のものを
 * もう一度頼まれたら**循環として日本語で断る**(FR-504。止めずに理由を出す)。
 *
 * **履歴順の制約**: 基準ジオメトリは自分より前に作られたものだけを参照できる。
 * 後ろのものを指した参照は「後で作られたので使えません」と断る(投影・交差 §2.7 と同じ考え方)。
 *
 * 立体の面・辺・頂点は、`deps.subShape` が渡されていればそれで選び直し、無ければ保存された
 * 指紋の位置・向きをそのまま使う(`subShapeFromFingerprint`)。カーネルへの往復を増やさない
 * ため(P5 計画書 §2.9b.1 と同じ判断)。
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
import { curveEnd, curveStart } from '../sketch/resolveSketch.js';
import type {
  CoordinateInput,
  PointReference,
  ResolvedCurve,
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
import type {
  PartDocument,
  ReferenceAxisDefinition,
  ReferenceAxisFeature,
  ReferenceCoordinateSystemFeature,
  ReferenceFeature,
  ReferencePlaneFeature,
  ReferencePointDefinition,
  ReferencePointFeature,
} from './types.js';

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
  /**
   * スケッチ 1 本の解決結果。まだ解けない(循環している)ときは null を返す。
   * 呼び出し側(`resolvePart`)が遅延解決と記憶を担う。
   */
  readonly sketch: (sketchId: string) => ResolvedSketch | null;
  /** 部分形状の選び直し。省略時は保存された指紋をそのまま使う。 */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
}

export interface ReferenceResolver {
  /** 作図面の id から平面を引く(基準 3 面 → 任意の作業平面の順)。 */
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  /** 軸の指定を解決する(回転・パターン・ばねからも使う)。 */
  readonly axis: (spec: AxisSpec) => AxisFrame | null;
  /** 点の参照を解決する。 */
  readonly point: (reference: PointReference) => Vec3 | null;
  /** 履歴順にすべて解決する(ツリー・画面表示・失敗の一覧のため)。 */
  readonly resolveAll: () => ResolvedReferences;
}

type ReferenceOutcome =
  | { readonly ok: true; readonly value: ResolvedReferenceValue }
  | { readonly ok: false; readonly error: ReferenceError };

type ResolvedReferenceValue =
  | { readonly kind: 'referencePlane'; readonly plane: ResolvedPlane }
  | { readonly kind: 'referenceAxis'; readonly frame: AxisFrame }
  | { readonly kind: 'referencePoint'; readonly position: Vec3 }
  | {
      readonly kind: 'referenceCoordinateSystem';
      readonly origin: Vec3;
      readonly xAxis: Vec3;
      readonly yAxis: Vec3;
      readonly zAxis: Vec3;
    };

/** 向きが定まったとみなす最小の長さ(mm)。 */
const DIRECTION_EPSILON = 1e-9;

/** 履歴順の上限を置かない(外から呼ぶとき)。 */
const NO_LIMIT = Number.POSITIVE_INFINITY;

function referenceError(
  featureId: string,
  code: ReferenceErrorCode,
  message: string,
): ReferenceError {
  return { featureId, code, message };
}

function failed(featureId: string, code: ReferenceErrorCode, message: string): ReferenceOutcome {
  return { ok: false, error: referenceError(featureId, code, message) };
}

/**
 * スケッチの解決結果から、要素の端点・中心を引く。
 *
 * `resolveSketch` は端点の表を返さないので、曲線の並びから拾い直す。
 * 1 フィーチャーが複数の曲線を生むもの(矩形・正多角形・長穴)は、
 * 先頭の曲線の始点を `start`、末尾の曲線の終点を `end` とする(解決の側と同じ規約)。
 */
function vertexOfSketch(
  resolved: ResolvedSketch,
  featureId: string,
  vertex: 'start' | 'end' | 'center',
): Vec3 | null {
  const curves: ResolvedCurve[] = [
    ...resolved.segments,
    ...resolved.arcs,
    ...resolved.ellipses,
    ...resolved.splines,
  ].filter((curve) => curve.featureId === featureId);
  if (vertex === 'center') {
    const found = curves.find((curve) => curve.kind === 'arc' || curve.kind === 'ellipse');
    return found === undefined ? null : found.center;
  }
  if (curves.length === 0) {
    // 曲線が無ければ点フィーチャー・点列の端を見る。
    const points = resolved.points.filter((point) => point.featureId === featureId);
    if (points.length === 0) {
      return null;
    }
    return vertex === 'start' ? points[0].position : points[points.length - 1].position;
  }
  return vertex === 'start' ? curveStart(curves[0]) : curveEnd(curves[curves.length - 1]);
}

/**
 * 基準ジオメトリの解決器を作る(FR-328、FR-329)。
 *
 * 返す関数はどれも例外を投げず、解けなければ null か理由つきの失敗を返す(FR-504)。
 */
export function createReferenceResolver(
  document: PartDocument,
  deps: ReferenceResolveDeps,
): ReferenceResolver {
  const order = new Map<string, number>();
  const byId = new Map<string, ReferenceFeature>();
  document.references.forEach((feature, index) => {
    // 同じ id が 2 つあるときは先に出たほうを正とする(履歴の一意性は生成側が守る)。
    if (!byId.has(feature.id)) {
      byId.set(feature.id, feature);
      order.set(feature.id, index);
    }
  });

  const cache = new Map<string, ReferenceOutcome>();
  const active = new Set<string>();
  /** いま解いている途中で循環に当たったか(`resolveReference` が拾い直すための印)。 */
  let cycleSeen = false;
  /** いま解いている途中で「後から作られたもの」を参照したか。その名前を覚える。 */
  let laterReference: string | null = null;
  const resolveSubShape = deps.subShape ?? subShapeFromFingerprint;

  /**
   * いま立っている印を読み出す。**関数越しに読む**のは、印を立てるのが入れ子の呼び出しの
   * 中なのに、型検査の流れ解析からは「直前に入れた値のまま」に見えてしまうため
   * (関数の境界をまたぐと絞り込みが解ける)。
   */
  function currentMarks(): { readonly cycle: boolean; readonly later: string | null } {
    return { cycle: cycleSeen, later: laterReference };
  }

  /**
   * 参照先が「自分より前」かを見る。後ろ・自分自身なら断る。
   * 文書には在るのに後ろだった場合は、断りの文言を変えられるよう名前を覚えておく。
   */
  function withinHistory(featureId: string, limit: number): boolean {
    const index = order.get(featureId);
    if (index === undefined) {
      return false;
    }
    if (index < limit) {
      return true;
    }
    laterReference = byId.get(featureId)?.name ?? featureId;
    return false;
  }

  function pointAt(reference: PointReference, limit: number): Vec3 | null {
    switch (reference.kind) {
      case 'origin':
        return ORIGIN;
      case 'previous':
        // 部品文書の基準ジオメトリには「直前の点」という順序の文脈が無い。
        return null;
      case 'point': {
        if (withinHistory(reference.pointId, limit)) {
          const outcome = resolveReference(reference.pointId, limit);
          if (outcome.ok && outcome.value.kind === 'referencePoint') {
            return outcome.value.position;
          }
          return null;
        }
        // スケッチの点(点フィーチャーは featureId、点列の n 番目は `featureId#n`)。
        // 文書の順に探し、最初に見つかったものを使う(同じ id が別のスケッチにもある
        // ときのために順序で決める。決定性のため「先に出たほう」と決めておく)。
        for (const sketch of document.sketches) {
          const resolved = deps.sketch(sketch.id);
          if (resolved === null) {
            continue;
          }
          const found = resolved.points.find((point) => point.id === reference.pointId);
          if (found !== undefined) {
            return found.position;
          }
        }
        return null;
      }
      case 'vertex': {
        for (const sketch of document.sketches) {
          const resolved = deps.sketch(sketch.id);
          if (resolved === null) {
            continue;
          }
          const found = vertexOfSketch(resolved, reference.featureId, reference.vertex);
          if (found !== null) {
            return found;
          }
        }
        return null;
      }
      case 'subShape': {
        // 立体の部分形状(3D スケッチの点、FR-330。P4 タスク10)。
        // 頂点はその位置、辺は中点、面は重心(`subShapeFromFingerprint` と同じ約束)。
        const found = resolveSubShape(reference.ref);
        return found === null ? null : found.position;
      }
    }
  }

  function axisAt(spec: AxisSpec, limit: number): AxisFrame | null {
    switch (spec.kind) {
      case 'world':
        return { origin: ORIGIN, direction: WORLD_AXIS_DIRECTIONS[spec.axis] };
      case 'line': {
        const resolved = deps.sketch(spec.line.sketchId);
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
        if (!withinHistory(spec.referenceFeatureId, limit)) {
          return null;
        }
        const outcome = resolveReference(spec.referenceFeatureId, limit);
        return outcome.ok && outcome.value.kind === 'referenceAxis' ? outcome.value.frame : null;
      }
    }
  }

  function planeAt(planeId: WorkPlaneId, limit: number): ResolvedPlane | null {
    const base = baseWorkPlane(planeId);
    if (base !== null) {
      return { origin: base.origin, axisU: base.axisU, axisV: base.axisV, normal: base.normal };
    }
    if (!withinHistory(planeId, limit)) {
      return null;
    }
    const outcome = resolveReference(planeId, limit);
    return outcome.ok && outcome.value.kind === 'referencePlane' ? outcome.value.plane : null;
  }

  function planeContext(limit: number): PlaneResolveContext {
    return {
      point: (reference) => pointAt(reference, limit),
      subShape: resolveSubShape,
      axis: (spec) => axisAt(spec, limit),
      workPlane: (planeId) => planeAt(planeId, limit),
    };
  }

  function resolvePlaneFeature(feature: ReferencePlaneFeature, limit: number): ReferenceOutcome {
    const outcome = resolvePlaneSpec(feature.plane, planeContext(limit));
    if (!outcome.ok) {
      return failed(feature.id, outcome.reason, outcome.message);
    }
    return { ok: true, value: { kind: 'referencePlane', plane: outcome.plane } };
  }

  function axisFromDefinition(
    featureId: string,
    definition: ReferenceAxisDefinition,
    limit: number,
  ): ReferenceOutcome {
    switch (definition.kind) {
      case 'twoPoints': {
        const from = pointAt(definition.from, limit);
        const to = pointAt(definition.to, limit);
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
        const edge = resolveSubShape(definition.edge);
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
        const face = resolveSubShape(definition.face);
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
      case 'faceIntersection': {
        const face1 = resolveSubShape(definition.face1);
        const face2 = resolveSubShape(definition.face2);
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
    }
  }

  function pointFromDefinition(
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
        const base = pointAt(at.base, limit);
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
        const found = resolveSubShape(reference);
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

  function coordinateSystemFrom(
    feature: ReferenceCoordinateSystemFeature,
    limit: number,
  ): ReferenceOutcome {
    const origin = pointAt(feature.origin, limit);
    if (origin === null) {
      return failed(feature.id, 'missingPoint', '座標系の原点が見つかりません。');
    }
    const xFrame = axisAt(feature.xAxis, limit);
    const yFrame = axisAt(feature.yAxis, limit);
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
    // X を保ち、Z = X × Y、Y = Z × X で直交化する(右手系)。
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

  function resolveAxisFeature(feature: ReferenceAxisFeature, limit: number): ReferenceOutcome {
    return axisFromDefinition(feature.id, feature.definition, limit);
  }

  function resolvePointFeature(feature: ReferencePointFeature, limit: number): ReferenceOutcome {
    return pointFromDefinition(feature.id, feature.definition, limit);
  }

  function resolveFeature(feature: ReferenceFeature, limit: number): ReferenceOutcome {
    switch (feature.kind) {
      case 'referencePlane':
        return resolvePlaneFeature(feature, limit);
      case 'referenceAxis':
        return resolveAxisFeature(feature, limit);
      case 'referencePoint':
        return resolvePointFeature(feature, limit);
      case 'referenceCoordinateSystem':
        return coordinateSystemFrom(feature, limit);
    }
  }

  /**
   * 1 つを解いて覚える。解いている途中にもう一度頼まれたら循環として断る。
   * `limit` は「頼んだ側の履歴上の位置」で、参照先はそれより前でなければならない。
   */
  function resolveReference(featureId: string, limit: number): ReferenceOutcome {
    const feature = byId.get(featureId);
    if (feature === undefined) {
      return failed(featureId, 'missingPlane', `基準ジオメトリが見つかりません: ${featureId}`);
    }
    if (!withinHistory(featureId, limit)) {
      return failed(
        featureId,
        'missingPlane',
        `${feature.name}は後から作られたので、ここからは参照できません。先に作ってください。`,
      );
    }
    if (active.has(featureId)) {
      cycleSeen = true;
      return failed(
        featureId,
        'circularReference',
        `${feature.name}の指定が循環しています。参照をたどると自分自身に戻ってきます。`,
      );
    }
    const remembered = cache.get(featureId);
    if (remembered !== undefined) {
      return remembered;
    }
    active.add(featureId);
    // 自分より前だけを参照できるので、上限は自分の位置になる。
    const own = order.get(featureId) ?? 0;
    // 循環はスケッチを経由して起きる(作業平面 → スケッチの点 → その作業平面)。
    // 途中で見つけた循環は「点が見つからない」に化けてしまうので、印を立てて拾い直す。
    const outer = currentMarks();
    cycleSeen = false;
    laterReference = null;
    const outcome = resolveFeature(feature, own);
    const seen = currentMarks();
    cycleSeen = outer.cycle;
    laterReference = outer.later;
    active.delete(featureId);
    let settled: ReferenceOutcome = outcome;
    if (!outcome.ok && seen.cycle) {
      settled = failed(
        featureId,
        'circularReference',
        `${feature.name}の指定が循環しています。参照をたどると自分自身に戻ってきます。`,
      );
    } else if (!outcome.ok && seen.later !== null) {
      settled = failed(
        featureId,
        outcome.error.code,
        `${seen.later}は${feature.name}より後から作られたので、参照できません。先に作ってください。`,
      );
    }
    cache.set(featureId, settled);
    return settled;
  }

  function resolveAll(): ResolvedReferences {
    const planes: ResolvedReferencePlane[] = [];
    const axes: ResolvedReferenceAxis[] = [];
    const points: ResolvedReferencePoint[] = [];
    const coordinateSystems: ResolvedReferenceCoordinateSystem[] = [];
    const errors: ReferenceError[] = [];
    for (const feature of document.references) {
      const outcome = resolveReference(feature.id, NO_LIMIT);
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

  return {
    workPlane: (planeId) => {
      const base = baseWorkPlane(planeId);
      if (base !== null) {
        return base;
      }
      const plane = planeAt(planeId, NO_LIMIT);
      return plane === null ? null : workPlaneFromResolved(planeId, plane);
    },
    axis: (spec) => axisAt(spec, NO_LIMIT),
    point: (reference) => pointAt(reference, NO_LIMIT),
    resolveAll,
  };
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
