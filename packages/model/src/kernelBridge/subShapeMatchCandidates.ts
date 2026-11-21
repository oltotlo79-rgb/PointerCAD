/** 保存した指紋から候補を集め、現在の形状の幾何と採点を返す。 */
import { resolveEdgeReference, resolveFaceReference, resolveVertexReference } from '@pointercad/kernel';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidBody, SolidFaceEntry, MateSubShapeGeometry } from './solidContracts.js';
import { toSubShapeQuery } from './subShapeQuery.js';

/**
 * 位置の点を部品の大きさで割るための長さ(境界箱の対角長の半分)。
 *
 * カーネル側(`makeHole.ts` 等)は `boundingDiagonal`(OCCT の `Bnd_Box`)で測るが、
 * model は B-rep を持たないので**三角形の頂点の並び**から同じ量を測る。
 * 三角形は形の表面を覆っているので、境界箱は実用上ほぼ一致する(曲面では
 * 近似の分だけわずかに小さく出るが、位置の点は 0〜1 の連続な値で、しきい値
 * (`SUB_SHAPE_MATCH_THRESHOLD`)の判定がこの差で覆るほど敏感ではない)。
 */
export function matchScaleOf(body: SolidBody): number {
  const positions = body.mesh.positions;
  if (positions.length < 3) return 0;
  const low: [number, number, number] = [positions[0], positions[1], positions[2]];
  const high: [number, number, number] = [positions[0], positions[1], positions[2]];
  for (let index = 3; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) * 0.5;
}

/** 現在の面の表から合致用の幾何を作る。二つの照合の道で同じ欄を運び、保存の指紋には使わない。 */
export function faceGeometry(body: SolidBody, face: SolidFaceEntry): MateSubShapeGeometry {
  const boundary = face.boundaryEdgeIndices;
  const completeBoundary = boundary !== undefined && boundary.length > 0 && new Set(boundary).size === boundary.length
    && Array.from(boundary).every(index => Number.isSafeInteger(index) && index >= 0 && body.edges.filter(edge => edge.index === index).length === 1);
  return {
    kind: 'face', ...(completeBoundary ? { boundaryEdgeIndices: Object.freeze([...boundary]) } : {}),
    surfaceKind: face.surfaceKind, area: face.area,
    position: face.centroid, axis: face.axis, radius: face.radius,
    ...(face.axisOrigin == null ? {} : { axisOrigin: face.axisOrigin }),
    ...(face.planarBasis === undefined ? {} : { planarBasis: face.planarBasis }),
    ...(face.cylinderSpan == null ? {} : { cylinderSpan: face.cylinderSpan }),
    ...(face.cylinderAxialExtent == null ? {} : { cylinderAxialExtent: face.cylinderAxialExtent }),
    ...(face.cylinderExterior === undefined ? {} : { cylinderExterior: face.cylinderExterior }),
  };
}

/** 採用前の候補。指紋の値ではなく、現在の形から得た参照と幾何を持つ。 */
export interface SubShapeMatchCandidate {
  readonly reference: SubShapeRef;
  /** Semantic adoption never turns a geometric score below 0.6 into a fake 1. */
  readonly basis?: 'semantic';
  readonly score: number;
  readonly geometry: MateSubShapeGeometry;
}

/**
 * kernel の同じ採点・種類・しきい値で全候補を求める。番号による並びは表示のためで、
 * 同一性の証明には使わない。元の表・参照は変更しない。
 */
export function subShapeMatchCandidates(body: SolidBody, reference: SubShapeRef): readonly SubShapeMatchCandidate[] {
  if (body.featureId !== reference.bodyFeatureId) return [];
  const query = toSubShapeQuery(reference), scale = matchScaleOf(body);
  let candidates: SubShapeMatchCandidate[];
  switch (query.kind) {
    case 'face':
      candidates = resolveFaceReference(body.faces, query, scale, body.origins).candidates.map(({ candidate: face, score }) => {
        return { score,
          ...(reference.origin === undefined ? {} : { basis: 'semantic' as const }),
          reference: { bodyFeatureId: body.featureId, index: face.index,
            ...(reference.origin === undefined ? {} : { origin: reference.origin }), fingerprint: {
            kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid, axis: face.axis, radius: face.radius,
          } },
          geometry: faceGeometry(body, face),
        };
      });
      break;
    case 'edge':
      candidates = resolveEdgeReference(body.edges, query, scale, body.origins).candidates.map(({ candidate: edge, score }) => {
        return { score,
          ...(reference.origin === undefined ? {} : { basis: 'semantic' as const }),
          reference: { bodyFeatureId: body.featureId, index: edge.index,
            ...(reference.origin === undefined ? {} : { origin: reference.origin }), fingerprint: {
            kind: 'edge', curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius,
          } },
          geometry: { kind: 'edge', curveKind: edge.curveKind, length: edge.length, position: edge.midpoint,
            axis: edge.axis, radius: edge.radius, ...(edge.axisOrigin == null ? {} : { axisOrigin: edge.axisOrigin }), ...(edge.curveKind !== 'circle' || edge.circleBasis === undefined ? {} : { circleBasis: edge.circleBasis }) },
        };
      });
      break;
    case 'vertex':
      candidates = resolveVertexReference(body.vertices, query, scale, body.origins).candidates.map(({ candidate: vertex, score }) => {
        return { score,
          ...(reference.origin === undefined ? {} : { basis: 'semantic' as const }),
          reference: { bodyFeatureId: body.featureId, index: vertex.index,
            ...(reference.origin === undefined ? {} : { origin: reference.origin }),
            fingerprint: { kind: 'vertex', position: vertex.position } },
          geometry: { kind: 'vertex', position: vertex.position },
        };
      });
      break;
  }
  return candidates.sort((first, second) => second.score - first.score || first.reference.index - second.reference.index);
}
