/** 現在の形状と保存した指紋を照合する同期処理。通信・形状生成・寿命管理は行わない。 */
import { matchEdge, matchFace, matchVertex, resolveEdgeReference, resolveFaceReference, resolveVertexReference } from '@pointercad/kernel';
import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { resolveCurrentOrigin } from './createSubShapeReference.js';
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
function matchScaleOf(body: SolidBody): number {
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

function uniqueSemanticCandidate(body: SolidBody, reference: SubShapeRef): SubShapeMatchCandidate | null {
  if (resolveCurrentOrigin(body, reference).status !== 'matched') return null;
  const candidates = subShapeMatchCandidates(body, reference);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 互換用の低水準選択。候補の採点だけであり、一意性・自動採用の保証ではない。
 * 製品の再計算は resolveSubShapeReference の matched だけを採用する。
 *
 * 採点は kernel の `matchFace` / `matchEdge` / `matchVertex`(OCCT を使わない純関数)を
 * そのまま使うので、重み・しきい値は加工フィーチャーと同じである(§0.a-0.4)。
 * ここに残した同点時の番号順選択は互換用であり、加工側の採用判定には使わない。
 * 返す位置・向きは現在の候補の値であり、保存された指紋の値を代用しない。
 *
 * 届かなければ null(呼び出し側が `missingSubShape` で断る、FR-504)。
 * Worker を通らない同期の純関数なので、`KernelBridge` のメソッドにはしない
 * 通信やWorkerの寿命とは独立して、現在の表示形状だけを参照する。
 */
export function selectSubShape(body: SolidBody, reference: SubShapeRef): ResolvedSubShape | null {
  if (reference.origin !== undefined) {
    const geometry = uniqueSemanticCandidate(body, reference)?.geometry;
    return geometry === undefined ? null : {
      kind: geometry.kind, position: geometry.position,
      axis: geometry.kind === 'vertex' ? null : geometry.axis,
      surfaceKind: geometry.kind === 'face' ? geometry.surfaceKind : null,
      curveKind: geometry.kind === 'edge' ? geometry.curveKind : null,
    };
  }
  const query = toSubShapeQuery(reference);
  const scale = matchScaleOf(body);
  switch (query.kind) {
    case 'face': {
      const match = matchFace(body.faces, query, scale);
      const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'face',
        position: found.centroid,
        axis: found.axis,
        surfaceKind: found.surfaceKind,
        curveKind: null,
      };
    }
    case 'edge': {
      const match = matchEdge(body.edges, query, scale);
      const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'edge',
        position: found.midpoint,
        axis: found.axis,
        surfaceKind: null,
        curveKind: found.curveKind,
      };
    }
    case 'vertex': {
      const match = matchVertex(body.vertices, query, scale);
      const found =
        match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'vertex',
        position: found.position,
        axis: null,
        surfaceKind: null,
        curveKind: null,
      };
    }
  }
}

/** 現在の面の表から合致用の幾何を作る。二つの照合の道で同じ欄を運び、保存の指紋には使わない。 */
function faceGeometry(face: SolidFaceEntry): MateSubShapeGeometry {
  return {
    kind: 'face',
    surfaceKind: face.surfaceKind,
    area: face.area,
    position: face.centroid,
    axis: face.axis,
    radius: face.radius,
    ...(face.axisOrigin == null ? {} : { axisOrigin: face.axisOrigin }),
    ...(face.cylinderSpan == null ? {} : { cylinderSpan: face.cylinderSpan }),
    ...(face.cylinderAxialExtent == null ? {} : { cylinderAxialExtent: face.cylinderAxialExtent }),
    ...(face.cylinderExterior === undefined ? {} : { cylinderExterior: face.cylinderExterior }),
  };
}

/**
 * 互換用の低水準選択。製品の合致は resolveSubShapeReference の matched だけを採用する。
 * 現在の形から種類・大きさ・重心・解析軸上点を選ぶ(P7-14b)。
 * selectSubShape と同じ kernel の採点を使い、重心を解析点で置き換えない。
 * body は部品座標の形。アセンブリの配置は resolveMateTarget が1回だけ掛ける。
 */
export function selectMateTargetGeometry(
  body: SolidBody,
  reference: SubShapeRef,
): MateSubShapeGeometry | null {
  if (body.featureId !== reference.bodyFeatureId) return null;
  if (reference.origin !== undefined) return uniqueSemanticCandidate(body, reference)?.geometry ?? null;
  const query = toSubShapeQuery(reference);
  const scale = matchScaleOf(body);
  switch (query.kind) {
    case 'face': {
      const match = matchFace(body.faces, query, scale);
      const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
      return found === undefined ? null : faceGeometry(found);
    }
    case 'edge': {
      const match = matchEdge(body.edges, query, scale);
      const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
      if (found === undefined) return null;
      return {
        kind: 'edge',
        curveKind: found.curveKind,
        length: found.length,
        position: found.midpoint,
        axis: found.axis,
        radius: found.radius,
        ...(found.axisOrigin == null ? {} : { axisOrigin: found.axisOrigin }),
      };
    }
    case 'vertex': {
      const match = matchVertex(body.vertices, query, scale);
      const found =
        match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
      return found === undefined ? null : { kind: 'vertex', position: found.position };
    }
  }
}

/**
 * 選び直しの最高点と次点(図形の測定値の曖昧さの判定、GR-05)。
 * `index` と `score` は `selectMateTargetGeometry` が選ぶ候補そのものの番号と点。
 */
export interface SubShapeMatchScores {
  /** 選ばれた部分形状の通し番号。 */
  readonly index: number;
  /** 最高点(しきい値以上)。 */
  readonly score: number;
  /** 選ばれた候補を除いた残りの最高点。しきい値に届く候補が無ければ null。 */
  readonly runnerUpScore: number | null;
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
          geometry: faceGeometry(face),
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
            axis: edge.axis, radius: edge.radius, ...(edge.axisOrigin == null ? {} : { axisOrigin: edge.axisOrigin }) },
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

/** 既存の採点API。候補の最高点と次点を返すだけで、採用可否は共通の参照解決で判断する。 */
export function scoreSubShapeMatch(body: SolidBody, reference: SubShapeRef): SubShapeMatchScores | null {
  const [best, runnerUp] = subShapeMatchCandidates(body, reference);
  return best === undefined ? null : { index: best.reference.index, score: best.score, runnerUpScore: runnerUp?.score ?? null };
}

/**
 * 互換用の低水準選択。一意性を保証せず、製品の差替えには resolveReplacementSubShapeReference を使う。
 * 部品を差し替えた後のボディから、候補の部分形状参照を作る(FR-614)。
 * 採点・しきい値・同点時の選択は `selectSubShape` と同じ kernel の純関数を使う。
 * 見つからなければ元の参照を消さずに残せるよう `null` を返す。
 */
export function rematchSubShapeRef(bodies: readonly SolidBody[], reference: SubShapeRef): SubShapeRef | null {
  if (reference.origin !== undefined) {
    const current = bodies.filter(body => body.featureId === reference.bodyFeatureId);
    return current.length === 1 ? uniqueSemanticCandidate(current[0], reference)?.reference ?? null : null;
  }
  const preferred = bodies.filter((body) => body.featureId === reference.bodyFeatureId);
  const candidates = preferred.length > 0 ? preferred : bodies;
  const query = toSubShapeQuery(reference);
  for (const body of candidates) {
    const scale = matchScaleOf(body);
    switch (query.kind) {
      case 'face': {
        const match = matchFace(body.faces, query, scale);
        const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
        if (found !== undefined) {
          return {
            bodyFeatureId: body.featureId,
            index: found.index,
            fingerprint: {
              kind: 'face', surfaceKind: found.surfaceKind, area: found.area,
              position: found.centroid, axis: found.axis, radius: found.radius,
            },
          };
        }
        break;
      }
      case 'edge': {
        const match = matchEdge(body.edges, query, scale);
        const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
        if (found !== undefined) {
          return {
            bodyFeatureId: body.featureId,
            index: found.index,
            fingerprint: {
              kind: 'edge', curveKind: found.curveKind, length: found.length,
              position: found.midpoint, axis: found.axis, radius: found.radius,
            },
          };
        }
        break;
      }
      case 'vertex': {
        const match = matchVertex(body.vertices, query, scale);
        const found = match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
        if (found !== undefined) {
          return {
            bodyFeatureId: body.featureId,
            index: found.index,
            fingerprint: { kind: 'vertex', position: found.position },
          };
        }
        break;
      }
    }
  }
  return null;
}
