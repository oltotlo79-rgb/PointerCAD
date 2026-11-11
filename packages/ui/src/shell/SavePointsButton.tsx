import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore.js';
import { NamedSavePointsDialog, type NamedSavePointsLabels } from '../history/NamedSavePointsDialog.js';
import { t } from '../i18n/t.js';

/** 名前付き保存点の画面の文言。部品・組立・図面の道具列で同じものを使う。 */
export function namedSavePointLabels(): NamedSavePointsLabels {
  return {
    title: t('savePoint.title'), name: t('savePoint.name'), create: t('savePoint.create'),
    clone: t('savePoint.clone'), compare: t('savePoint.compare'), restore: t('savePoint.restore'),
    before: t('savePoint.before'), after: t('savePoint.after'), close: t('savePoint.close'),
    cancel: t('savePoint.cancel'), empty: t('savePoint.empty'), busy: t('savePoint.busy'),
    cancelled: t('savePoint.cancelled'), restored: t('savePoint.restored'), limits: t('savePoint.limits'),
    kinds: { part: t('savePoint.kind.part'), assembly: t('savePoint.kind.assembly'), drawing: t('savePoint.kind.drawing') },
    hints: {
      close: t('savePoint.hint.close'), name: t('savePoint.hint.name'), create: t('savePoint.hint.create'),
      select: t('savePoint.hint.select'), clone: t('savePoint.hint.clone'), before: t('savePoint.hint.before'),
      after: t('savePoint.hint.after'), compare: t('savePoint.hint.compare'), restore: t('savePoint.hint.restore'),
      restoreKind: t('savePoint.hint.restoreKind'), cancel: t('savePoint.hint.cancel'),
    },
    errors: {
      invalid: t('savePoint.error.invalid'), corrupt: t('savePoint.error.corrupt'),
      limitPoints: t('savePoint.error.limitPoints'), limitBytes: t('savePoint.error.limitBytes'),
      unavailable: t('savePoint.error.unavailable'), quota: t('savePoint.error.quota'),
      aborted: t('savePoint.error.aborted'), conflict: t('savePoint.error.conflict'),
      cancelled: t('savePoint.error.cancelled'),
    },
  };
}

/** Close only the admitted session. The gateway is borrowed and is never disposed here. */
export function observeSavePointsDocument(): () => void {
  const owner = useAppStore.getState().savePointsOwner;
  const check = (): void => {
    const state = useAppStore.getState();
    if (state.utilityPanel !== 'savePoints' || state.savePointsOwner !== owner) return;
    if (owner === null || owner.activeDocumentId !== state.activeDocumentId || owner.fileGateway !== state.fileGateway) {
      state.setUtilityPanelOpen('savePoints', false);
    }
  };
  const unsubscribe = useAppStore.subscribe(check);
  check();
  return unsubscribe;
}

/** The existing file menus share one store admission and the original dialog/actions. */
export function SavePointsDialogHost(): React.JSX.Element | null {
  const open = useAppStore(state => state.utilityPanel === 'savePoints');
  const owner = useAppStore(state => state.savePointsOwner);
  const currentId = useAppStore(state => state.activeDocumentId);
  const gateway = useAppStore(state => state.fileGateway);
  useEffect(() => {
    if (open) return observeSavePointsDocument();
    return undefined;
  }, [open, owner]);
  if (!open || owner === null || owner.activeDocumentId !== currentId || owner.fileGateway !== gateway) return null;
  return <NamedSavePointsDialog labels={namedSavePointLabels()}
    onClose={() => {
      const state = useAppStore.getState();
      if (state.utilityPanel === 'savePoints' && state.savePointsOwner === owner) {
        state.setUtilityPanelOpen('savePoints', false);
      }
    }} />;
}
