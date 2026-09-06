/**
 * 拘束の自動推定(FR-333、FR-313。計画書 docs/plans/P6-入出力.md §0.a-0.48〜0.50・§2.15、タスク40)。
 *
 * 線を引いている最中に「水平・垂直・一致・接線・平行」を推定して、印で予告するための
 * 材料を作る。**ここは純関数だけを置く**(乱数・時刻・DOM・three.js に触れない)。画面の
 * 縮尺は引数で受け取るので、同じ入力からは必ず同じ推定になる。
 *
 * **推定するのは 5 種だけ**(§0.a-0.48)。同心・等しい・対称・直角は誤爆が多いので推定しない。
 *
 * **判定のしきい値は下の 2 つの定数だけ**(§0.a-0.48。ここ 1 か所に置き、ヘルプには数値を
 * 書かない)。角度は 3°、一致は画面上 6 画素。3° の根拠は「100 画素の線の端が 5 画素ずれると
 * 2.86°」で、**「まっすぐ引いたつもり」が水平と読まれる幅**として採った値である。
 *
 * **優先順位は 一致 > 接線 > 水平・垂直 > 平行**で、**同時に出すのは最大 2 つ**(§2.15。
 * 印が増えすぎると読めない)。
 *
 * **推定した拘束は、そのまま足しても P4b のソルバーが解ける形にする**(FR-313、FR-504)。
 * そのために次の 3 つを守っている。
 *   ①一致の相手へ端点を寄せた後の向きで、水平・垂直・平行・接線を判定する
 *     (寄せた後に 3° を外れる線へ水平を付けて、矛盾を作らないため)。
 *   ②既に水平(垂直)拘束を持つ相手との平行は、こちらにも同じ軸を推定したときは出さない
 *     (同じことを 2 通りで言う「足しすぎ」を作らない)。
 *   ③既存の拘束と同じものは出さない(同じ拘束を 2 つ付けない)。
 *
 * 入切(§0.a-0.49、既定は入)と Shift による一時停止(§0.a-0.50)もここで受ける。
 * 予告の印そのものを描くのと、確定して拘束を足す配線は ui の役目(タスク41)。
 */

import type { ConstraintTarget, SketchConstraint } from './constraints/types.js';
import { constraintTargets } from './constraints/types.js';
import { arcPointAt } from './intersectionMath.js';
import { degreesToRadians, distanceToPlane, worldToPlane, type WorkPlane } from './planeMath.js';
import { vertexKey } from './resolveCoordinate.js';
import type { ResolvedArc, ResolvedPoint, ResolvedSegment } from './types.js';
import { dotVec3, SKETCH_TOLERANCE_MM, type Vec3 } from './vec3.js';

/**
 * 水平・垂直・平行・接線とみなす角度の幅(度、§0.a-0.48)。**しきい値の定数はここだけ。**
 * ちょうどこの角度は推定する(`≤` で判定する。§2.15 の検証表)。
 */
export const INFER_ANGLE_TOLERANCE_DEGREES = 3;

/**
 * 一致とみなす**画面上の**距離(画素、§0.a-0.48)。**しきい値の定数はここだけ。**
 *
 * ワールド座標(mm)ではなく画面の画素で測るのは、mm で測ると遠くの要素にも近くと同じ
 * 距離で吸い付いてしまうため(ui の `snapMath.ts` と同じ理由)。値は ui の
 * `PICK_RADIUS_PIXELS`(= 6)と同じで、依存方向(ui → model)の都合で ui から
 * 借りられないので**こちらを正本にする**。ui はタスク41 でこの定数を読む。
 */
export const INFER_COINCIDENT_RADIUS_PIXELS = 6;

/** 同時に予告する上限(§2.15)。印が増えすぎると読めないため。 */
export const MAX_INFERRED_CONSTRAINTS = 2;

/**
 * 角度の判定に使う `tan(3°)`(= 0.05240777928304121)。
 *
 * 角度そのもの(`Math.atan2` → 度)ではなく正接で比べるのは、**ちょうど 3° の向きを
 * 度へ直すと最後の 1 桁が 3 をわずかに超えることがある**ためで、「ちょうど 3° は推定する」
 * (§2.15 の検証表)が丸めで揺れないようにする。
 */
const ANGLE_TOLERANCE_TANGENT = Math.tan(degreesToRadians(INFER_ANGLE_TOLERANCE_DEGREES));

/** 推定する拘束の種類(§0.a-0.48 の 5 種)。 */
export type InferredConstraintKind =
  | 'coincident'
  | 'tangent'
  | 'horizontal'
  | 'vertical'
  | 'parallel';

/**
 * 予告の並び順(§2.15)。**一致 > 接線 > 水平・垂直 > 平行。**
 * 上限を超えたぶんはこの順で落とす。
 */
export const INFERENCE_PRIORITY: readonly InferredConstraintKind[] = [
  'coincident',
  'tangent',
  'horizontal',
  'vertical',
  'parallel',
];

/** 作図面の上の座標(u, v。単位は mm)。 */
export type PlanePoint = readonly [number, number];

/**
 * 描いている線分。**まだ文書には無い**ので、確定したときに付く id を先に受け取る
 * (推定した拘束がその id で描いている線を指せるようにするため)。
 * 始点・終点は**作図面の座標**(u, v)で渡す(画面座標でもワールド座標でもない)。
 */
export interface DraftSegment {
  readonly featureId: string;
  readonly from: PlanePoint;
  readonly to: PlanePoint;
}

/**
 * 推定の相手にできる既存の要素(解決済み)。**近くのものだけを詰めて渡す**
 * (`pointermove` のたびに全要素を回さない。NFR-PF-1。絞るのは ui の役目、タスク41)。
 *
 * `ResolvedSketch` の同名の欄をそのまま渡せる形にしてある。
 * 楕円・スプラインは相手にしない(接線・平行の式を P4b が持たないため)。
 */
export interface InferenceElements {
  readonly points?: readonly ResolvedPoint[];
  readonly segments?: readonly ResolvedSegment[];
  readonly arcs?: readonly ResolvedArc[];
}

export interface InferConstraintsOptions {
  /** 描いている作図面。既存の要素はこの面の上にあるものだけを相手にする。 */
  readonly plane: WorkPlane;
  /** 画面の縮尺(1mm が何画素か)。一致の判定を画面上 6 画素で行うために要る。 */
  readonly pixelsPerMillimetre: number;
  /** 文書に既にある拘束。同じものは推定しない。省けば「1 つも無い」として読む。 */
  readonly constraints?: readonly SketchConstraint[];
  /** 自動推定の入切(§0.a-0.49)。**既定は入。** 切れば 1 つも推定しない。 */
  readonly enabled?: boolean;
  /** Shift を押している間の一時停止(§0.a-0.50)。true なら 1 つも推定しない。 */
  readonly suspended?: boolean;
}

interface InferredBase {
  /**
   * 相手の要素の id。一致は相手の点の鍵(`ResolvedPoint.id` または `featureId:start` の形)、
   * 接線は円弧の、平行は線分のフィーチャー id。**水平・垂直は相手がいないので null。**
   */
  readonly relatedId: string | null;
  /** 予告の印を出す位置(作図面の座標)。§0.a-0.50 の「相手の近くに小さな印」。 */
  readonly markerAt: PlanePoint;
}

/**
 * 推定した拘束 1 つ。欄の並びは P4b の `SketchConstraint` と同じにしてあるので、
 * `constraintFromInference` で id と名前を付ければそのまま文書へ足せる。
 */
export type InferredConstraint =
  | (InferredBase & {
      readonly kind: 'coincident';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
    })
  | (InferredBase & {
      readonly kind: 'horizontal' | 'vertical';
      readonly target: ConstraintTarget;
    })
  | (InferredBase & {
      readonly kind: 'parallel';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
    })
  | (InferredBase & {
      readonly kind: 'tangent';
      readonly line: ConstraintTarget;
      readonly circle: ConstraintTarget;
    });

/**
 * 推定した拘束が指す先を並べる(`constraints/types.ts` の `constraintTargets` と同じ流儀)。
 * ui の `commitAddConstraint` はこの並びのまま受け取れる(タスク41)。
 */
export function inferredConstraintTargets(
  inferred: InferredConstraint,
): readonly ConstraintTarget[] {
  switch (inferred.kind) {
    case 'horizontal':
    case 'vertical':
      return [inferred.target];
    case 'tangent':
      return [inferred.line, inferred.circle];
    case 'coincident':
    case 'parallel':
      return [inferred.a, inferred.b];
  }
}

/** 推定した拘束に id と名前を付けて、文書へ足せる形にする(FR-313)。 */
export function constraintFromInference(
  inferred: InferredConstraint,
  id: string,
  name: string,
): SketchConstraint {
  switch (inferred.kind) {
    case 'coincident':
      return { id, name, kind: 'coincident', a: inferred.a, b: inferred.b };
    case 'horizontal':
    case 'vertical':
      return { id, name, kind: inferred.kind, target: inferred.target };
    case 'parallel':
      return { id, name, kind: 'parallel', a: inferred.a, b: inferred.b };
    case 'tangent':
      return { id, name, kind: 'tangent', line: inferred.line, circle: inferred.circle };
  }
}

/** 曲線そのものを指す先。 */
function curveTarget(featureId: string): ConstraintTarget {
  return { kind: 'curve', element: { featureId } };
}

/**
 * 2 つの向きの角度差が 3° 以内か。**向きの正負は問わない**(0° と 180° を同じに扱う)。
 * `|外積| ≤ |内積| × tan(3°)` は `|tan(なす角)| ≤ tan(3°)` と同じことで、90° 近くでは
 * 内積が 0 に近づくので自然に外れる。単位ベクトルへ直さずに比べるのは、正規化の割り算で
 * 境界(ちょうど 3°)の判定が丸めで揺れるのを避けるため。
 */
function withinAngle(au: number, av: number, bu: number, bv: number): boolean {
  const cross = Math.abs(au * bv - av * bu);
  const dot = Math.abs(au * bu + av * bv);
  return cross <= dot * ANGLE_TOLERANCE_TANGENT;
}

/** 同じ判定だが、**向きの正負も合っている**ことを求める(接線の側を決めるのに使う)。 */
function withinOrientedAngle(au: number, av: number, bu: number, bv: number): boolean {
  const dot = au * bu + av * bv;
  return dot > 0 && Math.abs(au * bv - av * bu) <= dot * ANGLE_TOLERANCE_TANGENT;
}

/** その点が作図面の上にあるか。別の面の要素を渡されても推定しないため。 */
function onPlane(plane: WorkPlane, world: Vec3): boolean {
  return distanceToPlane(plane, world) <= SKETCH_TOLERANCE_MM;
}

/** 一致の相手になれる点 1 つ。 */
interface CoincidenceCandidate {
  readonly id: string;
  readonly at: PlanePoint;
  readonly target: ConstraintTarget;
}

/** 一致の相手を集める(既存の点と、線分・円弧の端点。§2.15)。 */
function coincidenceCandidates(
  nearby: InferenceElements,
  plane: WorkPlane,
  draftFeatureId: string,
): CoincidenceCandidate[] {
  const candidates: CoincidenceCandidate[] = [];
  const add = (id: string, world: Vec3, target: ConstraintTarget): void => {
    if (onPlane(plane, world)) {
      candidates.push({ id, at: worldToPlane(plane, world), target });
    }
  };
  for (const point of nearby.points ?? []) {
    if (point.featureId === draftFeatureId) {
      continue;
    }
    add(point.id, point.position, { kind: 'point', pointId: point.id });
  }
  for (const segment of nearby.segments ?? []) {
    if (segment.featureId === draftFeatureId) {
      continue;
    }
    add(vertexKey(segment.featureId, 'start'), segment.from, {
      kind: 'vertex',
      featureId: segment.featureId,
      vertex: 'start',
    });
    add(vertexKey(segment.featureId, 'end'), segment.to, {
      kind: 'vertex',
      featureId: segment.featureId,
      vertex: 'end',
    });
  }
  for (const arc of nearby.arcs ?? []) {
    if (arc.featureId === draftFeatureId) {
      continue;
    }
    add(vertexKey(arc.featureId, 'start'), arcPointAt(arc, arc.startAngle), {
      kind: 'vertex',
      featureId: arc.featureId,
      vertex: 'start',
    });
    add(vertexKey(arc.featureId, 'end'), arcPointAt(arc, arc.endAngle), {
      kind: 'vertex',
      featureId: arc.featureId,
      vertex: 'end',
    });
  }
  return candidates;
}

/** その端点にいちばん近い相手。しきい値(mm)を超えていれば null。同点は先に見つけたほうを採る。 */
function nearestCandidate(
  candidates: readonly CoincidenceCandidate[],
  at: PlanePoint,
  toleranceMm: number,
): CoincidenceCandidate | null {
  let best: CoincidenceCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.at[0] - at[0], candidate.at[1] - at[1]);
    if (distance > toleranceMm || distance >= bestDistance) {
      continue;
    }
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

/** 作図面の上に置き直した円弧(中心と半径)。面から外れている円弧は相手にしない。 */
interface PlaneArc {
  readonly featureId: string;
  readonly center: PlanePoint;
  readonly radius: number;
}

function planeArcOf(arc: ResolvedArc, plane: WorkPlane, draftFeatureId: string): PlaneArc | null {
  if (arc.featureId === draftFeatureId || arc.radius <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  // 円弧の面が作図面と同じ向きでなければ、作図面へ落とすと円でなくなる(楕円に見える)。
  const tilt = 1 - Math.abs(dotVec3(arc.normal, plane.normal));
  if (!onPlane(plane, arc.center) || tilt > SKETCH_TOLERANCE_MM) {
    return null;
  }
  return { featureId: arc.featureId, center: worldToPlane(plane, arc.center), radius: arc.radius };
}

/** 作図面の上に置き直した線分。 */
interface PlaneSegment {
  readonly featureId: string;
  readonly from: PlanePoint;
  readonly to: PlanePoint;
}

function planeSegmentOf(
  segment: ResolvedSegment,
  plane: WorkPlane,
  draftFeatureId: string,
): PlaneSegment | null {
  if (segment.featureId === draftFeatureId) {
    return null;
  }
  if (!onPlane(plane, segment.from) || !onPlane(plane, segment.to)) {
    return null;
  }
  const from = worldToPlane(plane, segment.from);
  const to = worldToPlane(plane, segment.to);
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  return { featureId: segment.featureId, from, to };
}

/** 2 つの指し先が同じものを指しているか。 */
function sameTarget(a: ConstraintTarget, b: ConstraintTarget): boolean {
  switch (a.kind) {
    case 'point':
      return b.kind === 'point' && a.pointId === b.pointId;
    case 'vertex':
      return b.kind === 'vertex' && a.featureId === b.featureId && a.vertex === b.vertex;
    case 'curve':
      return (
        b.kind === 'curve' &&
        a.element.featureId === b.element.featureId &&
        a.element.index === b.element.index
      );
  }
}

/** 指し先の集まりが同じか。**並び順は問わない**(一致・平行は左右を入れ替えても同じ拘束)。 */
function sameTargetSet(a: readonly ConstraintTarget[], b: readonly ConstraintTarget[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const used = new Set<number>();
  for (const one of a) {
    const index = b.findIndex((other, at) => !used.has(at) && sameTarget(one, other));
    if (index < 0) {
      return false;
    }
    used.add(index);
  }
  return true;
}

/** その要素に既に水平(垂直)拘束が付いているか。平行の足しすぎを避けるのに使う。 */
function hasAxisConstraint(
  constraints: readonly SketchConstraint[],
  featureId: string,
  kind: 'horizontal' | 'vertical',
): boolean {
  const target = curveTarget(featureId);
  return constraints.some(
    (constraint) => constraint.kind === kind && sameTarget(constraint.target, target),
  );
}

/**
 * 平行の相手を 1 本だけ選ぶ(平行の印を何本も出さない)。角度差がいちばん小さいものを採り、
 * 同点なら先に渡されたほうを採る(同じ入力から同じ答えになるように)。
 * `skip` は「足しすぎになるので相手にしない」判定(呼ぶ側が軸の拘束を見る)。
 */
function parallelPartner(
  nearby: InferenceElements,
  plane: WorkPlane,
  draftFeatureId: string,
  direction: readonly [number, number],
  skip: (featureId: string) => boolean,
): PlaneSegment | null {
  const [du, dv] = direction;
  const length = Math.hypot(du, dv);
  let best: PlaneSegment | null = null;
  let bestCross = Number.POSITIVE_INFINITY;
  for (const segment of nearby.segments ?? []) {
    const line = planeSegmentOf(segment, plane, draftFeatureId);
    if (line === null || skip(line.featureId)) {
      continue;
    }
    const ou = line.to[0] - line.from[0];
    const ov = line.to[1] - line.from[1];
    if (!withinAngle(du, dv, ou, ov)) {
      continue;
    }
    // 角度差の代わりに、長さで正規化した外積(= |sin(なす角)|)の小ささで選ぶ。
    const cross = Math.abs(du * ov - dv * ou) / (length * Math.hypot(ou, ov));
    if (cross < bestCross) {
      best = line;
      bestCross = cross;
    }
  }
  return best;
}

/** 既に同じ拘束が文書にあるか(同じ拘束を 2 つ付けない。§2.15 の検証表)。 */
function alreadyConstrained(
  inferred: InferredConstraint,
  constraints: readonly SketchConstraint[],
): boolean {
  const targets = inferredConstraintTargets(inferred);
  return constraints.some(
    (constraint) =>
      constraint.kind === inferred.kind &&
      sameTargetSet(targets, constraintTargets(constraint)),
  );
}

/**
 * 描いている線から拘束を推定する(FR-333)。**例外を投げない。**
 *
 * 返るのは優先順位の高い順に最大 2 つ(§2.15)。1 つも当てはまらなければ空。
 */
export function inferConstraints(
  draft: DraftSegment,
  nearby: InferenceElements,
  options: InferConstraintsOptions,
): readonly InferredConstraint[] {
  // 入切(§0.a-0.49)と Shift の一時停止(§0.a-0.50)。どちらも「1 つも推定しない」。
  if (options.enabled === false || options.suspended === true) {
    return [];
  }
  const { plane } = options;
  const constraints = options.constraints ?? [];
  const draftCurve = curveTarget(draft.featureId);

  /*
    ①一致。始点・終点それぞれについて、いちばん近い相手を 1 つだけ採る。
    画面上 6 画素を mm へ直すのに縮尺が要るので、縮尺が使えないときは一致を推定しない
    (向きだけの推定は縮尺に依らないので、そちらはそのまま続ける)。
  */
  const scale = options.pixelsPerMillimetre;
  const scaleUsable = Number.isFinite(scale) && scale > 0;
  const toleranceMm = scaleUsable ? INFER_COINCIDENT_RADIUS_PIXELS / scale : 0;
  const candidates = scaleUsable ? coincidenceCandidates(nearby, plane, draft.featureId) : [];
  const ends: readonly { readonly vertex: 'start' | 'end'; readonly at: PlanePoint }[] = [
    { vertex: 'start', at: draft.from },
    { vertex: 'end', at: draft.to },
  ];
  const found: InferredConstraint[] = [];
  /*
    一致の相手へ寄せた後の端点。**向きの推定はこちらで行う。** 引いた線の向きが 3° 以内でも、
    一致で端点が動いた後に 3° を外れるなら、その水平・平行はソルバーの中で矛盾になるため
    (推定した拘束が矛盾を作らないこと。タスク40 の「関係する過去の失敗」)。
  */
  const snapped: [PlanePoint, PlanePoint] = [draft.from, draft.to];
  for (const end of ends) {
    const nearest = nearestCandidate(candidates, end.at, toleranceMm);
    if (nearest === null) {
      continue;
    }
    snapped[end.vertex === 'start' ? 0 : 1] = nearest.at;
    found.push({
      kind: 'coincident',
      a: { kind: 'vertex', featureId: draft.featureId, vertex: end.vertex },
      b: nearest.target,
      relatedId: nearest.id,
      markerAt: nearest.at,
    });
  }

  const du = snapped[1][0] - snapped[0][0];
  const dv = snapped[1][1] - snapped[0][1];
  const length = Math.hypot(du, dv);
  if (length > SKETCH_TOLERANCE_MM) {
    /*
      ②接線。端点が円周の上にあり(一致と同じ幅で測る)、線の向きがその点の接線と 3° 以内。

      **向きの正負まで見る**のは、P4b の接線の残差(`constraints/residuals.ts` の
      `tangentOutcome`)が符号つきの距離で、**円の中心が線の進む向きの右側にある**ことを
      求めるためである。逆側で推定すると、拘束を足した瞬間に線が円の反対側へ飛ぶ。
      求める接線の向きは、中心から接点への向き n を −90° 回した (n_v, −n_u)。
    */
    for (const arc of nearby.arcs ?? []) {
      const circle = planeArcOf(arc, plane, draft.featureId);
      if (circle === null) {
        continue;
      }
      let touched = false;
      for (const at of snapped) {
        const nu = at[0] - circle.center[0];
        const nv = at[1] - circle.center[1];
        const distance = Math.hypot(nu, nv);
        if (Math.abs(distance - circle.radius) > toleranceMm || distance <= SKETCH_TOLERANCE_MM) {
          continue;
        }
        if (withinOrientedAngle(du, dv, nv / distance, -nu / distance)) {
          touched = true;
          found.push({
            kind: 'tangent',
            line: draftCurve,
            circle: curveTarget(circle.featureId),
            relatedId: circle.featureId,
            markerAt: at,
          });
          break;
        }
      }
      if (touched) {
        break;
      }
    }

    /*
      ③水平・垂直。**同時には成り立たない**(3° の幅では 0° と 90° の両方に入る向きが無い)ので、
      水平を先に見て、外れたときだけ垂直を見る。
    */
    const axis: 'horizontal' | 'vertical' | null = withinAngle(du, dv, 1, 0)
      ? 'horizontal'
      : withinAngle(du, dv, 0, 1)
        ? 'vertical'
        : null;
    if (axis !== null) {
      found.push({
        kind: axis,
        target: draftCurve,
        relatedId: null,
        markerAt: [(snapped[0][0] + snapped[1][0]) / 2, (snapped[0][1] + snapped[1][1]) / 2],
      });
    }

    /*
      ④平行。相手は角度差がいちばん小さい 1 本だけにする(平行の印を何本も出さない)。

      **相手が既に水平(垂直)拘束を持っていて、こちらにも同じ軸を推定したときは出さない。**
      その組み合わせは「軸に沿う」ことを 2 通りで言うだけになり、足しすぎ
      (`diagnose.ts` の redundant)を作るため。相手に軸の拘束が無ければ、平行は
      別のことを言っている(相手の向きにも効く)ので、水平と一緒に出してよい(§2.15 の表)。
    */
    const partner = parallelPartner(nearby, plane, draft.featureId, [du, dv], (featureId) =>
      axis !== null && hasAxisConstraint(constraints, featureId, axis),
    );
    if (partner !== null) {
      found.push({
        kind: 'parallel',
        a: draftCurve,
        b: curveTarget(partner.featureId),
        relatedId: partner.featureId,
        markerAt: [
          (partner.from[0] + partner.to[0]) / 2,
          (partner.from[1] + partner.to[1]) / 2,
        ],
      });
    }
  }

  // 既にある拘束と同じものは落とし、優先順位で並べ直して上限まで採る(§2.15)。
  return found
    .filter((inferred) => !alreadyConstrained(inferred, constraints))
    .sort((a, b) => INFERENCE_PRIORITY.indexOf(a.kind) - INFERENCE_PRIORITY.indexOf(b.kind))
    .slice(0, MAX_INFERRED_CONSTRAINTS);
}
