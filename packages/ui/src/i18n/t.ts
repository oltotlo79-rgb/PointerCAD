import ja from './ja.json';

/** ja.json に実在するキーだけを受け付ける。打ち間違いは型検査で落ちる。 */
export type MessageKey = keyof typeof ja;

const messages: Readonly<Record<MessageKey, string>> = ja;

/** UI 文字列を引く。表示は日本語のみで開始する(NFR-MA-5)。 */
export function t(key: MessageKey): string {
  return messages[key];
}

/** テストと網羅確認のために全キーを公開する。 */
export const MESSAGE_KEYS = Object.keys(ja) as readonly MessageKey[];
