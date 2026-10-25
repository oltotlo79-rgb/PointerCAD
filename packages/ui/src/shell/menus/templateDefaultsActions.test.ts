import { encodeSaveDocument, PCAD_TEMPLATE_KIND, readPcadFile, writePcadFile, type SaveDocumentEncoder } from '@pointercad/io';
import { createEmptyPartDocument, DEFAULT_TOOL_DEFAULTS, type ToolDefaults } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileGateway, PickedTypedFile } from '../../file/fileGateway.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { activeHasUnsavedChanges } from '../../file/assemblyFile.js';
import { PcadSaveWorkerError } from '../../file/pcadSaveWorker.js';
import { runFileMenuAction, runNewFromTemplate } from './fileToolbarActions.js';

const defaultSaveEncoder = useAppStore.getState().saveDocumentEncoder;
beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ saveDocumentEncoder: defaultSaveEncoder, documentSaveOperation: null, fileMessage: null });
});
afterEach(() => {
  vi.restoreAllMocks(); resetTestStore();
  useAppStore.setState({ saveDocumentEncoder: defaultSaveEncoder, documentSaveOperation: null });
});

function templateFile(defaults: ToolDefaults = DEFAULT_TOOL_DEFAULTS): PickedTypedFile {
  return { kind: 'pcadt', fileName: 'template.pcadt', bytes: writePcadFile(createEmptyPartDocument(), {
    kind: PCAD_TEMPLATE_KIND, lengthUnit: 'inch', toolDefaults: defaults,
  }) };
}

function installGateway(openFile: () => Promise<PickedTypedFile | null>) {
  const clear = vi.fn();
  const gateway: FileGateway = {
    openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null),
    hasSaveTarget: () => true, clearSaveTarget: clear, openFile,
  };
  const state = useAppStore.getState();
  state.setFileGateway(gateway);
  state.setFileState('current.pcad', state.document);
  state.setDisplaySettings({ ...state.displaySettings, numericToolDefaults: { 'point/relative/dx': '9' } });
  return clear;
}

describe('ひな形の初期値を現在の文書へ安全に反映する', () => {
  it('実ファイルの初期値を検証してから保存先を一度だけ解除し、他の設定を保つ', async () => {
    const clear = installGateway(() => Promise.resolve(templateFile({ ...DEFAULT_TOOL_DEFAULTS, circleRadius: '12.5' })));
    const before = useAppStore.getState();
    await runNewFromTemplate({ from: 'file' });
    const after = useAppStore.getState();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(after.activeDocumentId).not.toBe(before.activeDocumentId);
    expect(after.fileName).toBeNull();
    expect(after.displaySettings).toMatchObject({ lengthUnit: 'inch', numericToolDefaults: {
      'circleRadius/absolute/radius': '12.5', 'point/relative/dx': '9',
    } });
  });

  it('実ファイルに範囲外の初期値がある場合、文書・設定・保存先・Undoを維持する', async () => {
    const clear = installGateway(() => Promise.resolve(templateFile({ ...DEFAULT_TOOL_DEFAULTS, circleRadius: '0' })));
    const before = useAppStore.getState();
    await runNewFromTemplate({ from: 'file' });
    const after = useAppStore.getState();
    expect(after.fileMessage).toEqual({ key: 'settings.toolDefaults.invalidTemplate', failed: true });
    expect(clear).not.toHaveBeenCalled();
    expect(after.document).toBe(before.document);
    expect(after.activeDocumentId).toBe(before.activeDocumentId);
    expect(after.displaySettings).toBe(before.displaySettings);
    expect(after.fileName).toBe(before.fileName);
    expect(after.undoStack).toBe(before.undoStack);
  });

  it('ファイル選択の取消で文書と保存先を変えない', async () => {
    const clear = installGateway(() => Promise.resolve(null));
    const before = useAppStore.getState();
    await runNewFromTemplate({ from: 'file' });
    expect(useAppStore.getState()).toBe(before);
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(['edit', 'replace'] as const)('選択の待機中に文書が%sされたら、古い要求で上書きしない', async change => {
    let finish: () => void = () => { throw new Error('open gate was not initialized'); };
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const clear = installGateway(async () => { await gate; return templateFile(); });
    const pending = runNewFromTemplate({ from: 'file' });
    const previous = useAppStore.getState();
    const changed = change === 'replace' ? createEmptyPartDocument() : { ...previous.document, name: 'edited' };
    previous.applyDocument(changed, { replacesDocument: change === 'replace' });
    const beforeReply = useAppStore.getState();
    if (change === 'edit') expect(beforeReply.documentVersion).toBe(previous.documentVersion);
    finish(); await pending;
    const afterReply = useAppStore.getState();
    expect(afterReply).toBe(beforeReply);
    expect(afterReply.document).toBe(changed);
    expect(clear).not.toHaveBeenCalled();
  });
});

function saveTemplateFromMenu(): Promise<void> {
  return new Promise(resolve => runFileMenuAction('saveAsTemplate', () => {}, resolve, () => {}, () => {}));
}

function setupTemplateSave(encodeSave: SaveDocumentEncoder = encodeSaveDocument) {
  const save = vi.fn<NonNullable<FileGateway['saveFileAs']>>(() => Promise.resolve(true));
  const clear = vi.fn(), state = useAppStore.getState();
  state.applyDocument({ ...state.document, name: 'edited part' });
  useAppStore.setState({ saveDocumentEncoder: encodeSave, fileGateway: { ...state.fileGateway,
    saveFileAs: save, clearSaveTarget: clear }, canvases: new Map([['unused-image', Uint8Array.of(1, 2, 3)]]) });
  return { save, clear };
}

describe('ひな形保存メニューの非同期契約', () => {
  it('公開encoderへひな形だけを渡し、実ZIPを保存しても通常文書のdirtyとUndoを保つ', async () => {
    const encode = vi.fn<SaveDocumentEncoder>((input, control) => encodeSaveDocument(input, control));
    const { save, clear } = setupTemplateSave(encode), before = useAppStore.getState();
    expect(activeHasUnsavedChanges(before)).toBe(true);
    await saveTemplateFromMenu();
    expect(encode).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
    const parsed = readPcadFile(save.mock.calls[0][2]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('template could not be read');
    expect(parsed.kind).toBe(PCAD_TEMPLATE_KIND);
    expect(parsed.document.canvases).toEqual([]); expect(parsed.attachments.canvases.size).toBe(0);
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(after.canvases).toBe(before.canvases); expect(after.canvases.get('unused-image')?.byteLength).toBe(3);
    expect(after.savedDocument).toBe(before.savedDocument); expect(after.fileName).toBe(before.fileName);
    expect(activeHasUnsavedChanges(after)).toBe(true); expect(clear).not.toHaveBeenCalled();
    expect(after.fileMessage).toEqual({ key: 'template.saved', failed: false });
  });

  it.each(['edit', 'undo', 'replace', 'gateway'] as const)('圧縮待ちの%s後に古い要求を保存・通知しない', async change => {
    let release: () => void = () => { throw new Error('encoding gate missing'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    const encode = vi.fn<SaveDocumentEncoder>(async (input, control) => { await gate; return encodeSaveDocument(input, control); });
    const { save } = setupTemplateSave(encode);
    const saving = saveTemplateFromMenu();
    await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce());
    const old = useAppStore.getState();
    if (change === 'edit') old.applyDocument({ ...old.document, name: 'later edit' });
    else if (change === 'undo') old.undo();
    else if (change === 'replace') old.resetDocument(createEmptyPartDocument());
    else useAppStore.setState({ fileGateway: { ...old.fileGateway } });
    useAppStore.getState().setFileMessage({ key: 'file.openStopped', failed: true });
    const changed = useAppStore.getState();
    if (change === 'edit') expect(changed.documentVersion).toBe(old.documentVersion);
    if (change === 'undo') expect(changed.documentVersion).toBe(old.documentVersion + 1);
    release(); await saving;
    const after = useAppStore.getState();
    expect(save).not.toHaveBeenCalled();
    expect(after.document).toBe(changed.document); expect(after.undoStack).toBe(changed.undoStack);
    expect(after.savedDocument).toBe(changed.savedDocument); expect(after.canvases).toBe(changed.canvases);
    expect(after.fileGateway).toBe(changed.fileGateway); expect(after.activeDocumentId).toBe(changed.activeDocumentId);
    expect(after.fileMessage).toBe(changed.fileMessage);
  });

  it('圧縮中の取消で書かず、dirtyを保ち、同じ入口から実IOで再保存する', async () => {
    let release: () => void = () => { throw new Error('encoding gate missing'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    const encode = vi.fn<SaveDocumentEncoder>(async (input, control) => {
      control?.onProgress?.('compressing'); await gate; return encodeSaveDocument(input, control);
    });
    const { save } = setupTemplateSave(encode), before = useAppStore.getState();
    const saving = saveTemplateFromMenu();
    await vi.waitFor(() => expect(useAppStore.getState().documentSaveOperation?.stage).toBe('compressing'));
    const cancel = useAppStore.getState().documentSaveOperation?.cancel;
    if (cancel === null || cancel === undefined) throw new Error('cancel missing');
    cancel(); release(); await saving;
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().documentSaveOperation?.stage).toBe('cancelled');
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument });
    await saveTemplateFromMenu(); expect(save).toHaveBeenCalledOnce();
    expect(readPcadFile(save.mock.calls[0][2]).ok).toBe(true);
  });

  it('Worker失敗を成功にせず、通常文書を保ったまま再保存できる', async () => {
    const encode: SaveDocumentEncoder = () => Promise.reject(new PcadSaveWorkerError('crashed', 'worker failed'));
    const { save } = setupTemplateSave(encode), before = useAppStore.getState();
    await saveTemplateFromMenu();
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.saveEncodingFailed', failed: true });
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument });
    await saveTemplateFromMenu(); expect(readPcadFile(save.mock.calls[0][2]).ok).toBe(true);
  });
});
