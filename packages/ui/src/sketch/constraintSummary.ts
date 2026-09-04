/**
 * 拘束の要約(一覧の 1 行と、印を置く場所)を作る純関数
 * (FR-313、FR-501、FR-504、NFR-UX-7、計画書 docs/plans/P4b-スケッチの仕上げ.md タスク12)。
 *
 * `featureSummary.ts`(フィーチャーをプロパティ欄の行へ直す)と同じ流儀で、DOM にも
 * three.js にも触れず、画面に出す文言はすべて `ja.json` から引く(NFR-MA-5)。
 * 一覧パネル・印の描画・当たり判定(タスク13)は、ここが返した `ConstraintSummary` だけを見る。
 *
 * **記号は図柄の代わりではない。** ここが返す `symbol` は「どの拘束か」を 1 文字で言うための
 * 印(§0.a-0.7 の①「要素の脇に `⊥` `∥` `=` `H` `V` 等の記号を常時表示」)で、実際の図柄は
 * タスク13 が `icons.tsx` に持つ。両方が要るのは、ビューポートの印は 1 文字のビルボードで
 * 描くのに対し、ツールバーと一覧はボタンの大きさの図柄を要るため。
 */

import type { ExpressionValue } from '@pointercad/expression';
import {
  constraintTargets,
  sketchConstraints,
  type ConstraintDiagnosis,
  type ConstraintTarget,
  type SketchConstraint,
  type SketchConstraintKind,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import {
  circleCenterOf,
  constraintContextOf,
  constraintValueOf,
  constraintValueUnit,
  featureIdOfTarget,
  lineMidpointOf,
  targetPositionOf,
  type ConstraintContext,
} from './constraintCommands.js';
import { UNIT_KEYS } from './numericInput.js';

/** 一覧・印に出す状態。診断(model、タスク7)の結果をそのまま写す。 */
export type ConstraintState = 'ok' | 'conflicting' | 'redundant' | 'dangling';

/** 一覧の 1 行(FR-501 と同じ流儀。種類名・対象の名前・値)。 */
export interface ConstraintSummary {
  readonly id: string;
  readonly kind: SketchConstraintKind;
  /** 拘束の名前(「直角1」)。 */
  readonly label: string;
  /** 何を指しているか(「線分1 と 線分2」)。 */
  readonly detail: string;
  /** 印の記号(`⊥` `∥` `=` `H` `V` など)。図柄は `icons.tsx`(タスク13)。 */
  readonly symbol: string;
  /** 寸法拘束の値。式のまま持つ(FR-202)。数値を持たない拘束は null。 */
  readonly value: ExpressionValue | null;
  /** 値を単位つきで読める形にしたもの(「10 mm」「90°」)。 */
  readonly valueText: string | null;
  /** 印を置く場所(ワールド座標)。要素が消えていれば空。 */
  readonly anchors: readonly Vec3[];
  readonly state: ConstraintState;
  /** `state` が `ok` でないときに一覧へ添える一言。 */
  readonly stateMessage: string | null;
}

/**
 * 種類ごとの印の記号(§0.a-0.7 の①)。**言葉ではなく記号**なので `ja.json` へ置かない
 * (日本語以外へ広げても同じ記号を使う。NFR-MA-5 が分離を求めているのは文言)。
 * 14 種を網羅する `Record` なので、種類が増えたら型検査で落ちる。
 */
const CONSTRAINT_SYMBOLS: Readonly<Record<SketchConstraintKind, string>> = {
  coincident: '●',
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  tangent: '⌒',
  concentric: '◎',
  equal: '=',
  symmetric: '⇔',
  fix: '▣',
  distance: '↔',
  angle: '∠',
  radius: 'R',
  diameter: '⌀',
};

/** その種類の印の記号。 */
export function constraintKindSymbol(kind: SketchConstraintKind): string {
  return CONSTRAINT_SYMBOLS[kind];
}

/** 端点の見出しの鍵。`featureSummary.ts` の基準の見出しと同じ鍵を使い、文言を 2 か所に置かない。 */
const VERTEX_LABEL_KEYS: Readonly<Record<'start' | 'end' | 'center', MessageKey>> = {
  start: 'propertyPanel.base.vertexStart',
  end: 'propertyPanel.base.vertexEnd',
  center: 'propertyPanel.base.vertexCenter',
};

const STATE_MESSAGE_KEYS: Readonly<Record<Exclude<ConstraintState, 'ok'>, MessageKey>> = {
  conflicting: 'constraint.state.conflicting',
  redundant: 'constraint.state.redundant',
  dangling: 'constraint.state.dangling',
};

/** スケッチの中の要素の名前。見つからなければ「(消えた要素)」(FR-504)。 */
function featureNameOf(document: SketchDocument, featureId: string): string {
  const found = document.features.find((candidate) => candidate.id === featureId);
  return found === undefined ? t('constraint.detail.unknownElement') : found.name;
}

/** `featureId#3` の 3(0 起点)。番号を持たない id は null。 */
function indexOfPointId(pointId: string): number | null {
  const separator = pointId.indexOf('#');
  if (separator < 0) {
    return null;
  }
  const parsed = Number(pointId.slice(separator + 1));
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * 指し先 1 つの読み方(「線分1」「線分1 / 始点」「点列1 / 3番目」)。
 * `featureSummary.ts` の `namedBase` と同じ「名前 / 何を指すか」の並びにそろえる。
 */
export function describeConstraintTarget(
  document: SketchDocument,
  target: ConstraintTarget,
): string {
  const name = featureNameOf(document, featureIdOfTarget(target));
  switch (target.kind) {
    case 'point': {
      const index = indexOfPointId(target.pointId);
      return index === null
        ? name
        : `${name} / ${String(index + 1)}${t('constraint.detail.indexSuffix')}`;
    }
    case 'vertex':
      return `${name} / ${t(VERTEX_LABEL_KEYS[target.vertex])}`;
    case 'curve':
      return target.element.index === undefined
        ? name
        : `${name} / ${String(target.element.index + 1)}${t('constraint.detail.indexSuffix')}`;
  }
}

/**
 * 一覧の 1 行の「何を指しているか」。対称だけは軸を「軸: 線分3」と分けて添える
 * (点 2 つと軸を同じ「 と 」で並べると、どれが軸か読めなくなる)。
 */
function describeTargets(
  document: SketchDocument,
  constraint: SketchConstraint,
  targets: readonly ConstraintTarget[],
): string {
  const separator = t('constraint.detail.separator');
  if (constraint.kind === 'symmetric' && targets.length === 3) {
    const pair = [targets[0], targets[1]]
      .map((target) => describeConstraintTarget(document, target))
      .join(separator);
    return `${pair}${separator}${t('constraint.detail.axisPrefix')}${describeConstraintTarget(
      document,
      targets[2],
    )}`;
  }
  return targets.map((target) => describeConstraintTarget(document, target)).join(separator);
}

/** 値を単位つきの読める形にする。度だけ空白を空けない(「90°」)。 */
function describeValue(
  kind: SketchConstraintKind,
  value: ExpressionValue | null,
): string | null {
  if (value === null) {
    return null;
  }
  const unit = constraintValueUnit(kind);
  if (unit === null) {
    return value.source;
  }
  const label = t(UNIT_KEYS[unit]);
  return unit === 'degree' ? `${value.source}${label}` : `${value.source} ${label}`;
}

/** 印を置く場所 1 つ。曲線を指しているときは線分の中点、円・円弧なら中心。 */
function anchorOfTarget(context: ConstraintContext, target: ConstraintTarget): Vec3 | null {
  const direct = targetPositionOf(context.resolved, target);
  if (direct !== null) {
    return direct;
  }
  const featureId = featureIdOfTarget(target);
  return lineMidpointOf(context.resolved, featureId) ?? circleCenterOf(context.resolved, featureId);
}

/** 同じ位置に印を 2 つ重ねない。 */
function withoutDuplicates(anchors: readonly Vec3[]): readonly Vec3[] {
  const kept: Vec3[] = [];
  for (const anchor of anchors) {
    if (!kept.some((other) => other[0] === anchor[0] && other[1] === anchor[1] && other[2] === anchor[2])) {
      kept.push(anchor);
    }
  }
  return kept;
}

/**
 * 印を置く場所。**一致と同心は 1 つ**(2 つの指し先が同じ場所へ重なる拘束なので、
 * 印も 1 つでよい。計画書の「一致拘束の anchors は一致させた点 1 つ」)。
 * それ以外は指し先ごとに 1 つずつ置く(平行なら 2 本の線の中点)。
 */
function anchorsOf(
  context: ConstraintContext,
  constraint: SketchConstraint,
  targets: readonly ConstraintTarget[],
): readonly Vec3[] {
  const found: Vec3[] = [];
  for (const target of targets) {
    const anchor = anchorOfTarget(context, target);
    if (anchor !== null) {
      found.push(anchor);
    }
  }
  if (constraint.kind === 'coincident' || constraint.kind === 'concentric') {
    return found.length === 0 ? [] : [found[0]];
  }
  return withoutDuplicates(found);
}

/**
 * 一覧・印に出す状態。診断(タスク7)があればそれを写し、無ければ「材料がそろっているか」
 * だけを見る(`VariableSet.elementFeatureIds` は形が決まった要素の一覧)。
 *
 * 同じ拘束が冗長と矛盾の両方に入ることがある(長さ 10 と長さ 12)。**矛盾を優先**して出す
 * ── 形が合っていないことのほうが、重なっていることより先に直したい事実のため。
 */
function stateOf(
  context: ConstraintContext,
  constraint: SketchConstraint,
  diagnosis: ConstraintDiagnosis | null,
  targets: readonly ConstraintTarget[],
): ConstraintState {
  if (diagnosis !== null) {
    if (diagnosis.dangling.includes(constraint.id)) {
      return 'dangling';
    }
    if (diagnosis.conflicting.includes(constraint.id)) {
      return 'conflicting';
    }
    return diagnosis.redundant.includes(constraint.id) ? 'redundant' : 'ok';
  }
  const known = context.variableSet?.elementFeatureIds ?? null;
  if (known === null) {
    return 'ok';
  }
  return targets.some((target) => !known.has(featureIdOfTarget(target))) ? 'dangling' : 'ok';
}

/**
 * 拘束 1 つを一覧の 1 行にする(FR-501 と同じ流儀)。
 *
 * `diagnosis` を渡すと `state` に矛盾・冗長・材料切れが反映される(タスク13 が
 * `resolveConstrainedSketch` の結果から渡す)。省くと材料の有無だけを見る。
 */
export function constraintSummary(
  constraint: SketchConstraint,
  document: SketchDocument,
  diagnosis: ConstraintDiagnosis | null = null,
  context: ConstraintContext = constraintContextOf(document),
): ConstraintSummary {
  const targets = constraintTargets(constraint);
  const value = constraintValueOf(constraint);
  const state = stateOf(context, constraint, diagnosis, targets);
  return {
    id: constraint.id,
    kind: constraint.kind,
    label: constraint.name,
    detail: describeTargets(document, constraint, targets),
    symbol: CONSTRAINT_SYMBOLS[constraint.kind],
    value,
    valueText: describeValue(constraint.kind, value),
    anchors: anchorsOf(context, constraint, targets),
    state,
    stateMessage: state === 'ok' ? null : t(STATE_MESSAGE_KEYS[state]),
  };
}

/**
 * スケッチの拘束すべてを一覧の行にする(保存されている順のまま)。
 * 材料を 1 度だけ作って使い回すので、拘束が多くても解決は 1 回しか走らない。
 */
export function summarizeConstraints(
  document: SketchDocument,
  diagnosis: ConstraintDiagnosis | null = null,
  context: ConstraintContext = constraintContextOf(document),
): readonly ConstraintSummary[] {
  return sketchConstraints(document).map((constraint) =>
    constraintSummary(constraint, document, diagnosis, context),
  );
}
