/**
 * 段階再計算の段取り(GR-06。計画書 `scratchpad/claude/plans/geomref-plan.md` §4(d)、利用者の回答
 * Q7=O1「測る形は、その値を係数経由で使う形より履歴の前。連なりは最大8段」)。
 *
 * 測った値を係数へ渡し、その係数で別の形を作るには、1 回の再計算の中で「形を作る → 測る → 係数を
 * 決める → 形を作る」を依存の深さだけ繰り返す。ここには OCCT も数学の計算部も呼ばない部分だけを置く
 * (形を作る・測るのは `part/recomputePart.ts`)。
 *
 * - 段取り(`planMathGeometryStages`): GR-02 の依存解析(`analyzeMathGeometryDependencies`)から、
 *   段 k(1〜stageCount)の形を作った後で測る定義と、計算させない係数の理由(循環・循環の値・段数超過・
 *   順序違反)を作る。図形由来の係数が無い文書では null を返し、再計算は今までと同じ 1 回だけの経路を
 *   通る(`recomputeSolids` の呼出し回数・順序・結果を変えない)。
 * - 途中の段で測るのは、その段の定義のうち、計算させない係数以外の係数が使うものだけ。どの係数も
 *   使わない定義、循環とその下流、上限を超えた段の定義は、最後の段(全部の定義を測る段)でだけ測る。
 * - 測った値はこの再計算の中でだけ持ち回る(`known`)。未解決も「未解決」として渡し、古い値や
 *   別の値で代用しない(申し送り §6.2-4)。
 */
import type { PartDocument } from '../part/types.js';
import { analyzeMathGeometryDependencies } from './mathGeometryDependencies.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from './mathGeometryTypes.js';

/** 段階再計算の段取り。`recomputePart` がこのとおりに形を作り、測る。 */
export interface MathGeometryStagePlan {
  /**
   * 係数名 → その係数を計算させない理由(GR-02 の `blocked`)。どの段の数式の評価にも
   * `DocumentMathContext.blocked` として渡す。理由を持つ係数は数学の計算部へ送られず、その理由で失敗する。
   */
  readonly blocked: ReadonlyMap<string, string>;
  /**
   * 途中の段で測る定義。`stages[k - 1]` が段 k の形を作った後で測る定義で、文書の並び。
   * 段 k の定義は、段 k より前に測った値だけで作れる形を測る(GR-02 の `stageOf`)。
   * 計算させない係数だけが使う段は空になる(その段では形を作らない)。
   */
  readonly stages: readonly (readonly MathGeometryDefinition[])[];
}

/**
 * 文書の段取りを作る。図形由来の係数(図形の測定値を直接または他の係数を通して使う係数)が
 * 1 つも無ければ null(途中の段は無く、再計算は今までと同じ 1 回だけ)。
 *
 * 係数の式が 1 つも無い文書では依存解析そのものを行わない(NFR-PF-3: 図形の測定値を使わない
 * 部品の再計算に費用を足さない)。式の係数参照を読めない文書(GR-02 の `unreadable`)も null で、
 * その式は数式の評価が今までどおり理由付きで断る。例外を投げない。
 */
export function planMathGeometryStages(document: PartDocument): MathGeometryStagePlan | null {
  if (!document.parameters.some(parameter => parameter.value.mathDefinition !== undefined)) return null;
  const analysis = analyzeMathGeometryDependencies(document);
  if (analysis.geometryDerived.size === 0) return null;
  // 計算させない係数は測った値が揃っても失敗するので、その係数だけが使う定義を途中で測っても形は増えない。
  const needed = new Set<string>();
  for (const [name, ids] of analysis.geometryDerived) {
    if (analysis.blocked.has(name)) continue;
    for (const id of ids) if (analysis.usedDefinitionIds.has(id)) needed.add(id);
  }
  const stages = Array.from({ length: analysis.stageCount }, (): MathGeometryDefinition[] => []);
  const seen = new Set<string>();
  for (const definition of document.mathGeometry ?? []) {
    // 同じ識別番号の定義は 1 つに決まらない(GR-04 `resolvableMathGeometryDefinitions`)ので needed に入らない。
    if (seen.has(definition.id)) continue;
    seen.add(definition.id);
    const stage = analysis.stageOf.get(definition.id);
    if (stage === undefined || stage > stages.length || !needed.has(definition.id)) continue;
    stages[stage - 1].push(definition);
  }
  return { blocked: analysis.blocked, stages };
}

/**
 * 測った結果が係数の式へ数として入るか(GR-04 の `mathGeometryCoefficientValue` が値を渡すもの:
 * 有限の実数)。真偽(平行・垂直など)と未解決は入らない。段階再計算は、前に形を作ってから
 * このような値が 1 つも増えていなければ形を作り直さない(作り直しても同じ形になるため)。
 */
export function isMathGeometryValue(outcome: MathGeometryOutcome): boolean {
  return outcome.status === 'value' && outcome.kind === 'real' && Number.isFinite(outcome.value);
}

/**
 * 途中の段そのもの(形の計算部・数学の計算部の呼出しごと)が失敗して測れなかった定義の結果。
 * 値の代わりではなく、その定義を使う係数を「計算待ち」のまま終わらせず、理由付きで失敗させるための
 * 未解決(`failed-geometry`)。利用者に見せる測定結果は、最後の段で測り直した結果だけ
 * (`PartRecomputeResult.mathGeometry`)で、ここで作ったものは再計算の外へ出ない。
 */
export function unmeasuredMathGeometryOutcomes(definitions: readonly MathGeometryDefinition[], documentId: string,
  generation: number, message: string): readonly MathGeometryOutcome[] {
  return definitions.map(definition => ({ id: definition.id, documentId, generation, status: 'unresolved' as const,
    reason: 'failed-geometry' as const, message }));
}
