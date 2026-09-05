/**
 * 拘束を付ける・消す・値を書き換える純関数と、いま選んでいる要素に付けられる拘束の下見
 * (FR-313、FR-504、NFR-UX-1、NFR-UX-5、計画書 docs/plans/P4b-スケッチの仕上げ.md
 * §2.2・§0.a-0.2/0.3、タスク12)。
 *
 * `editCommands.ts` / `parameterCommands.ts` と同じ流儀にそろえる。DOM にもストアにも
 * 触れず、文書は不変で、断るときは元の文書を 1 文字も変えずに理由と日本語の一言だけを返す。
 * 印・一覧・ツールバーへの配線はタスク13、引っぱっての追従はタスク14 の役目で、ここは
 * 「どの拘束を付けられるか」「付けたらどんな文書になるか」だけを決める。
 *
 * **押したら必ず何かが起きる。** 条件がそろっていなくても `ready: false` と理由が必ず返り、
 * 呼ぶ側はそれを帯へ出せる(P4 タスク12 の失敗 (b)「押しても種類が変わらず理由も出ない」の
 * 再発防止)。
 *
 * **付けた後で矛盾するかどうかは、ここでは断らない。** 計画書 §0.a に「同じ要素に矛盾する
 * 拘束を足したとき」の決定が無いので、統括の指示どおり「止めずに警告する」(FR-504、
 * NFR-RE-1、`rules/04-設計の規律.md`)を採る。付けた文書を `resolveConstrainedSketch`
 * (model、タスク8)へ通せば `diagnosis.conflicting` に原因の拘束が並ぶので、印と帯は
 * タスク13 がそこから出す。ここで先回りして解いて断ると、①解く計算が 2 回になり、
 * ②「矛盾しているが値を直せば成り立つ」拘束を付けさせないことになる。
 *
 * ここで**事前に**断るのは、解かなくても分かることだけにする(NFR-UX-5)。
 * ①対象の種類・個数が合わない、②別のスケッチ/3D スケッチの要素、③同じ拘束が既にある、
 * ④選んだ要素に動かせる数が 1 つも無い(式で決まっている・固定されている)、⑤値が数でない。
 */

import { exactExpressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  baseWorkPlane,
  collectVariables,
  constraintTargets,
  curveEnd,
  curveStart,
  distanceVec3,
  featureIdOfPointKey,
  isFreeWorkPlaneId,
  resolveSketch,
  sketchConstraints,
  worldToPlane,
  type ConstraintTarget,
  type ConstraintVariable,
  type ResolvedSketch,
  type SketchConstraint,
  type SketchConstraintKind,
  type SketchDocument,
  type SketchResolveOptions,
  type VariableSet,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { FieldUnit } from './numericInput.js';
import { toElementRef } from './sketchCommands.js';

/* ---------------------------------------------------------------------------
 * 種類の見出しと単位
 * ------------------------------------------------------------------------- */

/**
 * 種類ごとの見出しの鍵(ja.json)。**文言は 1 か所だけ**にし、一覧・印・断り・拘束の名前
 * (「直角1」)がすべてここを引く(NFR-MA-5)。14 種を網羅する `Record` なので、model 側で
 * 種類が増えたらこの表が型検査で落ちる(`SketchFeatureKind` に種類を足したとき網羅箇所が
 * 落ちた P4 タスク4 の教訓)。
 */
export const CONSTRAINT_KIND_LABEL_KEYS: Readonly<Record<SketchConstraintKind, MessageKey>> = {
  coincident: 'constraint.kind.coincident',
  horizontal: 'constraint.kind.horizontal',
  vertical: 'constraint.kind.vertical',
  parallel: 'constraint.kind.parallel',
  perpendicular: 'constraint.kind.perpendicular',
  tangent: 'constraint.kind.tangent',
  concentric: 'constraint.kind.concentric',
  equal: 'constraint.kind.equal',
  symmetric: 'constraint.kind.symmetric',
  fix: 'constraint.kind.fix',
  distance: 'constraint.kind.distance',
  angle: 'constraint.kind.angle',
  radius: 'constraint.kind.radius',
  diameter: 'constraint.kind.diameter',
};

/**
 * 一覧に並べる順(ツールバーの並び。タスク13)。幾何拘束 10 種 → 寸法拘束 4 種の順で、
 * 幾何は「点を合わせる」→「向きをそろえる」→「大きさをそろえる」の並びにする。
 * model の `SKETCH_CONSTRAINT_KINDS` と同じ並びだが、あちらは保存形の網羅表で、
 * こちらは画面の並びなので別に持つ(画面の都合で並べ替えても保存形は動かない)。
 */
export const CONSTRAINT_KIND_ORDER: readonly SketchConstraintKind[] = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'concentric',
  'equal',
  'symmetric',
  'fix',
  'distance',
  'angle',
  'radius',
  'diameter',
];

/** 種類の見出しの鍵。ツールバーの一覧(タスク13)もこれを引く。 */
export function constraintKindLabelKey(kind: SketchConstraintKind): MessageKey {
  return CONSTRAINT_KIND_LABEL_KEYS[kind];
}

/** 種類の見出し(「直角」)。 */
export function constraintKindLabel(kind: SketchConstraintKind): string {
  return t(CONSTRAINT_KIND_LABEL_KEYS[kind]);
}

/** 数値を聞く拘束(寸法拘束 4 種)。その他は選んだ瞬間に付く。 */
const VALUE_KINDS: readonly SketchConstraintKind[] = ['distance', 'angle', 'radius', 'diameter'];

/** その拘束は数値を聞くか(段を開くかどうかの判断。タスク13)。 */
export function constraintNeedsValue(kind: SketchConstraintKind): boolean {
  return VALUE_KINDS.includes(kind);
}

/** 数値を聞く拘束の欄の単位。聞かない拘束は null。 */
export function constraintValueUnit(kind: SketchConstraintKind): FieldUnit | null {
  switch (kind) {
    case 'distance':
    case 'radius':
    case 'diameter':
      return 'mm';
    case 'angle':
      return 'degree';
    default:
      return null;
  }
}

/* ---------------------------------------------------------------------------
 * 結果の型
 * ------------------------------------------------------------------------- */

/** 断った理由。文言は `ja.json`(NFR-MA-5)、対応は `REJECTION_MESSAGE_KEYS` の 1 か所。 */
export type ConstraintCommandRejectionReason =
  /** 3D スケッチ(作図面を持たないスケッチ)には拘束を付けられない(§0.a-0.3)。 */
  | 'freeSketch'
  /** 選んだ要素がこのスケッチのものではない(複数スケッチの文書で起きる)。 */
  | 'otherSketch'
  /** 面・オフセット・矩形など、拘束の対象にできない要素。 */
  | 'unsupportedElement'
  | 'needTwoPoints'
  | 'needOneLine'
  | 'needTwoLines'
  | 'needTwoSameKind'
  | 'needLineAndCircle'
  | 'needTwoCircles'
  | 'needOneCircle'
  | 'needSymmetric'
  | 'needDistance'
  | 'needAnyElement'
  /** 同じ対象に同じ種類の拘束が既にある。 */
  | 'duplicate'
  /** 選んだ要素に動かせる数が 1 つも無い(式で決まっている・固定されている・導かれる)。 */
  | 'allFrozen'
  /** 値が数として読めない。 */
  | 'invalidValue'
  /** 長さ・半径・直径が 0 以下。 */
  | 'invalidSize'
  /** いまの形から既定値を測れない(長さ 0 の線分など)。 */
  | 'cannotMeasure'
  /** 消す・書き換える相手の拘束が見つからない。 */
  | 'notFound'
  /** 数値を持たない拘束の値を書き換えようとした。 */
  | 'notDimensional';

const REJECTION_MESSAGE_KEYS: Readonly<Record<ConstraintCommandRejectionReason, MessageKey>> = {
  freeSketch: 'constraint.error.freeSketch',
  otherSketch: 'constraint.error.otherSketch',
  unsupportedElement: 'constraint.error.unsupportedElement',
  needTwoPoints: 'constraint.error.needTwoPoints',
  needOneLine: 'constraint.error.needOneLine',
  needTwoLines: 'constraint.error.needTwoLines',
  needTwoSameKind: 'constraint.error.needTwoSameKind',
  needLineAndCircle: 'constraint.error.needLineAndCircle',
  needTwoCircles: 'constraint.error.needTwoCircles',
  needOneCircle: 'constraint.error.needOneCircle',
  needSymmetric: 'constraint.error.needSymmetric',
  needDistance: 'constraint.error.needDistance',
  needAnyElement: 'constraint.error.needAnyElement',
  duplicate: 'constraint.error.duplicate',
  allFrozen: 'constraint.error.allFrozen',
  invalidValue: 'constraint.error.invalidValue',
  invalidSize: 'constraint.error.invalidSize',
  cannotMeasure: 'constraint.error.cannotMeasure',
  notFound: 'constraint.error.notFound',
  notDimensional: 'constraint.error.notDimensional',
};

/** 断りの文言の鍵。ツールバーの案内(タスク13)も同じ鍵を引く。 */
export function constraintRejectionMessageKey(
  reason: ConstraintCommandRejectionReason,
): MessageKey {
  return REJECTION_MESSAGE_KEYS[reason];
}

export interface ConstraintCommandRejection {
  readonly ok: false;
  readonly reason: ConstraintCommandRejectionReason;
  /** 画面へそのまま出す日本語(NFR-UX-5)。 */
  readonly message: string;
}

/** 拘束を足せた。**「固定」を複数選んだときだけ 2 つ以上**、それ以外は必ず 1 つ足す。 */
export interface ConstraintAddSuccess {
  readonly ok: true;
  readonly document: SketchDocument;
  /** 足した拘束の id(履歴順)。 */
  readonly constraintIds: readonly string[];
  /** 先頭の id。一覧で選んで見せるのに使う(タスク13)。 */
  readonly constraintId: string;
}

/** 消す・書き換えの結果。 */
export interface ConstraintChangeSuccess {
  readonly ok: true;
  readonly document: SketchDocument;
}

export type ConstraintAddOutcome = ConstraintAddSuccess | ConstraintCommandRejection;
export type ConstraintChangeOutcome = ConstraintChangeSuccess | ConstraintCommandRejection;

function reject(reason: ConstraintCommandRejectionReason): ConstraintCommandRejection {
  return { ok: false, reason, message: t(REJECTION_MESSAGE_KEYS[reason]) };
}

/* ---------------------------------------------------------------------------
 * 下見に使う材料(解決結果・作図面・動かせる数)
 * ------------------------------------------------------------------------- */

/**
 * 判定と測定に要る材料。**拘束は解かない**(`resolveSketch` を 1 回呼ぶだけ)。
 * ツールバーの入り切りは選択が変わるたびに引き直されるので、連立を解く
 * `resolveConstrainedSketch` をここで呼ぶと、ボタンの色を決めるためだけに毎回
 * 反復計算が走ってしまう(NFR-PF-1)。
 *
 * 呼ぶ側(タスク13)は 1 回作って使い回してよい。省くと関数ごとに作り直す。
 */
export interface ConstraintContext {
  /** 拘束を無視した解決。既定値を測るもとであり、選んだ要素の種類の出どころ。 */
  readonly resolved: ResolvedSketch;
  /** このスケッチの作図面。3D スケッチ(作図面を持たない)なら null(§0.a-0.3)。 */
  readonly plane: WorkPlane | null;
  /** 動かせる数と、動かせない理由(`frozen`)。作図面が無ければ null。 */
  readonly variableSet: VariableSet | null;
}

/**
 * このスケッチの作図面。`SketchDocument` は面を 1 つだけ持つのではなくフィーチャーごとに
 * `planeId` を持つので、**履歴の中で最初に見つかった作図面つきのフィーチャーの面**を採る。
 * model 側の `solveSketch.ts` と同じ決め方にそろえる(規約を 2 通りにしない)。
 */
function sketchWorkPlane(document: SketchDocument, options: SketchResolveOptions): WorkPlane | null {
  const lookup = options.workPlane ?? baseWorkPlane;
  for (const feature of document.features) {
    if (isFreeWorkPlaneId(feature.planeId)) {
      continue;
    }
    const plane = lookup(feature.planeId);
    if (plane !== null) {
      return plane;
    }
  }
  return null;
}

/** 判定と測定の材料を作る(§2.2 の①の段だけを走らせる)。 */
export function constraintContextOf(
  document: SketchDocument,
  options: SketchResolveOptions = {},
): ConstraintContext {
  return constraintContextFrom(document, resolveSketch(document, options), options);
}

/**
 * 同じ材料を、**すでに解決してある結果から**作る(P4b タスク22b)。
 *
 * いま描いている形(ストアの `resolvedSketch`)をそのまま使えるので、解決をもう一度
 * 走らせずに済む(NFR-PF-1)。要素の決まり具合の色分け(FR-313、利用者の決定②)は
 * 文書が変わるたびに要るので、そこだけのために解決を 2 回走らせない。
 */
export function constraintContextFrom(
  document: SketchDocument,
  resolved: ResolvedSketch,
  options: SketchResolveOptions = {},
): ConstraintContext {
  const plane = sketchWorkPlane(document, options);
  return {
    resolved,
    plane,
    variableSet: plane === null ? null : collectVariables(document, resolved, plane),
  };
}

/* ---------------------------------------------------------------------------
 * 選んだ要素の見分け
 * ------------------------------------------------------------------------- */

/**
 * 拘束から見た要素の種類。`sketchCommands.ts` の `boundaryElementKind`(面を張れるか)とは
 * 目的が違うので別に持つ。拘束は「向きを持つ線」「半径を持つ円」「点」を区別する必要がある。
 */
export type ConstraintElementKind =
  | 'point'
  /** 線分。向きを使う拘束(平行・直角・水平・垂直・角度・接線・対称の軸)の相手。 */
  | 'line'
  /** 円・円弧・楕円。半径を持つ拘束(半径・直径・同心・接線)の相手。 */
  | 'circle'
  /** スプライン。形が点の並びで決まるので、固定以外の拘束は付けない。 */
  | 'spline'
  /** 矩形・正多角形・長穴・オフセット・複製・投影。1 フィーチャーが複数の曲線を生む。 */
  | 'compound'
  /** このスケッチに無い(別のスケッチの要素)。 */
  | 'missing'
  /** 面など、拘束の対象にできない要素。 */
  | 'unsupported';

interface ConstraintElement {
  readonly elementId: string;
  readonly featureId: string;
  readonly kind: ConstraintElementKind;
  /** 拘束の指し先。点なら点、それ以外は曲線そのもの。 */
  readonly target: ConstraintTarget;
  /** その要素が 3D スケッチ(作図面を持たない)のものか。 */
  readonly free: boolean;
}

/**
 * 選んだ id 1 つを見分ける。
 *
 * **`curvesByFeature` を先に見る**のが要。矩形・正多角形・長穴が生む辺は `segments` /
 * `arcs` にも入っているので、種類の配列だけで見ると矩形が「線分」に見えてしまう。
 */
function classifyElement(
  document: SketchDocument,
  resolved: ResolvedSketch,
  elementId: string,
): ConstraintElement {
  const ref = toElementRef(elementId);
  const feature = document.features.find((candidate) => candidate.id === ref.featureId);
  const free = feature !== undefined && isFreeWorkPlaneId(feature.planeId);
  const curveTarget: ConstraintTarget = { kind: 'curve', element: ref };
  if (resolved.points.some((point) => point.id === elementId)) {
    return {
      elementId,
      featureId: ref.featureId,
      kind: 'point',
      target: { kind: 'point', pointId: elementId },
      free,
    };
  }
  if (feature === undefined) {
    return { elementId, featureId: ref.featureId, kind: 'missing', target: curveTarget, free };
  }
  const kind = curveKindOf(resolved, ref.featureId);
  return { elementId, featureId: ref.featureId, kind, target: curveTarget, free };
}

function curveKindOf(resolved: ResolvedSketch, featureId: string): ConstraintElementKind {
  if (resolved.curvesByFeature.has(featureId)) {
    return 'compound';
  }
  if (resolved.segments.some((segment) => segment.featureId === featureId)) {
    return 'line';
  }
  if (
    resolved.arcs.some((arc) => arc.featureId === featureId) ||
    resolved.ellipses.some((ellipse) => ellipse.featureId === featureId)
  ) {
    return 'circle';
  }
  if (resolved.splines.some((spline) => spline.featureId === featureId)) {
    return 'spline';
  }
  return 'unsupported';
}

/* ---------------------------------------------------------------------------
 * 位置と大きさを測る(既定値は「いま測った値」。NFR-UX-4)
 * ------------------------------------------------------------------------- */

/** 線分・円弧・楕円の端点/中心のワールド座標。`vertexKey` の規約と同じ指し方。 */
export function vertexPositionOf(
  resolved: ResolvedSketch,
  featureId: string,
  vertex: 'start' | 'end' | 'center',
): Vec3 | null {
  const segment = resolved.segments.find((candidate) => candidate.featureId === featureId);
  if (segment !== undefined) {
    if (vertex === 'center') {
      return null;
    }
    return vertex === 'start' ? segment.from : segment.to;
  }
  const arc = resolved.arcs.find((candidate) => candidate.featureId === featureId);
  if (arc !== undefined) {
    return vertex === 'center' ? arc.center : vertex === 'start' ? curveStart(arc) : curveEnd(arc);
  }
  const ellipse = resolved.ellipses.find((candidate) => candidate.featureId === featureId);
  if (ellipse !== undefined) {
    return vertex === 'center'
      ? ellipse.center
      : vertex === 'start'
        ? curveStart(ellipse)
        : curveEnd(ellipse);
  }
  return null;
}

/** 指し先のワールド座標。曲線そのものを指しているときは null。 */
export function targetPositionOf(resolved: ResolvedSketch, target: ConstraintTarget): Vec3 | null {
  switch (target.kind) {
    case 'point': {
      const point = resolved.points.find((candidate) => candidate.id === target.pointId);
      return point === undefined ? null : point.position;
    }
    case 'vertex':
      return vertexPositionOf(resolved, target.featureId, target.vertex);
    case 'curve':
      return null;
  }
}

/** 線分の中点(印を線の真ん中に置く。タスク13)。 */
export function lineMidpointOf(resolved: ResolvedSketch, featureId: string): Vec3 | null {
  const segment = resolved.segments.find((candidate) => candidate.featureId === featureId);
  if (segment === undefined) {
    return null;
  }
  return [
    (segment.from[0] + segment.to[0]) / 2,
    (segment.from[1] + segment.to[1]) / 2,
    (segment.from[2] + segment.to[2]) / 2,
  ];
}

/** 半径を持つ要素の半径。楕円は長半径を採る(model の残差 `readRadius` と同じ順)。 */
export function circleRadiusOf(resolved: ResolvedSketch, featureId: string): number | null {
  const arc = resolved.arcs.find((candidate) => candidate.featureId === featureId);
  if (arc !== undefined) {
    return arc.radius;
  }
  const ellipse = resolved.ellipses.find((candidate) => candidate.featureId === featureId);
  return ellipse === undefined ? null : ellipse.majorRadius;
}

/** 半径を持つ要素の中心(印の置き場と同心の指し先)。 */
export function circleCenterOf(resolved: ResolvedSketch, featureId: string): Vec3 | null {
  return vertexPositionOf(resolved, featureId, 'center');
}

/**
 * 線分の作図面上の向き。長さ 0 の線分は向きが決まらないので null。
 * **単位ベクトルにしない**のは、角度が `atan2(外積, 内積)` で長さに依らず決まるため。
 */
function lineDirectionOf(
  resolved: ResolvedSketch,
  plane: WorkPlane,
  featureId: string,
): readonly [number, number] | null {
  const segment = resolved.segments.find((candidate) => candidate.featureId === featureId);
  if (segment === undefined) {
    return null;
  }
  const [fromU, fromV] = worldToPlane(plane, segment.from);
  const [toU, toV] = worldToPlane(plane, segment.to);
  const deltaU = toU - fromU;
  const deltaV = toV - fromV;
  return deltaU === 0 && deltaV === 0 ? null : [deltaU, deltaV];
}

/**
 * いまの形から測った既定値(NFR-UX-4「Enter 連打だけでも意味のある結果になる」)。
 * **丸めない**(`exactExpressionValueFromNumber`)。有効数字 12 桁へ丸める
 * `expressionValueFromNumber` を使うと、拘束が要求する精度(1e-9)より粗い値が入り、
 * 付けた瞬間に形がわずかに動く(§2.3)。
 *
 * 角度は `atan2(外積, 内積)` の符号つきの度で測る。model の残差
 * `dot·sinθ − cross·cosθ` はこの符号つきの角度で 0 になるので、絶対値にすると
 * 「付けた瞬間に線が裏返る」ことがある(§2.2 の角度の式)。
 */
export function measuredConstraintValue(
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
  context: ConstraintContext,
): ExpressionValue | null {
  const { resolved, plane } = context;
  switch (kind) {
    case 'distance': {
      if (targets.length !== 2) {
        return null;
      }
      const from = targetPositionOf(resolved, targets[0]);
      const to = targetPositionOf(resolved, targets[1]);
      if (from === null || to === null) {
        return null;
      }
      const length = distanceVec3(from, to);
      return length > 0 ? exactExpressionValueFromNumber(length) : null;
    }
    case 'angle': {
      if (targets.length !== 2 || plane === null) {
        return null;
      }
      const first = lineDirectionOf(resolved, plane, featureIdOfTarget(targets[0]));
      const second = lineDirectionOf(resolved, plane, featureIdOfTarget(targets[1]));
      if (first === null || second === null) {
        return null;
      }
      const cross = first[0] * second[1] - first[1] * second[0];
      const dot = first[0] * second[0] + first[1] * second[1];
      return exactExpressionValueFromNumber((Math.atan2(cross, dot) * 180) / Math.PI);
    }
    case 'radius':
    case 'diameter': {
      if (targets.length !== 1) {
        return null;
      }
      const radius = circleRadiusOf(resolved, featureIdOfTarget(targets[0]));
      if (radius === null || radius <= 0) {
        return null;
      }
      return exactExpressionValueFromNumber(kind === 'radius' ? radius : radius * 2);
    }
    default:
      return null;
  }
}

/** 指し先を作ったフィーチャーの id(model の `residuals.ts` と同じ引き方)。 */
export function featureIdOfTarget(target: ConstraintTarget): string {
  switch (target.kind) {
    case 'curve':
      return target.element.featureId;
    case 'vertex':
      return target.featureId;
    case 'point':
      return featureIdOfPointKey(target.pointId);
  }
}

/* ---------------------------------------------------------------------------
 * 選択 → 指し先
 * ------------------------------------------------------------------------- */

type TargetOutcome =
  | { readonly ok: true; readonly targets: readonly ConstraintTarget[] }
  | { readonly ok: false; readonly reason: ConstraintCommandRejectionReason };

function needs(reason: ConstraintCommandRejectionReason): TargetOutcome {
  return { ok: false, reason };
}

function targetsOf(elements: readonly ConstraintElement[]): readonly ConstraintTarget[] {
  return elements.map((element) => element.target);
}

/**
 * 選んだ要素の種類と個数から指し先を決める(計画書 タスク12 の表)。
 *
 * **順序に意味を持たせるのは角度だけ**(「1 本目から 2 本目へ測る」)。接線(線分+円)と
 * 対称(点 2 つ+軸)は種類で見分けるので選ぶ順は不問、平行・直角・一致・等しい・同心・
 * 距離は式が対称なので順不同。この振り分けはここ 1 か所に置く。
 */
function selectionTargets(
  kind: SketchConstraintKind,
  elements: readonly ConstraintElement[],
): TargetOutcome {
  const points = elements.filter((element) => element.kind === 'point');
  const lines = elements.filter((element) => element.kind === 'line');
  const circles = elements.filter((element) => element.kind === 'circle');
  switch (kind) {
    case 'coincident':
      return elements.length === 2 && points.length === 2
        ? { ok: true, targets: targetsOf(points) }
        : needs('needTwoPoints');
    case 'horizontal':
    case 'vertical':
      return elements.length === 1 && lines.length === 1
        ? { ok: true, targets: targetsOf(lines) }
        : needs('needOneLine');
    case 'parallel':
    case 'perpendicular':
    case 'angle':
      return elements.length === 2 && lines.length === 2
        ? { ok: true, targets: targetsOf(lines) }
        : needs('needTwoLines');
    case 'equal':
      if (elements.length !== 2) {
        return needs('needTwoSameKind');
      }
      return lines.length === 2 || circles.length === 2
        ? { ok: true, targets: targetsOf(elements) }
        : needs('needTwoSameKind');
    case 'tangent':
      return elements.length === 2 && lines.length === 1 && circles.length === 1
        ? { ok: true, targets: [lines[0].target, circles[0].target] }
        : needs('needLineAndCircle');
    case 'concentric':
      return elements.length === 2 && circles.length === 2
        ? { ok: true, targets: targetsOf(circles) }
        : needs('needTwoCircles');
    case 'symmetric':
      return elements.length === 3 && points.length === 2 && lines.length === 1
        ? { ok: true, targets: [points[0].target, points[1].target, lines[0].target] }
        : needs('needSymmetric');
    case 'fix':
      return elements.length >= 1
        ? { ok: true, targets: targetsOf(elements) }
        : needs('needAnyElement');
    case 'distance':
      if (elements.length === 2 && points.length === 2) {
        return { ok: true, targets: targetsOf(points) };
      }
      if (elements.length === 1 && lines.length === 1) {
        // 線分 1 本は「その長さ」。両端を指す 2 つの指し先へ開く(model の距離の残差は
        // 点 2 つしか受け取らない)。
        const featureId = lines[0].featureId;
        return {
          ok: true,
          targets: [
            { kind: 'vertex', featureId, vertex: 'start' },
            { kind: 'vertex', featureId, vertex: 'end' },
          ],
        };
      }
      return needs('needDistance');
    case 'radius':
    case 'diameter':
      return elements.length === 1 && circles.length === 1
        ? { ok: true, targets: targetsOf(circles) }
        : needs('needOneCircle');
  }
}

/**
 * 指し先そのものの形が種類に合っているか(選択を通さずに `commitAddConstraint` を
 * 直に呼ぶ道、タスク14 のドラッグ等のための検査)。
 */
function targetShapeReason(
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
): ConstraintCommandRejectionReason | null {
  const isPoint = (target: ConstraintTarget): boolean => target.kind !== 'curve';
  switch (kind) {
    case 'coincident':
      return targets.length === 2 && targets.every(isPoint) ? null : 'needTwoPoints';
    case 'horizontal':
    case 'vertical':
      return targets.length === 1 ? null : 'needOneLine';
    case 'parallel':
    case 'perpendicular':
    case 'angle':
      return targets.length === 2 ? null : 'needTwoLines';
    case 'equal':
      return targets.length === 2 ? null : 'needTwoSameKind';
    case 'tangent':
      return targets.length === 2 ? null : 'needLineAndCircle';
    case 'concentric':
      return targets.length === 2 ? null : 'needTwoCircles';
    case 'symmetric':
      return targets.length === 3 && isPoint(targets[0]) && isPoint(targets[1]) &&
        targets[2].kind === 'curve'
        ? null
        : 'needSymmetric';
    case 'fix':
      return targets.length >= 1 ? null : 'needAnyElement';
    case 'distance':
      return targets.length === 2 && targets.every(isPoint) ? null : 'needDistance';
    case 'radius':
    case 'diameter':
      return targets.length === 1 ? null : 'needOneCircle';
  }
}

/* ---------------------------------------------------------------------------
 * 事前の断り(NFR-UX-5)
 * ------------------------------------------------------------------------- */

/** 指し先を 1 つの文字列にする(同じ拘束が既にあるかの照合に使う)。 */
function targetKey(target: ConstraintTarget): string {
  switch (target.kind) {
    case 'point':
      return `p:${target.pointId}`;
    case 'vertex':
      return `v:${target.featureId}:${target.vertex}`;
    case 'curve':
      return `c:${target.element.featureId}#${
        target.element.index === undefined ? '*' : String(target.element.index)
      }`;
  }
}

/**
 * 指し先の並びを、順序に依らない 1 つの鍵にする。**順序を無視する**のは、平行や一致を
 * 選ぶ順を入れ替えただけの拘束を「別の拘束」として 2 つ付けさせないため。角度も
 * 入れ替えたものは冗長(または矛盾)にしかならないので、同じ扱いにする。
 */
function targetSetKey(targets: readonly ConstraintTarget[]): string {
  return [...targets.map(targetKey)].sort().join('|');
}

/** 同じ種類・同じ指し先の拘束が既にあるか。 */
function hasSameConstraint(
  document: SketchDocument,
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
): boolean {
  const key = targetSetKey(targets);
  return sketchConstraints(document).some(
    (constraint) =>
      constraint.kind === kind && targetSetKey(constraintTargets(constraint)) === key,
  );
}

function featureIdOfVariable(variable: ConstraintVariable): string {
  return variable.kind === 'radius'
    ? variable.featureId
    : featureIdOfPointKey(variable.pointKey);
}

/**
 * 選んだ要素に動かせる数が 1 つでもあるか(§0.a-0.2)。1 つも無ければ、拘束を付けても
 * 形は動かず「矛盾」とだけ言われる。付ける前に理由を出す(NFR-UX-5)。
 */
function hasMovableVariable(
  variableSet: VariableSet,
  targets: readonly ConstraintTarget[],
): boolean {
  const featureIds = new Set(targets.map(featureIdOfTarget));
  return variableSet.variables.some((variable) => featureIds.has(featureIdOfVariable(variable)));
}

/** 値が数として使えるか。長さ・半径・直径は 0 より大きいこと。 */
function valueReason(
  kind: SketchConstraintKind,
  value: ExpressionValue,
): ConstraintCommandRejectionReason | null {
  if (!Number.isFinite(value.value)) {
    return 'invalidValue';
  }
  if (kind !== 'angle' && value.value <= 0) {
    return 'invalidSize';
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 下見(ツールバーの入り切り)
 * ------------------------------------------------------------------------- */

export interface ConstraintReadiness {
  readonly ready: boolean;
  /** 付けられない理由。付けられるときは null。 */
  readonly reason: ConstraintCommandRejectionReason | null;
  /** 画面へそのまま出す日本語。付けられるときは null。 */
  readonly message: string | null;
  /** 決まった指し先。そのまま `commitAddConstraint` へ渡せる。付けられないときは空。 */
  readonly targets: readonly ConstraintTarget[];
  /** 数値を聞く拘束の既定値(いま測った値)。聞かない拘束・付けられないときは null。 */
  readonly defaultValue: ExpressionValue | null;
}

const NOT_READY_TARGETS: readonly ConstraintTarget[] = [];

function notReady(reason: ConstraintCommandRejectionReason): ConstraintReadiness {
  return {
    ready: false,
    reason,
    message: t(REJECTION_MESSAGE_KEYS[reason]),
    targets: NOT_READY_TARGETS,
    defaultValue: null,
  };
}

/**
 * いま選んでいる要素にその拘束を付けられるか(NFR-UX-5「実行前に理由を出す」)。
 * ツールバーのボタンの入り切りと、押したときの帯の一言の両方がこれを引く。
 */
export function constraintReadiness(
  document: SketchDocument,
  elementIds: readonly string[],
  kind: SketchConstraintKind,
  context: ConstraintContext = constraintContextOf(document),
): ConstraintReadiness {
  const { resolved, variableSet } = context;
  const elements = elementIds.map((elementId) => classifyElement(document, resolved, elementId));
  if (elements.some((element) => element.kind === 'missing')) {
    return notReady('otherSketch');
  }
  if (elements.some((element) => element.free) || (elements.length > 0 && variableSet === null)) {
    // 3D スケッチの要素を選んでいる、または作図面がまだ 1 つも無い(§0.a-0.3)。
    return notReady('freeSketch');
  }
  if (
    elements.some(
      (element) =>
        element.kind === 'unsupported' ||
        element.kind === 'compound' ||
        // スプラインは点の並びで形が決まるので、固定以外の拘束の相手にしない。
        (element.kind === 'spline' && kind !== 'fix'),
    )
  ) {
    return notReady('unsupportedElement');
  }
  const outcome = selectionTargets(kind, elements);
  if (!outcome.ok) {
    return notReady(outcome.reason);
  }
  const targets = outcome.targets;
  if (variableSet === null) {
    return notReady('freeSketch');
  }
  if (newTargetSets(document, kind, targets).length === 0) {
    return notReady('duplicate');
  }
  if (!hasMovableVariable(variableSet, targets)) {
    return notReady('allFrozen');
  }
  if (!constraintNeedsValue(kind)) {
    return { ready: true, reason: null, message: null, targets, defaultValue: null };
  }
  const measured = measuredConstraintValue(kind, targets, context);
  if (measured === null) {
    return notReady('cannotMeasure');
  }
  return { ready: true, reason: null, message: null, targets, defaultValue: measured };
}

/**
 * いま選んでいる要素に付けられる拘束の一覧(ツールバーの活性に使う)。
 * 14 種を順に下見して、付けられるものだけを `CONSTRAINT_KIND_ORDER` の順で返す。
 */
export function applicableConstraintKinds(
  document: SketchDocument,
  elementIds: readonly string[],
  context: ConstraintContext = constraintContextOf(document),
): readonly SketchConstraintKind[] {
  return CONSTRAINT_KIND_ORDER.filter(
    (kind) => constraintReadiness(document, elementIds, kind, context).ready,
  );
}

/* ---------------------------------------------------------------------------
 * 拘束を付ける
 * ------------------------------------------------------------------------- */

/**
 * まだ同じ拘束が付いていない指し先の組。**「固定」だけは 1 つの操作で複数付く**ので、
 * 指し先ごとに 1 組ずつに分ける。既に固定されている要素は黙って飛ばし、全部が既に
 * 付いているときだけ「同じ拘束がすでに付いています」と断る。
 */
function newTargetSets(
  document: SketchDocument,
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
): readonly (readonly ConstraintTarget[])[] {
  const groups: (readonly ConstraintTarget[])[] =
    kind === 'fix' ? targets.map((target) => [target]) : [targets];
  return groups.filter((group) => !hasSameConstraint(document, kind, group));
}

/** その名前の連番(「直角1」の 1)。見出しで始まらない名前は 0 とみなす。 */
function nameSerial(name: string, label: string): number {
  if (!name.startsWith(label)) {
    return 0;
  }
  const rest = name.slice(label.length);
  if (!/^[0-9]+$/.test(rest)) {
    return 0;
  }
  const parsed = Number(rest);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 同じ見出しの既存の名前の最大連番 + 1(「直角1」「直角2」)。
 *
 * model の `nextSerialName`(`createSketchDocument.ts`)と同じ方式だが、あちらは
 * `@pointercad/model` の公開口に並んでいない。統括の指示で model のファイルは触らないので、
 * 同じ 3 行をここへ置く。**輸出が増えたら model 側へ寄せる**(タスク13 への申し送り)。
 */
function nextConstraintName(document: SketchDocument, kind: SketchConstraintKind): string {
  const label = constraintKindLabel(kind);
  let max = 0;
  for (const constraint of sketchConstraints(document)) {
    const serial = nameSerial(constraint.name, label);
    if (serial > max) {
      max = serial;
    }
  }
  return `${label}${String(max + 1)}`;
}

/** 拘束の id。`constraint-1`、`constraint-2`(フィーチャーの id と同じ連番の方式)。 */
function nextConstraintId(usedIds: ReadonlySet<string>): string {
  let max = 0;
  for (const id of usedIds) {
    const serial = nameSerial(id, 'constraint-');
    if (serial > max) {
      max = serial;
    }
  }
  return `constraint-${String(max + 1)}`;
}

/** 1 つの拘束を組み立てる。指し先の形が合わなければ null(呼ぶ前に検査済み)。 */
function buildConstraint(
  kind: SketchConstraintKind,
  id: string,
  name: string,
  targets: readonly ConstraintTarget[],
  value: ExpressionValue | null,
): SketchConstraint | null {
  switch (kind) {
    case 'coincident':
      return { id, name, kind, a: targets[0], b: targets[1] };
    case 'horizontal':
    case 'vertical':
      return { id, name, kind, target: targets[0] };
    case 'parallel':
    case 'perpendicular':
    case 'equal':
      return { id, name, kind, a: targets[0], b: targets[1] };
    case 'tangent':
      return { id, name, kind, line: targets[0], circle: targets[1] };
    case 'concentric':
      return { id, name, kind, a: targets[0], b: targets[1] };
    case 'symmetric': {
      const axis = targets[2];
      return axis.kind === 'curve'
        ? { id, name, kind, a: targets[0], b: targets[1], axis: axis.element }
        : null;
    }
    case 'fix':
      return { id, name, kind, target: targets[0] };
    case 'distance':
      return value === null ? null : { id, name, kind, a: targets[0], b: targets[1], length: value };
    case 'angle':
      return value === null ? null : { id, name, kind, a: targets[0], b: targets[1], angle: value };
    case 'radius':
    case 'diameter':
      return value === null ? null : { id, name, kind, target: targets[0], size: value };
  }
}

function withConstraints(
  document: SketchDocument,
  constraints: readonly SketchConstraint[],
): SketchDocument {
  return { ...document, constraints };
}

/**
 * 拘束を 1 つ(「固定」は選んだ要素の数だけ)足す(FR-313)。
 *
 * `value` を省くと、数値を聞く拘束(距離・角度・半径・直径)の目標値は**いまの形から
 * 測った値**になる(NFR-UX-4)。値は `ExpressionValue` なので、パラメータ表(FR-207)の
 * 名前をそのまま書ける(§2.2「2 つの機能がここで噛み合う」)。
 */
export function commitAddConstraint(
  document: SketchDocument,
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
  value?: ExpressionValue,
  context: ConstraintContext = constraintContextOf(document),
): ConstraintAddOutcome {
  const shapeReason = targetShapeReason(kind, targets);
  if (shapeReason !== null) {
    return reject(shapeReason);
  }
  if (context.variableSet === null) {
    return reject('freeSketch');
  }
  const groups = newTargetSets(document, kind, targets);
  if (groups.length === 0) {
    return reject('duplicate');
  }
  if (!hasMovableVariable(context.variableSet, targets)) {
    return reject('allFrozen');
  }

  let size: ExpressionValue | null = null;
  if (constraintNeedsValue(kind)) {
    size = value ?? measuredConstraintValue(kind, targets, context);
    if (size === null) {
      return reject('cannotMeasure');
    }
    const reason = valueReason(kind, size);
    if (reason !== null) {
      return reject(reason);
    }
  }

  const usedIds = new Set(sketchConstraints(document).map((constraint) => constraint.id));
  const added: SketchConstraint[] = [];
  let next = document;
  for (const group of groups) {
    const id = nextConstraintId(usedIds);
    usedIds.add(id);
    const constraint = buildConstraint(kind, id, nextConstraintName(next, kind), group, size);
    if (constraint === null) {
      return reject('unsupportedElement');
    }
    added.push(constraint);
    // 名前の連番は 1 つ足すごとに数え直す(「固定1」「固定2」と続く)。
    next = withConstraints(next, [...sketchConstraints(next), constraint]);
  }
  return {
    ok: true,
    document: next,
    constraintIds: added.map((constraint) => constraint.id),
    constraintId: added[0].id,
  };
}

/**
 * いま選んでいる要素から拘束を足す(NFR-UX-1「対象を選んでから操作」)。
 * 下見(`constraintReadiness`)と同じ判定を通るので、ボタンが押せた操作は必ず成立する。
 */
export function commitConstraintFromSelection(
  document: SketchDocument,
  kind: SketchConstraintKind,
  elementIds: readonly string[],
  value?: ExpressionValue,
  context: ConstraintContext = constraintContextOf(document),
): ConstraintAddOutcome {
  const readiness = constraintReadiness(document, elementIds, kind, context);
  if (!readiness.ready) {
    return reject(readiness.reason ?? 'unsupportedElement');
  }
  return commitAddConstraint(
    document,
    kind,
    readiness.targets,
    value ?? readiness.defaultValue ?? undefined,
    context,
  );
}

/* ---------------------------------------------------------------------------
 * 拘束を消す・値を書き換える
 * ------------------------------------------------------------------------- */

/** 拘束を 1 つ消す(一覧の「×」。NFR-UX-3 で 1 回の取り消しで戻る)。 */
export function commitRemoveConstraint(
  document: SketchDocument,
  constraintId: string,
): ConstraintChangeOutcome {
  return commitRemoveConstraints(document, [constraintId]);
}

/** 拘束をまとめて消す(要素を消したときの後始末など)。1 つも無ければ断る。 */
export function commitRemoveConstraints(
  document: SketchDocument,
  constraintIds: readonly string[],
): ConstraintChangeOutcome {
  const removing = new Set(constraintIds);
  const constraints = sketchConstraints(document);
  const kept = constraints.filter((constraint) => !removing.has(constraint.id));
  if (kept.length === constraints.length) {
    return reject('notFound');
  }
  return { ok: true, document: withConstraints(document, kept) };
}

/** その拘束が持っている値。数値を持たない拘束は null。 */
export function constraintValueOf(constraint: SketchConstraint): ExpressionValue | null {
  switch (constraint.kind) {
    case 'distance':
      return constraint.length;
    case 'angle':
      return constraint.angle;
    case 'radius':
    case 'diameter':
      return constraint.size;
    default:
      return null;
  }
}

/** 値を差し替えた拘束。数値を持たない拘束は null。 */
function withValue(constraint: SketchConstraint, value: ExpressionValue): SketchConstraint | null {
  switch (constraint.kind) {
    case 'distance':
      return { ...constraint, length: value };
    case 'angle':
      return { ...constraint, angle: value };
    case 'radius':
    case 'diameter':
      return { ...constraint, size: value };
    default:
      return null;
  }
}

/**
 * 寸法拘束の値を書き換える(FR-313、FR-207)。式のまま入るので、
 * パラメータ表の名前(「幅」)を書けば表を 1 か所直すだけで形が追従する。
 */
export function commitSetConstraintValue(
  document: SketchDocument,
  constraintId: string,
  source: ExpressionValue,
): ConstraintChangeOutcome {
  const constraints = sketchConstraints(document);
  const current = constraints.find((constraint) => constraint.id === constraintId);
  if (current === undefined) {
    return reject('notFound');
  }
  if (constraintValueOf(current) === null) {
    return reject('notDimensional');
  }
  const reason = valueReason(current.kind, source);
  if (reason !== null) {
    return reject(reason);
  }
  const replaced = withValue(current, source);
  if (replaced === null) {
    return reject('notDimensional');
  }
  return {
    ok: true,
    document: withConstraints(
      document,
      constraints.map((constraint) => (constraint.id === constraintId ? replaced : constraint)),
    ),
  };
}

/** いま付いている拘束の数(帯・一覧の見出しに出す)。 */
export function constraintCountOf(document: SketchDocument): number {
  return sketchConstraints(document).length;
}

/** その要素を指している拘束の id(要素を消すときの後始末に使う。タスク13)。 */
export function constraintsReferencing(
  document: SketchDocument,
  featureId: string,
): readonly string[] {
  return sketchConstraints(document)
    .filter((constraint) =>
      constraintTargets(constraint).some((target) => featureIdOfTarget(target) === featureId),
    )
    .map((constraint) => constraint.id);
}
