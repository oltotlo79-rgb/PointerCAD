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
    if (isCurrent()) await save(isCurrent);
  });
  const tracked = attempt.finally(() => {
    if (pending.get(state.fileGateway) === tracked) pending.delete(state.fileGateway);
  });
  pending.set(state.fileGateway, tracked);
  return tracked;
}
