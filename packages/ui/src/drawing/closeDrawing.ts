import { createDefaultPartFileDeps, type PartFileDeps } from '../file/partFile.js';
import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { useAppStore } from '../store/useAppStore.js';

let asking = false;

/** 戻る操作で図面を閉じる前に、未保存の図面を破棄してよいか確認する。 */
export async function closeDrawingWithConfirmation(
  deps: Pick<PartFileDeps, 'confirmDiscard'> = createDefaultPartFileDeps(),
): Promise<boolean> {
  const before = useAppStore.getState();
  if (before.drawing === null || asking) return false;
  asking = true;
  try {
    if (activeHasUnsavedChanges(before) && !(await deps.confirmDiscard('file.discardConfirm'))) return false;
    const current = useAppStore.getState();
    // 確認に答えている間の別文書・追加編集には、古い破棄の回答を使わない。
    if (current.activeDocumentId !== before.activeDocumentId || current.drawing !== before.drawing
      || current.drawingSources !== before.drawingSources) return false;
    current.closeDrawing();
    return true;
  } finally { asking = false; }
}
