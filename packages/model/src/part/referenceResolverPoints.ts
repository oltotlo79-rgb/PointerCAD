/**
 * 基準ジオメトリの解決器の、点の参照の解き方(FR-329)と球の引き方(球面上の点 FR-431)。
 *
 * 点は原点・基準点・スケッチの点と端点・立体の部分形状・関数の点・球面上の点から引く。
 * 位置と一緒に「どの生成物から来た点か」(素性)を返し、素性を示せない点は位置だけを返す。
 * 基準点の解決と履歴順の判定は解決器の口(`ReferencePointLookups`)を借りるので、ここは
 * 状態を持たない。球の中心を解いている途中の印だけは `createSphereLookup` が持つ。
 */

import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { PointPlacementSourceAnchor } from '../geometry/subShapeOrigin.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { WORK_PLANES } from '../sketch/planeMath.js';
import {
  resolveCoordinate,
  resolvePointReference,
  type ResolveContext,
  type ResolvedSphere,
} from '../sketch/resolveCoordinate.js';
import { curveEnd, curveStart } from '../sketch/resolveSketch.js';
import type {
  CoordinateInput,
  PointReference,
  ResolvedCurve,
  ResolvedSketch,
} from '../sketch/types.js';
import { ORIGIN, type Vec3 } from '../sketch/vec3.js';
import type { ReferenceOutcome } from './referenceResolverMemo.js';
import type { ReferenceResolveDeps, ResolvedPointWithIdentity } from './resolveReferences.js';
import type { PartDocument, SolidOrigin } from './types.js';

/** 点の参照を解くときに、解決器から借りる口。 */
export interface ReferencePointLookups {
  readonly document: PartDocument;
  readonly deps: ReferenceResolveDeps;
  /** 部分形状の選び直し。`deps.subShape` が無ければ保存された指紋をそのまま使う。 */
  readonly subShape: (reference: SubShapeRef) => ResolvedSubShape | null;
  readonly withinHistory: (featureId: string, limit: number) => boolean;
  readonly resolveReference: (featureId: string, limit: number) => ReferenceOutcome;
  readonly sphere: (sphereFeatureId: string, limit: number) => ResolvedSphere | null;
}

interface PointResolution {
  readonly position: Vec3;
  readonly identity?: PointPlacementSourceAnchor;
}

/** 球を引くときに要る口。基本形状の基準点のうち座標の式は、点の参照の解き方へ戻って解く。 */
interface SolidOriginLookups {
  readonly document: PartDocument;
  readonly deps: ReferenceResolveDeps;
  readonly subShape: (reference: SubShapeRef) => ResolvedSubShape | null;
  readonly point: (reference: PointReference, limit: number) => Vec3 | null;
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

/** Persist authored formal definition, never its evaluated value or displayed coordinates. */
function canonicalPointExpressionDefinition(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

/**
 * 基本形状の基準点(`SolidOrigin`)を世界座標にする(球面上の点 FR-431 が球の中心を
 * 知るために要る)。解けなければ null。
 *
 * 立体の頂点は保存された指紋の位置をそのまま使う(点の参照の `subShape` と同じ約束)。
 * `resolvePart` は頂点をカーネルへ選び直させるが、ここはカーネルを呼ばない解決なので、
 * 指紋の位置で近似する(`resolveReferences.ts` 冒頭の注釈と同じ判断)。
 */
function solidOriginAt(
  lookups: SolidOriginLookups,
  featureId: string,
  origin: SolidOrigin,
  limit: number,
): Vec3 | null {
  switch (origin.kind) {
    case 'coordinate': {
      // 部品文書には作図面が無いので極座標の基準は XY 平面(`pointFromDefinition` と同じ)。
      const at = origin.value;
      const context: ResolveContext = {
        plane: WORK_PLANES.xy,
        points: [],
        previous: null,
        vertices: new Map<string, Vec3>(),
      };
      if (at.mode === 'absolute') {
        const resolved = resolveCoordinate(at, context, featureId);
        return resolved.ok ? resolved.value : null;
      }
      const base = lookups.point(at.base, limit);
      if (base === null) {
        return null;
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
      return resolved.ok ? resolved.value : null;
    }
    case 'sketchPoint': {
      const resolved = lookups.deps.sketch(origin.ref.sketchId);
      if (resolved === null) {
        return null;
      }
      // 点列を指していれば先頭の 1 点(`resolvePart.ts` の `resolveSpringOrigin` と同じ規約)。
      const point = resolved.points.find(
        (candidate) => candidate.featureId === origin.ref.pointFeatureId,
      );
      return point === undefined ? null : point.position;
    }
    case 'vertex': {
      const found = lookups.subShape(origin.ref);
      return found === null ? null : found.position;
    }
  }
}

/**
 * 球の基本形状(FR-429)を id で引き、中心と半径にする口を作る(球面上の点 FR-431)。
 *
 * 見つからない・球でない・抑制されている・半径が正の数でない・中心が解けない、のどれでも
 * null を返す。呼び出し側はそれを 1 つの断り(`MISSING_SPHERE_MESSAGE`)にまとめる。
 */
export function createSphereLookup(
  lookups: SolidOriginLookups,
): (sphereFeatureId: string, limit: number) => ResolvedSphere | null {
  /** いま中心を解いている途中の球(球面上の点 FR-431 の循環を止める印)。 */
  const activeSpheres = new Set<string>();
  return (sphereFeatureId, limit) => {
    if (lookups.deps.invalidInputs?.has(sphereFeatureId)) {
      return null;
    }
    if (activeSpheres.has(sphereFeatureId)) {
      // 球の中心が自分の球面上の点を指している(循環)。解こうとすると戻ってこないので断る。
      return null;
    }
    const feature = lookups.document.solids.find((candidate) => candidate.id === sphereFeatureId);
    if (feature === undefined || feature.kind !== 'primitive' || feature.shape.kind !== 'sphere') {
      return null;
    }
    if (feature.suppressed) {
      // 抑制した球は画面に無いので、その球面上の点も置けない。
      return null;
    }
    const radius = feature.shape.radius.value;
    if (!Number.isFinite(radius) || radius <= 0) {
      return null;
    }
    activeSpheres.add(sphereFeatureId);
    const center = solidOriginAt(lookups, feature.id, feature.origin, limit);
    activeSpheres.delete(sphereFeatureId);
    return center === null ? null : { center, radius };
  };
}

/** 点の参照を、位置と(示せれば)素性にする。解けなければ null。 */
export function pointResolutionAt(
  lookups: ReferencePointLookups,
  reference: PointReference,
  limit: number,
): PointResolution | null {
  switch (reference.kind) {
    case 'origin':
      return { position: ORIGIN, identity: { kind: 'origin' } };
    case 'previous':
      // 部品文書の基準ジオメトリには「直前の点」という順序の文脈が無い。
      return null;
    case 'point':
      return namedPointAt(lookups, reference, limit);
    case 'vertex':
      return sketchVertexAt(lookups, reference);
    case 'subShape':
      return subShapePointAt(lookups, reference);
    case 'functionPoint':
      return functionPointAt(lookups, reference, limit);
    case 'sphereGrid':
      return sphereGridPointAt(lookups, reference, limit);
  }
}

/** 基準点(自分より前のもの)か、スケッチの点(点フィーチャーは featureId、点列の n 番目は `featureId#n`)。 */
function namedPointAt(
  lookups: ReferencePointLookups,
  reference: Extract<PointReference, { readonly kind: 'point' }>,
  limit: number,
): PointResolution | null {
  if (lookups.withinHistory(reference.pointId, limit)) {
    const outcome = lookups.resolveReference(reference.pointId, limit);
    if (outcome.ok && outcome.value.kind === 'referencePoint') {
      return { position: outcome.value.position, identity: { kind: 'reference-point', featureId: reference.pointId } };
    }
    return null;
  }
  // 文書の順に探し、最初に見つかったものを使う(同じ id が別のスケッチにもある
  // ときのために順序で決める。決定性のため「先に出たほう」と決めておく)。
  for (const sketch of lookups.document.sketches) {
    const resolved = lookups.deps.sketch(sketch.id);
    if (resolved === null) {
      continue;
    }
    const found = resolved.points.find((point) => point.id === reference.pointId);
    if (found !== undefined) {
      return { position: found.position, ...(found.producerAnchor === undefined ? {} : { identity: {
        kind: 'sketch-point', anchor: { sketchId: sketch.id, producer: found.producerAnchor },
      } as const }) };
    }
  }
  return null;
}

/**
 * スケッチの要素の端点・中心。1 本の曲線ならその曲線の端、点・点列なら作った点の素性を添える。
 * 複数の曲線を生むフィーチャー(矩形など)の端は位置だけを返す。
 */
function sketchVertexAt(
  lookups: ReferencePointLookups,
  reference: Extract<PointReference, { readonly kind: 'vertex' }>,
): PointResolution | null {
  for (const sketch of lookups.document.sketches) {
    const resolved = lookups.deps.sketch(sketch.id);
    if (resolved === null) {
      continue;
    }
    const found = vertexOfSketch(resolved, reference.featureId, reference.vertex);
    if (found !== null) {
      const curves = [...resolved.segments, ...resolved.arcs, ...resolved.ellipses, ...resolved.splines]
        .filter((curve) => curve.featureId === reference.featureId);
      if (curves.length === 1) {
        return { position: found, identity: { kind: 'curve-vertex', sketchId: sketch.id,
          featureId: reference.featureId, vertex: reference.vertex } };
      }
      if (curves.length !== 0) {
        return { position: found };
      }
      const points = resolved.points.filter((point) => point.featureId === reference.featureId);
      const selected = reference.vertex === 'start' ? points[0] : points[points.length - 1];
      return { position: found, ...(selected?.producerAnchor === undefined ? {} : { identity: {
        kind: 'sketch-point', anchor: { sketchId: sketch.id, producer: selected.producerAnchor },
      } as const }) };
    }
  }
  return null;
}

/**
 * 立体の部分形状(3D スケッチの点、FR-330)。頂点はその位置、辺は中点、面は重心
 * (`subShapeFromFingerprint` と同じ約束)。選び直しの口と意味の素性があるときだけ素性を添える。
 */
function subShapePointAt(
  lookups: ReferencePointLookups,
  reference: Extract<PointReference, { readonly kind: 'subShape' }>,
): PointResolution | null {
  const found = lookups.subShape(reference.ref);
  return found === null ? null : { position: found.position,
    ...(reference.ref.origin === undefined || lookups.deps.subShape === undefined ? {} : { identity: {
      kind: 'semantic-subshape', bodyFeatureId: reference.ref.bodyFeatureId, origin: reference.ref.origin,
    } as const }) };
}

/**
 * 関数の点。持ち主は「いま解いている基準」(履歴の上限の位置にあるもの)で、外からの問い合わせ
 * (上限なし)では持ち主が無いので引かない。
 */
function functionPointAt(
  lookups: ReferencePointLookups,
  reference: Extract<PointReference, { readonly kind: 'functionPoint' }>,
  limit: number,
): PointResolution | null {
  // This order contains reference geometry only; a sketch/solid ID cannot be checked against it.
  // The point recomputer must have validated and evaluated this exact owner before publishing it.
  const owner = lookups.document.references[limit]?.id;
  const position = owner === undefined ? null : lookups.deps.functionPoint?.(reference, owner) ?? null;
  return position === null ? null : { position };
}

/**
 * 球面上の点(FR-431)。**位置と緯度の範囲の規則は `sketch/resolveCoordinate.ts` に 1 つだけ
 * 置く**ので、ここは球を引く口を渡してそちらへ任せる(同じ規則を 2 か所に書かない)。断りの
 * 文言は使わず、他の基準と同じく null にして呼び出し側の「見つかりません」に合わせる。
 */
function sphereGridPointAt(
  lookups: ReferencePointLookups,
  reference: Extract<PointReference, { readonly kind: 'sphereGrid' }>,
  limit: number,
): PointResolution | null {
  const context: ResolveContext = {
    plane: null,
    points: [],
    previous: null,
    vertices: new Map<string, Vec3>(),
    sphere: (sphereFeatureId) => lookups.sphere(sphereFeatureId, limit),
  };
  const outcome = resolvePointReference(reference, context, reference.sphereFeatureId);
  return outcome.ok ? { position: outcome.value, identity: { kind: 'sphere-grid', featureId: reference.sphereFeatureId,
    latitudeSource: reference.latitude.source, longitudeSource: reference.longitude.source,
    ...(reference.latitude.mathDefinition === undefined ? {} : {
      latitudeMathDefinition: canonicalPointExpressionDefinition(reference.latitude.mathDefinition),
    }),
    ...(reference.longitude.mathDefinition === undefined ? {} : {
      longitudeMathDefinition: canonicalPointExpressionDefinition(reference.longitude.mathDefinition),
    }) } } : null;
}

/** 位置と素性を、素性を示せたか(identified)・示せなかったか(unidentified)の形にする。 */
export function pointWithIdentityOf(resolved: PointResolution | null): ResolvedPointWithIdentity | null {
  if (resolved === null) {
    return null;
  }
  return resolved.identity === undefined
    ? { state: 'unidentified', position: resolved.position, reason: 'producer-unavailable' }
    : { state: 'identified', position: resolved.position, identity: resolved.identity };
}
