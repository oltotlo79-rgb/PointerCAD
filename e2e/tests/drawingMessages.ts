import { readFileSync } from 'node:fs';

/** 操作ラベルを翻訳の正本から取り、文書・メニューの表示名を推測して待ち続けない。 */
const messages: unknown = JSON.parse(readFileSync(new URL('../../packages/ui/src/i18n/ja/drawing.json', import.meta.url), 'utf8'));
export function drawingMessage(key: string): string {
  const value: unknown = typeof messages === 'object' && messages !== null ? Reflect.get(messages, key) : undefined;
  if (typeof value !== 'string' || /\?{2,}|\uFFFD/u.test(value)) throw new Error(`図面操作ラベルが未登録または破損: ${key}`);
  return value;
}
