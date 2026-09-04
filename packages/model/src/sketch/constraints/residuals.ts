/**
 * 拘束の残差とヤコビアン(FR-313、計画書 docs/plans/P4b-スケッチの仕上げ.md §2.2、タスク5)。
 *
 * 変数の現在値 x(`VariableSet.variables` と同じ並び)から、拘束 1 つあたり 1〜2 本の
 * 残差 r(x) と、その偏微分(ヤコビアンの 1 行)を作る純関数を置く。連立の解き方(タスク6)と
 * 診断(タスク7)は、ここが返す行だけを見る。
 *
 * **偏微分は手で導いた解析式で書く**(数値微分に頼らない)。数値微分は打ち切り誤差と丸め誤差の
 * 板挟みで精度が出ず、変数の数だけ残差を数え直すので速度でも不利になる。正しさは検査で
 * 中心差分(h = 1e-6)と突き合わせて機械的に確かめる(`residuals.test.ts`)。
 *
 * **向きを使う残差は単位ベクトルにしてから外積・内積を取る**(§2.2)。線分の長さが残差の
 * 大きさに混ざると、長い線と短い線を同じ拘束でつないだときに長い側だけが大きく動く。
 *
 * 長さ 0 の線分・重なった点・半径 0 の円では単位ベクトルが作れないので、残差を作らずに
 * 日本語の理由を返す(NaN をソルバーへ流さない。FR-504、NFR-RE-1)。
 */

import { vertexKey } from '../resolveCoordinate.js';
import { SKETCH_TOLERANCE_MM } from '../vec3.js';
import type { ConstraintTarget, SketchConstraint } from './types.js';
import {
  canonicalPointKey,
  constraintPointKey,
  curveEndpointKeys,
  featureIdOfPointKey,
  pointComponentKey,
  pointValueAt,
  radiusComponentKey,
  radiusValueAt,
  type ImplicitCircleEquation,
  type RadiusKind,
  type VariableSet,
} from './variables.js';

/**
 * 残差 1 本と、その偏微分(変数の添字 → 値)。**0 の項は入れない**ので、1 行あたりの
 * 項数は 2〜8 個に収まる(疎な行)。`JᵀJ` の組み立て(タスク6)はこの疎さを前提にする。
 */
export interface ResidualRow {
  /** どの拘束が出した式か。円弧の暗黙の式は `implicit:` で始まる作り物の id。 */
  readonly constraintId: string;
  readonly value: number;
  readonly gradient: ReadonlyMap<number, number>;
}

/** 残差を作れなかった理由。 */
export type ResidualSkipReason =
  /** 指していた要素が見つからない(消された、別の作図面にある)。FR-504。 */
  | 'dangling'
  /** 長さ 0 の線分・重なった点・半径 0 の円で、向きや単位ベクトルが決まらない。 */
  | 'degenerate'
  /** 指し先の組み合わせがその拘束に合わない(円に平行拘束、線分に半径拘束など)。 */
  | 'unsupportedTarget';

/** 残差を作れなかった拘束 1 つ。理由の文は画面へそのまま出せる日本語で持つ(タスク7 が使う)。 */
export interface SkippedResidual {
  readonly constraintId: string;
  readonly reason: ResidualSkipReason;
  readonly message: string;
}

/** 残差の組み立ての結果。 */
export interface ResidualReport {
  /** 利用者の拘束の順 → 円弧の暗黙の式の順。同じ入力からは必ず同じ並び(決定性)。 */
  readonly rows: readonly ResidualRow[];
  readonly skipped: readonly SkippedResidual[];
}

/**
 * 円弧の暗黙の式(端点が円周の上にある)の id の接頭辞。利用者が付けた拘束の id と
 * 見分けるために付ける。診断(タスク7)は、この接頭辞の付いた id を利用者へ見せない。
 */
export const IMPLICIT_CONSTRAINT_ID_PREFIX = 'implicit:';

/** 円弧の暗黙の式の id。端点の鍵にフィーチャー id が含まれるので、式ごとに一意になる。 */
export function implicitEquationId(equation: ImplicitCircleEquation): string {
  return `${IMPLICIT_CONSTRAINT_ID_PREFIX}${equation.pointKey}`;
}

/** その id が円弧の暗黙の式のものか。 */
export function isImplicitConstraintId(constraintId: string): boolean {
  return constraintId.startsWith(IMPLICIT_CONSTRAINT_ID_PREFIX);
}

// --- 変数と定数の読み取り -------------------------------------------------

/** 1 つの点。列が null なら定数(勾配の項を作らない)。 */
interface PointRef {
  readonly u: number;
  readonly v: number;
  readonly uColumn: number | null;
  readonly vColumn: number | null;
}

/** 1 つの数(半径)。列が null なら定数。 */
interface ScalarRef {
  readonly value: number;
  readonly column: number | null;
}

/** 向きを持つ要素(線分)。単位ベクトルは長さが 0 のとき (0, 0) になるので、必ず length を見る。 */
interface LineRef {
  readonly start: PointRef;
  readonly end: PointRef;
  readonly unitU: number;
  readonly unitV: number;
  readonly length: number;
}

/** 半径を持つ要素(円・円弧・楕円)。 */
interface CircleRef {
  readonly center: PointRef;
  readonly radius: ScalarRef;
}

/**
 * 半径を探す順。円・円弧は `radius`、楕円は長半径 `major` を採る。
 * 短半径だけを指す道具は P4b では作らないので、ここでは扱わない(タスク12 の範囲)。
 */
const RADIUS_KINDS: readonly RadiusKind[] = ['radius', 'major'];

/** **正本の鍵**(`canonicalPointKey` / `curveEndpointKeys` が返した鍵)を渡す。 */
function readPoint(
  variableSet: VariableSet,
  x: readonly number[],
  pointKey: string | null,
): PointRef | null {
  if (pointKey === null) {
    return null;
  }
  const position = pointValueAt(variableSet, x, pointKey);
  if (position === null) {
    return null;
  }
  return {
    u: position[0],
    v: position[1],
    uColumn: variableSet.index.get(pointComponentKey(pointKey, 'u')) ?? null,
    vColumn: variableSet.index.get(pointComponentKey(pointKey, 'v')) ?? null,
  };
}

function readRadius(
  variableSet: VariableSet,
  x: readonly number[],
  featureId: string,
): ScalarRef | null {
  for (const kind of RADIUS_KINDS) {
    const value = radiusValueAt(variableSet, x, featureId, kind);
    if (value !== null) {
      return {
        value,
        column: variableSet.index.get(radiusComponentKey(featureId, kind)) ?? null,
      };
    }
  }
  return null;
}

/** 指し先を作ったフィーチャーの id。 */
function featureIdOfTarget(target: ConstraintTarget): string {
  switch (target.kind) {
    case 'curve':
      return target.element.featureId;
    case 'vertex':
      return target.featureId;
    case 'point':
      return featureIdOfPointKey(target.pointId);
  }
}

function makeLine(start: PointRef, end: PointRef): LineRef {
  const deltaU = end.u - start.u;
  const deltaV = end.v - start.v;
  // 2 次元では `Math.hypot` より素朴な `Math.sqrt` が速く、精度の差は実用上出ない
  // (残差はドラッグ中に毎フレーム回るため。タスク5 の落とし穴)。
  const length = Math.sqrt(deltaU * deltaU + deltaV * deltaV);
  const scale = length > 0 ? 1 / length : 0;
  return { start, end, unitU: deltaU * scale, unitV: deltaV * scale, length };
}

/**
 * 向きを使う拘束(平行・直角・角度・接線の線側・水平・垂直・対称の軸)が読む線分。
 * **半径を持つ要素は線として読まない**(円・円弧の両端を結んだ弦の向きは形を表さないため)。
 */
function readLine(
  variableSet: VariableSet,
  x: readonly number[],
  target: ConstraintTarget,
): LineRef | null {
  const featureId = featureIdOfTarget(target);
  if (readRadius(variableSet, x, featureId) !== null) {
    return null;
  }
  const keys = curveEndpointKeys(variableSet, featureId);
  if (keys === null) {
    return null;
  }
  const start = readPoint(variableSet, x, keys[0]);
  const end = readPoint(variableSet, x, keys[1]);
  return start === null || end === null ? null : makeLine(start, end);
}

/** 半径を持つ要素。中心は必ず `featureId:center`(`vertexKey` の規約)。 */
function readCircle(
  variableSet: VariableSet,
  x: readonly number[],
  target: ConstraintTarget,
): CircleRef | null {
  const featureId = featureIdOfTarget(target);
  const radius = readRadius(variableSet, x, featureId);
  if (radius === null) {
    return null;
  }
  const center = readPoint(
    variableSet,
    x,
    canonicalPointKey(variableSet, vertexKey(featureId, 'center')),
  );
  return center === null ? null : { center, radius };
}

/**
 * 中心の点。同心拘束は円どうしだけでなく、正多角形の中心や点フィーチャーも相手にできる
 * ので、半径の有無を問わずに中心を探す。
 */
function readCenter(
  variableSet: VariableSet,
  x: readonly number[],
  target: ConstraintTarget,
): PointRef | null {
  if (target.kind === 'curve') {
    return readPoint(
      variableSet,
      x,
      canonicalPointKey(variableSet, vertexKey(target.element.featureId, 'center')),
    );
  }
  return readPoint(variableSet, x, constraintPointKey(variableSet, target));
}

// --- 勾配の組み立て -------------------------------------------------------

function addTerm(gradient: Map<number, number>, column: number | null, coefficient: number): void {
  if (column === null || coefficient === 0) {
    return;
  }
  gradient.set(column, (gradient.get(column) ?? 0) + coefficient);
}

function addPointTerm(
  gradient: Map<number, number>,
  point: PointRef,
  alongU: number,
  alongV: number,
): void {
  addTerm(gradient, point.uColumn, alongU);
  addTerm(gradient, point.vColumn, alongV);
}

/**
 * 単位ベクトル û についての勾配 (gu, gv) を、もとのベクトル d = 終点 − 始点 についての
 * 勾配へ直して両端点へ配る。`d(û)/d(d) = (I − ûûᵀ)/|d|` なので
 * `∂r/∂d = (g − û(û·g))/|d|` になる。始点は d に −1 で効くので符号を反転する。
 */
function addDirectionTerms(
  gradient: Map<number, number>,
  line: LineRef,
  alongU: number,
  alongV: number,
): void {
  const projection = line.unitU * alongU + line.unitV * alongV;
  const deltaU = (alongU - line.unitU * projection) / line.length;
  const deltaV = (alongV - line.unitV * projection) / line.length;
  addPointTerm(gradient, line.end, deltaU, deltaV);
  addPointTerm(gradient, line.start, -deltaU, -deltaV);
}

/** 打ち消し合って 0 になった項を落とす(疎な行を保つ)。 */
function finish(gradient: Map<number, number>): ReadonlyMap<number, number> {
  for (const [column, coefficient] of gradient) {
    if (coefficient === 0) {
      gradient.delete(column);
    }
  }
  return gradient;
}

function rowOf(
  constraintId: string,
  value: number,
  gradient: Map<number, number>,
): ResidualRow {
  return { constraintId, value, gradient: finish(gradient) };
}

// --- 拘束 1 つぶんの残差 --------------------------------------------------

type ResidualOutcome =
  | { readonly ok: true; readonly rows: readonly ResidualRow[] }
  | { readonly ok: false; readonly reason: ResidualSkipReason };

const NO_ROWS: ResidualOutcome = { ok: true, rows: [] };

function ok(rows: readonly ResidualRow[]): ResidualOutcome {
  return { ok: true, rows };
}

function skip(reason: ResidualSkipReason): ResidualOutcome {
  return { ok: false, reason };
}

/** 点を 2 つ取る拘束(一致・距離・対称)は、曲線そのものを指されたら組み合わせ違いで断る。 */
function isPointTarget(target: ConstraintTarget): boolean {
  return target.kind !== 'curve';
}

/** 一致・同心が使う「2 点が重なる」2 本。 */
function samePointRows(id: string, p: PointRef, q: PointRef): readonly ResidualRow[] {
  const alongU = new Map<number, number>();
  addPointTerm(alongU, p, 1, 0);
  addPointTerm(alongU, q, -1, 0);
  const alongV = new Map<number, number>();
  addPointTerm(alongV, p, 0, 1);
  addPointTerm(alongV, q, 0, -1);
  return [rowOf(id, p.u - q.u, alongU), rowOf(id, p.v - q.v, alongV)];
}

function coincidentOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
): ResidualOutcome {
  if (!isPointTarget(a) || !isPointTarget(b)) {
    return skip('unsupportedTarget');
  }
  const p = readPoint(variableSet, x, constraintPointKey(variableSet, a));
  const q = readPoint(variableSet, x, constraintPointKey(variableSet, b));
  if (p === null || q === null) {
    return skip('dangling');
  }
  return ok(samePointRows(id, p, q));
}

function concentricOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
): ResidualOutcome {
  const p = readCenter(variableSet, x, a);
  const q = readCenter(variableSet, x, b);
  if (p === null || q === null) {
    return skip('dangling');
  }
  return ok(samePointRows(id, p, q));
}

/**
 * 水平・垂直。線分の 2 端点の成分の差なので、長さ 0 の線分でも意味が決まる
 * (単位ベクトルを作らない)。縮退で断らないのはそのため。
 */
function axisAlignedOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  target: ConstraintTarget,
  kind: 'horizontal' | 'vertical',
): ResidualOutcome {
  const line = readLine(variableSet, x, target);
  if (line === null) {
    return skip('unsupportedTarget');
  }
  const gradient = new Map<number, number>();
  if (kind === 'horizontal') {
    // 作図面の第 2 軸(v)の値がそろう = 面の中で水平。
    addPointTerm(gradient, line.start, 0, 1);
    addPointTerm(gradient, line.end, 0, -1);
    return ok([rowOf(id, line.start.v - line.end.v, gradient)]);
  }
  addPointTerm(gradient, line.start, 1, 0);
  addPointTerm(gradient, line.end, -1, 0);
  return ok([rowOf(id, line.start.u - line.end.u, gradient)]);
}

/** 平行(単位ベクトルの外積 = 0)・直角(単位ベクトルの内積 = 0)。 */
function directionPairOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
  kind: 'parallel' | 'perpendicular',
): ResidualOutcome {
  const first = readLine(variableSet, x, a);
  const second = readLine(variableSet, x, b);
  if (first === null || second === null) {
    return skip('unsupportedTarget');
  }
  if (first.length <= SKETCH_TOLERANCE_MM || second.length <= SKETCH_TOLERANCE_MM) {
    return skip('degenerate');
  }
  const gradient = new Map<number, number>();
  if (kind === 'parallel') {
    const value = first.unitU * second.unitV - first.unitV * second.unitU;
    addDirectionTerms(gradient, first, second.unitV, -second.unitU);
    addDirectionTerms(gradient, second, -first.unitV, first.unitU);
    return ok([rowOf(id, value, gradient)]);
  }
  const value = first.unitU * second.unitU + first.unitV * second.unitV;
  addDirectionTerms(gradient, first, second.unitU, second.unitV);
  addDirectionTerms(gradient, second, first.unitU, first.unitV);
  return ok([rowOf(id, value, gradient)]);
}

/**
 * 接線。中心から直線までの符号つき距離 − 半径。
 * 符号つき距離は `cross(中心 − 始点, û)` で、直線のどちら側にあるかを符号で持つ。
 * 符号を潰す絶対値を取らないのは、絶対値が 0 で微分できず Newton が止まるため。
 */
function tangentOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  lineTarget: ConstraintTarget,
  circleTarget: ConstraintTarget,
): ResidualOutcome {
  const line = readLine(variableSet, x, lineTarget);
  const circle = readCircle(variableSet, x, circleTarget);
  if (line === null || circle === null) {
    return skip('unsupportedTarget');
  }
  if (line.length <= SKETCH_TOLERANCE_MM || circle.radius.value <= SKETCH_TOLERANCE_MM) {
    return skip('degenerate');
  }
  const offsetU = circle.center.u - line.start.u;
  const offsetV = circle.center.v - line.start.v;
  const value = offsetU * line.unitV - offsetV * line.unitU - circle.radius.value;
  const gradient = new Map<number, number>();
  addPointTerm(gradient, circle.center, line.unitV, -line.unitU);
  // 始点は「中心 − 始点」にも直接効く(向きを通した効き方は addDirectionTerms が足す)。
  addPointTerm(gradient, line.start, -line.unitV, line.unitU);
  addDirectionTerms(gradient, line, -offsetV, offsetU);
  addTerm(gradient, circle.radius.column, -1);
  return ok([rowOf(id, value, gradient)]);
}

/** 等しい。円どうしは半径の差、線分どうしは長さの差(§2.2)。 */
function equalOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
): ResidualOutcome {
  const firstCircle = readCircle(variableSet, x, a);
  const secondCircle = readCircle(variableSet, x, b);
  if (firstCircle !== null && secondCircle !== null) {
    const gradient = new Map<number, number>();
    addTerm(gradient, firstCircle.radius.column, 1);
    addTerm(gradient, secondCircle.radius.column, -1);
    return ok([rowOf(id, firstCircle.radius.value - secondCircle.radius.value, gradient)]);
  }
  const first = readLine(variableSet, x, a);
  const second = readLine(variableSet, x, b);
  if (first === null || second === null) {
    return skip('unsupportedTarget');
  }
  if (first.length <= SKETCH_TOLERANCE_MM || second.length <= SKETCH_TOLERANCE_MM) {
    // 長さの微分は単位ベクトルそのものなので、長さ 0 では向きが決まらない。
    return skip('degenerate');
  }
  const gradient = new Map<number, number>();
  addPointTerm(gradient, first.end, first.unitU, first.unitV);
  addPointTerm(gradient, first.start, -first.unitU, -first.unitV);
  addPointTerm(gradient, second.end, -second.unitU, -second.unitV);
  addPointTerm(gradient, second.start, second.unitU, second.unitV);
  return ok([rowOf(id, first.length - second.length, gradient)]);
}

/**
 * 対称。2 本の式で「軸をはさんで向かい合う」を表す。
 * ① 2 点の中点が軸の上にある(軸の法線方向の符号つき距離 = 0)。
 * ② 2 点を結ぶ線が軸に直交する(軸の向きとの内積 = 0)。
 *
 * 軸の線分そのものが変数のこともあるので、軸の端点にも勾配を出す(定数と決めつけない)。
 */
function symmetricOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
  axisTarget: ConstraintTarget,
): ResidualOutcome {
  if (!isPointTarget(a) || !isPointTarget(b)) {
    return skip('unsupportedTarget');
  }
  const p = readPoint(variableSet, x, constraintPointKey(variableSet, a));
  const q = readPoint(variableSet, x, constraintPointKey(variableSet, b));
  const axis = readLine(variableSet, x, axisTarget);
  if (p === null || q === null) {
    return skip('dangling');
  }
  if (axis === null) {
    return skip('unsupportedTarget');
  }
  if (axis.length <= SKETCH_TOLERANCE_MM) {
    return skip('degenerate');
  }
  // 中点から軸の始点までの差。軸の法線は (−û.v, û.u)。
  const middleU = (p.u + q.u) / 2 - axis.start.u;
  const middleV = (p.v + q.v) / 2 - axis.start.v;
  const onAxisValue = -middleU * axis.unitV + middleV * axis.unitU;
  const onAxis = new Map<number, number>();
  addPointTerm(onAxis, p, -axis.unitV / 2, axis.unitU / 2);
  addPointTerm(onAxis, q, -axis.unitV / 2, axis.unitU / 2);
  addPointTerm(onAxis, axis.start, axis.unitV, -axis.unitU);
  addDirectionTerms(onAxis, axis, middleV, -middleU);

  const acrossU = p.u - q.u;
  const acrossV = p.v - q.v;
  const acrossValue = acrossU * axis.unitU + acrossV * axis.unitV;
  const across = new Map<number, number>();
  addPointTerm(across, p, axis.unitU, axis.unitV);
  addPointTerm(across, q, -axis.unitU, -axis.unitV);
  addDirectionTerms(across, axis, acrossU, acrossV);

  return ok([rowOf(id, onAxisValue, onAxis), rowOf(id, acrossValue, across)]);
}

/** 距離。2 点の間の長さ − 目標値。 */
function distanceOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
  target: number,
): ResidualOutcome {
  if (!isPointTarget(a) || !isPointTarget(b)) {
    return skip('unsupportedTarget');
  }
  const p = readPoint(variableSet, x, constraintPointKey(variableSet, a));
  const q = readPoint(variableSet, x, constraintPointKey(variableSet, b));
  if (p === null || q === null) {
    return skip('dangling');
  }
  const span = makeLine(q, p);
  if (span.length <= SKETCH_TOLERANCE_MM) {
    // 重なった点は向きが決まらないので、どちらへ離せばよいか決められない。
    return skip('degenerate');
  }
  const gradient = new Map<number, number>();
  addPointTerm(gradient, p, span.unitU, span.unitV);
  addPointTerm(gradient, q, -span.unitU, -span.unitV);
  return ok([rowOf(id, span.length - target, gradient)]);
}

/**
 * 角度。`dot(û1, û2)·sinθ − cross(û1, û2)·cosθ`(§2.2)。
 * `atan2` の差で書くと ±180° をまたいだところで不連続になり Newton が発散するので採らない。
 * 目標の角度は度で持つ(`ExpressionValue` の角度欄の約束)ので、ここで弧度へ直す。
 */
function angleOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
  degrees: number,
): ResidualOutcome {
  const first = readLine(variableSet, x, a);
  const second = readLine(variableSet, x, b);
  if (first === null || second === null) {
    return skip('unsupportedTarget');
  }
  if (first.length <= SKETCH_TOLERANCE_MM || second.length <= SKETCH_TOLERANCE_MM) {
    return skip('degenerate');
  }
  const radians = (degrees * Math.PI) / 180;
  const sine = Math.sin(radians);
  const cosine = Math.cos(radians);
  const dot = first.unitU * second.unitU + first.unitV * second.unitV;
  const cross = first.unitU * second.unitV - first.unitV * second.unitU;
  const gradient = new Map<number, number>();
  addDirectionTerms(
    gradient,
    first,
    sine * second.unitU - cosine * second.unitV,
    sine * second.unitV + cosine * second.unitU,
  );
  addDirectionTerms(
    gradient,
    second,
    sine * first.unitU + cosine * first.unitV,
    sine * first.unitV - cosine * first.unitU,
  );
  return ok([rowOf(id, dot * sine - cross * cosine, gradient)]);
}

/** 半径・直径。半径そのものを目標値に合わせる(直径は 2 倍)。 */
function sizeOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  id: string,
  target: ConstraintTarget,
  size: number,
  kind: 'radius' | 'diameter',
): ResidualOutcome {
  const circle = readCircle(variableSet, x, target);
  if (circle === null) {
    return skip('unsupportedTarget');
  }
  const factor = kind === 'radius' ? 1 : 2;
  const gradient = new Map<number, number>();
  addTerm(gradient, circle.radius.column, factor);
  return ok([rowOf(id, factor * circle.radius.value - size, gradient)]);
}

/** 拘束 1 つの残差。ここが `switch` の唯一の場所(種類ごとの式は 1 種 = 1 関数)。 */
function constraintOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  constraint: SketchConstraint,
): ResidualOutcome {
  const id = constraint.id;
  switch (constraint.kind) {
    case 'coincident':
      return coincidentOutcome(variableSet, x, id, constraint.a, constraint.b);
    case 'horizontal':
    case 'vertical':
      return axisAlignedOutcome(variableSet, x, id, constraint.target, constraint.kind);
    case 'parallel':
    case 'perpendicular':
      return directionPairOutcome(variableSet, x, id, constraint.a, constraint.b, constraint.kind);
    case 'tangent':
      return tangentOutcome(variableSet, x, id, constraint.line, constraint.circle);
    case 'concentric':
      return concentricOutcome(variableSet, x, id, constraint.a, constraint.b);
    case 'equal':
      return equalOutcome(variableSet, x, id, constraint.a, constraint.b);
    case 'symmetric':
      return symmetricOutcome(variableSet, x, id, constraint.a, constraint.b, {
        kind: 'curve',
        element: constraint.axis,
      });
    case 'fix':
      // 固定は式を足さず、変数を減らす道具(`collectVariables` が済ませている)。
      return NO_ROWS;
    case 'distance':
      return distanceOutcome(variableSet, x, id, constraint.a, constraint.b, constraint.length.value);
    case 'angle':
      return angleOutcome(variableSet, x, id, constraint.a, constraint.b, constraint.angle.value);
    case 'radius':
    case 'diameter':
      return sizeOutcome(variableSet, x, id, constraint.target, constraint.size.value, constraint.kind);
  }
}

/**
 * 円弧の暗黙の式(端点が円周の上にある。|P − C| − r = 0)。
 * 円弧の端点を変数にした代わりに立てる式で、利用者の拘束ではない(統括の決定 2026-09-04)。
 */
function implicitOutcome(
  variableSet: VariableSet,
  x: readonly number[],
  equation: ImplicitCircleEquation,
): ResidualOutcome {
  const id = implicitEquationId(equation);
  const point = readPoint(variableSet, x, canonicalPointKey(variableSet, equation.pointKey));
  const center = readPoint(variableSet, x, canonicalPointKey(variableSet, equation.centerKey));
  const radius = readRadius(variableSet, x, equation.featureId);
  if (point === null || center === null || radius === null) {
    return skip('dangling');
  }
  const spoke = makeLine(center, point);
  if (spoke.length <= SKETCH_TOLERANCE_MM) {
    return skip('degenerate');
  }
  const gradient = new Map<number, number>();
  addPointTerm(gradient, point, spoke.unitU, spoke.unitV);
  addPointTerm(gradient, center, -spoke.unitU, -spoke.unitV);
  addTerm(gradient, radius.column, -1);
  return ok([rowOf(id, spoke.length - radius.value, gradient)]);
}

// --- 断りの文 -------------------------------------------------------------

function skipMessage(label: string, reason: ResidualSkipReason): string {
  switch (reason) {
    case 'dangling':
      return `${label}が指している要素が見つかりません。要素が消されたか、別の作図面にあります。`;
    case 'degenerate':
      return `${label}は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。`;
    case 'unsupportedTarget':
      return `${label}は、選んだ要素の組み合わせには付けられません。`;
  }
}

/** 円弧の暗黙の式が作れないときの断り。利用者は付けた覚えのない式なので、円弧の側から言う。 */
function implicitMessage(featureId: string, reason: ResidualSkipReason): string {
  return reason === 'degenerate'
    ? `${featureId} は中心と端点が重なっていて、円弧の形を保てません。`
    : `${featureId} の中心・端点・半径がそろっていないので、円弧の形を保てません。`;
}

// --- 入口 -----------------------------------------------------------------

/**
 * すべての拘束と円弧の暗黙の式から、残差の行と、作れなかったものの一覧を作る。
 *
 * 並びは「利用者の拘束の順 → 円弧の暗黙の式の順」で決め打ちする(決定性。同じ入力からは
 * 必ず同じ行の並びになり、階数の数え方(タスク7)も揺れない)。
 */
export function buildResidualReport(
  constraints: readonly SketchConstraint[],
  variableSet: VariableSet,
  x: readonly number[],
): ResidualReport {
  const rows: ResidualRow[] = [];
  const skipped: SkippedResidual[] = [];
  for (const constraint of constraints) {
    const outcome = constraintOutcome(variableSet, x, constraint);
    if (outcome.ok) {
      rows.push(...outcome.rows);
      continue;
    }
    skipped.push({
      constraintId: constraint.id,
      reason: outcome.reason,
      message: skipMessage(constraint.name, outcome.reason),
    });
  }
  for (const equation of variableSet.implicit) {
    const outcome = implicitOutcome(variableSet, x, equation);
    if (outcome.ok) {
      rows.push(...outcome.rows);
      continue;
    }
    skipped.push({
      constraintId: implicitEquationId(equation),
      reason: outcome.reason,
      message: implicitMessage(equation.featureId, outcome.reason),
    });
  }
  return { rows, skipped };
}

/**
 * 残差の行だけを作る(連立を解く反復から毎回呼ばれる入口。タスク6)。
 * 断りの一覧が要るときは `buildResidualReport` を使う。
 */
export function buildResiduals(
  constraints: readonly SketchConstraint[],
  variableSet: VariableSet,
  x: readonly number[],
): readonly ResidualRow[] {
  return buildResidualReport(constraints, variableSet, x).rows;
}
