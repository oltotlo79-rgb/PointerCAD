import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FileGateway } from './fileGateway.js';

const pending = new WeakMap<FileGateway, Promise<void>>();

/** 同じ窓の保存を依頼順に完了させる。別の文書へ切り替わった依頼は実行しない。 */
export function queueDocumentSave(state: AppState, save: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
  const isCurrent = (): boolean => {
    const current = useAppStore.getState();
    return current.activeDocumentId === state.activeDocumentId && current.fileGateway === state.fileGateway;
  };
  const previous = pending.get(state.fileGateway) ?? Promise.resolve();
  const attempt = previous.catch(() => undefined).then(async () => {
    if (isCurrent()) {
      useAppStore.getState().setFileMessage(null);
      await save(isCurrent);
    }
  });
  const tracked = attempt.finally(() => {
    if (pending.get(state.fileGateway) === tracked) pending.delete(state.fileGateway);
  });
  pending.set(state.fileGateway, tracked);
  return tracked;
}

/** 古い控えの消去が終わる前に「保存しました」と知らせない。途中の編集・文書切替も上書きしない。 */
export async function completeDocumentSave(
  isCurrent: () => boolean,
  discardRecovery: () => Promise<void>,
): Promise<void> {
  const version = useAppStore.getState().documentVersion;
  try {
    await discardRecovery();
  } catch {
    // ファイル自体の保存は成功済み。消去できない控えを残しても保存失敗とは扱わない。
  }
  const current = useAppStore.getState();
  if (isCurrent() && current.documentVersion === version) {
    current.setFileMessage({ key: 'file.saved', failed: false });
  }
}
