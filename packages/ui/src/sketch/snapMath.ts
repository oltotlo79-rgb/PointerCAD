/**
 * スナップの候補集めと選択(計画書 docs/plans/P1-式とスケッチ.md タスク15 手順3、§2.8、§0.a-0.10)。
 *
 * 対応要件: FR-107(端点・中点・円中心・交点・グリッドへのスナップ、種別のフィルタ)。
 *
 * 判定はワールド座標ではなく**画面座標**で行う。ワールド座標で測ると、
 * 遠くにある要素にも近くの要素と同じ距離で吸い付いてしまうため。
 * ワールド → 画面の写し方は呼び出し側(ビューポート)から関数で注入する。
 * ここは DOM にも three.js にも触れない純関数だけを置く。
 */

import {
  addVec3, arcPointAt, distanceVec3, dotVec3, lerpVec3, planeToWorld, scaleVec3, subVec3,
  worldToPlane, type ResolvedSegment, type ResolvedSketch, type Vec3, type WorkPlane,
} from '@pointercad/model';

/** スナップの種別(FR-107)。 */
export type SnapKind = 'endpoint' | 'intersection' | 'midpoint' | 'center' | 'grid';

/**
 * 優先順位(§0.a-0.10)。判定半径の中に複数の候補があれば、まずこの順で選び、
 * 同じ種別の中でだけ画面距離の近さで選ぶ。
 * 距離を先に見ると、ポインタのすぐ近くに必ず現れる格子点が常に勝ってしまい、
 * 端点や交点へ吸い付けなくなるため。
 */
export const SNAP_PRIORITY: readonly SnapKind[] = [
  'endpoint',
  'intersection',
  'midpoint',
  'center',
  'grid',
];

/** 既定では全種別が有効(§0.a-0.10「スナップ既定有効」)。 */
export const DEFAULT_SNAP_KINDS: readonly SnapKind[] = SNAP_PRIORITY;

/** 吸い付く画面上の距離(画素)。 */
export const SNAP_RADIUS_PIXELS = 12;

/** 交点とみなす2直線の最短距離(mm)。これより離れていればねじれの位置。 */
export const INTERSECTION_TOLERANCE_MM = 1e-3;

export interface SnapCandidate {
  readonly kind: SnapKind;
  readonly position: Vec3;
  /** どの要素から来た候補か。グリッドは null。 */
  readonly featureId: string | null;
  /**
   * 候補の元になった要素そのものの id。点列の n 番目の点だけは `featureId#n` になり、
   * `PointReference { kind: 'point', pointId }` でその 1 点を名指しできる(FR-311 の土台)。
   * 線分・円弧から来た候補は featureId と同じ。グリッドは null。
   */
  readonly elementId: string | null;
}

/** ワールド座標を画面座標へ写す。ビューポートが渡す。画面の外なら null。 */
export type ProjectToScreen = (point: Vec3) => readonly [number, number] | null;

/**
 * 2 線分の交点。平行・ねじれ・線分の外側なら null。
 * 最短距離を与える媒介変数を解いて、両方が [0,1] に入り、かつ2点が十分近いときだけ交点とする。
 */
export function segmentIntersection(a: ResolvedSegment, b: ResolvedSegment): Vec3 | null {
  const u = subVec3(a.to, a.from);
  const v = subVec3(b.to, b.from);
  const w = subVec3(a.from, b.from);
  const uu = dotVec3(u, u);
  const uv = dotVec3(u, v);
  const vv = dotVec3(v, v);
  const uw = dotVec3(u, w);
  const vw = dotVec3(v, w);
  const denominator = uu * vv - uv * uv;
  if (Math.abs(denominator) <= 1e-12) {
    return null;
  }
  const s = (uv * vw - vv * uw) / denominator;
  const t = (uu * vw - uv * uw) / denominator;
  if (s < 0 || s > 1 || t < 0 || t > 1) {
    return null;
  }
  const onA = addVec3(a.from, scaleVec3(u, s));
  const onB = addVec3(b.from, scaleVec3(v, t));
  if (distanceVec3(onA, onB) > INTERSECTION_TOLERANCE_MM) {
    return null;
  }
  return lerpVec3(onA, onB, 0.5);
}

/** 作図面の上で、ポインタに最も近い格子点。 */
export function nearestGridPoint(plane: WorkPlane, pointOnPlane: Vec3, spacing: number): Vec3 {
  const [u, v] = worldToPlane(plane, pointOnPlane);
  return planeToWorld(plane, Math.round(u / spacing) * spacing, Math.round(v / spacing) * spacing);
}

/**
 * スケッチと作図面から、スナップ候補を集める(FR-107)。
 * `pointOnPlane` はポインタを作図面へ落とした点。無ければ格子点の候補は作らない。
 */
export function collectSnapCandidates(
  sketch: ResolvedSketch,
  plane: WorkPlane,
  gridSpacing: number,
  pointOnPlane: Vec3 | null,
): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];

  for (const point of sketch.points) {
    candidates.push({
      kind: 'endpoint',
      position: point.position,
      featureId: point.featureId,
      elementId: point.id,
    });
  }

  for (const segment of sketch.segments) {
    candidates.push({
      kind: 'endpoint',
      position: segment.from,
      featureId: segment.featureId,
      elementId: segment.featureId,
    });
    candidates.push({
      kind: 'endpoint',
      position: segment.to,
      featureId: segment.featureId,
      elementId: segment.featureId,
    });
    candidates.push({
      kind: 'midpoint',
      position: lerpVec3(segment.from, segment.to, 0.5),
      featureId: segment.featureId,
      elementId: segment.featureId,
    });
  }

  for (const arc of sketch.arcs) {
    // 端点と弧長中央は角度から直に求める。折れ線の標本点から拾うと、
    // 区間数が奇数のときに中央が弧の真ん中からずれるため。
    candidates.push({
      kind: 'endpoint',
      position: arcPointAt(arc, arc.startAngle),
      featureId: arc.featureId,
      elementId: arc.featureId,
    });
    candidates.push({
      kind: 'endpoint',
      position: arcPointAt(arc, arc.endAngle),
      featureId: arc.featureId,
      elementId: arc.featureId,
    });
    candidates.push({
      kind: 'midpoint',
      position: arcPointAt(arc, (arc.startAngle + arc.endAngle) / 2),
      featureId: arc.featureId,
      elementId: arc.featureId,
    });
    candidates.push({
      kind: 'center',
      position: arc.center,
      featureId: arc.featureId,
      elementId: arc.featureId,
    });
  }

  // 交点は線分どうしだけ(§0.a-0.10。円弧との交点は P2)。
  for (let i = 0; i < sketch.segments.length; i += 1) {
    for (let j = i + 1; j < sketch.segments.length; j += 1) {
      const crossing = segmentIntersection(sketch.segments[i], sketch.segments[j]);
      if (crossing !== null) {
        candidates.push({
          kind: 'intersection',
          position: crossing,
          featureId: sketch.segments[i].featureId,
          elementId: sketch.segments[i].featureId,
        });
      }
    }
  }

  if (pointOnPlane !== null && gridSpacing > 0) {
    candidates.push({
      kind: 'grid',
      position: nearestGridPoint(plane, pointOnPlane, gridSpacing),
      featureId: null,
      elementId: null,
    });
  }

  return candidates;
}

/**
 * 画面上でポインタに吸い付く候補を 1 つ選ぶ(§2.8)。
 * 判定半径の中にある候補のうち優先度が最も高いものを返し、
 * 同じ優先度が並んだときだけ画面距離の近いものを返す。
 * `enabled` に無い種別は候補から外す(FR-107 の種別フィルタ)。
 */
export function chooseSnap(
  candidates: readonly SnapCandidate[],
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number,
  enabled: ReadonlySet<SnapKind>,
): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  let bestPriority = SNAP_PRIORITY.length;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (!enabled.has(candidate.kind)) {
      continue;
    }
    const screen = project(candidate.position);
    if (screen === null) {
      continue;
    }
    const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
    if (distance > radiusPixels) {
      continue;
    }
    const priority = SNAP_PRIORITY.indexOf(candidate.kind);
    if (priority < bestPriority || (priority === bestPriority && distance < bestDistance)) {
      best = candidate;
      bestPriority = priority;
      bestDistance = distance;
    }
  }

  return best;
}
