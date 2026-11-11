import type { AppState } from '../store/appState.js';
import { captureDocumentIdentity, compareDocumentIdentity } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FileGateway } from './fileGateway.js';
import type { SaveEncodingControl } from '@pointercad/io';
import { PcadSaveWorkerError } from './pcadSaveWorker.js';

const pending = new WeakMap<FileGateway, Promise<void>>();
const generations = new WeakMap<FileGateway, number>();
const running = new WeakMap<FileGateway, AbortController>();

export interface DocumentSaveControl extends SaveEncodingControl {
  readonly signal: AbortSignal;
  /** 書込み開始から確定までは取消ボタンを出さない。 */
  readonly beginWriting: () => boolean;
}

/** 所有者の終了時は処理中のWorkerと同世代の待機依頼を取り消す。 */
export function cancelDocumentSaves(gateway: FileGateway): void {
  generations.set(gateway, (generations.get(gateway) ?? 0) + 1);
  running.get(gateway)?.abort();
}

export function reportSaveEncodingFailure(error: unknown, isCurrent: () => boolean): void {
  if (!isCurrent() || !(error instanceof PcadSaveWorkerError)) return;
  useAppStore.getState().setFileMessage({ key: 'file.saveEncodingFailed', failed: true, detail: error.message });
}

/** 同じ窓の保存を依頼順に完了させる。別の文書へ切り替わった依頼は実行しない。 */
export function queueDocumentSave(state: AppState,
  save: (isCurrent: () => boolean, control: DocumentSaveControl) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const generation = generations.get(state.fileGateway) ?? 0;
  const id = crypto.randomUUID();
  let finished = false, writing = false;
  const sameOwner = (): boolean => {
    const current = useAppStore.getState();
    return current.activeDocumentId === state.activeDocumentId && current.fileGateway === state.fileGateway;
  };
  const isCurrent = (): boolean => {
    return !finished && sameOwner() && !controller.signal.aborted && generation === (generations.get(state.fileGateway) ?? 0);
  };
  const previous = pending.get(state.fileGateway) ?? Promise.resolve();
  const attempt = previous.catch(() => undefined).then(async () => {
    if (isCurrent()) {
      running.set(state.fileGateway, controller);
      const cancel = (): void => {
        if (!isCurrent() || writing) return;
        cancelDocumentSaves(state.fileGateway);
        useAppStore.setState({ documentSaveOperation: { id, documentId: state.activeDocumentId,
          gateway: state.fileGateway, stage: 'cancelled', fileName: null, cancel: null } });
      };
      const update = (stage: 'preparing' | 'compressing' | 'writing'): void => {
        if (isCurrent()) useAppStore.setState({ documentSaveOperation: { id, documentId: state.activeDocumentId,
          gateway: state.fileGateway, stage, fileName: null, cancel: stage === 'writing' ? null : cancel } });
      };
      const unsubscribe = useAppStore.subscribe(() => { if (!sameOwner()) controller.abort(); });
      useAppStore.getState().setFileMessage(null);
      update('preparing');
      try {
        await save(isCurrent, { signal: controller.signal, onProgress: stage => { if (!writing) update(stage); },
          beginWriting: () => { if (!isCurrent()) return false; writing = true; update('writing'); return true; } });
      } finally {
        finished = true;
        unsubscribe();
        if (running.get(state.fileGateway) === controller) running.delete(state.fileGateway);
        const operation = useAppStore.getState().documentSaveOperation;
        if (operation?.id === id && operation.stage !== 'complete' && operation.stage !== 'cancelled') {
          useAppStore.setState({ documentSaveOperation: null });
        }
      }
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
  fileName?: string,
): Promise<void> {
  // 版の番号は通常の編集で増えないので、文書・履歴・添付の参照で「途中の編集」を調べる。
  const identity = captureDocumentIdentity(useAppStore.getState());
  const operation = useAppStore.getState().documentSaveOperation;
  if (isCurrent() && operation !== null) useAppStore.setState({ documentSaveOperation: { ...operation, stage: 'settling', cancel: null } });
  try {
    await discardRecovery();
  } catch (error) {
    // ファイル自体の保存は成功済み。消去できない控えを残しても保存失敗とは扱わない。
    const state = useAppStore.getState();
    if (isCurrent() && state.autoSaver !== null) useAppStore.setState({ recoverySaveState: {
      documentId: state.activeDocumentId, saver: state.autoSaver, stage: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    } });
  }
  const current = useAppStore.getState();
  if (isCurrent() && compareDocumentIdentity(identity, current) === 'current') {
    current.setFileMessage({ key: 'file.saved', failed: false });
  }
  // 追加編集はdirtyのまま残るが、実際に保存したファイル名は控え処理後に示せる。
  if (isCurrent() && operation !== null && current.documentSaveOperation?.id === operation.id) {
    useAppStore.setState({ documentSaveOperation: { ...operation, stage: 'complete', fileName: fileName ?? null, cancel: null } });
  }
}
