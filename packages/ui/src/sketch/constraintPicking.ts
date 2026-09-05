/**
 * 拘束の道具で「押した場所が何を指すか」を決める純関数
 * (FR-313、NFR-UX-1、NFR-UX-7、計画書 docs/plans/P4b-スケッチの仕上げ.md タスク13)。
 *
 * 拘束の道具は**トリム・延長と同じ流儀**(道具を選んでから要素を順に押す。統括の決定
 * 2026-09-05)なので、押した場所を `ConstraintTarget`(model、タスク4)へ直す仕事が要る。
 * `pickMath.ts` の当たり判定は点フィーチャー・曲線・面しか返さず、**線分の端点や円弧の
 * 中心を個別に拾えない**。一致・距離・対称は端点を指せないと使いものにならないので、
 * ここで**拘束の道具が活きているときだけ**の端点の当たり判定(12 画素)を足す。
 *
 * 判定は `snapMath.ts` / `pickMath.ts` と同じく**画面座標**で行い、ワールド → 画面の
 * 写し方は呼び出し側から関数で受ける。DOM にも three.js にもストアにも触れない。
 */

import {
  curveEnd,
  curveStart,
  type ConstraintTarget,
  type ResolvedSketch,
  type SketchConstraintKind,
  type Vec3,
} from '@pointercad/model';

import type { ConstraintSummary } from './constraintSummary.js';
import { pickSketchElement } from './pickMath.js';
import type { ProjectToScreen } from './snapMath.js';

/**
 * 端点・中心の当たり判定の半径(画素、統括の決定 2026-09-05)。
 * 吸着(`SNAP_RADIUS_PIXELS`)と同じ 12 画素にする。要素そのものの当たり判定
 * (`PICK_RADIUS_PIXELS` = 6)より広いのは、端点は線の上にあり、狭いと線のほうが
 * 先に当たって端点をいつまでも掴めないため。
 */
export const CONSTRAINT_PICK_RADIUS_PIXELS = 12;

/** 端点・中心 1 つ。`vertexKey`(model)と同じ指し方をそのまま持つ。 */
export interface SketchVertex {
  readonly featureId: string;
  readonly vertex: 'start' | 'end' | 'center';
  readonly position: Vec3;
}

/**
 * 拘束の指し先になる端点・中心をすべて集める。
 *
 * 線分は両端、円弧・楕円は中心と両端。**点フィーチャーはここに入れない**
 * (`pickSketchElement` が `point` として拾い、`ConstraintTarget` の `point` になる)。
 * 並びは `ResolvedSketch` の並びで決まるので、同じ入力からは必ず同じ順になる。
 */
export function sketchVertices(resolved: ResolvedSketch): readonly SketchVertex[] {
  const vertices: SketchVertex[] = [];
  for (const segment of resolved.segments) {
    vertices.push({ featureId: segment.featureId, vertex: 'start', position: segment.from });
    vertices.push({ featureId: segment.featureId, vertex: 'end', position: segment.to });
  }
  for (const arc of resolved.arcs) {
    vertices.push({ featureId: arc.featureId, vertex: 'center', position: arc.center });
    vertices.push({ featureId: arc.featureId, vertex: 'start', position: curveStart(arc) });
    vertices.push({ featureId: arc.featureId, vertex: 'end', position: curveEnd(arc) });
  }
  for (const ellipse of resolved.ellipses) {
    vertices.push({ featureId: ellipse.featureId, vertex: 'center', position: ellipse.center });
  }
  return vertices;
}

/** 押した場所が指すもの 1 つ。 */
export interface ConstraintPick {
  /** model へ渡す指し先。 */
  readonly target: ConstraintTarget;
  /**
   * 画面の強調に使う要素 id(`selection` へ入れられる形)。端点を押したときは
   * その端点を持つフィーチャーの id になる(端点だけを光らせる仕組みは無いので、
   * 要素そのものを光らせて「この線の端」と分かるようにする)。
   */
  readonly elementId: string;
  /** 端点・中心を押したか。帯の案内を分けるのに使う。 */
  readonly vertex: SketchVertex | null;
}

/** 画面上の 2 点の距離。 */
function screenDistance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 押した場所に最も近い端点・中心。判定半径の外なら null。
 * 同じ距離のものが複数あるときは**先に見つかったほう**を採る(`sketchVertices` の並びは
 * 決まっているので、同じ入力からは必ず同じ答えになる)。
 */
export function vertexAt(
  resolved: ResolvedSketch,
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number = CONSTRAINT_PICK_RADIUS_PIXELS,
): SketchVertex | null {
  let best: SketchVertex | null = null;
  let bestDistance = radiusPixels;
  for (const vertex of sketchVertices(resolved)) {
    const screen = project(vertex.position);
    if (screen === null) {
      continue;
    }
    const distance = screenDistance(screen, pointer);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = vertex;
    }
  }
  return best;
}

/**
 * 押した場所が指す拘束の相手(NFR-UX-1)。
 *
 * **端点・中心を先に見る**のが要。線分の端の近くを押したときに線そのものが当たると、
 * 一致・距離を付けられない。要素そのものを指したいときは端から離れたところを押せばよい。
 */
export function pickConstraintTarget(
  resolved: ResolvedSketch,
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number = CONSTRAINT_PICK_RADIUS_PIXELS,
): ConstraintPick | null {
  const vertex = vertexAt(resolved, project, pointer, radiusPixels);
  if (vertex !== null) {
    return {
      target: { kind: 'vertex', featureId: vertex.featureId, vertex: vertex.vertex },
      elementId: vertex.featureId,
      vertex,
    };
  }
  const picked = pickSketchElement(resolved, project, pointer);
  if (picked === null || picked.kind === 'face') {
    // 面は拘束の相手にならない(`constraintCommands.ts` の `unsupportedElement`)。
    return null;
  }
  if (picked.kind === 'point') {
    return {
      target: { kind: 'point', pointId: picked.elementId },
      elementId: picked.elementId,
      vertex: null,
    };
  }
  return {
    target: { kind: 'curve', element: { featureId: picked.featureId } },
    elementId: picked.elementId,
    vertex: null,
  };
}

/**
 * 種類ごとに要る指し先の数(タスク13)。
 *
 * `constraintCommands.ts` の `targetShapeReason` が同じ数を検査しているが、あちらは
 * 「組み上がった指し先が正しいか」を見る非公開の判定で、こちらは「あと何個押せばよいか」を
 * 押すたびに知らせるためのもの。**足りない数を先に知らせる**のが役目なので、外へ出す表を
 * ここに持つ(model 側の値ではないので、種類を足したら両方が型検査で落ちる)。
 *
 * 「固定」は 1 つずつ付く(選んだ数だけ足す作りは `commitAddConstraint` が持つ)ので 1。
 */
export const CONSTRAINT_TARGET_COUNTS: Readonly<Record<SketchConstraintKind, number>> = {
  coincident: 2,
  horizontal: 1,
  vertical: 1,
  parallel: 2,
  perpendicular: 2,
  tangent: 2,
  concentric: 2,
  equal: 2,
  symmetric: 3,
  fix: 1,
  distance: 2,
  angle: 2,
  radius: 1,
  diameter: 1,
};

/** その種類に要る指し先の数。 */
export function constraintTargetCount(kind: SketchConstraintKind): number {
  return CONSTRAINT_TARGET_COUNTS[kind];
}

/** その指し先は曲線そのものを指しているか(点・端点でないか)。 */
function isCurveTarget(target: ConstraintTarget): boolean {
  return target.kind === 'curve';
}

/** 曲線を指す指し先が、いまの形で線分かどうか。 */
function isSegmentTarget(resolved: ResolvedSketch, target: ConstraintTarget): boolean {
  if (target.kind !== 'curve') {
    return false;
  }
  const featureId = target.element.featureId;
  return resolved.segments.some((segment) => segment.featureId === featureId);
}

/**
 * 押した順を、種類が求める並びへ直す(タスク13)。
 *
 * **順序に意味があるのは 3 つだけ**で、それ以外は押した順のまま渡す。
 * ① 接線は「線分 → 円」の順(model の `tangent` は `line` / `circle` の欄を持つ)。
 * ② 対称は「点・点 → 軸の線」の順(軸は `SketchElementRef` の欄)。
 * ③ 角度は「1 本目から 2 本目へ測る」ので**押した順を保つ**(直さない)。
 *
 * 並べ直せない組(接線なのに線分が無い等)はそのまま返し、断りは
 * `commitAddConstraint`(t12)の検査に任せる。判定を 2 か所に置かないため。
 */
export function orderConstraintTargets(
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
  resolved: ResolvedSketch,
): readonly ConstraintTarget[] {
  if (kind === 'tangent' && targets.length === 2) {
    const lineFirst = isSegmentTarget(resolved, targets[0]);
    return lineFirst ? targets : [targets[1], targets[0]];
  }
  if (kind === 'symmetric' && targets.length === 3) {
    const points = targets.filter((target) => !isCurveTarget(target));
    const axes = targets.filter(isCurveTarget);
    return points.length === 2 && axes.length === 1 ? [points[0], points[1], axes[0]] : targets;
  }
  return targets;
}

/**
 * すでに押したものをもう一度押したか(押し直しで外せるようにする)。
 * 指し先を 1 つの文字列にして比べる(`constraintCommands.ts` の `targetKey` と同じ考え方。
 * あちらは非公開なのでここにも置くが、**用途が違う**: あちらは「同じ拘束が既にあるか」、
 * ここは「同じ場所をもう一度押したか」)。
 */
export function sameConstraintTarget(a: ConstraintTarget, b: ConstraintTarget): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'point' && b.kind === 'point') {
    return a.pointId === b.pointId;
  }
  if (a.kind === 'vertex' && b.kind === 'vertex') {
    return a.featureId === b.featureId && a.vertex === b.vertex;
  }
  if (a.kind === 'curve' && b.kind === 'curve') {
    return a.element.featureId === b.element.featureId && a.element.index === b.element.index;
  }
  return false;
}

/**
 * 押した指し先を積む・外す(NFR-UX-1「押したら必ず何かが起きる」)。
 * 同じところをもう一度押したら外れる(選び直せる)。まだ無ければ末尾へ足す。
 */
export function toggleConstraintTarget(
  picked: readonly ConstraintTarget[],
  target: ConstraintTarget,
): readonly ConstraintTarget[] {
  const found = picked.findIndex((existing) => sameConstraintTarget(existing, target));
  if (found >= 0) {
    return [...picked.slice(0, found), ...picked.slice(found + 1)];
  }
  return [...picked, target];
}

/**
 * 寸法拘束(距離・角度・半径・直径)の値を聞いている最中の状態(FR-313、NFR-UX-2)。
 *
 * 表示だけの一時状態なのでストア(`useAppStore`)に置く(rules/04-設計の規律.md)。
 * 型をここ(純関数の側)に置くのは、ストアが画面の部品を知らずに済むようにするため
 * (`shapeCommands.ts` の `ShapeDraft` と同じ置き方)。
 */
export interface ConstraintValuePrompt {
  readonly kind: SketchConstraintKind;
  /** 決まった指し先。そのまま `commitAddConstraint` へ渡す。 */
  readonly targets: readonly ConstraintTarget[];
  /**
   * いま測った値(NFR-UX-4「Enter 連打だけでも意味のある結果になる」)。
   * 空のまま Enter を押すとこの値になる。
   */
  readonly defaultSource: string;
  /** ポップアップを出す画面座標(canvas の左上を原点とした画素)。 */
  readonly anchor: readonly [number, number];
}

/* ---------------------------------------------------------------------------
 * 印の当たり判定(過去の失敗「描画・当たり判定・選択の 3 つを揃える」)
 * ------------------------------------------------------------------------- */

/** 3D に出す印 1 つ。`createConstraintLayer.ts` が描き、ここが当たり判定に使う。 */
export interface ConstraintMark {
  readonly constraintId: string;
  readonly symbol: string;
  readonly state: 'ok' | 'conflicting' | 'redundant' | 'dangling';
  /** 印が指している場所(ワールド座標)。 */
  readonly position: Vec3;
  /**
   * 指している場所からの**画面上のずらし量**(画素。x は右、y は下が正。P4b タスク22b)。
   *
   * 描く側(`createConstraintLayer.ts`)は記号の絵の中で位置をずらして描き、当たり判定
   * (`constraintMarkAt`)は写した画面座標へこれを足す。**描画・当たり判定・選択の 3 つが
   * 同じ値を見る**ようにするため、ずらし量は印そのものが持つ(P4 タスク12 の失敗の再発防止)。
   */
  readonly offset: readonly [number, number];
}

/**
 * 重なった印を横へ並べる間隔(画素。利用者の決定③(2026-09-05)「横に 18px ずつずらす」)。
 * 印の大きさ(`createConstraintLayer.ts` の `MARK_SIZE_PIXELS` = 16)より少し広く取り、
 * 隣り合った記号がくっついて 1 文字に見えないようにする。
 */
export const MARK_SPREAD_PIXELS = 18;

/**
 * 点に付く印を上へ逃がす量(画素。t14 の申し送り)。一致・固定・距離の端のように
 * **点そのものを指す印**は、そのまま描くと点の真上に出て掴み(ドラッグ)と競合する。
 * 印の大きさ(16px)の半分 + 点の当たり判定(6px)ぶんだけ上げれば重ならない。
 */
export const MARK_POINT_LIFT_PIXELS = 14;

/**
 * 印の当たり判定の半径(画素)。印そのものの大きさ(`createConstraintLayer.ts` の
 * `MARK_SIZE_PIXELS` = 14)の半分より少し広くして、狙って押せば必ず当たるようにする。
 */
export const CONSTRAINT_MARK_RADIUS_PIXELS = 9;

/**
 * 一覧の行(`ConstraintSummary`)を 3D の印へ開く。1 つの拘束が指し先の数だけ印を持つ
 * (平行なら 2 本の線の中点にひとつずつ)。指す先が消えていれば印は 0 個になる。
 */
export function constraintMarksOf(
  summaries: readonly ConstraintSummary[],
): readonly ConstraintMark[] {
  const marks: ConstraintMark[] = [];
  for (const summary of summaries) {
    for (const anchor of summary.anchors) {
      marks.push({
        constraintId: summary.id,
        symbol: summary.symbol,
        state: summary.state,
        position: anchor.position,
        offset: anchor.onPoint ? [0, -MARK_POINT_LIFT_PIXELS] : [0, 0],
      });
    }
  }
  return spreadOverlappingMarks(marks);
}

/** 同じ場所に置かれた印をまとめる鍵(ワールド座標をそのまま文字列にする)。 */
function positionKey(position: Vec3): string {
  return `${String(position[0])}|${String(position[1])}|${String(position[2])}`;
}

/**
 * 同じ場所に重なった印を、横に `MARK_SPREAD_PIXELS` ずつ並べる
 * (利用者の決定③(2026-09-05)。平行と直角を同じ線に付けると印が同じ中点に重なり、
 * 読めなくなる実測がある。`docs/報告記録.md` 2026-09-05 実時計 02:50)。
 *
 * **まとめる単位はワールド座標が同じ印**にする。指示は「画面で 1px 以内」だが、画面座標は
 * カメラが決めるので、印を組み立てる時点(文書が変わったとき)に画面で数えると視点を
 * 回した後に古いずらし量が残る。**同じ場所に置かれた印はどの視点でも必ず重なる**ので、
 * ワールド座標でまとめれば視点に依らず正しく、毎コマ数え直す費用も要らない
 * (別々の場所の印がたまたま 1px 以内に重なる場合は残るが、視点を少し動かせば解ける)。
 *
 * 並べ方は**左右に振り分ける**(0 番目が中央、以降は左右へ交互ではなく、
 * まとめて中央ぞろえ)。1 つだけのときはずれないので、ふだんの見え方は変わらない。
 */
export function spreadOverlappingMarks(
  marks: readonly ConstraintMark[],
): readonly ConstraintMark[] {
  /** 同じ場所の印が何個あるか(鍵ごとの合計)。 */
  const counts = new Map<string, number>();
  for (const mark of marks) {
    const key = positionKey(mark.position);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  /** その鍵で何個目か(0 起点)。 */
  const seen = new Map<string, number>();
  // **元の並びは変えない**(印の並びは一覧の並びから決まっていて、当たり判定の
  // 同点のときの選び方もそれに従う)。ずらし量だけを足す。
  return marks.map((mark) => {
    const key = positionKey(mark.position);
    const total = counts.get(key) ?? 1;
    if (total === 1) {
      return mark;
    }
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    // 中央ぞろえ。n 個なら −(n−1)/2 …… +(n−1)/2 の位置へ 18px 刻みで置く。
    const half = (total - 1) / 2;
    return {
      ...mark,
      offset: [mark.offset[0] + (index - half) * MARK_SPREAD_PIXELS, mark.offset[1]] as const,
    };
  });
}

/**
 * 押した場所にある印の拘束 id。無ければ null(FR-106 と同じ「押したら選ばれる」)。
 * 重なっているときは**最も近いもの**を採る。
 */
export function constraintMarkAt(
  marks: readonly ConstraintMark[],
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number = CONSTRAINT_MARK_RADIUS_PIXELS,
): string | null {
  let best: string | null = null;
  let bestDistance = radiusPixels;
  for (const mark of marks) {
    const screen = project(mark.position);
    if (screen === null) {
      continue;
    }
    // 描く側と同じずらし量を足してから測る(印は指している場所から離れて描かれる)。
    const distance = screenDistance(
      [screen[0] + mark.offset[0], screen[1] + mark.offset[1]],
      pointer,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mark.constraintId;
    }
  }
  return best;
}
