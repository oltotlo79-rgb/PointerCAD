import type { FileGateway } from '../../file/fileGateway.js';
import { PCAD_TEMPLATE_KIND } from '@pointercad/io';
import { runNewFromTemplate } from './fileToolbarActions.js';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { encodeSaveDocument, readPcadFile, writePcadFile } from '@pointercad/io';
import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCommand } from '../../commands/commandRegistry.js';
import { toolbarCommandId } from '../../commands/toolbarCommandCatalog.js';
import { createNamedSavePointActions } from '../../history/namedSavePointActions.js';
import { createNamedSavePoints, type NamedSavePoint, type SavePointBlob, type SavePointStorage } from '../../history/namedSavePoints.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { observeSavePointsDocument, SavePointsDialogHost } from '../SavePointsButton.js';
import { fileMenuItems } from './fileMenuItems.js';

const admittedDialogs = vi.hoisted(() => ({ callbacks: [] as (() => void)[] }));
vi.mock('../../history/NamedSavePointsDialog.js', () => ({
  NamedSavePointsDialog: (props: { readonly onClose: () => void }) => {
    admittedDialogs.callbacks.push(props.onClose);
    return null;
  },
}));
beforeEach(() => { admittedDialogs.callbacks.length = 0; resetTestStore(); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function memoryStorage(): SavePointStorage {
  let revision = 0;
  const points = new Map<string, NamedSavePoint>(), blobs = new Map<string, Uint8Array>();
  return {
    load: () => Promise.resolve().then(() => {
      const metadata: SavePointBlob[] = [...blobs].map(([sha256, bytes]) => ({ version: 1, sha256,
        byteLength: bytes.byteLength, chunkCount: Math.max(1, Math.ceil(bytes.byteLength / 1048576)) }));
      return { revision, points: [...points.values()], blobs: metadata,
        chunkKeys: metadata.flatMap(blob => Array.from({ length: blob.chunkCount }, (_, i) => `${blob.sha256}:${i}`)) };
    }),
    readBlob: blob => Promise.resolve().then(() => {
      const bytes = blobs.get(blob.sha256);
      if (bytes === undefined) throw new Error('missing saved blob');
      return new Uint8Array(bytes);
    }),
    commit: (expected, change, signal) => Promise.resolve().then(() => {
      signal?.throwIfAborted();
      if (revision !== expected) throw new Error('conflicting save-point revision');
      if (change.pointPut) points.set(change.pointPut.id, structuredClone(change.pointPut));
      if (change.pointDelete) points.delete(change.pointDelete);
      for (const [hash, bytes] of change.blobPut ?? []) blobs.set(hash, new Uint8Array(bytes));
      for (const hash of change.blobDelete ?? []) blobs.delete(hash.sha256);
      revision += 1;
    }),
  };
}

describe('保存点の実command入口と原本', () => {
  it.each(['part', 'assembly', 'drawing'] as const)('%sで同じcommandを実行し、文書/履歴/通常保存先を変えない', kind => {
    const initial = useAppStore.getState();
    if (kind === 'assembly') initial.openAssembly(createAssemblyDocument('組立'));
    if (kind === 'drawing') initial.openDrawing(createDrawingDocument('図面', {
      sourceRef: 'source', sourceKind: 'part', fileName: 'source.pcad', path: '', contentHash: '', importedAt: '',
    }));
    const before = useAppStore.getState();
    const id = toolbarCommandId(kind === 'drawing' ? 'drawing' : 'fileMenu', 'savePoints');
    expect(executeCommand(id).status).toBe('executed');
    const opened = useAppStore.getState();
    expect(opened.utilityPanel).toBe('savePoints');
    expect(opened.savePointsOwner).toEqual({ activeDocumentId: before.activeDocumentId, fileGateway: before.fileGateway });
    expect(opened.document).toBe(before.document); expect(opened.undoStack).toBe(before.undoStack);
    expect(opened.assembly).toBe(before.assembly); expect(opened.drawing).toBe(before.drawing);
    expect(opened.fileName).toBe(before.fileName); expect(opened.fileGateway).toBe(before.fileGateway);
    if (kind !== 'drawing') expect(fileMenuItems([], [], kind).some(row => row.id === 'savePoints')).toBe(true);
  });

  it('文書切替がhost初回effectより早くても古いownerを拒否し、古い閉鎖で別画面を消さない', () => {
    executeCommand(toolbarCommandId('fileMenu', 'savePoints'));
    useAppStore.getState().resetDocument({ ...createEmptyPartDocument(), name: '別の部品' });
    const stop = observeSavePointsDocument();
    try {
      expect(useAppStore.getState().utilityPanel).toBeNull();
      executeCommand(toolbarCommandId('fileMenu', 'savePoints'));
      const currentOwner = useAppStore.getState().savePointsOwner;
      useAppStore.getState().setUtilityPanelOpen('export', true);
      useAppStore.getState().setUtilityPanelOpen('savePoints', false);
      expect(useAppStore.getState().utilityPanel).toBe('export');
      expect(currentOwner?.activeDocumentId).toBe(useAppStore.getState().activeDocumentId);
    } finally { stop(); }
  });

  it('図面計算中も元の独立ボタンと同じく一覧を開くだけで、文書/計算世代を変えない', () => {
    useAppStore.getState().openDrawing(createDrawingDocument('計算中の図面', {
      sourceRef: 'source', sourceKind: 'part', fileName: 'source.pcad', path: '', contentHash: '', importedAt: '',
    }));
    useAppStore.setState({ drawingBusy: true });
    const before = useAppStore.getState();
    expect(executeCommand(toolbarCommandId('drawing', 'savePoints')).status).toBe('executed');
    const after = useAppStore.getState();
    expect(after.utilityPanel).toBe('savePoints');
    expect(after.drawing).toBe(before.drawing); expect(after.drawingUndoStack).toBe(before.drawingUndoStack);
    expect(after.drawingBusy).toBe(true); expect(after.requestedGeneration).toBe(before.requestedGeneration);
  });

  it('同じ文書でも保存先の口が差し替わればhostを閉じ、借用した元の口を変更しない', () => {
    executeCommand(toolbarCommandId('fileMenu', 'savePoints'));
    const original = useAppStore.getState().fileGateway;
    const stop = observeSavePointsDocument();
    try {
      const replacement = { ...original };
      useAppStore.setState({ fileGateway: replacement });
      expect(useAppStore.getState().utilityPanel).toBeNull();
      expect(useAppStore.getState().fileGateway).toBe(replacement);
    } finally { stop(); }
  });

  it('メニューから到達した実保存点を独立読取し、複製は元SHA不変、復元だけUndo1段', async () => {
    executeCommand(toolbarCommandId('fileMenu', 'savePoints'));
    useAppStore.setState({ saveDocumentEncoder: async snapshot => encodeSaveDocument(snapshot) });
    const repo = createNamedSavePoints(memoryStorage()), actions = createNamedSavePointActions(repo);
    const original = { ...createEmptyPartDocument(), name: '試作A' };
    useAppStore.getState().applyDocument(original, { replacesDocument: true });
    const before = useAppStore.getState();
    const point = await actions.create('試作A');
    const saved = await repo.read(point.id), parsed = readPcadFile(saved.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('実保存点ZIPが読めない');
    expect(parsed.document).toEqual(original);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    const hash = createHash('sha256').update(saved.bytes).digest('hex');
    await actions.clone(point.id, '試作Aの複製');
    expect(createHash('sha256').update((await repo.read(point.id)).bytes).digest('hex')).toBe(hash);
    const changed = { ...original, name: '発注前' };
    useAppStore.getState().applyDocument(changed);
    await actions.restore(point.id);
    expect(useAppStore.getState().document.name).toBe('試作A');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(changed);
  });

  it('保存準備中の文書切替は作成を取り消し、新文書/Undo/原本一覧を変えない', async () => {
    const repo = createNamedSavePoints(memoryStorage()), actions = createNamedSavePointActions(repo);
    let finish: (bytes: Uint8Array) => void = () => { throw new Error('encoder not started'); };
    useAppStore.setState({ saveDocumentEncoder: () => new Promise<Uint8Array>(resolve => { finish = resolve; }) });
    const bytes = writePcadFile(useAppStore.getState().document);
    const pending = actions.create('取り消す点');
    useAppStore.getState().resetDocument({ ...createEmptyPartDocument(), name: '切替先' });
    const current = useAppStore.getState();
    finish(bytes);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await repo.list()).toEqual([]);
    expect(useAppStore.getState().document).toBe(current.document);
    expect(useAppStore.getState().undoStack).toBe(current.undoStack);
  });
});

// Capture props from the real host render, rather than rebuilding its close logic in a test.
it.each([false, true])('旧host onCloseは再入場したownerを閉じない（新文書=%s）', newDocument => {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  const command = toolbarCommandId('fileMenu', 'savePoints');
  expect(executeCommand(command).status).toBe('executed');
  renderToStaticMarkup(createElement(SavePointsDialogHost));
  const oldClose = admittedDialogs.callbacks[0];
  if (oldClose === undefined) throw new Error('実hostがdialogを渡していない');
  const oldOwner = useAppStore.getState().savePointsOwner;
  useAppStore.getState().setUtilityPanelOpen('savePoints', false);
  if (newDocument) useAppStore.getState().resetDocument({ ...createEmptyPartDocument(), name: '新ownerの文書' });
  expect(executeCommand(command).status).toBe('executed');
  const newOwner = useAppStore.getState().savePointsOwner;
  expect(newOwner).not.toBe(oldOwner);
  renderToStaticMarkup(createElement(SavePointsDialogHost));
  const newClose = admittedDialogs.callbacks[1];
  if (newClose === undefined) throw new Error('再入場hostがdialogを渡していない');
  oldClose();
  expect(useAppStore.getState().utilityPanel).toBe('savePoints');
  expect(useAppStore.getState().savePointsOwner).toBe(newOwner);
  newClose();
  expect(useAppStore.getState().utilityPanel).toBeNull();
});

it('actual template caller cannot change settings or target if preparation fails after template lineage', async () => {
  const original = globalThis.crypto;
  const document = createEmptyPartDocument();
  const bytes = writePcadFile(document, { kind: PCAD_TEMPLATE_KIND, lengthUnit: 'inch' });
  const clearSaveTarget = vi.fn();
  const openFile = vi.fn<NonNullable<FileGateway['openFile']>>(() => Promise.resolve({ kind: 'pcadt', fileName: 'actual.pcadt', bytes }));
  useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway,
    openFile, clearSaveTarget, hasSaveTarget: () => true } });
  const before = useAppStore.getState();
  let requests = 0;
  const entropy = vi.fn(() => {
    requests += 1;
    if (requests > 1) throw new Error('Session entropy unavailable after template lineage');
    return original.randomUUID();
  });
  vi.stubGlobal('crypto', { randomUUID: entropy });
  try {
    await runNewFromTemplate({ from: 'file' });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(entropy).toHaveBeenCalledTimes(2);
    expect(clearSaveTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().displaySettings).toBe(before.displaySettings);
    expect(useAppStore.getState()).toEqual({ ...before,
      fileMessage: { key: 'command.unavailable.action', failed: true } });
    expect(useAppStore.getState().fileGateway.hasSaveTarget()).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
