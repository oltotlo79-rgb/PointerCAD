/**
 * 画面に出す失敗の文の鍵と、差し込む値(D4「失敗の文は画面の側の一覧に持つ」、利用者の回答 2026-11-20 18:2x)。
 * 計算部(model)は日本語の文を持たず、この鍵と値だけを返す。文は ui の文言の表(i18n/ja)が鍵ごとに 1 つ持つ。
 * 鍵は文言の表の鍵と同じ文字(model は ui の型を読めないので文字で持つ。鍵が表にあるかは ui の検査が見る)。
 * 差し込む値は文字か、別の文の鍵と値(文の中に別の文を入れる時。例: 鋼材の拒否の理由)。
 */
export interface FailureText {
  readonly key: string;
  readonly parameters: Readonly<Record<string, string | FailureText>>;
}
