/** 再計算の失敗と、他の立体へ取り込まれた履歴を同じ規則で扱う。 */
import { consumedBodyIds, type PartDocument, type PartRecomputeError } from '@pointercad/model';

/**
 * ほかの立体に取り込まれた立体の id(§0.a-0.5)。
 *
 * 文書だけを見る `consumedBodyIds` と違い、**失敗したブーリアンは何も取り込まない**ものとして
 * 数える。再計算(resolvePart)が失敗した段では消費を確定させないので、失敗を数に入れると
 * 画面には出ているのにツリーだけ「統合済み」と出て食い違う(FR-504)。
 * 失敗が分からないとき(errors を渡さないとき)は文書どおりの判定になる。
 */
export function consumedIds(
  document: PartDocument,
  errors: readonly PartRecomputeError[],
): ReadonlySet<string> {
  if (errors.length === 0) {
    return consumedBodyIds(document);
  }
  const failed = new Set(errors.map((error) => error.featureId));
  const survivors = document.solids.filter(
    (feature) => feature.kind !== 'boolean' || !failed.has(feature.id),
  );
  return consumedBodyIds({ ...document, solids: survivors });
}

/** その id の失敗の理由。無ければ null(FR-504)。 */
export function partErrorMessage(
  errors: readonly PartRecomputeError[],
  featureId: string,
): string | null {
  const found = errors.find((error) => error.featureId === featureId);
  return found === undefined ? null : found.message;
}
