/** ばねのプロパティ変更と、全長・ピッチ・巻数の従属関係を更新する。 */
import type { ExpressionValue, EvaluateOptions } from '@pointercad/expression';
import type { SolidFeature, SpringDerived, SpringFeature, SpringHandedness } from '@pointercad/model';
import type { SolidFieldKey } from './solidPropertyContracts.js';
import { deriveSpringValue } from './springExpressions.js';


/**
 * derived が指す `SolidFieldKey`(§0.a-0.30)。`setSpringField` が読み取り専用の欄への
 * 書き戻しを防ぐのに使う。
 */
const SPRING_DERIVED_FIELD_KEY: Readonly<Record<SpringDerived, SolidFieldKey>> = {
  length: 'springLength',
  pitch: 'springPitch',
  turns: 'springTurns',
};

/**
 * ばねの全長・ピッチ・巻数のうち、`derived` が指す1つを他の2つから自動生成した式で
 * 計算し直す(§0.a-0.30)。`solidCommands.ts` の `commitSpring` が使う式(タスク25b で
 * 固定済み)と同じものを、欄を書き換えた直後・求める値を切り替えた直後の書き戻しにも使う。
 *
 * `variables` はパラメータ表の変数表(P4b タスク22a、追加のみ)。
 */
function resolveSpringDerivedFields(
  derived: SpringDerived,
  length: ExpressionValue,
  pitch: ExpressionValue,
  turns: ExpressionValue,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): { readonly length: ExpressionValue; readonly pitch: ExpressionValue; readonly turns: ExpressionValue } {
  switch (derived) {
    case 'length':
      return {
        length: deriveSpringValue(pitch, turns, '*', variables, options),
        pitch,
        turns,
      };
    case 'pitch':
      return {
        length,
        pitch: deriveSpringValue(length, turns, '/', variables, options),
        turns,
      };
    case 'turns':
      return {
        length,
        pitch,
        turns: deriveSpringValue(length, pitch, '/', variables, options),
      };
  }
}

/** derived が指す欄を計算し直した新しいばねフィーチャーを作る。 */
function recomputeSpringDerived(
  feature: SpringFeature,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SpringFeature {
  const { length, pitch, turns } = resolveSpringDerivedFields(
    feature.derived,
    feature.length,
    feature.pitch,
    feature.turns,
    variables,
    options,
  );
  return { ...feature, length, pitch, turns };
}

/**
 * ばねの欄を書き戻す(§0.a-0.30)。`derived` が指す欄は読み取り専用なので書き戻さない
 * (`ExpressionField` を無効化しているので onChange は来ないが、念のためここでも防ぐ)。
 * 全長・ピッチ・巻数のどれかを書き換えたときは、derived が指す欄を計算し直して画面の数字を
 * 合わせる(NFR-UX-4。E2E「巻数を書き換えると全長が変わる」の土台)。コイル径・線径は
 * `全長 = ピッチ × 巻数` の関係に関わらないので、書き換えても他の欄は変わらない。
 *
 * `variables` はパラメータ表の変数表(P4b タスク22a、追加のみ)。
 */
export function setSpringField(
  feature: SpringFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SolidFeature {
  if (key === SPRING_DERIVED_FIELD_KEY[feature.derived]) {
    return feature;
  }
  switch (key) {
    case 'coilDiameter':
      return { ...feature, coilDiameter: value };
    case 'wireDiameter':
      return { ...feature, wireDiameter: value };
    case 'springPitch':
      return recomputeSpringDerived({ ...feature, pitch: value }, variables, options);
    case 'springTurns':
      return recomputeSpringDerived({ ...feature, turns: value }, variables, options);
    case 'springLength':
      return recomputeSpringDerived({ ...feature, length: value }, variables, options);
    default:
      return feature;
  }
}

/** ばねの軸をワールドの X / Y / Z へ変える(パターンの向き・回転軸と同じ扱い、§0.a-0.29)。 */
export function setSpringAxis(feature: SolidFeature, axis: 'x' | 'y' | 'z'): SolidFeature {
  return feature.kind === 'spring' ? { ...feature, axis: { kind: 'world', axis } } : feature;
}

/** ばねの巻き方向を変える(§0.a-0.33)。見た目が左右反転するだけで体積は変わらない。 */
export function setSpringHandedness(feature: SolidFeature, handedness: SpringHandedness): SolidFeature {
  return feature.kind === 'spring' ? { ...feature, handedness } : feature;
}

/**
 * 「求める値」を切り替える(§0.a-0.30)。切り替えた直後に、新しく derived になった欄を
 * 他の2つから計算し直して書き戻す(NFR-UX-4「切り替えた瞬間に画面の数字が合う」)。
 *
 * `variables` はパラメータ表の変数表(P4b タスク22a、追加のみ)。
 */
export function setSpringDerived(
  feature: SolidFeature,
  derived: SpringDerived,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SolidFeature {
  if (feature.kind !== 'spring') {
    return feature;
  }
  return recomputeSpringDerived({ ...feature, derived }, variables, options);
}
