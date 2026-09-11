/**
 * トリム・延長の予告表示(FR-322、計画書 docs/plans/P4-スケッチ拡張.md タスク22、
 * §0.a-0.26 の利用者の決定)。
 *
 * 利用者の決定(2026-09-04)は「道具を選んで、消したい部分をクリック」「道具を選んで、
 * 伸ばしたい端の近くをクリック」なので、**押す前に何が起きるかが見えている**必要がある
 * (NFR-UX-5「実行してから失敗させない」)。ここはマウスの位置から
 *
 * - トリム: 交点で区切られた区間のうち、マウスが乗っている 1 区間(= 消える区間)
 * - 延長: いまの端から、その先で最初にぶつかる曲線までの区間(= 伸びる区間)
 *
 * を折れ線で返す純関数を置く。DOM にも three.js にもストアにも触れない。
 *
 * ## model 側と同じ答えになるようにしてある
 *
 * 実際に切る・伸ばすのは model の `trimCurve` / `extendCurve`(タスク17)で、ここは
 * **同じ手順を同じ順で辿って区間だけを取り出す**。区切りの集め方(交点の 0〜1 の位置、
 * 端ちょうどの落とし方、輪になった曲線での 0 への寄せ方)も、伸ばす向きの試し方
 * (`probeSegment` / `probeArc` / `probeLength` に当たるもの)も、model の
 * `packages/model/src/sketch/trimExtend.ts` の写しである。
 *
 * **なぜ写しているのか**: 予告はマウスが動くたびに出し直すので、文書を作り替えて
 * 解き直す(`trimCurve` は中で `resolveSketch` を 1〜3 回呼ぶ)経路を毎回通せない
 * (NFR-PF-1「60fps」)。model 側は「文書 → 新しい文書」の純関数として閉じており、
 * 途中の区間を取り出す口を持っていないため、区間の計算だけをここへ写した。
 * model の区間の決め方を変えるときは、この 2 ファイルを一緒に直す
 * (食い違うと「赤く見えていた場所と違う所が消える」ことになる)。
 */

import {
  curveEnd,
  curveIntersections,
  curveParameterNear,
  curvePointAt,
  curveStart,
  distanceVec3,
  hasConnectedSegmentEnd,
  isFullCircle,
  lengthVec3,
  normalizeVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type ResolvedArc,
  type ResolvedCurve,
  type ResolvedSegment,
  type ResolvedSketch,
  type TrimErrorKey,
  type Vec3,
} from '@pointercad/model';

import { ARC_SEGMENTS_PER_TURN } from './sampleCurve.js';

/** 1 周(ラジアン)。円弧を折れ線へ割るときの分母。 */
const FULL_TURN = 2 * Math.PI;

/**
 * 0〜1 のものさしの上での遊び。model の `trimExtend.ts` の `RATIO_EPSILON` と同じ値で、
 * 端ちょうどの交点を「区間を分けない」と見なす境目になる。
 */
const RATIO_EPSILON = 1e-7;

/**
 * 予告に出す折れ線 1 本。ビューポートはこれをそのまま重ねて描く。
 *
 * 種類は「消える区間(trim)」「伸びる区間(extend)」に加え、P4 タスク23 が
 * 「丸めたあとの形(fillet)」「面取りしたあとの形(chamfer)」を足した(FR-323)。
 * 描く層(`createSketchLayer.ts`)は消える区間だけを赤く濃く出し、それ以外は
 * ホバーと同じ色で薄く出す作りなので、種類を足しても描く側は変えなくてよい。
 */
export interface EditPreview {
  readonly kind: 'trim' | 'extend' | 'fillet' | 'chamfer';
  /** 世界座標の折れ線(2 点以上)。 */
  readonly points: readonly Vec3[];
}

export type EditPreviewOutcome =
  | { readonly ok: true; readonly preview: EditPreview }
  /** 断る理由。model の `TrimErrorKey` と同じ 6 種を使い、文言は ja.json から引く。 */
  | { readonly ok: false; readonly reason: TrimErrorKey };

function refuse(reason: TrimErrorKey): EditPreviewOutcome {
  return { ok: false, reason };
}

/* ------------------------------------------------------------------ *
 * 指した曲線を選ぶ
 * ------------------------------------------------------------------ */

/**
 * 指した要素 id と押した場所から、対象になる曲線 1 本を選ぶ。
 *
 * 矩形・正多角形・長穴は 1 フィーチャーが複数の曲線を生む(§0.a-0.8)ので、
 * **押した場所にいちばん近い 1 本**を選ぶ。model の `prepareTarget` が
 * `nearestCurveIndex` で選ぶのと同じ決め方にしてある(選ぶ 1 本が食い違うと、
 * 赤く見えている辺と実際に切れる辺がずれる)。
 */
export function targetCurveAt(
  resolved: ResolvedSketch,
  elementId: string,
  at: Vec3,
): ResolvedCurve | null {
  const featureId = elementId.split('#')[0];
  const group = resolved.curvesByFeature.get(featureId);
  if (group !== undefined && group.length > 0) {
    return group[nearestCurveIndex(group, at)];
  }
  for (const curve of [
    ...resolved.segments,
    ...resolved.arcs,
    ...resolved.ellipses,
    ...resolved.splines,
  ]) {
    if (curve.featureId === featureId) {
      return curve;
    }
  }
  return null;
}

/** 並んだ曲線のうち、指した点にいちばん近い 1 本の位置(model の `nearestCurveIndex` の写し)。 */
function nearestCurveIndex(curves: readonly ResolvedCurve[], point: Vec3): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < curves.length; index += 1) {
    const curve = curves[index];
    const distance = distanceVec3(point, curvePointAt(curve, curveParameterNear(curve, point)));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * 切る・伸ばすことができる種類か。model の `targetOf` と同じで、線分と円弧だけを扱う
 * (楕円・スプライン・オフセットの結果は交点は取れるが、切る側にはまだできない。
 * タスク17 の申し送り)。
 */
function isTrimmable(curve: ResolvedCurve): curve is ResolvedSegment | ResolvedArc {
  return curve.kind === 'segment' || curve.kind === 'arc';
}

/* ------------------------------------------------------------------ *
 * 区切りの位置
 * ------------------------------------------------------------------ */

/** スケッチの中の曲線をすべて数え上げる(model の `allCurves` の写し)。 */
function allCurves(resolved: ResolvedSketch): readonly ResolvedCurve[] {
  return [...resolved.segments, ...resolved.arcs, ...resolved.ellipses, ...resolved.splines];
}

/**
 * 対象の曲線を切る位置(0〜1)を集める(model の `cutRatios` の写し)。
 *
 * 自分と同じフィーチャーの曲線は相手にしない。開いた曲線では端ちょうど(0 と 1)の
 * 交点は区間を分けないので落とし、輪になった曲線(全周の円)では端が曲線の途中なので
 * 0 も切る場所として数える。
 */
export function cutRatiosOf(
  target: ResolvedCurve,
  resolved: ResolvedSketch,
  closed: boolean,
): readonly number[] {
  const ratios: number[] = [];
  for (const other of allCurves(resolved)) {
    if (other.featureId === target.featureId) {
      continue;
    }
    for (const found of curveIntersections(target, other)) {
      let ratio = found.onFirst;
      if (closed) {
        if (ratio >= 1 - RATIO_EPSILON) {
          ratio = 0;
        }
      } else if (ratio <= RATIO_EPSILON || ratio >= 1 - RATIO_EPSILON) {
        continue;
      }
      if (ratios.every((known) => Math.abs(known - ratio) > RATIO_EPSILON)) {
        ratios.push(ratio);
      }
    }
  }
  return ratios.sort((a, b) => a - b);
}

/** 消える区間 1 つ(0〜1 のものさしの上。輪のときは終わりが 1 を超えることがある)。 */
export interface PreviewRange {
  readonly from: number;
  readonly to: number;
}

/**
 * 開いた曲線で、押した位置を含む区間(= 消える区間)。
 * model の `keptRangesOpen` が「残す側」を選ぶときに使う境目と同じ値を返す。
 */
export function removedRangeOpen(cuts: readonly number[], clicked: number): PreviewRange {
  const bounds = [0, ...cuts, 1];
  let index = bounds.length - 2;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    if (clicked <= bounds[i + 1]) {
      index = i;
      break;
    }
  }
  return { from: bounds[index], to: bounds[index + 1] };
}

/**
 * 輪になった曲線(全周の円)で、押した位置を含む区間(= 消える区間)。
 * model の `keptRangesClosed` が「残す 1 本」を作るときの `removedStart` /
 * `removedEnd` と同じ値を返す。
 */
export function removedRangeClosed(cuts: readonly number[], clicked: number): PreviewRange {
  let from = cuts[cuts.length - 1];
  let to = cuts[0] + 1;
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    if (clicked >= cuts[i] && clicked <= cuts[i + 1]) {
      from = cuts[i];
      to = cuts[i + 1];
      break;
    }
  }
  return { from, to };
}

/**
 * 0〜1 の区間を折れ線へ割る。線分は 2 点、円弧は掃く角度に比例した分割
 * (全周で `ARC_SEGMENTS_PER_TURN` 区間。表示のほかの曲線と同じ粗さ)。
 * 輪の区間は終わりが 1 を超えるが、`curvePointAt` は角度をそのまま伸ばして評価するので
 * 端をまたいだ区間もそのまま描ける。
 */
export function samplePreviewRange(
  curve: ResolvedSegment | ResolvedArc,
  range: PreviewRange,
): readonly Vec3[] {
  const width = Math.abs(range.to - range.from);
  const divisions =
    curve.kind === 'segment'
      ? 1
      : Math.max(
          1,
          Math.ceil(
            (width * Math.abs(curve.endAngle - curve.startAngle) * ARC_SEGMENTS_PER_TURN) /
              FULL_TURN,
          ),
        );
  const points: Vec3[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    points.push(curvePointAt(curve, range.from + (range.to - range.from) * (index / divisions)));
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * トリムの予告
 * ------------------------------------------------------------------ */

/**
 * トリム(FR-322)の予告。押した場所を含む区間の折れ線を返す。
 * 断るときは model の `trimCurve` とまったく同じ理由を返すので、強調が出ない場面と
 * クリックしたときに帯へ出る理由が食い違わない(NFR-UX-5)。
 */
export function trimPreviewAt(
  resolved: ResolvedSketch,
  elementId: string,
  at: Vec3,
): EditPreviewOutcome {
  const curve = targetCurveAt(resolved, elementId, at);
  if (curve === null) {
    return refuse('missingElement');
  }
  if (!isTrimmable(curve)) {
    return refuse('unsupportedCurve');
  }
  const closed = curve.kind === 'arc' && isFullCircle(curve);
  const cuts = cutRatiosOf(curve, resolved, closed);
  if (cuts.length === 0) {
    if (curve.kind === 'segment' && hasConnectedSegmentEnd(curve, resolved)) {
      return { ok: true, preview: { kind: 'trim', points: [curve.from, curve.to] } };
    }
    return refuse('noIntersection');
  }
  if (closed && cuts.length < 2) {
    return refuse('singleIntersection');
  }
  const clicked = curveParameterNear(curve, at);
  const range = closed ? removedRangeClosed(cuts, clicked) : removedRangeOpen(cuts, clicked);
  if (!closed && range.from <= RATIO_EPSILON && range.to >= 1 - RATIO_EPSILON) {
    // 切っても何も残らない(model の `wholeCurve` と同じ判定)。
    return refuse('wholeCurve');
  }
  return { ok: true, preview: { kind: 'trim', points: samplePreviewRange(curve, range) } };
}

/* ------------------------------------------------------------------ *
 * 延長の予告
 * ------------------------------------------------------------------ */

/** 曲線の 2 つの端のうち、指した点に近いほう(model の `nearestCurveEnd` と同じ決め方)。 */
function nearestEnd(curve: ResolvedCurve, point: Vec3): 'start' | 'end' {
  return distanceVec3(point, curveStart(curve)) <= distanceVec3(point, curveEnd(curve))
    ? 'start'
    : 'end';
}

/** 伸ばす向きを試す長さ(mm)。model の `probeLength` の写し。 */
function probeLength(resolved: ResolvedSketch, from: Vec3): number {
  let far = 1;
  for (const curve of allCurves(resolved)) {
    far = Math.max(far, distanceVec3(from, curveStart(curve)), distanceVec3(from, curveEnd(curve)));
    if (curve.kind === 'arc') {
      far = Math.max(far, distanceVec3(from, curve.center) + curve.radius);
    }
  }
  for (const point of resolved.points) {
    far = Math.max(far, distanceVec3(from, point.position));
  }
  return far * 2 + 1;
}

/** 線分を、指定した端の外側へ伸ばした「試しの線分」(model の `probeSegment` の写し)。 */
function probeSegment(
  segment: ResolvedSegment,
  end: 'start' | 'end',
  length: number,
): ResolvedSegment | null {
  const tip = end === 'start' ? segment.from : segment.to;
  const other = end === 'start' ? segment.to : segment.from;
  const along = subVec3(tip, other);
  if (lengthVec3(along) <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  const direction = normalizeVec3(along);
  return {
    kind: 'segment',
    featureId: segment.featureId,
    from: tip,
    to: [
      tip[0] + direction[0] * length,
      tip[1] + direction[1] * length,
      tip[2] + direction[2] * length,
    ],
  };
}

/** 円弧を、指定した端の先へ「残りの周ぶん」伸ばした試しの円弧(model の `probeArc` の写し)。 */
function probeArc(arc: ResolvedArc, end: 'start' | 'end'): ResolvedArc | null {
  const span = arc.endAngle - arc.startAngle;
  const rest = FULL_TURN - Math.abs(span);
  if (rest <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  const forward = span >= 0 ? 1 : -1;
  if (end === 'end') {
    return { ...arc, startAngle: arc.endAngle, endAngle: arc.endAngle + forward * rest };
  }
  return { ...arc, startAngle: arc.startAngle, endAngle: arc.startAngle - forward * rest };
}

/** 試しの曲線が最初にぶつかる相手との交点(model の `firstHit` の写し)。 */
function firstHitRatio(
  probe: ResolvedCurve,
  resolved: ResolvedSketch,
  featureId: string,
): number | null {
  let best: number | null = null;
  for (const other of allCurves(resolved)) {
    if (other.featureId === featureId) {
      continue;
    }
    for (const found of curveIntersections(probe, other)) {
      if (found.onFirst <= RATIO_EPSILON) {
        continue;
      }
      if (best === null || found.onFirst < best) {
        best = found.onFirst;
      }
    }
  }
  return best;
}

/**
 * 延長(FR-322)の予告。押した場所に近い端から、その先で最初にぶつかる曲線までの
 * 区間の折れ線を返す。ぶつかる相手が無ければ `noBoundary` を返し、何も強調しない。
 */
export function extendPreviewAt(
  resolved: ResolvedSketch,
  elementId: string,
  at: Vec3,
): EditPreviewOutcome {
  const curve = targetCurveAt(resolved, elementId, at);
  if (curve === null) {
    return refuse('missingElement');
  }
  if (!isTrimmable(curve)) {
    return refuse('unsupportedCurve');
  }
  const end = nearestEnd(curve, at);
  const probe =
    curve.kind === 'segment'
      ? probeSegment(curve, end, probeLength(resolved, curve.from))
      : probeArc(curve, end);
  if (probe === null) {
    return refuse('unsupportedCurve');
  }
  const ratio = firstHitRatio(probe, resolved, curve.featureId);
  if (ratio === null) {
    return refuse('noBoundary');
  }
  return {
    ok: true,
    preview: { kind: 'extend', points: samplePreviewRange(probe, { from: 0, to: ratio }) },
  };
}

/* ------------------------------------------------------------------ *
 * 出し直しの判定
 * ------------------------------------------------------------------ */

/**
 * 同じ予告かどうか。マウスが動くたびに同じ折れ線をストアへ入れ直すと、
 * ビューポートが毎回描き直すことになるので、同じなら書き換えない(NFR-PF-1。
 * 吸着の印の `sameIndicator` と同じ考え方)。
 */
export function sameEditPreview(a: EditPreview | null, b: EditPreview | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.kind !== b.kind || a.points.length !== b.points.length) {
    return false;
  }
  for (let index = 0; index < a.points.length; index += 1) {
    const left = a.points[index];
    const right = b.points[index];
    if (left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2]) {
      return false;
    }
  }
  return true;
}
