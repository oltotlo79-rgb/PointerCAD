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
 * ポインタの光線(カメラの視点からポインタの画素を通る半直線)。ワールド座標系の
 * origin/direction(単位ベクトル)を持つ。ビューポート側(`createViewportScene.ts` の
 * `pointerRay`)が three.js の `Raycaster.ray` からそのまま作って渡す(P4b 仕上げ (a))。
 */
export interface PointerRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/**
 * 直線 L: line.origin + t・line.direction の上で、光線 ray に最も近い点のパラメータ t
 * (P4b 仕上げ (a)、§2.4)。
 *
 * 【なぜ】タスク15の `positionAlongCandidate` は「候補の直線上で、作図面上のポインタ点に
 * ワールド座標で最も近い点」(直線への垂直射影)を採っていたが、視点が斜めだと、この
 * ワールドの最近点と画面上での最近点がずれ、案内線の印がポインタから遠くに決まってしまう
 * (実測、`docs/報告記録.md` 2026-09-05 00:10 の t16 の懸念)。**候補の直線上の点は
 * 「ポインタの光線に最も近い点」で決めれば、この食い違いが起きない**(下記の導出)。
 *
 * 【導出】d = line.direction、v = ray.direction とし、
 *   a = d・d、b = d・v、c = v・v、
 *   e = d・(ray.origin − line.origin)、f = v・(ray.origin − line.origin)
 * とおくと、L 上の点 P(t) と光線上の点 Q(s) の距離の 2 乗を t, s それぞれで偏微分して
 * 0 と置くと連立 1 次方程式 a・t − b・s = e、b・t − c・s = f になり、これを t について解くと
 *   t = (c・e − b・f) / (a・c − b・b)
 * になる(2 直線の最近点の標準の閉じた式)。
 *
 * 分母 a・c − b・b は、d・v が単位ベクトルどうしの内積のときは 1 − (d・v)²(= |d×v|²、
 * ラグランジュの恒等式)に等しく、**L と光線がちょうど平行(視線と案内線の向きが一致する、
 * めったに起きない退化)のときだけ 0 になる。** そのときは t が一意に決まらないので null を
 * 返し、呼び出し側(`positionAlongCandidate`)が従来の方法(ポインタを作図面へ落とした点への
 * 垂直射影)へ後退する。
 *
 * 【なぜ画面座標の最近点と一致するか】平行投影では、画面座標は光線の向き(視線方向、
 * どの画素でも同じ)に沿った成分を無視してワールド座標を写す写像なので、L 上の点と光線との
 * 距離は、その点を画面へ写した位置とポインタの画面距離**そのもの**になる。したがってこの t
 * で決めた点は、画面上でポインタに最も近い点と厳密に一致する(`trackMath.test.ts` の
 * 「斜めの視点」の節で、この一致をブルートフォースの数値探索と突き合わせて検証している)。
 * 透視投影では画角の全域で厳密には一致しないが、案内線が効く近傍(判定半径12画素)では
 * 画角による歪みは無視できるほど小さく、近似として使う。
 */
export function closestParameterToRay(
  line: { readonly origin: Vec3; readonly direction: Vec3 },
  ray: PointerRay,
): number | null {
  const a = dotVec3(line.direction, line.direction);
  const b = dotVec3(line.direction, ray.direction);
  const c = dotVec3(ray.direction, ray.direction);
  const denominator = a * c - b * b;
  if (Math.abs(denominator) <= PARALLEL_DOT_EPSILON) {
    // 案内線が視線とほぼ平行(退化)。呼び出し側が従来の方法へ後退する。
    return null;
  }
  const originDelta = subVec3(ray.origin, line.origin);
  const e = dotVec3(line.direction, originDelta);
  const f = dotVec3(ray.direction, originDelta);
  return (c * e - b * f) / denominator;
}

/**
 * 候補の直線の上で、吸い付く点を決める(§2.4、P4b 仕上げ (a))。
 *
 * 極(polar)だけは例外。極は「起点からの距離を保ったまま角度だけ丸める」という
 * 利用者の意図(AutoCADの極トラッキングと同じ挙動)に合わせるため、直線への垂直な
 * 射影ではなく、**起点からポインタまでの距離をそのまま向きへ載せる**(検証表の
 * 「極: 20∠17°→20∠15°」がこの式でないと一致しない。垂直射影だと 20·cos2° まで縮む)。
 * この式は画面上の最近点とは無関係な意図的な挙動なので、光線が渡っても変えない。
 *
 * 延長線・垂線・平行線は、**光線 ray が渡っていれば** `closestParameterToRay` で
 * 「ポインタの光線に最も近い点」を採る(P4b 仕上げ (a) の直し方)。光線が無い
 * (呼び出し側が渡していない、既存の呼び出し方との後方互換)か、案内線が視線と
 * 平行で t が求まらないときだけ、従来の「作図面上のポインタ点への垂直射影」へ後退する。
 */
function positionAlongCandidate(
  candidate: TrackCandidate,
  pointOnPlane: Vec3,
  ray: PointerRay | null,
): Vec3 {
  if (candidate.kind === 'polar') {
    const distance = distanceVec3(candidate.origin, pointOnPlane);
    return addVec3(candidate.origin, scaleVec3(candidate.direction, distance));
  }
  if (ray !== null) {
    const rayParameter = closestParameterToRay(candidate, ray);
    if (rayParameter !== null) {
      return addVec3(candidate.origin, scaleVec3(candidate.direction, rayParameter));
    }
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
  ray: PointerRay | null,
): ScoredTrackCandidate | null {
  let best: ScoredTrackCandidate | null = null;
  let bestPriority = TRACK_PRIORITY.length;

  for (const candidate of candidates) {
    if (excludeKind !== null && candidate.kind === excludeKind) {
      continue;
    }
    const position = positionAlongCandidate(candidate, pointOnPlane, ray);
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
 *
 * **交点も判定半径の中にあるときだけ採る**(P4b タスク22b の (e)、t16 の懸念)。
 * 1 本ずつの候補は「ポインタに最も近い点」で決まるので必ず判定半径の中に入るが、
 * **2 本の交点はその限りではない**。ほぼ平行な 2 本(例: 330° の極と延長線)の交点は
 * 遠くに決まり、実測でポインタから最大 51.57px 離れた(`docs/報告記録.md` 2026-09-05
 * 実時計 01:10)。そのまま採ると「案内線には合っているのに、点は指から遠い所へ飛ぶ」
 * ことになるので、交点が判定半径の外なら**近い方の 1 本へ落とす**(NFR-UX-5)。
 *
 * `ray`(ポインタの光線、P4b 仕上げ (a))は**省略可**にしてある。既存の呼び出し(t15・t16)は
 * 渡さないので、そのときは従来どおり `pointOnPlane` への垂直射影で候補の位置を決める
 * (`positionAlongCandidate` を参照)。呼び出し側(`attachSketchInteraction.ts`)が
 * `scene.pointerRay` で作った光線を渡すと、画面上でポインタに最も近い点で決まる。
 */
export function chooseTrack(
  candidates: readonly TrackCandidate[],
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number,
  pointOnPlane: Vec3,
  ray: PointerRay | null = null,
): TrackResult | null {
  const first = bestTrackCandidate(
    candidates, project, pointer, radiusPixels, pointOnPlane, null, ray,
  );
  if (first === null) {
    return null;
  }

  const second = bestTrackCandidate(
    candidates, project, pointer, radiusPixels, pointOnPlane, first.candidate.kind, ray,
  );
  if (second !== null) {
    const intersection = intersectTrackLines(first.candidate, second.candidate);
    if (intersection !== null && withinRadius(intersection, project, pointer, radiusPixels)) {
      return { position: intersection, candidates: [first.candidate, second.candidate] };
    }
  }

  return { position: first.position, candidates: [first.candidate] };
}

/**
 * その点が、画面上でポインタから判定半径の中にあるか(上の注釈のとおり)。
 * 画面へ写せない(視野の外・背後)ときは採らない。
 */
function withinRadius(
  position: Vec3,
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number,
): boolean {
  const screen = project(position);
  if (screen === null) {
    return false;
  }
  return Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]) <= radiusPixels;
}
