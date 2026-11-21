/** 現在の形状と保存した指紋を照合する同期処理。通信・形状生成・寿命管理は行わない。 */
import { matchEdge, matchFace, matchVertex } from '@pointercad/kernel';
import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { resolveCurrentOrigin } from './createSubShapeReference.js';
import type { SolidBody, MateSubShapeGeometry } from './solidContracts.js';
import { faceGeometry, matchScaleOf, subShapeMatchCandidates, type SubShapeMatchCandidate } from './subShapeMatchCandidates.js';
import { toSubShapeQuery } from './subShapeQuery.js';

export { subShapeMatchCandidates, type SubShapeMatchCandidate } from './subShapeMatchCandidates.js';

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
 * そのまま使うので、重み・しきい値は加工フィーチャーと同じである。
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

/**
 * 互換用の低水準選択。製品の合致は resolveSubShapeReference の matched だけを採用する。
 * 現在の形から種類・大きさ・重心・解析軸上点を選ぶ。
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
      return found === undefined ? null : faceGeometry(body, found);
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
        ...(found.axisOrigin == null ? {} : { axisOrigin: found.axisOrigin }), ...(found.curveKind !== 'circle' || found.circleBasis === undefined ? {} : { circleBasis: found.circleBasis }),
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
 * 選び直しの最高点と次点(図形の測定値の曖昧さの判定)。
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
