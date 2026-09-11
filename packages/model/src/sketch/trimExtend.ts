/**
 * トリム(切り取り)と延長(FR-322、計画書 P4 §2.5・§0.a-0.10、タスク17)。
 *
 * どちらも**元のフィーチャーを書き換える**(履歴に新しい道具を積まない)。統括の決定
 * §0.a-0.10「整形系(トリム・延長・フィレット/面取り)は既存の要素を書き換える」に従う。
 * 利用者の目には「引いた線が短くなる/伸びる」だけで、道具の履歴は増えない。
 *
 * ## 書き換えた欄は数値になる
 *
 * 端点を交点へ動かすとき、**式ではなく計算した数値**を入れる(`absoluteCoordinate` /
 * `expressionValueFromNumber`)。交点は「相手の曲線」との関係で決まる値で、これを参照の形で
 * 持たせようとすると、**相手が履歴の後ろにいるときに前方参照になって解けない**
 * (`resolveSketch` は履歴を先頭から順に解くので、後ろのフィーチャーは基準にできない。
 * 計画書 §2.5 の `{ kind: 'intersection' }` 案はこの点で成り立たない)。
 * だから交点は確定した瞬間に数へ落とす。**触っていない欄の式はそのまま残る**ので、
 * 円弧のトリムでは中心の式が残り、角度だけが数になる。
 *
 * ## 複数の曲線を生む図形(矩形・正多角形・長穴)
 *
 * そのままでは 1 本だけ短くできないので、**先に線分・円弧の個別のフィーチャーへ分解**して
 * から切る(`explodeCompoundFeature`)。分解は文書を 1 回作り替えるだけなので、
 * Undo 1 回で元の矩形へ戻る(P2 の Undo は文書の差し替えを 1 段と数える、FR-505)。
 *
 * すべて純関数で、文書を書き換えず新しい文書を返す。DOM にもカーネルにも触れない。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import { hasConnectedSegmentEnd } from './connectedSegment.js';
import { constraintTargets } from './constraints/types.js';

import {
  absoluteCoordinate,
  appendFeature,
  nextFeatureId,
  nextFeatureName,
} from './createSketchDocument.js';
import {
  curveEnd,
  curveIntersections,
  curveParameterNear,
  curvePointAt,
  curveStart,
  isFullCircle,
} from './intersectionMath.js';
import {
  baseWorkPlane,
  radiansToDegrees,
  type WorkPlane,
  type WorkPlaneId,
} from './planeMath.js';
import { resolveSketch, type SketchResolveOptions } from './resolveSketch.js';
import type {
  CopyPlacement,
  ResolvedArc,
  ResolvedCurve,
  ResolvedSegment,
  ResolvedSketch,
  SketchArcFeature,
  SketchDocument,
  SketchElementRef,
  SketchFeature,
  SketchLineFeature,
  SketchPolygonFeature,
  SketchRectangleFeature,
  SketchSlotFeature,
} from './types.js';
import {
  crossVec3,
  distanceVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type Vec3,
} from './vec3.js';

/**
 * 断る理由。画面の言い回し(ja.json)はこの鍵で選ぶ(タスク22)。
 * 文言もここで日本語のまま返すので、鍵を使わない側はそのまま出せる。
 */
export type TrimErrorKey =
  /** 指した要素が見つからない。 */
  | 'missingElement'
  /** 楕円・スプライン・オフセットのように、いまは切れない/伸ばせない種類。 */
  | 'unsupportedCurve'
  /** 交わる曲線が 1 本も無い。 */
  | 'noIntersection'
  /** 円・全周の楕円で、交わる点が 1 つしか無く区間を決められない。 */
  | 'singleIntersection'
  /** 切ると何も残らない。 */
  | 'wholeCurve'
  /** 延長の先にぶつかる曲線が無い。 */
  | 'noBoundary';

export type TrimOutcome =
  | { readonly ok: true; readonly document: SketchDocument }
  | { readonly ok: false; readonly reason: TrimErrorKey; readonly message: string };

/** トリムの指定(FR-322)。 */
export interface TrimRequest {
  /** 切る曲線。`featureId`、または複数曲線フィーチャーの n 番目なら `featureId#n`。 */
  readonly elementId: string;
  /** 利用者がクリックした位置。**この点を含む区間を消す**。 */
  readonly at: Vec3;
}

/** 延長の指定(FR-322)。 */
export interface ExtendRequest {
  /** 伸ばす曲線。指定の形はトリムと同じ。 */
  readonly elementId: string;
  /** どちらの端を伸ばすか。省くと `at` に近いほうの端を選ぶ。 */
  readonly end?: 'start' | 'end';
  /** 利用者がクリックした位置。`end` を省いたときに使う。 */
  readonly at?: Vec3;
}

/** ものさしの上でこれ以下の長さしか残らない区間は「無い」とみなす。 */
const RATIO_EPSILON = 1e-7;

function refuse(reason: TrimErrorKey, message: string): TrimOutcome {
  return { ok: false, reason, message };
}

/* ------------------------------------------------------------------ *
 * 要素の指定を解く
 * ------------------------------------------------------------------ */

/** `featureId#n` を分ける。`#` が無ければ n は null。 */
export function parseElementId(elementId: string): {
  readonly featureId: string;
  readonly index: number | null;
} {
  const separator = elementId.indexOf('#');
  if (separator < 0) {
    return { featureId: elementId, index: null };
  }
  const parsed = Number(elementId.slice(separator + 1));
  return {
    featureId: elementId.slice(0, separator),
    index: Number.isInteger(parsed) && parsed >= 0 ? parsed : null,
  };
}

/** 曲線の 2 つの端のうち、指した点に近いほう。 */
export function nearestCurveEnd(curve: ResolvedCurve, point: Vec3): 'start' | 'end' {
  return distanceVec3(point, curveStart(curve)) <= distanceVec3(point, curveEnd(curve))
    ? 'start'
    : 'end';
}

/** 単体の線分・円弧(1 フィーチャー = 1 曲線)の解決結果を id で引く。 */
function singleCurveOf(resolved: ResolvedSketch, featureId: string): ResolvedCurve | null {
  for (const curve of [...resolved.segments, ...resolved.arcs]) {
    if (curve.featureId === featureId) {
      return curve;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 複数曲線フィーチャーの分解
 * ------------------------------------------------------------------ */

/** 1 フィーチャーが複数の線分・円弧を生む図形(分解できるもの)。 */
type CompoundFeature = SketchRectangleFeature | SketchPolygonFeature | SketchSlotFeature;

/** 分解できる(線分・円弧の集まりでできている)種類か。 */
function isExplodable(feature: SketchFeature): feature is CompoundFeature {
  return feature.kind === 'rectangle' || feature.kind === 'polygon' || feature.kind === 'slot';
}

/** 作図面の中での角度(第1軸から法線まわりに正)。 */
function angleInPlane(plane: WorkPlane, center: Vec3, point: Vec3): number {
  const axisV = crossVec3(plane.normal, plane.axisU);
  const offset = subVec3(point, center);
  return Math.atan2(dotVec3(offset, axisV), dotVec3(offset, plane.axisU));
}

/**
 * 解決済みの曲線 1 本を、単体のフィーチャー(線分か円弧)へ写す。
 *
 * 円弧の角度は**作図面の第1軸から測り直す**。長穴の半円弧は角度 0 の向きを
 * 「中心1→中心2」に取っているので(`resolveSketch.ts` の `resolveSlotCurves`)、
 * そのまま持ってくると別の場所の弧になってしまうため。掃く幅は変えないので形は同じ。
 */
function featureFromCurve(
  document: SketchDocument,
  curve: ResolvedCurve,
  plane: WorkPlane,
  planeId: WorkPlaneId,
  construction: boolean,
): SketchLineFeature | SketchArcFeature | null {
  if (curve.kind === 'segment') {
    return {
      id: nextFeatureId(document, 'line'),
      name: nextFeatureName(document, 'line'),
      planeId,
      kind: 'line',
      from: absoluteCoordinate(curve.from[0], curve.from[1], curve.from[2]),
      to: absoluteCoordinate(curve.to[0], curve.to[1], curve.to[2]),
      construction,
    };
  }
  if (curve.kind === 'arc') {
    const start = angleInPlane(plane, curve.center, curveStart(curve));
    const span = curve.endAngle - curve.startAngle;
    return {
      id: nextFeatureId(document, 'arc'),
      name: nextFeatureName(document, 'arc'),
      planeId,
      kind: 'arc',
      center: absoluteCoordinate(curve.center[0], curve.center[1], curve.center[2]),
      radius: expressionValueFromNumber(curve.radius),
      startAngle: expressionValueFromNumber(radiansToDegrees(start)),
      endAngle: expressionValueFromNumber(radiansToDegrees(start + span)),
      construction,
    };
  }
  return null;
}

/** 面の境界・オフセット元が指していた「分解前の要素」を、分解後の要素へ付け替える。 */
function remapElementRefs(
  refs: readonly SketchElementRef[],
  featureId: string,
  createdIds: readonly string[],
): readonly SketchElementRef[] {
  const mapped: SketchElementRef[] = [];
  for (const ref of refs) {
    if (ref.featureId !== featureId) {
      mapped.push(ref);
      continue;
    }
    if (ref.index === undefined) {
      // 全周を指していたので、分解後の全部を順に並べる。
      mapped.push(...createdIds.map((id): SketchElementRef => ({ featureId: id })));
      continue;
    }
    const created = createdIds[ref.index];
    // 範囲の外を指していた参照はそのまま残す(解決のときに missingBase で伝わる)。
    mapped.push(created === undefined ? ref : { featureId: created });
  }
  return mapped;
}

/**
 * 1 本だけを指す参照(鏡にする軸、FR-324)を付け替える。全体を指していたときは
 * 分解後の 1 本目にする(軸に選べるのは線分 1 本だけなので、全部へ広げても意味が無い)。
 */
function remapSingleRef(
  reference: SketchElementRef,
  featureId: string,
  createdIds: readonly string[],
): SketchElementRef {
  if (reference.featureId !== featureId) {
    return reference;
  }
  const created = createdIds[reference.index ?? 0];
  // 範囲の外を指していた参照はそのまま残す(解決のときに missingBase で伝わる)。
  return created === undefined ? reference : { featureId: created };
}

/** 複製(FR-324、タスク20)の「複製のしかた」に入っている参照を付け替える。 */
function remapCopyPlacement(
  placement: CopyPlacement,
  featureId: string,
  createdIds: readonly string[],
): CopyPlacement {
  if (placement.kind !== 'mirror' || placement.basis.kind !== 'axis') {
    return placement;
  }
  return {
    kind: 'mirror',
    basis: { kind: 'axis', axis: remapSingleRef(placement.basis.axis, featureId, createdIds) },
  };
}

function remapFeature(
  feature: SketchFeature,
  featureId: string,
  createdIds: readonly string[],
): SketchFeature {
  if (feature.kind === 'face') {
    return { ...feature, boundary: remapElementRefs(feature.boundary, featureId, createdIds) };
  }
  if (feature.kind === 'offset') {
    return { ...feature, source: remapElementRefs(feature.source, featureId, createdIds) };
  }
  if (feature.kind === 'copy') {
    return {
      ...feature,
      source: remapElementRefs(feature.source, featureId, createdIds),
      placement: remapCopyPlacement(feature.placement, featureId, createdIds),
    };
  }
  return feature;
}

/**
 * 矩形・正多角形・長穴を、線分・円弧の個別のフィーチャーへ分解する(FR-322 の下ごしらえ)。
 *
 * 分解後のフィーチャーは**元の位置へ順に差し込む**ので、履歴の並びと「直前の点」
 * (FR-302)の意味が変わらない(最後の 1 本の終点は元の図形の終点と同じ)。
 * 面の境界・オフセット元がこの図形を指していれば、分解後の要素へ付け替える。
 */
export function explodeCompoundFeature(
  document: SketchDocument,
  featureId: string,
  options: SketchResolveOptions = {},
): TrimOutcome {
  const exploded = explodeInto(document, featureId, options);
  if (!exploded.ok) {
    return refuse(exploded.reason, exploded.message);
  }
  return { ok: true, document: exploded.document };
}

type ExplodeOutcome =
  | {
      readonly ok: true;
      readonly document: SketchDocument;
      /** 分解して出来たフィーチャーの id(元の曲線の順)。 */
      readonly createdIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: TrimErrorKey; readonly message: string };

function explodeInto(
  document: SketchDocument,
  featureId: string,
  options: SketchResolveOptions,
): ExplodeOutcome {
  const index = document.features.findIndex((feature) => feature.id === featureId);
  if (index < 0) {
    return { ok: false, reason: 'missingElement', message: `指した図形が見つかりません: ${featureId}` };
  }
  const feature = document.features[index];
  if (!isExplodable(feature)) {
    return {
      ok: false,
      reason: 'unsupportedCurve',
      message: 'この図形は 1 本ずつの線に分けられません。',
    };
  }
  const resolved = resolveSketch(document, options);
  const curves = resolved.curvesByFeature.get(featureId);
  if (curves === undefined || curves.length === 0) {
    return { ok: false, reason: 'missingElement', message: 'この図形はまだ形が決まっていません。' };
  }
  const lookupPlane = options.workPlane ?? baseWorkPlane;
  const plane = lookupPlane(feature.planeId);
  if (plane === null) {
    return {
      ok: false,
      reason: 'missingElement',
      message: `作図面が見つかりません: ${feature.planeId}`,
    };
  }

  const remaining = document.features.filter((other) => other.id !== featureId);
  const created: (SketchLineFeature | SketchArcFeature)[] = [];
  for (const curve of curves) {
    // 名前と id の連番は、分解して出来たぶんも数に入れて決める(「線分3」「線分4」…)。
    const naming: SketchDocument = { ...document, features: [...remaining, ...created] };
    const piece = featureFromCurve(naming, curve, plane, feature.planeId, feature.construction);
    if (piece === null) {
      return {
        ok: false,
        reason: 'unsupportedCurve',
        message: 'この図形は 1 本ずつの線に分けられません。',
      };
    }
    created.push(piece);
  }
  const createdIds = created.map((piece) => piece.id);
  const features = [
    ...document.features.slice(0, index),
    ...created,
    ...document.features.slice(index + 1),
  ].map((other) => remapFeature(other, featureId, createdIds));
  return { ok: true, document: { ...document, features }, createdIds };
}

/* ------------------------------------------------------------------ *
 * 対象の下ごしらえ(必要なら分解する)
 * ------------------------------------------------------------------ */

interface PreparedTarget {
  readonly document: SketchDocument;
  readonly resolved: ResolvedSketch;
  readonly feature: SketchLineFeature | SketchArcFeature;
  readonly curve: ResolvedSegment | ResolvedArc;
}

type PrepareOutcome =
  | { readonly ok: true; readonly target: PreparedTarget }
  | { readonly ok: false; readonly reason: TrimErrorKey; readonly message: string };

const UNSUPPORTED_MESSAGE = '切り取り・延長ができるのは線分と円弧だけです。';

/** 分解後の文書から、線分か円弧のフィーチャーとその解決結果を取り出す。 */
function targetOf(
  document: SketchDocument,
  resolved: ResolvedSketch,
  featureId: string,
): PrepareOutcome {
  const feature = document.features.find((other) => other.id === featureId);
  if (feature === undefined) {
    return { ok: false, reason: 'missingElement', message: `指した線が見つかりません: ${featureId}` };
  }
  if (feature.kind !== 'line' && feature.kind !== 'arc') {
    return { ok: false, reason: 'unsupportedCurve', message: UNSUPPORTED_MESSAGE };
  }
  const curve = singleCurveOf(resolved, featureId);
  if (curve === null || (curve.kind !== 'segment' && curve.kind !== 'arc')) {
    return { ok: false, reason: 'missingElement', message: 'この線はまだ形が決まっていません。' };
  }
  return { ok: true, target: { document, resolved, feature, curve } };
}

/**
 * 指された要素を、切ったり伸ばしたりできる形(線分・円弧のフィーチャー 1 つ)にする。
 * 矩形・正多角形・長穴を指されたら、その場で分解してから選び直す。
 */
function prepareTarget(
  document: SketchDocument,
  elementId: string,
  hint: Vec3 | null,
  options: SketchResolveOptions,
): PrepareOutcome {
  const { featureId, index } = parseElementId(elementId);
  const feature = document.features.find((other) => other.id === featureId);
  if (feature === undefined) {
    return { ok: false, reason: 'missingElement', message: `指した線が見つかりません: ${featureId}` };
  }
  if (!isExplodable(feature)) {
    const resolved = resolveSketch(document, options);
    return targetOf(document, resolved, featureId);
  }
  const before = resolveSketch(document, options);
  const curves = before.curvesByFeature.get(featureId);
  if (curves === undefined || curves.length === 0) {
    return { ok: false, reason: 'missingElement', message: 'この図形はまだ形が決まっていません。' };
  }
  // どの 1 本を指したかは `featureId#n` の n で決まる。n が無ければクリック位置に近い 1 本。
  const picked =
    index !== null && curves[index] !== undefined
      ? index
      : hint === null
        ? 0
        : nearestCurveIndex(curves, hint);
  const exploded = explodeInto(document, featureId, options);
  if (!exploded.ok) {
    return { ok: false, reason: exploded.reason, message: exploded.message };
  }
  const pieceId = exploded.createdIds[picked];
  if (pieceId === undefined) {
    return { ok: false, reason: 'missingElement', message: 'この線はまだ形が決まっていません。' };
  }
  return targetOf(exploded.document, resolveSketch(exploded.document, options), pieceId);
}

/** 並んだ曲線のうち、指した点にいちばん近い 1 本の位置。 */
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

/* ------------------------------------------------------------------ *
 * 交点の集め方
 * ------------------------------------------------------------------ */

/** スケッチの中の曲線をすべて数え上げる(複数曲線フィーチャーの 1 本ずつを含む)。 */
function allCurves(resolved: ResolvedSketch): readonly ResolvedCurve[] {
  return [...resolved.segments, ...resolved.arcs, ...resolved.ellipses, ...resolved.splines];
}

/**
 * 対象の曲線を切る位置(0〜1)を集める。
 *
 * 開いた曲線では、端ちょうど(0 と 1)で交わっても区間が分かれないので落とす。
 * **輪になった曲線(全周の円)では端が曲線の途中**なので、0 も切る場所として数える
 * (1 は 0 と同じ位置なので 0 へ寄せる)。
 */
function cutRatios(
  target: ResolvedCurve,
  resolved: ResolvedSketch,
  closed: boolean,
): number[] {
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

/* ------------------------------------------------------------------ *
 * トリム
 * ------------------------------------------------------------------ */

/** 残す区間 1 つ(0〜1 のものさしの上。円のときは終わりが 1 を超えることがある)。 */
interface KeptRange {
  readonly from: number;
  readonly to: number;
}

/** 開いた曲線を切ったときに残る区間(0 個・1 個・2 個)。 */
function keptRangesOpen(cuts: readonly number[], clicked: number): readonly KeptRange[] {
  const bounds = [0, ...cuts, 1];
  let index = bounds.length - 2;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    if (clicked <= bounds[i + 1]) {
      index = i;
      break;
    }
  }
  const kept: KeptRange[] = [];
  if (bounds[index] > RATIO_EPSILON) {
    kept.push({ from: 0, to: bounds[index] });
  }
  if (bounds[index + 1] < 1 - RATIO_EPSILON) {
    kept.push({ from: bounds[index + 1], to: 1 });
  }
  return kept;
}

/**
 * 輪になった曲線(全周の円)を切ったときに残る区間。
 * 区間は端をまたいで一周するので、消す区間の**終わりから次の始まり**までの 1 本が残る。
 */
function keptRangesClosed(cuts: readonly number[], clicked: number): readonly KeptRange[] {
  // 既定は「最後の交点から 1 周ぶんの端をまたいで最初の交点まで」の区間。
  let removedStart = cuts[cuts.length - 1];
  let removedEnd = cuts[0] + 1;
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    if (clicked >= cuts[i] && clicked <= cuts[i + 1]) {
      removedStart = cuts[i];
      removedEnd = cuts[i + 1];
      break;
    }
  }
  // 残るのは消した区間の続き 1 本。角度が 1 周ぶん先へずれないよう 0〜1 の側へ寄せる。
  const shift = removedEnd >= 1 ? 1 : 0;
  return [{ from: removedEnd - shift, to: removedStart + 1 - shift }];
}

/** 残す区間 1 つを、線分か円弧のフィーチャーの欄へ写す。 */
function featureForRange(
  feature: SketchLineFeature | SketchArcFeature,
  curve: ResolvedSegment | ResolvedArc,
  range: KeptRange,
  id: string,
  name: string,
): SketchLineFeature | SketchArcFeature {
  if (feature.kind === 'line' && curve.kind === 'segment') {
    const from = curvePointAt(curve, range.from);
    const to = curvePointAt(curve, range.to);
    return {
      ...feature,
      id,
      name,
      from: absoluteCoordinate(from[0], from[1], from[2]),
      to: absoluteCoordinate(to[0], to[1], to[2]),
    };
  }
  if (feature.kind === 'arc' && curve.kind === 'arc') {
    // 中心・半径の式はそのまま。動かすのは角度だけ(このファイル冒頭の「数になる欄」)。
    const span = curve.endAngle - curve.startAngle;
    return {
      ...feature,
      id,
      name,
      startAngle: expressionValueFromNumber(
        radiansToDegrees(curve.startAngle + span * range.from),
      ),
      endAngle: expressionValueFromNumber(radiansToDegrees(curve.startAngle + span * range.to)),
    };
  }
  return feature;
}

/**
 * トリム(FR-322)。**クリックした位置を含む区間を消す**。
 *
 * 交点で区切った区間のうち、クリックした点が入っている 1 つを取り除く。
 * 端の区間を消せば線が短くなり、真ん中の区間を消せば線は 2 本に分かれる
 * (元のフィーチャーを 1 つ書き換え、残りをもう 1 つのフィーチャーとして足す)。
 * 円は切った残りが 1 本の円弧になる。
 */
export function trimCurve(
  document: SketchDocument,
  request: TrimRequest,
  options: SketchResolveOptions = {},
): TrimOutcome {
  const prepared = prepareTarget(document, request.elementId, request.at, options);
  if (!prepared.ok) {
    return refuse(prepared.reason, prepared.message);
  }
  const { document: prepDocument, resolved, feature, curve } = prepared.target;
  const closed = curve.kind === 'arc' && isFullCircle(curve);
  const cuts = cutRatios(curve, resolved, closed);
  if (cuts.length === 0) {
    if (curve.kind === 'segment' && hasConnectedSegmentEnd(curve, resolved)) {
      return { ok: true, document: { ...prepDocument,
        features: prepDocument.features.filter((other) => other.id !== feature.id),
        ...(prepDocument.constraints === undefined ? {} : {
          constraints: prepDocument.constraints.filter((constraint) => !constraintTargets(constraint).some((target) =>
            target.kind === 'point' ? target.pointId === feature.id || target.pointId.startsWith(`${feature.id}:`)
              : target.kind === 'vertex' ? target.featureId === feature.id : target.element.featureId === feature.id)),
        }),
      } };
    }
    return refuse('noIntersection', '交わる線・円弧が無いので、切り取る場所を決められません。');
  }
  if (closed && cuts.length < 2) {
    return refuse(
      'singleIntersection',
      '交わる点が 1 つだけなので、消す区間を決められません。もう 1 か所で交わらせてください。',
    );
  }
  const clicked = curveParameterNear(curve, request.at);
  const kept = closed ? keptRangesClosed(cuts, clicked) : keptRangesOpen(cuts, clicked);
  if (kept.length === 0) {
    return refuse('wholeCurve', '切り取ると何も残りません。');
  }
  const first = featureForRange(feature, curve, kept[0], feature.id, feature.name);
  let next: SketchDocument = {
    ...prepDocument,
    features: prepDocument.features.map((other) => (other.id === feature.id ? first : other)),
  };
  if (kept.length > 1) {
    // 真ん中を消したので 2 本に分かれる。残りは新しいフィーチャーとして履歴の末尾へ足す
    // (途中へ差し込むと、後ろのフィーチャーの「直前の点」(FR-302)の意味が変わるため)。
    next = appendFeature(
      next,
      featureForRange(
        feature,
        curve,
        kept[1],
        nextFeatureId(next, feature.kind),
        nextFeatureName(next, feature.kind),
      ),
    );
  }
  return { ok: true, document: next };
}

/* ------------------------------------------------------------------ *
 * 延長
 * ------------------------------------------------------------------ */

/** 伸ばす向きを試す長さ(mm)。スケッチ全体を確実に覆う長さにする。 */
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

/** 線分を、指定した端の外側へ伸ばした「試しの線分」。 */
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

/** 円弧を、指定した端の先へ「残りの周ぶん」伸ばした試しの円弧。 */
function probeArc(arc: ResolvedArc, end: 'start' | 'end'): ResolvedArc | null {
  const span = arc.endAngle - arc.startAngle;
  const rest = 2 * Math.PI - Math.abs(span);
  if (rest <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  const forward = span >= 0 ? 1 : -1;
  if (end === 'end') {
    return { ...arc, startAngle: arc.endAngle, endAngle: arc.endAngle + forward * rest };
  }
  return { ...arc, startAngle: arc.startAngle, endAngle: arc.startAngle - forward * rest };
}

/** 試しの曲線が最初にぶつかる相手との交点(自分と同じフィーチャーは相手にしない)。 */
function firstHit(
  probe: ResolvedCurve,
  resolved: ResolvedSketch,
  featureId: string,
): { readonly point: Vec3; readonly ratio: number } | null {
  let best: { readonly point: Vec3; readonly ratio: number } | null = null;
  for (const other of allCurves(resolved)) {
    if (other.featureId === featureId) {
      continue;
    }
    for (const found of curveIntersections(probe, other)) {
      if (found.onFirst <= RATIO_EPSILON) {
        continue;
      }
      if (best === null || found.onFirst < best.ratio) {
        best = { point: found.point, ratio: found.onFirst };
      }
    }
  }
  return best;
}

/**
 * 延長(FR-322)。指定した端を、その先で最初にぶつかる曲線まで伸ばす。
 *
 * 線分は同じ直線の上を、円弧は同じ円周の上を進む。ぶつかる相手が無ければ断る
 * (NFR-UX-5「実行してから失敗させない」の趣旨で、文書は変えずに理由を返す)。
 */
export function extendCurve(
  document: SketchDocument,
  request: ExtendRequest,
  options: SketchResolveOptions = {},
): TrimOutcome {
  const hint = request.at ?? null;
  const prepared = prepareTarget(document, request.elementId, hint, options);
  if (!prepared.ok) {
    return refuse(prepared.reason, prepared.message);
  }
  const { document: prepDocument, resolved, feature, curve } = prepared.target;
  const end = request.end ?? (hint === null ? 'end' : nearestCurveEnd(curve, hint));

  if (curve.kind === 'segment' && feature.kind === 'line') {
    const probe = probeSegment(curve, end, probeLength(resolved, curve.from));
    if (probe === null) {
      return refuse('unsupportedCurve', '線の向きが定まらないため伸ばせません。');
    }
    const hit = firstHit(probe, resolved, feature.id);
    if (hit === null) {
      return refuse('noBoundary', '伸ばした先にぶつかる線・円弧がありません。');
    }
    const moved = absoluteCoordinate(hit.point[0], hit.point[1], hit.point[2]);
    const next: SketchLineFeature =
      end === 'start' ? { ...feature, from: moved } : { ...feature, to: moved };
    return {
      ok: true,
      document: {
        ...prepDocument,
        features: prepDocument.features.map((other) => (other.id === feature.id ? next : other)),
      },
    };
  }

  if (curve.kind === 'arc' && feature.kind === 'arc') {
    const probe = probeArc(curve, end);
    if (probe === null) {
      return refuse('unsupportedCurve', '円は 1 周しているのでこれ以上伸ばせません。');
    }
    const hit = firstHit(probe, resolved, feature.id);
    if (hit === null) {
      return refuse('noBoundary', '伸ばした先にぶつかる線・円弧がありません。');
    }
    const probeSpan = probe.endAngle - probe.startAngle;
    const angle = probe.startAngle + probeSpan * hit.ratio;
    const next: SketchArcFeature =
      end === 'start'
        ? { ...feature, startAngle: expressionValueFromNumber(radiansToDegrees(angle)) }
        : { ...feature, endAngle: expressionValueFromNumber(radiansToDegrees(angle)) };
    return {
      ok: true,
      document: {
        ...prepDocument,
        features: prepDocument.features.map((other) => (other.id === feature.id ? next : other)),
      },
    };
  }

  return refuse('unsupportedCurve', UNSUPPORTED_MESSAGE);
}
