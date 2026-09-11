import { decodeScriptFile, encodeScriptFile } from '@pointercad/io';
import type { ScriptFile } from '@pointercad/model/scripting';
import { openFileThrough, saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { openScriptPanel, loadScriptLibrary } from './scriptActions.js';
import { fileFromDraft } from './scriptDraft.js';
import { browserScriptStorage, writeScriptLibrary } from './scriptLibrary.js';

export async function openScriptFile(): Promise<void> {
  const before = useAppStore.getState().scriptDraft;
  try {
    const picked = await openFileThrough(useAppStore.getState().fileGateway, ['pcadscript']);
    if (picked === null) return;
    const decoded = await decodeScriptFile(picked.bytes);
    if (useAppStore.getState().scriptDraft !== before) { useAppStore.setState({ scriptMessage: t('script.draftChanged') }); return; }
    if (!decoded.ok) { useAppStore.setState({ scriptMessage: t('script.invalidFile') }); return; }
    openScriptPanel(decoded.file); useAppStore.setState({ scriptMessage: t('script.opened') });
  } catch { useAppStore.setState({ scriptMessage: t('script.openFailed') }); }
}
export async function saveScriptFile(): Promise<void> {
  const { scriptDraft: draft, fileGateway: gateway } = useAppStore.getState();
  if (draft === null) return;
  try {
    const result = await fileFromDraft(draft);
    if (!result.ok) { useAppStore.setState({ scriptMessage: t('script.invalidInput') }); return; }
    const fileName = result.file.name.replace(/[<>:"/\\|?*]/gu, '_') + '.pcadscript';
    const saved = await saveFileAsThrough(gateway, fileName, 'pcadscript', await encodeScriptFile(result.file));
    if (useAppStore.getState().scriptDraft === draft) useAppStore.setState({ scriptMessage: t(saved ? 'script.saved' : 'script.saveCancelled') });
  } catch { useAppStore.setState({ scriptMessage: t('script.saveFailed') }); }
}
async function replaceTools(transform: (tools: readonly ScriptFile[]) => readonly ScriptFile[] | null,
  success: 'script.registered' | 'script.deleted' | 'script.restored', deleted: ScriptFile | null = null): Promise<void> {
  await loadScriptLibrary();
  const state = useAppStore.getState();
  if (state.scriptLibraryState !== 'ready' || state.scriptLibraryBusy) {
    useAppStore.setState({ scriptMessage: t('script.libraryFailed') }); return;
  }
  const next = transform(state.scriptLibrary);
  if (next === null) { useAppStore.setState({ scriptMessage: t('script.duplicateName') }); return; }
  useAppStore.setState({ scriptLibraryBusy: true });
  const saved = await writeScriptLibrary(browserScriptStorage(), next);
  useAppStore.setState(saved ? { scriptLibrary: next, scriptLibraryBusy: false, scriptDeletedTool: deleted, scriptMessage: t(success) }
    : { scriptLibraryBusy: false, scriptMessage: t('script.libraryWriteFailed') });
}
export async function registerScript(): Promise<void> {
  const draft = useAppStore.getState().scriptDraft; if (draft === null) return;
  const result = await fileFromDraft(draft);
  if (useAppStore.getState().scriptDraft !== draft) { useAppStore.setState({ scriptMessage: t('script.draftChanged') }); return; }
  if (!result.ok) { useAppStore.setState({ scriptMessage: t('script.invalidInput') }); return; }
  await replaceTools(tools => {
    if (tools.some(tool => tool.name === result.file.name && tool.scriptId !== result.file.scriptId)) return null;
    return tools.some(tool => tool.scriptId === result.file.scriptId)
      ? tools.map(tool => tool.scriptId === result.file.scriptId ? result.file : tool) : [...tools, result.file];
  }, 'script.registered');
}
export async function deleteScriptTool(scriptId: string): Promise<void> {
  const tool = useAppStore.getState().scriptLibrary.find(item => item.scriptId === scriptId); if (tool === undefined) return;
  await replaceTools(tools => tools.filter(item => item.scriptId !== scriptId), 'script.deleted', tool);
}
export async function restoreScriptTool(): Promise<void> {
  const tool = useAppStore.getState().scriptDeletedTool; if (tool === null) return;
  await replaceTools(tools => tools.some(item => item.scriptId === tool.scriptId || item.name === tool.name) ? null : [...tools, tool], 'script.restored');
}
