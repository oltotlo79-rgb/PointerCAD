/**
 * 開く(部品・組立・図面)で、読込の待ちの間に文書が変わったときの扱い
 * (docs/review-2026-09-28-codex.md R02・§6.1 の1)。
 *
 * 破棄の確認に答えた後も、ファイルを選ぶ窓や読込の間に利用者は編集・取り消しを続けられる。
 * その変更を黙って捨てないよう、**確認に答えた時点の文書**を札に控え、開く直前に照合する。
 * - 変わっていない: そのまま開く。
 * - 同じ文書が変わった: 改めて確認する。断れば今の文書・取り消しの履歴・保存先を保つ。
 * - 別の文書に切り替わった: 開くのをやめ、理由を出す。
 * - 後から別の「開く」が始まった: 先の依頼は黙ってやめる。
 */

import type { MessageKey } from '../i18n/t.js';
import { beginDocumentRequest, type DocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';

/** 開く操作の札を始める。破棄の確認に答えた直後(失ってよいと認めた状態)で呼ぶ。 */
export function beginOpenRequest(): DocumentRequest {
  return beginDocumentRequest('open');
}

/** 読込に失敗したとき、その理由を今の画面へ出してよいか(別の文書・後の依頼には出さない)。 */
export function mayReportOpenFailure(request: DocumentRequest): boolean {
  const status = request.status();
  return status === 'current' || status === 'changed';
}

function reportStopped(): void {
  useAppStore.getState().setFileMessage({ key: 'file.openStopped', failed: true });
}

/**
 * 読込を待った後、選んだファイルで今の文書を置き換えてよいかを決める。true のときだけ開く。
 * 改めての確認に答えるまでの間にさらに変わったら、開くのをやめる(確認した中身と違うため)。
 */
export async function mayOpenAfterRead(
  request: DocumentRequest,
  deps: { readonly confirmDiscard: (messageKey: MessageKey) => Promise<boolean> },
): Promise<boolean> {
  const status = request.status();
  if (status === 'current') return true;
  if (status === 'superseded') return false;
  if (status === 'switched') {
    reportStopped();
    return false;
  }
  request.accept();
  if (!(await deps.confirmDiscard('file.openChangedWhileReading'))) return false;
  const answered = request.status();
  if (answered === 'current') return true;
  if (answered !== 'superseded') reportStopped();
  return false;
}
