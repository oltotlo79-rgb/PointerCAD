/**
 * 拘束の自動推定(FR-333)の予告と確定を、ui 側で組み立てる純関数
 * (計画書 docs/plans/P6-入出力.md §0.a-0.48〜0.50・§2.15、タスク41)。
 *
 * 判定そのものは model の `inferConstraints`(タスク40)が持つ。ここがやるのは 3 つだけ。
 *   ①`pointermove` のたびに渡す**近くの要素を絞る**(全要素を回さない。NFR-PF-1)。
 *   ②推定の結果を、P4b の拘束の印(`ConstraintMark`)と同じ形へ開く(§0.a-0.50
 *     「P4b の図柄をそのままビューポートへ小さく出す」)。
 *   ③確定したときに `commitAddConstraint` で文書へ足す(FR-313)。
 *
 * **DOM にも three.js にもストアにも触れない。** ワールド → 画面の写し方は
 * `snapMath.ts` と同じく呼び出し側から関数(`ProjectToScreen`)で受ける。
 * 画面の縮尺(1mm が何画素か)も、その関数から測って model へ渡す。
 */

import {
  addVec3,
  arcPointAt,
  inferConstraints,
  inferredConstraintTargets,
  planeToWorld,
  sketchConstraints,
  worldToPlane,
  type InferenceElements,
  type InferredConstraint,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import { commitAddConstraint } from './constraintCommands.js';
import type { ConstraintMark } from './constraintPicking.js';
import { constraintKindSymbol } from './constraintSummary.js';
import type { ProjectToScreen } from './snapMath.js';

/**
 * 推定の相手にする画面上の広さ(画素)。**引いている線の両端から**この距離までにある
 * 要素だけを model へ渡す。
 *
 * 一致の判定は 6 画素(model の `INFER_COINCIDENT_RADIUS_PIXELS`)だが、ここを 6 に
 * すると**平行の相手**(離れたところにある長い線)と**接線の相手**(中心が遠い大きな円)
 * が候補から落ちる。逆に広く取りすぎると `pointermove` のたびに回す数が増える
 * (NFR-PF-1)。120 画素は「画面のおよそ 1/6」で、目で見て『この線と平行だな』と
 * 分かる範囲の目安として採った。
 *
 * **絞りは model の判定を厳しくしない**(ここで落ちた要素は最初から相手にならないだけで、
 * 残った要素の判定は 1 つも変わらない)。
 */
export const INFERENCE_NEARBY_RADIUS_PIXELS = 120;

/** 予告の印の id に付ける接頭辞。実在の拘束の id(`c1` など)と混ざらないようにする。 */
export const INFERRED_MARK_ID_PREFIX = 'inferred:';

/** 画面上の 2 点の距離。 */
function screenDistance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 画面上で、点から線分までの最短距離。線分の外側にいるときは近いほうの端との距離。
 * 平行の相手(長い線)を、線のどこが近くても拾えるようにするために使う。
 */
export function screenDistanceToSegment(
  from: readonly [number, number],
  to: readonly [number, number],
  point: readonly [number, number],
): number {
  const du = to[0] - from[0];
  const dv = to[1] - from[1];
  const lengthSquared = du * du + dv * dv;
  if (lengthSquared === 0) {
    return screenDistance(from, point);
  }
  const raw = ((point[0] - from[0]) * du + (point[1] - from[1]) * dv) / lengthSquared;
  const t = Math.min(1, Math.max(0, raw));
  return screenDistance([from[0] + t * du, from[1] + t * dv], point);
}

/** 引いている線の両端(画面座標)のどれかからの最短距離。 */
function distanceToEnds(
  ends: readonly (readonly [number, number])[],
  at: readonly [number, number],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const end of ends) {
    best = Math.min(best, screenDistance(end, at));
  }
  return best;
}

/**
 * 推定の相手にする要素を、画面上の近さで絞る(NFR-PF-1。§2.15 の `nearby`)。
 *
 * 測り方は種類ごとに変える。**円弧だけは中心ではなく円周までの距離で測る**のが要で、
 * 中心で測ると「中心が画面の外にある大きな円に接線を引く」が拾えなくなる。
 * 画面へ写せない(視野の外・視線と平行)要素は相手にしない。
 */
export function nearbyInferenceElements(
  resolved: ResolvedSketch,
  project: ProjectToScreen,
  ends: readonly (readonly [number, number])[],
  radiusPixels: number = INFERENCE_NEARBY_RADIUS_PIXELS,
): InferenceElements {
  const points = resolved.points.filter((point) => {
    const screen = project(point.position);
    return screen !== null && distanceToEnds(ends, screen) <= radiusPixels;
  });

  const segments = resolved.segments.filter((segment) => {
    const from = project(segment.from);
    const to = project(segment.to);
    if (from === null || to === null) {
      return false;
    }
    return ends.some((end) => screenDistanceToSegment(from, to, end) <= radiusPixels);
  });

  const arcs = resolved.arcs.filter((arc) => {
    const centre = project(arc.center);
    const onCircle = project(arcPointAt(arc, arc.startAngle));
    if (centre === null || onCircle === null) {
      return false;
    }
    // 画面上の半径。円周までの距離は「中心までの距離 − 半径」の絶対値で測る。
    const screenRadius = screenDistance(centre, onCircle);
    return ends.some((end) => {
      const toCentre = screenDistance(centre, end);
      return Math.min(toCentre, Math.abs(toCentre - screenRadius)) <= radiusPixels;
    });
  });

  return { points, segments, arcs };
}

/**
 * その場所での画面の縮尺(1mm が何画素か)。一致の判定を画面上 6 画素で行うために要る。
 *
 * 作図面の 2 つの軸へ 1mm ずつ動かして画面上の伸びを測り、**大きいほうを採る**。
 * 面を真横から見ているときは片方の軸がほとんど潰れるので、小さいほうを採ると
 * 縮尺が 0 に近づき、一致が効かなくなるため。写せなければ 0(model 側は縮尺が
 * 0 / NaN のとき一致だけを止め、向きの推定はそのまま続ける)。
 */
export function pixelsPerMillimetreAt(
  project: ProjectToScreen,
  plane: WorkPlane,
  at: Vec3,
): number {
  const origin = project(at);
  if (origin === null) {
    return 0;
  }
  const alongU = project(addVec3(at, plane.axisU));
  const alongV = project(addVec3(at, plane.axisV));
  const u = alongU === null ? 0 : screenDistance(origin, alongU);
  const v = alongV === null ? 0 : screenDistance(origin, alongV);
  return Math.max(u, v);
}

/**
 * 予告の印 1 組(推定した拘束と、それを描くための印)。
 *
 * `featureId` は**これから作る線の id**(`nextFeatureId(document, 'line')`)。確定の時に
 * 「予告したときと同じ線が作られたか」を照らし合わせるために持つ。ずれていたら足さない。
 */
export interface InferredConstraintPreview {
  readonly featureId: string;
  readonly constraints: readonly InferredConstraint[];
  readonly marks: readonly ConstraintMark[];
}

/**
 * 推定した拘束を、P4b の拘束の印と同じ形へ開く(§0.a-0.50)。
 *
 * 記号は `constraintSummary.ts` の表(`constraintKindSymbol`)をそのまま使う——
 * **予告と確定後で図柄が変わらない**ようにするためで、ここに記号の表の写しを作らない。
 * 状態は `ok` 固定(矛盾する推定はそもそも model が返さない)。ずらしは 0 で、
 * 印は `markerAt`(作図面の座標)をワールドへ戻した場所にそのまま出す。
 */
export function inferredConstraintMarks(
  inferred: readonly InferredConstraint[],
  plane: WorkPlane,
): readonly ConstraintMark[] {
  return inferred.map((constraint, index) => ({
    constraintId: `${INFERRED_MARK_ID_PREFIX}${String(index)}`,
    symbol: constraintKindSymbol(constraint.kind),
    state: 'ok',
    position: planeToWorld(plane, constraint.markerAt[0], constraint.markerAt[1]),
    offset: [0, 0],
  }));
}

/** `inferredConstraintPreview` に渡す材料。画面に触れるものは関数で受ける。 */
export interface InferencePreviewInput {
  /** いま解けているスケッチ(近くの要素を絞る元)。 */
  readonly resolved: ResolvedSketch;
  /** 既にある拘束を見るための文書。同じ拘束は 2 つ推定しない。 */
  readonly document: SketchDocument;
  /** 引いている作図面。 */
  readonly plane: WorkPlane;
  /** これから作る線の id(`nextFeatureId(document, 'line')`)。 */
  readonly draftFeatureId: string;
  /** 引いている線の始点(ワールド座標)。 */
  readonly fromWorld: Vec3;
  /** いまポインタが指している終点(ワールド座標)。 */
  readonly toWorld: Vec3;
  readonly project: ProjectToScreen;
  /** 自動推定の入切(§0.a-0.49、既定は入)。 */
  readonly enabled: boolean;
  /** Shift を押している間の一時停止(§0.a-0.50)。 */
  readonly suspended: boolean;
}

/**
 * 線を引いている最中の予告を 1 回ぶん組み立てる(`pointermove` ごとに 1 回)。
 * 1 つも推定できなければ null(印を消す)。**例外を投げない。**
 *
 * 切ってあるとき・Shift を押している間は、絞り込みも縮尺の計算もせずに即座に null を返す
 * (止めているのに毎コマ計算するのは無駄だから。判定そのものは model 側にもある)。
 */
export function inferredConstraintPreview(
  input: InferencePreviewInput,
): InferredConstraintPreview | null {
  if (!input.enabled || input.suspended) {
    return null;
  }
  const fromScreen = input.project(input.fromWorld);
  const toScreen = input.project(input.toWorld);
  const ends: (readonly [number, number])[] = [];
  if (fromScreen !== null) {
    ends.push(fromScreen);
  }
  if (toScreen !== null) {
    ends.push(toScreen);
  }
  if (ends.length === 0) {
    // 引いている線が画面へ写せない(視線と平行な面など)。相手を絞れないので推定しない。
    return null;
  }
  const nearby = nearbyInferenceElements(input.resolved, input.project, ends);
  const constraints = inferConstraints(
    {
      featureId: input.draftFeatureId,
      from: worldToPlane(input.plane, input.fromWorld),
      to: worldToPlane(input.plane, input.toWorld),
    },
    nearby,
    {
      plane: input.plane,
      pixelsPerMillimetre: pixelsPerMillimetreAt(input.project, input.plane, input.toWorld),
      constraints: sketchConstraints(input.document),
      enabled: input.enabled,
      suspended: input.suspended,
    },
  );
  if (constraints.length === 0) {
    return null;
  }
  return {
    featureId: input.draftFeatureId,
    constraints,
    marks: inferredConstraintMarks(constraints, input.plane),
  };
}

/**
 * 前の予告と同じ内容か。同じならストアへ書き直さない(NFR-PF-1。`snapIndicator` の
 * `sameIndicator` と同じ流儀で、変わっていない予告で 3D の並びを組み立て直さない)。
 */
export function sameInferredPreview(
  a: InferredConstraintPreview | null,
  b: InferredConstraintPreview | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.featureId !== b.featureId || a.constraints.length !== b.constraints.length) {
    return false;
  }
  return a.constraints.every((one, index) => {
    const other = b.constraints[index];
    return (
      one.kind === other.kind &&
      one.relatedId === other.relatedId &&
      one.markerAt[0] === other.markerAt[0] &&
      one.markerAt[1] === other.markerAt[1]
    );
  });
}

/** `applyInferredConstraints` の結果。足せた拘束の id を返す(検査で数えるため)。 */
export interface InferredCommitResult {
  readonly document: SketchDocument;
  readonly constraintIds: readonly string[];
}

/**
 * 推定した拘束を文書へ足す(FR-313、FR-333。線を引き終えた瞬間、§0.a-0.50)。
 *
 * **断られたものは黙って飛ばす。** 推定はあくまで手助けなので、足せない 1 件のために
 * 線を引く操作そのものを止めない(NFR-UX-5 の「断って理由を出す」は、利用者が自分で
 * 押した操作に対する約束であって、ここは押していない)。飛ぶのは、
 * 3D スケッチ(拘束を持てない)・相手が全部固定・同じ拘束が既にある場合。
 *
 * 文書の差し替えは呼び出し側で 1 回だけ行うので、**線 1 本と拘束はまとめて 1 回の
 * 取り消し(Ctrl+Z)で戻る**(NFR-UX-3)。
 */
export function applyInferredConstraints(
  document: SketchDocument,
  inferred: readonly InferredConstraint[],
): InferredCommitResult {
  let next = document;
  const constraintIds: string[] = [];
  for (const constraint of inferred) {
    /*
      文脈(変数表)は渡さず、`commitAddConstraint` の既定に任せて**1 件ごとに作り直す。**
      拘束を 1 つ足すと動かせる点が変わるので、最初の 1 件の文脈を使い回すと
      「もう全部固定されている」の判定(`hasMovableVariable`)を取り違える。
    */
    const outcome = commitAddConstraint(
      next,
      constraint.kind,
      inferredConstraintTargets(constraint),
    );
    if (!outcome.ok) {
      continue;
    }
    next = outcome.document;
    constraintIds.push(...outcome.constraintIds);
  }
  return { document: next, constraintIds };
}
