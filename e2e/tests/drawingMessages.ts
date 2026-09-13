import { uiMessage } from './uiMessages.js';

/** 操作ラベルを翻訳の正本から取り、文書・メニューの表示名を推測して待ち続けない。 */
export function drawingMessage(key: string): string {
  return uiMessage('drawing', key);
}
