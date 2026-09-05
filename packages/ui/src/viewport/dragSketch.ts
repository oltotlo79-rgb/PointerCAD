/**
 * 要素を引っぱって形を変える(FR-313「1 つの要素を動かすと、拘束でつながった要素が
 * 条件を満たす位置へ一緒に動く」、NFR-UX-2、NFR-PF-1。
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク14)。
 *
 * ここは純関数だけを置く。DOM にも three.js にもストアにも触れないので、Node の検査で
 * そのまま確かめられる(`attachSketchInteraction.ts` は DOM を直に触るため検査から外れる、
 * P1 §0.8)。ポインタの位置を作図面の (u, v) へ直す仕事は呼び出し側が受け持つ。
 *
 * **引っぱっている間、文書は 1 か所も書き換えない。** `pointermove` のたびに文書を作り直すと
 * 取り消しの段がその数だけ増える(NFR-UX-3)し、面の張り直し(幾何カーネルの往復)まで
 * 起きて 1 コマに間に合わない(§2.9)。表示は解いた形だけを差し替え、文書へ書き戻すのは
 * **離した 1 回だけ**(取り消し 1 回で元へ戻る)。
 *
 * 解き方は model の**軟らかい目標+拘束優先**(§0.a 追記 3。`resolveConstrainedSketch` の
 * `pinned`)。拘束を先に満たしたうえで、残った自由度のぶんだけポインタへ寄る。
 */

import { exactExpressionValueFromNumber } from '@pointercad/expression';
import {
  canonicalPointKey,
  dotVec3,
  featureIdOfPointKey,
  findFeature,
  ORIGIN,
  pointValueAt,
  radiansToDegrees,
  replaceFeature,
  resolveConstrainedSketch,
  subShapeFromFingerprint,
  subVec3,
  vertexKey,
  type ConstrainedSketch,
  type ConstraintTarget,
  type CoordinateInput,
  type PointReference,
  type ResolvedSketch,
  type SketchDocument,
  type SketchFeature,
  type SketchResolveOptions,
  type VariableSet,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { vertexPositionOf } from '../sketch/constraintCommands.js';

/** 引っぱっている点が書き換える欄。**確定のときに取り違えない**ための札(過去の失敗)。 */
export type DragField =
  /** 点フィーチャーの `at`。 */
  | 'at'
  /** 線分の `from`。 */
  | 'from'
  /** 線分の `to`。 */
  | 'to'
  /** 円弧・楕円の `center`。 */
  | 'center'
  /** スプラインの `points[index]`。`SketchDrag.index` が何番目かを持つ。 */
  | 'splinePoint';

/** 引っぱっている最中の状態(表示専用。文書は変えない)。 */
export interface SketchDrag {
  /** 引っぱっている点の鍵(`ResolvedPoint.id` / `vertexKey` の規約。別名は正本へ寄せてある)。 */
  readonly pointKey: string;
  /** その点を持つフィーチャーの id。 */
  readonly featureId: string;
  /** 書き換える欄(確定のときに使う)。 */
  readonly field: DragField;
  /** スプラインのときだけ、点の並びの何番目か。それ以外は null。 */
  readonly index: number | null;
  /** 押した瞬間の、その点の作図面上の位置。 */
  readonly startUv: readonly [number, number];
  /** 押した瞬間の、ポインタの作図面上の位置。点との差を保ったまま動かすのに使う。 */
  readonly grabUv: readonly [number, number];
}

/** 引っぱれない理由。押した瞬間に帯へ出す(NFR-UX-5「実行前に理由を出す」)。 */
export type DragRefusalReason =
  /** 座標が式で書かれている(§0.a-0.2。式は拘束より強い)。 */
  | 'expression'
  /** 「固定」拘束で留められている。 */
  | 'fixed'
  /**
   * 座標が相対・極で書かれている(基準が動けば追従するので、独立して動かすと二重定義になる)。
   * `derived` のうち**利用者が直せるもの**なので、直し方を言えるように分けて持つ。
   */
  | 'relative'
  /** 規則から作られる点(点列・複製・オフセット・投影・矩形・正多角形・長穴)。 */
  | 'derived'
  /** 円弧・楕円の端。中心・半径・角度から決まるので、端だけを書き戻せない。 */
  | 'arcEndpoint'
  /** 3D スケッチ(作図面が無いので (u, v) が決まらない。§0.a-0.3)。 */
  | 'freeSketch';

/** 引っぱれないときの答え。 */
export interface DragRefusal {
  readonly reason: DragRefusalReason;
}

/** 理由ごとの帯の文言(`ja.json` が正本。ここは対応表だけを持つ)。 */
export const DRAG_REFUSAL_MESSAGE_KEYS = {
  expression: 'drag.error.expression',
  fixed: 'drag.error.fixed',
  relative: 'drag.error.relative',
  derived: 'drag.error.derived',
  arcEndpoint: 'drag.error.arcEndpoint',
  freeSketch: 'drag.error.freeSketch',
} as const satisfies Record<DragRefusalReason, MessageKey>;

/** 引っぱれない理由の文言キー。 */
export function dragRefusalMessageKey(reason: DragRefusalReason): MessageKey {
  return DRAG_REFUSAL_MESSAGE_KEYS[reason];
}

/** 答えが「引っぱれる」かどうか。 */
export function isDraggable(outcome: SketchDrag | DragRefusal | null): outcome is SketchDrag {
  return outcome !== null && !('reason' in outcome);
}

/** 拘束の指し先を、点の鍵へ直す。曲線そのものを指しているときは null。 */
function pointKeyOfTarget(target: ConstraintTarget): string | null {
  if (target.kind === 'curve') {
    return null;
  }
  return target.kind === 'point' ? target.pointId : vertexKey(target.featureId, target.vertex);
}

/** 点の鍵の末尾(`line-1:end` なら `end`)。`featureId#3` のような番号つきは null。 */
function vertexOfPointKey(pointKey: string): string | null {
  const colon = pointKey.lastIndexOf(':');
  return colon < 0 ? null : pointKey.slice(colon + 1);
}

/** 点の鍵の番号(`spline-1#3` なら 3)。番号を持たない鍵は null。 */
function indexOfPointKey(pointKey: string): number | null {
  const hash = pointKey.lastIndexOf('#');
  if (hash < 0) {
    return null;
  }
  const parsed = Number.parseInt(pointKey.slice(hash + 1), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * その点の鍵が、どのフィーチャーのどの欄にあたるか。書き戻せない点は理由を返す。
 *
 * **どの欄を書き換えるかをここ 1 か所で決める**(P4 タスク14 の失敗「確定のときに
 * どの点を書き換えるかを取り違えて線分の長さが 0 になった」の再発防止)。
 */
function fieldOf(
  feature: SketchFeature,
  pointKey: string,
): { readonly field: DragField; readonly index: number | null } | DragRefusal {
  const vertex = vertexOfPointKey(pointKey);
  switch (feature.kind) {
    case 'point':
      return { field: 'at', index: null };
    case 'line':
      if (vertex === 'start') {
        return { field: 'from', index: null };
      }
      if (vertex === 'end') {
        return { field: 'to', index: null };
      }
      return { reason: 'derived' };
    case 'arc':
    case 'ellipse':
      if (vertex === 'center') {
        return { field: 'center', index: null };
      }
      // 端は中心・半径・角度から導かれるので、端だけを座標として書き戻せない。
      return { reason: 'arcEndpoint' };
    case 'spline': {
      const index = indexOfPointKey(pointKey);
      return index === null || index >= feature.points.length
        ? { reason: 'derived' }
        : { field: 'splinePoint', index };
    }
    default:
      // 点列・矩形・正多角形・長穴・オフセット・複製・投影・断面・面。
      return { reason: 'derived' };
  }
}

/** その欄に入っている座標。欄が合わなければ null。 */
function coordinateOf(
  feature: SketchFeature,
  field: DragField,
  index: number | null,
): CoordinateInput | null {
  switch (field) {
    case 'at':
      return feature.kind === 'point' ? feature.at : null;
    case 'from':
      return feature.kind === 'line' ? feature.from : null;
    case 'to':
      return feature.kind === 'line' ? feature.to : null;
    case 'center':
      return feature.kind === 'arc' || feature.kind === 'ellipse' ? feature.center : null;
    case 'splinePoint':
      return feature.kind === 'spline' && index !== null ? (feature.points[index] ?? null) : null;
  }
}

/**
 * 動かせない理由を、利用者が直せる形まで細かくする。
 *
 * **数で書かれた相対・極の点は引っぱれる**(統括の決定 2026-09-05、案 A。P4b タスク22b)。
 * 式で書かれていれば model が `expression` と言うのでここへは来ない。ここへ来る相対・極は
 * 「基準そのものが解けていない」場合で、指定方法を絶対へ切り替えれば動かせるので、
 * 直し方を言えるように `derived` と分けて出す(NFR-UX-5)。判定は文書に入っている指定方法を
 * 読むだけで、model の規約(何を変数にするか)は 1 つのままにする。
 */
function refineFrozenReason(
  feature: SketchFeature,
  field: DragField,
  index: number | null,
  frozen: DragRefusalReason,
): DragRefusalReason {
  if (frozen !== 'derived') {
    return frozen;
  }
  const input = coordinateOf(feature, field, index);
  return input !== null && input.mode !== 'absolute' ? 'relative' : 'derived';
}

/**
 * 押した相手を引っぱれるか(FR-313)。引っぱれるなら引っぱりの状態、引っぱれないなら理由、
 * そもそも点を指していなければ null。
 *
 * `variableSet` は「動かせる数」と「動かせない理由」の正本(model の `collectVariables`)。
 * 画面の側で判定をもう 1 つ作らないため、**式・固定・導かれるの見分けはすべてこれに任せる**。
 * `grabUv` は押した瞬間のポインタの位置で、点との差を保ったまま動かすのに使う
 * (端から少しずれて掴んでも点が指へ飛びつかない)。
 */
export function draggableAt(
  document: SketchDocument,
  variableSet: VariableSet,
  target: ConstraintTarget,
  grabUv: readonly [number, number],
): SketchDrag | DragRefusal | null {
  const raw = pointKeyOfTarget(target);
  if (raw === null) {
    return null;
  }
  const pointKey = canonicalPointKey(variableSet, raw);
  if (pointKey === null) {
    return null;
  }
  const startUv = pointValueAt(variableSet, variableSet.initial, pointKey);
  if (startUv === null) {
    return null;
  }
  const featureId = featureIdOfPointKey(pointKey);
  const feature = findFeature(document, featureId);
  if (feature === undefined) {
    return null;
  }
  const field = fieldOf(feature, pointKey);
  if ('reason' in field) {
    // 書き戻せる欄が無い(円弧の端など)。動かせる数かどうかより先にここで断る。
    return field;
  }
  const frozen = variableSet.frozen.get(pointKey);
  if (frozen !== undefined) {
    return { reason: refineFrozenReason(feature, field.field, field.index, frozen) };
  }
  return {
    pointKey,
    featureId,
    field: field.field,
    index: field.index,
    startUv: [startUv[0], startUv[1]],
    grabUv: [grabUv[0], grabUv[1]],
  };
}

/**
 * いまのポインタの位置から、引っぱりの目標(作図面上の (u, v))を出す。
 * 掴んだときのずれを保つので、点は指の下へ飛びつかず、掴んだ位置関係のまま付いてくる。
 */
export function dragTargetUv(
  drag: SketchDrag,
  pointerUv: readonly [number, number],
): readonly [number, number] {
  return [
    pointerUv[0] + (drag.startUv[0] - drag.grabUv[0]),
    pointerUv[1] + (drag.startUv[1] - drag.grabUv[1]),
  ];
}

/**
 * 引っぱっている間の解(§0.a 追記 3)。**文書は変えない**ので、返ってきた
 * `ConstrainedSketch.resolved` を表示だけに使う。
 */
export function solveWithDrag(
  document: SketchDocument,
  drag: SketchDrag,
  targetUv: readonly [number, number],
  options: SketchResolveOptions = {},
): ConstrainedSketch {
  return resolveConstrainedSketch(document, options, {
    pinned: new Map([[drag.pointKey, [targetUv[0], targetUv[1]] as const]]),
  });
}

/**
 * 解いた世界座標を、丸めない絶対座標の欄へ直す(§2.3)。
 *
 * `exactExpressionValueFromNumber` は倍精度を過不足なく表す最短の 10 進表記を作るので、
 * 保存して開き直しても寸分変わらない。有効数字 12 桁へ丸める `expressionValueFromNumber` を
 * 使うと、拘束が求める精度(1e-9)より粗い値が残り、開き直したときに形が動く。
 */
function absoluteAt(position: Vec3): CoordinateInput {
  return {
    mode: 'absolute',
    x: exactExpressionValueFromNumber(position[0]),
    y: exactExpressionValueFromNumber(position[1]),
    z: exactExpressionValueFromNumber(position[2]),
  };
}

/**
 * 基準の点のワールド座標(引っぱった後の形の上で)。分からなければ null。
 *
 * `previous`(直前の点)は文書の指し先ではなく履歴の位置で決まるので、**解決の規約と
 * 同じ形でここでも決める**(`resolveSketch.ts`)。線分の終点の基準はその線分の始点、
 * スプラインの n 番目(n >= 1)の基準は n-1 番目。それ以外の `previous` は履歴を歩かないと
 * 決まらないので null にし、絶対座標へ切り替えて書き戻す(位置は正しく、指定方法だけが
 * 変わる。黙って違う位置へ書くよりは良い)。
 */
function baseWorldPosition(
  base: PointReference,
  drag: SketchDrag,
  resolved: ResolvedSketch,
): Vec3 | null {
  switch (base.kind) {
    case 'origin':
      return ORIGIN;
    case 'point':
      return resolved.points.find((point) => point.id === base.pointId)?.position ?? null;
    case 'vertex':
      return vertexPositionOf(resolved, base.featureId, base.vertex);
    case 'subShape':
      return subShapeFromFingerprint(base.ref)?.position ?? null;
    case 'sphereGrid':
      // 球面上の点(FR-431、P5 タスク19)。球の中心・半径は部品文書の側にしか無く、
      // ここ(スケッチ 1 本の引っぱり)からは引けないので分からない扱いにする。
      // 呼び出し側は絶対座標へ切り替えて書き戻す(`previous` が決まらないときと同じ後始末)。
      return null;
    case 'previous': {
      if (drag.field === 'to') {
        // 線分の終点の「直前の点」は、その線分の始点(`resolveSketch.ts` の line の段)。
        return vertexPositionOf(resolved, drag.featureId, 'start');
      }
      if (drag.field === 'splinePoint' && drag.index !== null && drag.index > 0) {
        // スプラインの n 番目の基準は n-1 番目(`resolveSplineFeature`)。
        const spline = resolved.splines.find((entry) => entry.featureId === drag.featureId);
        return spline?.points[drag.index - 1] ?? null;
      }
      return null;
    }
  }
}

/** 相対のずれ(delta)の欄。丸めない(`absoluteAt` と同じ理由)。 */
function relativeAt(base: PointReference, delta: Vec3): CoordinateInput {
  return {
    mode: 'relative',
    base,
    dx: exactExpressionValueFromNumber(delta[0]),
    dy: exactExpressionValueFromNumber(delta[1]),
    dz: exactExpressionValueFromNumber(delta[2]),
  };
}

/**
 * 極(距離+角度)の欄。角度は度で、作図面の第1軸から第2軸へ向かう向きが正
 * (`planeMath.polarOffset` の逆算)。**丸めない**(度も mm と同じ扱い)。
 */
function polarAt(base: PointReference, delta: Vec3, plane: WorkPlane): CoordinateInput {
  const du = dotVec3(delta, plane.axisU);
  const dv = dotVec3(delta, plane.axisV);
  const dn = dotVec3(delta, plane.normal);
  const distance = Math.hypot(du, dv, dn);
  const azimuth = radiansToDegrees(Math.atan2(dv, du));
  // 距離 0 では向きが決まらないので仰角は 0 にする。
  const elevation = distance === 0 ? 0 : radiansToDegrees(Math.asin(dn / distance));
  return {
    mode: 'polar',
    base,
    distance: exactExpressionValueFromNumber(distance),
    azimuth: exactExpressionValueFromNumber(azimuth),
    elevation: exactExpressionValueFromNumber(elevation),
  };
}

/**
 * 引っぱった点を、**保存されている指定方法のまま**書き戻す(統括の決定 2026-09-05、案 A)。
 *
 * 絶対はそのまま座標を、相対は delta =(解いた位置 - 基準の位置)を、極はその delta を
 * 距離と角度へ直して書く。基準が求まらないときだけ絶対へ落とす(`baseWorldPosition`)。
 * こうすると「ふつうに引いた線分(終点が相対)」を引っぱっても、欄は相対のまま数字だけが
 * 変わる(利用者が選んだ書き方を勝手に変えない。FR-202 と同じ考え方)。
 */
function commitInput(
  stored: CoordinateInput | null,
  drag: SketchDrag,
  position: Vec3,
  resolved: ResolvedSketch | null,
  plane: WorkPlane | null,
): CoordinateInput {
  if (stored === null || stored.mode === 'absolute' || resolved === null) {
    return absoluteAt(position);
  }
  const base = baseWorldPosition(stored.base, drag, resolved);
  if (base === null) {
    return absoluteAt(position);
  }
  const delta = subVec3(position, base);
  if (stored.mode === 'relative') {
    return relativeAt(stored.base, delta);
  }
  // 極は作図面が要る(角度の基準が第1軸・第2軸のため)。無ければ絶対へ落とす。
  return plane === null ? absoluteAt(position) : polarAt(stored.base, delta, plane);
}

/** 欄を 1 つだけ差し替えたフィーチャー。欄が合わないときは元のまま返す。 */
function withDraggedField(
  feature: SketchFeature,
  drag: SketchDrag,
  at: CoordinateInput,
): SketchFeature {
  switch (drag.field) {
    case 'at':
      return feature.kind === 'point' ? { ...feature, at } : feature;
    case 'from':
      return feature.kind === 'line' ? { ...feature, from: at } : feature;
    case 'to':
      return feature.kind === 'line' ? { ...feature, to: at } : feature;
    case 'center':
      return feature.kind === 'arc' || feature.kind === 'ellipse'
        ? { ...feature, center: at }
        : feature;
    case 'splinePoint': {
      if (feature.kind !== 'spline' || drag.index === null) {
        return feature;
      }
      const points = feature.points.map((point, index) => (index === drag.index ? at : point));
      return { ...feature, points };
    }
  }
}

/**
 * 離したときの確定(§0.a-0.4)。**引っぱった点の座標だけ**を新しい値へ書き換える。
 *
 * 拘束につられて動いた他の点は書き換えない(解いた座標は保存しない、`rules/04`
 * 「導出できるものは保存しない」)。開き直せば同じ拘束から同じ形へ解き直る。
 * 解の表にその点が無いとき(動かせなかったとき)は文書をそのまま返す。
 */
export function commitDrag(
  document: SketchDocument,
  drag: SketchDrag,
  solution: ReadonlyMap<string, Vec3>,
  /**
   * 引っぱった後の形。相対・極の基準の位置を読むのに使う(P4b タスク22b)。
   * 渡さなければ従来どおり絶対座標で書き戻す(既存の呼び出しをそのまま通すため)。
   */
  resolved: ResolvedSketch | null = null,
  /** 作図面(極座標の角度の基準)。渡さなければ極も絶対座標へ落とす。 */
  plane: WorkPlane | null = null,
): SketchDocument {
  const position = solution.get(drag.pointKey);
  if (position === undefined) {
    return document;
  }
  const feature = findFeature(document, drag.featureId);
  if (feature === undefined) {
    return document;
  }
  const stored = coordinateOf(feature, drag.field, drag.index);
  const next = withDraggedField(feature, drag, commitInput(stored, drag, position, resolved, plane));
  return next === feature ? document : replaceFeature(document, drag.featureId, next);
}
