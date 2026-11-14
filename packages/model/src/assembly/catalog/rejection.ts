/**
 * 族の部品(保存の catalog が `catalogItem`)を組めない理由。**黙って消さず、読めない理由が分かる型付きの拒否**にする。
 *
 * 文は利用者の言葉で書き、保存の形の識別子(`catalogItem`・`family`・`item`・options の鍵の名前)は出さない
 * (内部用語を画面に出さない)。どの欄が食い違ったかは `fields` に持つ(画面には出さない)。
 * 画面の文言の正本は ui の `i18n/ja/catalog.json` の `catalog.rejection.<理由>` で、ここの文と一字一句同じ
 * (ui の検査が照らす)。`{count}` は差し込む値。
 */

export const CATALOG_ITEM_REJECTION_TEMPLATES = {
  'unknown-family': 'この部品の種類は、このアプリの版の部品の表にありません。アプリを新しい版にしてから開いてください。',
  'family-not-loaded': 'この部品の表を読み込んでいます。読み込みが終わってから、もう一度開いてください。',
  'unsupported-catalog-revision': 'この部品の表の版には対応していません。',
  'unsupported-generator-revision': 'この部品の形を作る版には対応していません。',
  'unknown-item': 'この部品の呼び寸法は、部品の表にありません。',
  'saved-fields-mismatch': '保存した部品の指定のうち {count} 項目が部品の表と一致しません。',
  'invalid-option-value': '部品の長さなどの指定が、範囲の外か数として読めません。',
} as const;

export type CatalogItemRejectionCode = keyof typeof CATALOG_ITEM_REJECTION_TEMPLATES;

/** 拒否の 1 件。形は鋼材の拒否(`buildStandardPart.ts` の `standardPartRejection`)と同じ。 */
export interface CatalogItemRejection {
  readonly code: CatalogItemRejectionCode;
  readonly messageKey: `catalog.rejection.${CatalogItemRejectionCode}`;
  readonly parameters: Readonly<Record<string, string>>;
  /** 日本語の文(model を使う側の既定の文)。 */
  readonly message: string;
  /** 食い違った保存の欄の名前(昇順)。画面の文には出さない。 */
  readonly fields: readonly string[];
  /** 鋼材の拒否と形を揃えるための欄。族の拒否は規格の箇条を示さないので常に空。 */
  readonly basis: readonly never[];
}

export function catalogItemRejectionOf(code: CatalogItemRejectionCode,
  fields: readonly string[] = []): CatalogItemRejection {
  const parameters: Readonly<Record<string, string>> = code === 'saved-fields-mismatch' ? { count: String(fields.length) } : {};
  let message: string = CATALOG_ITEM_REJECTION_TEMPLATES[code];
  for (const [key, value] of Object.entries(parameters)) message = message.split(`{${key}}`).join(value);
  return { code, messageKey: `catalog.rejection.${code}`, parameters, message, fields: [...fields].sort(), basis: [] };
}
