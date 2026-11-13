/**
 * 開く(部品・組立・図面)で、読込の待ちの間に文書が変わったときの
 * 扱い。
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
import { readPcadInWorker } from './pcadReadWorker.js';
import type { PcadReadKind, PcadReadResults } from './pcadReadProtocol.js';
import type { PickedFile } from './fileGateway.js';
import { readTutorialCheckpoint, TUTORIAL_CHECKPOINT_KEY, type TutorialCheckpointResult,
  type TutorialCheckpointStorage, type TutorialSavedEvidence } from '../tutorial/tutorialCheckpoint.js';

const openOwners = new Map<DocumentRequest, { readonly controller: AbortController; readonly unsubscribe: () => void }>();
const cancelledOpenRequests = new WeakSet<DocumentRequest>();

/** App disposal or a newer open cancels the complete operation, including picker/checkpoint waits. */
export function cancelOpenReads(): void {
  for (const [request, owner] of openOwners) {
    cancelledOpenRequests.add(request);
    openOwners.delete(request);
    owner.unsubscribe();
    owner.controller.abort();
  }
}

function ownOpenRequest(request: DocumentRequest) {
  const existing = openOwners.get(request);
  if (existing !== undefined) return existing;
  const controller = new AbortController();
  const unsubscribe = useAppStore.subscribe(() => {
    const status = request.status();
    if (status === 'switched' || status === 'superseded') finishOpenRequest(request);
  });
  const owner = { controller, unsubscribe };
  openOwners.set(request, owner);
  return owner;
}

/** The caller that finishes the open owns subscription release; nested dispatch is idempotent. */
export function finishOpenRequest(request: DocumentRequest): void {
  const owner = openOwners.get(request);
  if (owner === undefined) return;
  openOwners.delete(request);
  owner.unsubscribe();
  owner.controller.abort();
}

/**
 * 開いたバイト列の所有を読込の Worker へ移してよいか(移すと写しを作らず、picked.bytes は長さ 0 になる)。
 * 移すのは、口が自分だけの並びとして渡した時(`picked.owned`)で、読込の後にそのバイト列を読む所が無い時だけ。
 * 学習の控えの鍵があると、読込の後に保存バイトの SHA-256 を取る(`readTutorialCheckpoint`)ので移さない。
 * 鍵を読めない時も移さない(読込の後に読めるようになりうるため)。控えの置き場が無い時は読込の後も読まない。
 */
export function mayTransferPickedBytes(picked: PickedFile, storage: TutorialCheckpointStorage | null): boolean {
  if (picked.owned !== true) return false;
  if (storage === null) return true;
  try { return storage.getItem(TUTORIAL_CHECKPOINT_KEY) === null; } catch { return false; }
}

/**
 * 読込の後に学習の控えを読む(移す道でも、今までの写しの道と同じ答えにする)。
 * - 移していない: 今までどおり picked.bytes で読む。
 * - 移した: 鍵が無ければ控えは保存バイトを読まないので、切り離された picked.bytes のまま読む(鍵の確かめと
 *   readTutorialCheckpoint の呼び出しの間に await を挟まない)。移すと決めた後に鍵が現れていたら、口の読み直しで同じ中身を
 *   取り直して照合する。読み直せない(開いた後に同じパスへ保存し直された等で同じ中身を返せない)時は staleContent
 *   (控えを書いた時と保存ファイルの中身が違う)にし、切り離された並びで corrupt にしない。
 */
export async function readCheckpointAfterRead(picked: PickedFile, transferred: boolean,
  storage: TutorialCheckpointStorage | null, evidenceOf: (savedBytes: Uint8Array) => TutorialSavedEvidence,
): Promise<TutorialCheckpointResult> {
  if (!transferred || storage === null || !checkpointKeyMayExist(storage)) return readTutorialCheckpoint(evidenceOf(picked.bytes), storage);
  let reread: Uint8Array;
  try {
    if (picked.reread === undefined) return { ok: false, reason: 'staleContent' };
    reread = await picked.reread();
  } catch {
    return { ok: false, reason: 'staleContent' };
  }
  return readTutorialCheckpoint(evidenceOf(reread), storage);
}

/** 鍵があるか。読めない時は「あるかもしれない」とする(読み直しの道へ。控えの読み取りが改めて今の答えを決める)。 */
function checkpointKeyMayExist(storage: TutorialCheckpointStorage): boolean {
  try { return storage.getItem(TUTORIAL_CHECKPOINT_KEY) !== null; } catch { return true; }
}

/**
 * Read only; document/history/attachments/save target are committed by the existing caller after its guard.
 * `transferInput` は呼び手が以後 bytes を読まない時だけ true(`mayTransferPickedBytes`)。
 */
export async function readForOpen<K extends PcadReadKind>(
  request: DocumentRequest, kind: K, bytes: Uint8Array, transferInput = false,
): Promise<PcadReadResults[K] | null> {
  const mayRead = () => !cancelledOpenRequests.has(request)
    && (request.status() === 'current' || request.status() === 'changed');
  if (!mayRead()) {
    if (request.status() === 'switched') reportStopped();
    return null;
  }
  const owner = ownOpenRequest(request);
  try {
    const result = await readPcadInWorker(kind, bytes, { signal: owner.controller.signal, isCurrent: mayRead, transferInput });
    if (!mayRead() || owner.controller.signal.aborted) {
      if (request.status() === 'switched') reportStopped();
      return null;
    }
    return result;
  } catch {
    if (request.status() === 'switched') reportStopped();
    else if (!owner.controller.signal.aborted && mayReportOpenFailure(request)) {
      useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    }
    return null;
  }
}

/** 開く操作の札を始める。破棄の確認に答えた直後(失ってよいと認めた状態)で呼ぶ。 */
export function beginOpenRequest(): DocumentRequest {
  cancelOpenReads();
  const request = beginDocumentRequest('open');
  ownOpenRequest(request);
  return request;
}

/** 読込に失敗したとき、その理由を今の画面へ出してよいか(別の文書・後の依頼には出さない)。 */
export function mayReportOpenFailure(request: DocumentRequest): boolean {
  const status = request.status();
  return !cancelledOpenRequests.has(request) && (status === 'current' || status === 'changed');
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
  if (cancelledOpenRequests.has(request)) return false;
  const status = request.status();
  if (status === 'current') return true;
  if (status === 'superseded') return false;
  if (status === 'switched') {
    reportStopped();
    return false;
  }
  request.accept();
  if (!(await deps.confirmDiscard('file.openChangedWhileReading'))) return false;
  if (cancelledOpenRequests.has(request)) return false;
  const answered = request.status();
  if (answered === 'current') return true;
  if (answered !== 'superseded') reportStopped();
  return false;
}
