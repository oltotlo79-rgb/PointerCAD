import { ja } from './ja.js';

/** ja の表に実在するキーだけを受け付ける。打ち間違いは型検査で落ちる。 */
export type MessageKey = keyof typeof ja;

const messages: Readonly<Record<MessageKey, string>> = ja;

/**
 * 設定で一部が替わる文の読み手(B-08 2-5: 選択に足す・外すキーの案内)。null なら表の値をそのまま返す。
 * i18n から店を読み込むと循環するので、店の側(store/useAppStore.ts)が読む関数だけを登録する。状態は複製しない。
 */
let readOverride: (key: MessageKey) => string | null = () => null;
export function registerMessageOverride(read: (key: MessageKey) => string | null): void { readOverride = read; }

/** UI 文字列を引く。表示は日本語のみで開始する(NFR-MA-5)。 */
export function t(key: MessageKey): string {
  return readOverride(key) ?? messages[key];
}

/** テストと網羅確認のために全キーを公開する。 */
export const MESSAGE_KEYS = Object.keys(ja) as readonly MessageKey[];
