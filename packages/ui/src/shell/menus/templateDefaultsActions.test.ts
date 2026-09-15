import { PCAD_TEMPLATE_KIND, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument, DEFAULT_TOOL_DEFAULTS, type ToolDefaults } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileGateway, PickedTypedFile } from '../../file/fileGateway.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { runNewFromTemplate } from './fileToolbarActions.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

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
