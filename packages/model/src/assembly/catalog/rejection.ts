/**
 * 族の部品(保存の catalog が `catalogItem`)を組めない理由。**黙って消さず、読めない理由が分かる型付きの拒否**にする。
 *
 * 画面の文は ui の `i18n/ja/catalog.json` の `catalog.rejection.<理由>` が持ち、ここは文を持たない(D4「失敗の文は画面の側の一覧に持つ」)。
 * 文は利用者の言葉で書き、保存の形の識別子(`catalogItem`・`family`・`item`・options の鍵の名前)は出さない
 * (内部用語を画面に出さない)。どの欄が食い違ったかは `fields` に持つ(画面には出さない)。`{count}` は差し込む値。
 */
import type { FailureText } from '../../failureText.js';

export const CATALOG_ITEM_REJECTION_CODES = [
  'unknown-family',
  'family-not-loaded',
  'unsupported-catalog-revision',
  'unsupported-generator-revision',
  'unknown-item',
  'saved-fields-mismatch',
  'invalid-option-value',
] as const;

export type CatalogItemRejectionCode = typeof CATALOG_ITEM_REJECTION_CODES[number];

/** 拒否の 1 件。形は鋼材の拒否(`buildStandardPart.ts` の `standardPartRejection`)と同じ。 */
export interface CatalogItemRejection {
  readonly code: CatalogItemRejectionCode;
  /** 画面に出す文の鍵(`catalog.rejection.<理由>`)と差し込む値。 */
  readonly text: FailureText;
  /** 食い違った保存の欄の名前(昇順)。画面の文には出さない。 */
  readonly fields: readonly string[];
  /** 鋼材の拒否と形を揃えるための欄。族の拒否は規格の箇条を示さないので常に空。 */
  readonly basis: readonly never[];
}

export function catalogItemRejectionOf(code: CatalogItemRejectionCode,
  fields: readonly string[] = []): CatalogItemRejection {
  const parameters: Readonly<Record<string, string>> = code === 'saved-fields-mismatch' ? { count: String(fields.length) } : {};
  return { code, text: { key: `catalog.rejection.${code}`, parameters }, fields: [...fields].sort(), basis: [] };
}
