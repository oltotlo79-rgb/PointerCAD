/**
 * 非同期の文書操作の採用判定。
 *
 * 読み込み・開く・置き換えなど、**待ちをはさんで文書へ結果を当てる操作**は、待ちの間に
 * 利用者が文書を切り替えた・編集した・取り消した(Undo)・同じ操作をもう一度始めたときに、
 * 開始時の古い文書から作った結果を今の文書へ当ててはならない。その判定をここ 1 か所に置く。
 *
 * **版の番号(`documentVersion`)だけでは足りない。** プロパティ欄の 1 文字ずつの編集や
 * 通常の `applyDocument` では番号が増えない(`documentSlice.ts` の `applyDocument`)。
 * 文書・履歴・添付はどれも不変の値で、変わるたびに参照が変わるので、**参照で比べる**。
 *
 * 判定の単位は次の 3 つをまとめたもの。
 * - 文書の同一性: 開いている文書の寿命(`activeDocumentId`)とファイルの口。
 * - 内容: 部品・組立・図面の文書と Undo の履歴、それに付く添付(読み込んだ形・下絵)。
 * - 依頼の順序: 同じ種類の依頼を後から始めたら、先の依頼の結果は採らない。
 */

import type { AppState } from './appState.js';
import { useAppStore } from './useAppStore.js';
import { beginDocumentRequest as beginDocumentRequestCore, type DocumentRequest } from './documentRequestCore.js';
export { captureDocumentIdentity, compareDocumentIdentity, type DocumentIdentity, type DocumentRequestStatus,
  type DocumentRequest } from './documentRequestCore.js';

/**
 * 待ちをはさむ文書操作を始める。**待つ前に**呼び、結果を当てる直前に `status()` を見る。
 *
 * @param channel 依頼の種類(例 `'import'`・`'open'`)。同じ種類を後から始めると先の札は
 *   `superseded` になる。
 */
export function beginDocumentRequest(channel: string, state: AppState = useAppStore.getState()): DocumentRequest {
  return beginDocumentRequestCore(channel, useAppStore.getState, state);
}
