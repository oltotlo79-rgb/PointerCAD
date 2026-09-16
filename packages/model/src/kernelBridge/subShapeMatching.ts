/** 現在の形状と保存した指紋を照合する同期処理。通信・形状生成・寿命管理は行わない。 */
import { matchEdge, matchFace, matchVertex } from '@pointercad/kernel';
import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidBody, MateSubShapeGeometry } from './solidContracts.js';
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
  if (positions.length < 3) {
    return 0;
  }
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

/**
 * 指紋に最も近い面・辺・頂点を、いまのボディの中から選び直す(FR-325、FR-330、タスク25)。
 *
 * 採点は kernel の `matchFace` / `matchEdge` / `matchVertex`(OCCT を使わない純関数)を
 * そのまま使うので、**重み・しきい値・同点の決め方は加工フィーチャーと完全に同じ**である
 * (§0.a-0.4)。この関数を通すと、スケッチの頂点参照・作業平面・基準ジオメトリが
 * 「保存された指紋の位置」ではなく「いまの形の位置」を見るようになる。
 *
 * 届かなければ null(呼び出し側が `missingSubShape` で断る、FR-504)。
 * Worker を通らない同期の純関数なので、`KernelBridge` のメソッドにはしない
 * 通信やWorkerの寿命とは独立して、現在の表示形状だけを参照する。
 */
export function selectSubShape(body: SolidBody, reference: SubShapeRef): ResolvedSubShape | null {
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
 * 合致のため、現在の形から種類・大きさ・重心・解析軸上点を選び直す(P7-14b)。
 * selectSubShape と同じ kernel の採点を使い、重心を解析点で置き換えない。
 * body は部品座標の形。アセンブリの配置は resolveMateTarget が1回だけ掛ける。
 */
export function selectMateTargetGeometry(
  body: SolidBody,
  reference: SubShapeRef,
): MateSubShapeGeometry | null {
  if (body.featureId !== reference.bodyFeatureId) return null;
  const query = toSubShapeQuery(reference);
  const scale = matchScaleOf(body);
  switch (query.kind) {
    case 'face': {
      const match = matchFace(body.faces, query, scale);
      const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
      if (found === undefined) return null;
      return {
        kind: 'face',
        surfaceKind: found.surfaceKind,
        area: found.area,
        position: found.centroid,
        axis: found.axis,
        radius: found.radius,
        ...(found.axisOrigin == null ? {} : { axisOrigin: found.axisOrigin }),
      };
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
 * 部品を差し替えた後のボディから、保存し直せる部分形状参照を作る(FR-614)。
 * 採点・しきい値・同点時の選択は `selectSubShape` と同じ kernel の純関数を使う。
 * 見つからなければ元の参照を消さずに残せるよう `null` を返す。
 */
export function rematchSubShapeRef(
  bodies: readonly SolidBody[],
  reference: SubShapeRef,
): SubShapeRef | null {
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
