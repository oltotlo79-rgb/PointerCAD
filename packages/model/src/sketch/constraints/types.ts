/**
 * 拘束の保存形(FR-313、計画書 docs/plans/P4b-スケッチの仕上げ.md §0.a-0.5・§2.2、タスク4)。
 *
 * 寸法拘束 4 種(距離・角度・半径・直径)と幾何拘束 9 種(一致・水平・垂直・平行・直角・
 * 接線・同心・等しい・対称)に、ソルバーの基準になる「固定」を足した 14 種を判別共用体で持つ。
 * 「固定」を足したのは、動かない点が 1 つも無いと解が一意に決まらないため(§0.a-0.2)。
 *
 * **拘束は順序を持たない**ので、フィーチャーの履歴(`SketchDocument.features`)とは
 * 別の配列(`SketchDocument.constraints`)に置く(§0.a-0.5)。
 *
 * 寸法の目標値は `ExpressionValue` で持つ。式のまま保存されるので、パラメータ表
 * (FR-207)の名前を寸法拘束へ書ける(§2.2「2 つの機能がここで噛み合う」)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { SketchDocument, SketchElementRef } from '../types.js';

/**
 * 拘束が指す先。点の鍵は `resolveCoordinate.ts` の `vertexKey` / `ResolvedPoint.id` と
 * 同じ規約で、別の規約をここで作らない(§2.2 の落とし穴)。
 *
 * - `point`: 点フィーチャー(鍵は `featureId`)、点列・複製の n 番目(`featureId#n`)、
 *   スプラインの n 番目(`featureId#n`)。
 * - `vertex`: 要素の端点・中心(鍵は `featureId:start` / `:end` / `:center`)。
 * - `curve`: 曲線そのもの(平行・直角・接線・等しい・対称の軸が指す先)。
 */
export type ConstraintTarget =
  | { readonly kind: 'point'; readonly pointId: string }
  | {
      readonly kind: 'vertex';
      readonly featureId: string;
      readonly vertex: 'start' | 'end' | 'center';
    }
  | { readonly kind: 'curve'; readonly element: SketchElementRef };

export type SketchConstraintKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'concentric'
  | 'equal'
  | 'symmetric'
  | 'fix'
  | 'distance'
  | 'angle'
  | 'radius'
  | 'diameter';

/**
 * 種類の網羅表。`io` の読み書き(タスク21)と ui の一覧(タスク12・13)が
 * 「知らない種類が増えていないか」をこの 1 か所で確かめられるようにする
 * (`SketchFeatureKind` に種類を足したとき網羅箇所が落ちた P4 タスク4 の教訓)。
 */
export const SKETCH_CONSTRAINT_KINDS: readonly SketchConstraintKind[] = [
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

interface ConstraintBase {
  readonly id: string;
  /** 一覧に出す名前(FR-501 と同じ流儀。「直角1」など)。 */
  readonly name: string;
}

export type SketchConstraint =
  | (ConstraintBase & {
      readonly kind: 'coincident';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
    })
  | (ConstraintBase & {
      readonly kind: 'horizontal' | 'vertical';
      readonly target: ConstraintTarget;
    })
  | (ConstraintBase & {
      readonly kind: 'parallel' | 'perpendicular' | 'equal';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
    })
  | (ConstraintBase & {
      readonly kind: 'tangent';
      readonly line: ConstraintTarget;
      readonly circle: ConstraintTarget;
    })
  | (ConstraintBase & {
      readonly kind: 'concentric';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
    })
  | (ConstraintBase & {
      readonly kind: 'symmetric';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
      readonly axis: SketchElementRef;
    })
  | (ConstraintBase & { readonly kind: 'fix'; readonly target: ConstraintTarget })
  | (ConstraintBase & {
      readonly kind: 'distance';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
      readonly length: ExpressionValue;
    })
  | (ConstraintBase & {
      readonly kind: 'angle';
      readonly a: ConstraintTarget;
      readonly b: ConstraintTarget;
      readonly angle: ExpressionValue;
    })
  | (ConstraintBase & {
      readonly kind: 'radius' | 'diameter';
      readonly target: ConstraintTarget;
      readonly size: ExpressionValue;
    });

/**
 * 拘束 1 つが出す残差(式)の本数(§2.2 の表)。自由度は
 * 「変数の数 − 有効な拘束の式の数」で数える(`variables.ts` の `countDegreesOfFreedom`)。
 *
 * **「固定」だけ 0 本**なのは、固定が式を足すのではなく**変数を 2 つ減らす**道具だから
 * (`collectVariables` が固定された点を `frozen: 'fixed'` にして変数から外す)。
 * ここで 2 本と数えると、減った変数と足した式で二重に引くことになり自由度が合わなくなる。
 */
export const CONSTRAINT_EQUATION_COUNTS: Readonly<Record<SketchConstraintKind, number>> = {
  coincident: 2,
  horizontal: 1,
  vertical: 1,
  parallel: 1,
  perpendicular: 1,
  tangent: 1,
  concentric: 2,
  equal: 1,
  symmetric: 2,
  fix: 0,
  distance: 1,
  angle: 1,
  radius: 1,
  diameter: 1,
};

/** その拘束が出す残差の本数。 */
export function constraintEquationCount(constraint: SketchConstraint): number {
  return CONSTRAINT_EQUATION_COUNTS[constraint.kind];
}

/**
 * その拘束が指している先をすべて並べる(材料が在るかの判定に使う)。
 * 対称の軸(`SketchElementRef`)は `curve` の指し先として扱い、呼ぶ側で場合分けを増やさない。
 */
export function constraintTargets(constraint: SketchConstraint): readonly ConstraintTarget[] {
  switch (constraint.kind) {
    case 'horizontal':
    case 'vertical':
    case 'fix':
      return [constraint.target];
    case 'radius':
    case 'diameter':
      return [constraint.target];
    case 'tangent':
      return [constraint.line, constraint.circle];
    case 'symmetric':
      return [constraint.a, constraint.b, { kind: 'curve', element: constraint.axis }];
    case 'coincident':
    case 'parallel':
    case 'perpendicular':
    case 'equal':
    case 'concentric':
    case 'distance':
    case 'angle':
      return [constraint.a, constraint.b];
  }
}

/**
 * スケッチの拘束。**欄が無ければ空**として読む(版 4 までの `.pcad` には拘束の欄が無い)。
 * 「無ければ空」の規約はここ 1 か所に置き、読む側で `?? []` を書き散らさない。
 */
export function sketchConstraints(document: SketchDocument): readonly SketchConstraint[] {
  return document.constraints ?? [];
}
