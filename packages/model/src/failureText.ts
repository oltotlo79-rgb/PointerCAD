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

/** 計算部の文をそのまま出す鍵(文言の表の文は「{text}」)。 */
const PLAIN_TEXT_KEY = 'partError.plainText';

/**
 * 計算部(kernel・数式・関数の計算・Worker)が返した文を、そのまま画面に出す鍵と値にする(0b-3、統括の決定 D-0b-3-3 案 2)。
 * 文言の表の文は「{text}」だけ。部品・スケッチの誤りの文を鍵へ移すまでの間は、今ある model の文もこれで運ぶ
 * (使う所の数は束ごとの README に書き、鍵へ移すと減る)。model が新しく作る文には使わない。
 */
export function plainText(text: string): FailureText {
  return { key: PLAIN_TEXT_KEY, parameters: { text } };
}

/**
 * 鍵と値が、計算部の文をそのまま出す鍵(plainText)なら、その文を返す。ほかの鍵・無い時は null(0b-3)。
 * 文しか持てない入れ物(数式の図形の測りの未解決の理由)へ写す所と、検査だけが使う。画面へ出す所は ui の partErrorMessage を通す。
 */
export function plainTextValue(text: FailureText | undefined): string | null {
  const value = text?.key === PLAIN_TEXT_KEY ? text.parameters.text : undefined;
  return typeof value === 'string' ? value : null;
}
