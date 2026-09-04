/**
 * 向きの吸着(直交・極トラッキング)の候補集めと選択(計画書 docs/plans/P4b-スケッチの仕上げ.md タスク15、§0.13、§2.4)。
 *
 * 対応要件: FR-110(直交・極トラッキング。既存の点からの延長線・垂線・平行線への吸着)。
 *
 * `snapMath.ts` の `SnapCandidate` は「点」しか持てない(§0.13 の根拠)ため、
 * 「向き」の候補はここに新しい型(`TrackCandidate`)を分けて持つ。判定は `snapMath.ts` と
 * 同じく**画面座標**で行う(ワールド座標で測ると遠くの要素にも近くの要素と同じ距離で
 * 吸い付いてしまうため)。ここは DOM にも three.js にも触れない純関数だけを置く
 * (`snapMath.ts` は触らない。`SnapKind` への 4 種の追加・配線はタスク16で行う)。
 */

import {
  addVec3, crossVec3, directionInPlane, distanceVec3, dotVec3, lengthVec3, lerpVec3,
  normalizeVec3, radiansToDegrees, scaleVec3, SKETCH_TOLERANCE_MM, subVec3,
  worldToPlane, type ResolvedSegment, type ResolvedSketch, type Vec3, type WorkPlane,
} from '@pointercad/model';

import type { ProjectToScreen } from './snapMath.js';

/** 向きの吸着の種別(FR-110)。 */
export type TrackKind = 'polar' | 'extension' | 'perpendicular' | 'parallel';

/**
 * 優先順位(§0.13)。点の吸着(`SnapCandidate`)がすべて先に判定されるので、
 * ここは向きの候補どうしの優先順位だけを決める。極を先にするのは、極が
 * 「起点からの角度」という利用者の意図に最も近いため(§2.4)。
 */
const TRACK_PRIORITY: readonly TrackKind[] = ['polar', 'extension', 'perpendicular', 'parallel'];

export interface TrackCandidate {
  readonly kind: TrackKind;
  /** 案内線が通る点(ワールド座標、作図面の上)。 */
  readonly origin: Vec3;
  /** 案内線の向き(単位ベクトル、作図面の上)。 */
  readonly direction: Vec3;
  /** どの要素から来た候補か。極だけ null。 */
  readonly sourceFeatureId: string | null;
  /** 極の候補の角度(度、0〜360 未満)。他は null。案内の文言に出す。 */
  readonly angleDegrees: number | null;
}

export interface TrackResult {
  /** 吸い付いた位置。 */
  readonly position: Vec3;
  /** 採った案内線(1 本か、交点なら 2 本)。 */
  readonly candidates: readonly TrackCandidate[];
}

/** 刻み角度の候補(§0.12)。設定パネルの6択(タスク16)もこれを正とする。 */
export const TRACK_ANGLE_STEPS: readonly number[] = [5, 10, 15, 30, 45, 90];
export const DEFAULT_TRACK_ANGLE_STEP = 15;

/**
 * 案内線の候補を絞る粗い当たり判定の半径(mm、§2.9)。
 *
 * `collectTrackCandidates` はここでは画面座標(`ProjectToScreen`)を受け取らないため、
 * 「画面 200 画素」をそのままでは測れない。ポインタを作図面へ落とした点(`pointOnPlane`)
 * とのワールド距離で代わりに絞る、粗い一次選別として使う(最終判定は `chooseTrack` が
 * 画面座標で行う)。値は性能検査(線分200本、うち近傍10本、4ms以内)で実測して決めた
 * (`trackMath.test.ts` の性能検査を参照。担当が実測して固定した値、§2.9 の落とし穴)。
 */
const TRACK_CANDIDATE_SEARCH_RADIUS_MM = 200;

/** 2 直線が平行とみなす、単位方向ベクトルどうしの内積の絶対値のしきい値(§2.2 の 1e-9 と同じ考え方)。 */
const PARALLEL_DOT_EPSILON = 1e-9;

/** 角度を 0〜360 未満へ正規化する。 */
function normalizeAngleDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** ポインタに最も近い極の向きを 1 本だけ作る(24 本を全部作らない)。 */
export function polarCandidate(
  plane: WorkPlane,
  origin: Vec3,
  pointOnPlane: Vec3,
  stepDegrees: number,
): TrackCandidate | null {
  if (stepDegrees <= 0) {
    return null;
  }
  const [originU, originV] = worldToPlane(plane, origin);
  const [pointerU, pointerV] = worldToPlane(plane, pointOnPlane);
  const deltaU = pointerU - originU;
  const deltaV = pointerV - originV;
  if (Math.hypot(deltaU, deltaV) <= SKETCH_TOLERANCE_MM) {
    // 起点とポインタが同じ位置では向きが決まらない。
    return null;
  }
  const rawDegrees = normalizeAngleDegrees(radiansToDegrees(Math.atan2(deltaV, deltaU)));
  const angleDegrees = normalizeAngleDegrees(Math.round(rawDegrees / stepDegrees) * stepDegrees);
  return {
    kind: 'polar',
    origin,
    direction: directionInPlane(plane, angleDegrees),
    sourceFeatureId: null,
    angleDegrees,
  };
}

/** 線分の両端・中点のいずれかがポインタの近くにあるか(§2.9 の粗い当たり判定)。 */
function isSegmentNearby(segment: ResolvedSegment, pointOnPlane: Vec3): boolean {
  return (
    distanceVec3(segment.from, pointOnPlane) <= TRACK_CANDIDATE_SEARCH_RADIUS_MM ||
    distanceVec3(segment.to, pointOnPlane) <= TRACK_CANDIDATE_SEARCH_RADIUS_MM ||
    distanceVec3(lerpVec3(segment.from, segment.to, 0.5), pointOnPlane)
      <= TRACK_CANDIDATE_SEARCH_RADIUS_MM
  );
}

/**
 * 既存の要素から、延長線・垂線・平行線の候補を集める(FR-110)。
 *
 * 円弧・楕円・スプラインからは作らない(向きが1つに決まらないため、§2.4 の落とし穴)。
 * 線分だけを対象にする。
 */
export function collectTrackCandidates(
  sketch: ResolvedSketch,
  plane: WorkPlane,
  origin: Vec3 | null,
  pointOnPlane: Vec3,
  stepDegrees: number,
  enabled: ReadonlySet<TrackKind>,
): readonly TrackCandidate[] {
  const candidates: TrackCandidate[] = [];

  if (enabled.has('polar') && origin !== null) {
    const polar = polarCandidate(plane, origin, pointOnPlane, stepDegrees);
    if (polar !== null) {
      candidates.push(polar);
    }
  }

  const wantsSegmentCandidates =
    enabled.has('extension') || enabled.has('perpendicular') || enabled.has('parallel');
  if (!wantsSegmentCandidates) {
    return candidates;
  }

  for (const segment of sketch.segments) {
    if (!isSegmentNearby(segment, pointOnPlane)) {
      continue;
    }
    const raw = subVec3(segment.to, segment.from);
    if (lengthVec3(raw) <= SKETCH_TOLERANCE_MM) {
      // 縮退した線分(長さ0)からは向きが決まらない。
      continue;
    }
    const direction = normalizeVec3(raw);

    if (enabled.has('extension')) {
      // 両端から、線分の向きへ伸ばした半直線(反対の端からは逆向き)。
      candidates.push({
        kind: 'extension', origin: segment.to, direction,
        sourceFeatureId: segment.featureId, angleDegrees: null,
      });
      candidates.push({
        kind: 'extension', origin: segment.from, direction: scaleVec3(direction, -1),
        sourceFeatureId: segment.featureId, angleDegrees: null,
      });
    }

    if (enabled.has('perpendicular')) {
      // 法線との外積で作図面の上で90°回した向き(単位ベクトルどうしなので長さ1のまま)。
      const perpendicular = crossVec3(plane.normal, direction);
      candidates.push({
        kind: 'perpendicular', origin: segment.to, direction: perpendicular,
        sourceFeatureId: segment.featureId, angleDegrees: null,
      });
      candidates.push({
        kind: 'perpendicular', origin: segment.from, direction: perpendicular,
        sourceFeatureId: segment.featureId, angleDegrees: null,
      });
    }

    if (enabled.has('parallel') && origin !== null) {
      // 起点を通り、線分と同じ向きの直線。半直線ではないので1本だけでよい。
      candidates.push({
        kind: 'parallel', origin, direction,
        sourceFeatureId: segment.featureId, angleDegrees: null,
      });
    }
  }

  return candidates;
}

/**
 * 候補の直線の上で、ポインタに最も近い点(§2.4)。
 *
 * ただし極(polar)だけは例外。極は「起点からの距離を保ったまま角度だけ丸める」という
 * 利用者の意図(AutoCADの極トラッキングと同じ挙動)に合わせるため、直線への垂直な
 * 射影ではなく、**起点からポインタまでの距離をそのまま向きへ載せる**(検証表の
 * 「極: 20∠17°→20∠15°」がこの式でないと一致しない。垂直射影だと 20·cos2° まで縮む)。
 */
function positionAlongCandidate(candidate: TrackCandidate, pointOnPlane: Vec3): Vec3 {
  if (candidate.kind === 'polar') {
    const distance = distanceVec3(candidate.origin, pointOnPlane);
    return addVec3(candidate.origin, scaleVec3(candidate.direction, distance));
  }
  const projected = dotVec3(subVec3(pointOnPlane, candidate.origin), candidate.direction);
  return addVec3(candidate.origin, scaleVec3(candidate.direction, projected));
}

interface ScoredTrackCandidate {
  readonly candidate: TrackCandidate;
  readonly position: Vec3;
  readonly distance: number;
}

/**
 * 判定半径の中にある候補のうち、`excludeKind` と異なる種別で最も優先度が高いものを選ぶ
 * (同じ優先度なら画面距離が近い方)。`chooseTrack` が1本目・2本目の両方をこれで選ぶ。
 */
function bestTrackCandidate(
  candidates: readonly TrackCandidate[],
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number,
  pointOnPlane: Vec3,
  excludeKind: TrackKind | null,
): ScoredTrackCandidate | null {
  let best: ScoredTrackCandidate | null = null;
  let bestPriority = TRACK_PRIORITY.length;

  for (const candidate of candidates) {
    if (excludeKind !== null && candidate.kind === excludeKind) {
      continue;
    }
    const position = positionAlongCandidate(candidate, pointOnPlane);
    const screen = project(position);
    if (screen === null) {
      continue;
    }
    const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
    if (distance > radiusPixels) {
      continue;
    }
    const priority = TRACK_PRIORITY.indexOf(candidate.kind);
    if (best === null || priority < bestPriority || (priority === bestPriority && distance < best.distance)) {
      best = { candidate, position, distance };
      bestPriority = priority;
    }
  }

  return best;
}

/**
 * 2本の(コプレナーな)直線の交点。平行なら null。
 *
 * 作図面を受け取らずに求める(`chooseTrack` の口が作図面を持たないため)。両方の候補が
 * 同じ作図面の上にある(コプレナー)前提で、ねじれ直線どうしの最短点を求める式を使う。
 * コプレナーなら最短距離が0になり、その点がそのまま交点になる(平行なら分母が0)。
 */
function intersectTrackLines(a: TrackCandidate, b: TrackCandidate): Vec3 | null {
  const crossDirections = dotVec3(a.direction, b.direction);
  const denominator = 1 - crossDirections * crossDirections;
  if (Math.abs(denominator) <= PARALLEL_DOT_EPSILON) {
    return null;
  }
  const originDelta = subVec3(a.origin, b.origin);
  const d = dotVec3(a.direction, originDelta);
  const e = dotVec3(b.direction, originDelta);
  const t = (crossDirections * e - d) / denominator;
  return addVec3(a.origin, scaleVec3(a.direction, t));
}

/**
 * 画面距離で1〜2本を選び、吸い付く位置を返す(FR-110)。
 * 2本目が1本目と別の種類で、かつ平行でなければ、その交点を吸着点にする
 * (AutoCADのオブジェクトスナップトラッキングと同じ挙動、§2.4)。
 */
export function chooseTrack(
  candidates: readonly TrackCandidate[],
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number,
  pointOnPlane: Vec3,
): TrackResult | null {
  const first = bestTrackCandidate(candidates, project, pointer, radiusPixels, pointOnPlane, null);
  if (first === null) {
    return null;
  }

  const second = bestTrackCandidate(
    candidates, project, pointer, radiusPixels, pointOnPlane, first.candidate.kind,
  );
  if (second !== null) {
    const intersection = intersectTrackLines(first.candidate, second.candidate);
    if (intersection !== null) {
      return { position: intersection, candidates: [first.candidate, second.candidate] };
    }
  }

  return { position: first.position, candidates: [first.candidate] };
}
