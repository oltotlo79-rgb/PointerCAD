import { createThumbnailCaptureReasonJournal, observeThumbnailCaptureReasons } from './thumbnail.js';
/**
 * 新規・開く・保存の検査(計画書 docs/plans/P2-ソリッド基礎.md タスク23 手順7、
 * 「検証」の表)。
 *
 * ブラウザの API は使わない。ファイルを選ぶ・読む・書くはすべて**偽の口**に差し替え、
 * 記憶上のバイト列で往復させる。確かめるのは次の 3 つ。
 *  - 保存して開き直すと元の部品に戻る(FR-801)。
 *  - 読めなかったとき・取り消されたときに**今の文書を壊さない**(NFR-RE-1)。
 *  - 失うものがある操作の前に確認する(NFR-UX-3)。
 */

import { encodeSaveDocument,
  DEFAULT_AUTO_SAVE_IDENTITY,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  createAutoSaver,
  createMemoryAutoSaveStorage,
  emptyPcadAttachments,
  readPcadFile,
  writePcadFile,
  type AutoSaver,
  type ImportedMeshBytes,
  type PcadAttachments,
} from '@pointercad/io';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { newSketchCanvas } from './canvasFile.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FileGateway, PickedFile } from './fileGateway.js';
import {
  displayFileName,
  createDefaultPartFileDeps,
  documentLabel,
  hasUnsavedChanges,
  newPart,
  openPart,
  savePart,
  windowTitle,
  type PartFileDeps,
} from './partFile.js';
import { loadRecentFiles, type RecentFilesStorage } from './recentFiles.js';
import { readTutorialCheckpoint, saveTutorialCheckpoint, TUTORIAL_CHECKPOINT_KEY } from '../tutorial/tutorialCheckpoint.js';
import { createParameterTutorialSession } from '../tutorial/tutorialProgress.js';

interface SaveCall {
  readonly suggestedName: string;
  readonly bytes: Uint8Array;
  readonly saveAs: boolean;
}

describe('部品を開くときの下絵所有と実保存往復', () => {
  it.each(['canvas-1', 'canvas-image-550e8400-e29b-41d4-a716-446655440000'])('%sが衝突してもA→Bを開いた後のUndo・Redo・保存再開とdirty基準を保ち、前の文書へ戻らない', async imageId => {
    const a = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, imageId);
    const b = { ...a, name: 'B.png', visible: false };
    const documentA = { ...createEmptyPartDocument(), name: 'A', canvases: [a] };
    const documentB = { ...createEmptyPartDocument(), name: 'B', canvases: [b] };
    const bytesA = Uint8Array.of(1, 2), bytesB = Uint8Array.of(3, 4);
    const fileA = writePcadFile(documentA, { attachments: { ...emptyPcadAttachments(), canvases: new Map([[imageId, bytesA]]) } });
    const fileB = writePcadFile(documentB, { attachments: { ...emptyPcadAttachments(), canvases: new Map([[imageId, bytesB]]) } });
    const originalA = fileA.slice(), originalB = fileB.slice(), received: PcadAttachments[] = [];
    const defaults = createDefaultPartFileDeps();
    const deps: PartFileDeps = { ...defaults, captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true),
      recentFilesStorage: null, onAttachmentsLoaded: attachments => {
        received.push(attachments); defaults.onAttachmentsLoaded?.(attachments);
      } };
    async function load(name: string, bytes: Uint8Array): Promise<FakeGateway> {
      const fake = createFakeGateway({ openName: name, openBytes: bytes });
      useAppStore.setState({ fileGateway: fake.gateway }); await openPart(deps); return fake;
    }
    function expectSaved(bytes: Uint8Array, name: string, image: Uint8Array): void {
      const result = readPcadFile(bytes); expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Saved canvas part could not be read');
      expect(result.document.name).toBe(name); expect(result.document.canvases).toHaveLength(1);
      expect(result.attachments.canvases.size).toBe(1);
      expect(result.attachments.canvases.get(result.document.canvases[0].imageId)).toEqual(image);
    }
    await load('A.pcad', fileA);
    const loadedA = useAppStore.getState(), captured = loadedA.canvases, capturedBytes = captured.get(imageId);
    expect(loadedA.document.canvases).toEqual([a]); expect(capturedBytes).toEqual(bytesA);
    const fakeB = await load('B.pcad', fileB), loadedB = useAppStore.getState();
    const newId = loadedB.document.canvases[0].imageId;
    // 開く時点ではAの画像が表にあるので、Bの同じ番号は新しい番号へ振り直す。
    expect(newId).not.toBe(imageId); expect(loadedB.document.canvases).toEqual([{ ...b, imageId: newId }]);
    // 開いた文書は新しい履歴から始まる(Undo でAへ戻らない)ので、Aの画像は表に残さない。
    expect(loadedB.canUndo).toBe(false);
    expect(loadedB.canvases.size).toBe(1); expect(loadedB.canvases.has(imageId)).toBe(false);
    expect(loadedB.canvases.get(newId)).toEqual(bytesB);
    expect(received[1].canvases.get(newId)).toBe(loadedB.canvases.get(newId));
    expect(loadedB.savedDocument).toBe(loadedB.document);
    expect(hasUnsavedChanges(loadedB.document, loadedB.savedDocument)).toBe(false);
    await savePart(deps, false); expectSaved(fakeB.saveCalls[0].bytes, 'B', bytesB);
    loadedB.undo();
    const undone = useAppStore.getState();
    // Undo しても開いたBのまま。上書き保存はBのファイルへBの中身を書く(Aの中身でBを壊さない)。
    expect(undone.document).toBe(loadedB.document); expect(undone.canvases.get(newId)).toBe(loadedB.canvases.get(newId));
    expect(hasUnsavedChanges(undone.document, undone.savedDocument)).toBe(false);
    await savePart(deps, false); expectSaved(fakeB.saveCalls[1].bytes, 'B', bytesB);
    undone.redo(); expect(useAppStore.getState().document).toBe(loadedB.document);
    await savePart(deps, true); expectSaved(fakeB.saveCalls[2].bytes, 'B', bytesB);
    const savedB = fakeB.saveCalls[2].bytes, savedBefore = savedB.slice();
    const reopenedGateway = await load('saved-B.pcad', savedB), reopened = useAppStore.getState();
    const reopenedId = reopened.document.canvases[0].imageId;
    expect(reopened.document.canvases).toEqual([{ ...b, imageId: reopenedId }]); expect(reopenedId).not.toBe(newId);
    expect(reopened.canvases.get(reopenedId)).toEqual(bytesB); expect(reopened.canvases.size).toBe(1);
    expect(hasUnsavedChanges(reopened.document, reopened.savedDocument)).toBe(false);
    reopened.undo(); reopened.undo();
    expect(useAppStore.getState().document).toBe(reopened.document);
    expect(useAppStore.getState().canvases.get(reopenedId)).toEqual(bytesB);
    reopened.redo(); reopened.redo();
    expect(useAppStore.getState().document.canvases[0].imageId).toBe(reopenedId);
    await savePart(deps, false); expectSaved(reopenedGateway.saveCalls[0].bytes, 'B', bytesB);
    expect(fileA).toEqual(originalA); expect(fileB).toEqual(originalB); expect(savedB).toEqual(savedBefore);
    expect(captured.size).toBe(1); expect(captured.get(imageId)).toBe(capturedBytes);
    expect(capturedBytes).toEqual(bytesA);
  });
});

describe('5段案内は通常の部品保存と開き直しだけを証拠にする', () => {
  it('同じ部品の板厚3→6mm保存は実成功bytesへcheckpointを進める', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const state = useAppStore.getState();
    const session = createParameterTutorialSession(state.document, state.documentVersion);
    if (session === null) throw new Error('session missing');
    state.setTutorialSession(session);
    state.setTutorialCheckpointStorage(storage);
    const gateway = createFakeGateway();
    useAppStore.setState({ fileGateway: gateway.gateway });
    const thickness = { name: '板厚', unit: 'mm' as const, description: '',
      value: { source: '3mm', value: 3, display: '3' } };
    useAppStore.getState().applyDocument({ ...state.document, parameters: [thickness] });
    const deps = createFakeDeps(true).deps;
    await savePart(deps, false);
    const first = values.get(TUTORIAL_CHECKPOINT_KEY);
    expect(first).toBeDefined();
    expect(useAppStore.getState().tutorialSession?.checkpointIdentity).toBeDefined();
    const three = useAppStore.getState().document;
    useAppStore.getState().applyDocument({ ...three, parameters: [{ ...thickness,
      value: { source: '6mm', value: 6, display: '6' } }] });
    await savePart(deps, false);
    const saved = gateway.stored();
    if (saved === null) throw new Error('saved file missing');
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).not.toBe(first);
    expect(await readTutorialCheckpoint({ part: { document: useAppStore.getState().document,
      savedBytes: saved.bytes } }, storage)).toMatchObject({ ok: true });
  });

  it('別の新規part-1と別保存先は旧原票を上書きせず通常保存だけ成功する', async () => {
    const oldPart = { ...createEmptyPartDocument(), name: '旧部品' };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(await saveTutorialCheckpoint({ stageHint: 'pointCoordinates', owned: { sketchId: oldPart.activeSketchId } },
      { part: { document: oldPart, savedBytes: writePcadFile(oldPart) } }, storage)).toMatchObject({ ok: true });
    const raw = values.get(TUTORIAL_CHECKPOINT_KEY);
    const state = useAppStore.getState();
    expect(state.document.id).not.toBe(oldPart.id);
    expect(state.document.id).toMatch(/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(state.document).not.toBe(oldPart);
    const session = createParameterTutorialSession(state.document, state.documentVersion);
    if (session === null) throw new Error('session missing');
    state.setTutorialSession(session);
    state.setTutorialCheckpointStorage(storage);
    const gateway = createFakeGateway({ savedName: '新しい保存先.pcad' });
    useAppStore.setState({ fileGateway: gateway.gateway });
    const undo = useAppStore.getState().undoStack;
    await savePart(createFakeDeps(true).deps, true);
    expect(gateway.stored()?.name).toBe('新しい保存先.pcad');
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(raw);
    expect(useAppStore.getState().tutorialCheckpointFailure).toBe('storageConflict');
    expect(useAppStore.getState().undoStack).toBe(undo);
  });

  it('先に依頼した同文書2連続保存は最後の実bytesをガイド原票に残す', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const state = useAppStore.getState();
    const session = createParameterTutorialSession(state.document, state.documentVersion);
    if (session === null) throw new Error('session missing');
    state.setTutorialSession(session);
    state.setTutorialCheckpointStorage(storage);
    const gateway = createFakeGateway();
    useAppStore.setState({ fileGateway: gateway.gateway });
    let thumbnail = 0;
    const deps = { ...createFakeDeps(true).deps, captureThumbnail: () => Uint8Array.of(++thumbnail) };
    await Promise.all([savePart(deps, false), savePart(deps, false)]);
    expect(gateway.saveCalls).toHaveLength(2);
    expect(gateway.saveCalls[0].bytes).not.toEqual(gateway.saveCalls[1].bytes);
    expect(await readTutorialCheckpoint({ part: { document: state.document,
      savedBytes: gateway.saveCalls[1].bytes } }, storage)).toMatchObject({ ok: true });
  });

  it('実保存bytesと同版部品からcheckpointを作り、開き直した所有者だけ復元する', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
    const fake = createFakeGateway();
    const state = useAppStore.getState();
    const session = createParameterTutorialSession(state.document, state.documentVersion);
    if (session === null) throw new Error('session missing');
    state.setTutorialSession(session);
    state.setTutorialCheckpointStorage(storage);
    useAppStore.setState({ fileGateway: fake.gateway });
    const deps = createFakeDeps(true).deps;
    await savePart(deps, false);
    const saved = fake.stored();
    if (saved === null) throw new Error('save missing');
    expect((await readTutorialCheckpoint({ part: { document: state.document, savedBytes: saved.bytes } }, storage)).ok).toBe(true);
    const record = values.get(TUTORIAL_CHECKPOINT_KEY);
    expect(record).toBeDefined();
    await openPart(deps);
    const reopened = useAppStore.getState();
    expect(reopened.tutorialSession?.course).toBe('parameterToExport');
    expect(reopened.tutorialSession?.paused).toBe(true);
    expect(reopened.tutorialSession?.documentId).toBe(reopened.document.id);
    expect(reopened.tutorialSession?.checkpointIdentity).toBeDefined();
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(record);
    await savePart(deps, false);
    const continued = fake.stored();
    if (continued === null) throw new Error('continued save missing');
    expect(await readTutorialCheckpoint({ part: { document: useAppStore.getState().document,
      savedBytes: continued.bytes } }, storage)).toMatchObject({ ok: true });
  });

  it('保存先の取消ではcheckpointと部品文書を変えない', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    const values = new Map([[TUTORIAL_CHECKPOINT_KEY, 'previous checkpoint']]);
    const state = useAppStore.getState();
    const session = createParameterTutorialSession(state.document, state.documentVersion);
    if (session === null) throw new Error('session missing');
    state.setTutorialSession(session);
    state.setTutorialCheckpointStorage({ getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); } });
    useAppStore.setState({ fileGateway: fake.gateway });
    const before = useAppStore.getState();
    await savePart(createFakeDeps(true).deps, false);
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe('previous checkpoint');
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('開く時の添付参照衝突が保存文書を書き換えたら古いcheckpointを復帰しない', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'canvas-1');
    useAppStore.getState().addCanvas(canvas, Uint8Array.of(1, 2, 3));
    const state = useAppStore.getState();
    const session = createParameterTutorialSession(state.document, state.documentVersion);
    if (session === null) throw new Error('session missing');
    state.setTutorialSession(session);
    state.setTutorialCheckpointStorage(storage);
    const fake = createFakeGateway();
    useAppStore.setState({ fileGateway: fake.gateway });
    const deps = { ...createFakeDeps(true).deps, attachmentsOf: currentPcadAttachments };
    await savePart(deps, false);
    const record = values.get(TUTORIAL_CHECKPOINT_KEY);
    expect(record).toBeDefined();
    await openPart(deps);
    const opened = useAppStore.getState();
    expect(opened.document.canvases[0]?.imageId).not.toBe(canvas.imageId);
    expect(opened.tutorialSession).toBeNull();
    expect(opened.tutorialDraft).toBeNull();
    expect(opened.tutorialCheckpointFailure).toBe('staleContent');
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(record);
  });
});

describe('削除した下絵の実保存と取り消し', () => {
  it('削除画像を ZIP に残さず、Undo 後の保存には元の画像を戻す', async () => {
    const fake = createFakeGateway();
    useAppStore.setState({ fileGateway: fake.gateway });
    const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'canvas-1');
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 17);
    useAppStore.getState().addCanvas(canvas, bytes);
    useAppStore.getState().removeCanvas(canvas.id);
    const deps = { ...createDefaultPartFileDeps(), captureThumbnail: () => null, recentFilesStorage: null };
    await savePart(deps, false);
    const deleted = readPcadFile(fake.saveCalls[0].bytes);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error('Deleted part could not be read');
    expect(deleted.document.canvases).toEqual([]);
    expect(deleted.attachments.canvases.size).toBe(0);
    expect(Buffer.from(fake.saveCalls[0].bytes).includes(Buffer.from('canvases/canvas-1.png'))).toBe(false);
    expect(useAppStore.getState().canvases.get(canvas.imageId)).toEqual(bytes);
    useAppStore.getState().undo();
    await savePart(deps, false);
    const restored = readPcadFile(fake.saveCalls[1].bytes);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('Restored part could not be read');
    expect(restored.document.canvases).toEqual([canvas]);
    expect(restored.attachments.canvases.get(canvas.imageId)).toEqual(bytes);
  });
});

interface FakeOptions {
  /** 保存できたときに返す名前。既定は渡された候補名。 */
  readonly savedName?: string;
  /** 保存を取り消す。 */
  readonly saveCancels?: boolean;
  /** 保存が失敗する。 */
  readonly saveThrows?: boolean;
  /** 開くのを取り消す。 */
  readonly openCancels?: boolean;
  /** 開くのが失敗する。 */
  readonly openThrows?: boolean;
  /** 記憶上のファイルの代わりに、このバイト列を返す(壊れたファイルの検査に使う)。 */
  readonly openBytes?: Uint8Array;
  /** `openBytes` を返すときの名前。 */
  readonly openName?: string;
}

interface FakeGateway {
  readonly gateway: FileGateway;
  readonly saveCalls: readonly SaveCall[];
  /** 記憶上のファイル。`savePcad` が書き、`openPcad` が読む。 */
  readonly stored: () => PickedFile | null;
}

/** 記憶上のバイト列だけを扱う偽の口。ブラウザには触らない。 */
function createFakeGateway(options: FakeOptions = {}): FakeGateway {
  const saveCalls: SaveCall[] = [];
  let stored: PickedFile | null = null;
  let hasTarget = false;
  let hasPendingTarget = false;
  const openTargetToken = 'fake-open-target';

  const gateway: FileGateway = {
    openPcad(): Promise<PickedFile | null> {
      if (options.openThrows === true) {
        return Promise.reject(new Error('開けませんでした'));
      }
      if (options.openCancels === true) {
        return Promise.resolve(null);
      }
      if (options.openBytes !== undefined) {
        hasPendingTarget = true;
        return Promise.resolve({
          name: options.openName ?? 'こわれた部品.pcad',
          bytes: options.openBytes,
          saveTargetToken: openTargetToken,
        });
      }
      if (stored === null) {
        return Promise.resolve(null);
      }
      hasPendingTarget = true;
      return Promise.resolve({ ...stored, saveTargetToken: openTargetToken });
    },
    savePcad(suggestedName, bytes, saveAs): Promise<string | null> {
      saveCalls.push({ suggestedName, bytes, saveAs });
      if (options.saveThrows === true) {
        return Promise.reject(new Error('保存できませんでした'));
      }
      if (options.saveCancels === true) {
        return Promise.resolve(null);
      }
      const name = options.savedName ?? suggestedName;
      stored = { name, bytes, saveTargetToken: null };
      hasTarget = true;
      hasPendingTarget = false;
      return Promise.resolve(name);
    },
    hasSaveTarget(): boolean {
      return hasTarget;
    },
    confirmSaveTarget(token): Promise<void> {
      if (hasPendingTarget && token === openTargetToken) {
        hasTarget = true;
        hasPendingTarget = false;
      }
      return Promise.resolve();
    },
    clearSaveTarget(): void {
      hasTarget = false;
      hasPendingTarget = false;
    },
  };

  return { gateway, saveCalls, stored: () => stored };
}

/** 何を答えたかを覚える確認の口。 */
interface FakeDeps {
  readonly deps: PartFileDeps;
  readonly confirmed: readonly string[];
}

/**
 * 偽の口。**履歴の置き場は既定で `null`**(どこにも残さない)にしてあるので、
 * 履歴を見ない検査は端末の `localStorage` を一切触らない(検査どうしが漏れ合わない)。
 */
function createFakeDeps(
  answer: boolean,
  thumbnail: Uint8Array | null = null,
  recentFilesStorage: RecentFilesStorage | null = null,
): FakeDeps {
  const confirmed: string[] = [];
  return {
    confirmed,
    deps: {
      captureThumbnail: () => thumbnail,
      confirmDiscard: (messageKey) => {
        confirmed.push(messageKey);
        return Promise.resolve(answer);
      },
      recentFilesStorage,
    },
  };
}

/** 記憶上だけの履歴の置き場(ブラウザには触れない)。 */
function createMemoryStorage(): RecentFilesStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/**
 * 名前ごとに中身を覚える偽の口(別名保存の検査に使う)。本物と同じく
 * **上書き先を覚え、`saveAs` が true のときだけ名前を訊き直す。**
 * 訊かれたときに答える名前は `setNextName` で決め、`null` を渡すと取り消しになる。
 */
interface NamedFakeGateway {
  readonly gateway: FileGateway;
  /** 記憶上のファイル(名前 → 中身)。 */
  readonly files: () => ReadonlyMap<string, Uint8Array>;
  readonly setNextName: (name: string | null) => void;
  /** 名前を訊かれた回数。 */
  readonly asked: () => number;
}

function createNamedGateway(): NamedFakeGateway {
  const files = new Map<string, Uint8Array>();
  let target: string | null = null;
  let answer: string | null = null;
  let asked = 0;

  const gateway: FileGateway = {
    openPcad(): Promise<PickedFile | null> {
      // この口は保存の検査にだけ使う(開くのは `createFakeGateway` が受け持つ)。
      return Promise.resolve(null);
    },
    savePcad(_suggestedName, bytes, saveAs): Promise<string | null> {
      // 別名保存(saveAs)と、まだ保存先を知らないときは名前を訊く。
      let name = saveAs ? null : target;
      if (name === null) {
        asked += 1;
        if (answer === null) {
          return Promise.resolve(null);
        }
        name = answer;
      }
      files.set(name, bytes);
      // 書けた先が次からの上書き先になる(本物の口もそう振る舞う、§0.a-0.37)。
      target = name;
      return Promise.resolve(name);
    },
    hasSaveTarget(): boolean {
      return target !== null;
    },
    confirmSaveTarget(): Promise<void> {
      return Promise.resolve();
    },
    clearSaveTarget(): void {
      target = null;
    },
  };

  return {
    gateway,
    files: () => files,
    setNextName: (name) => {
      answer = name;
    },
    asked: () => asked,
  };
}

interface OpenSequenceItem {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface SequencedTargetGateway {
  readonly gateway: FileGateway;
  readonly saveCalls: readonly SaveCall[];
  readonly files: () => ReadonlyMap<string, Uint8Array>;
  readonly asked: () => number;
}

/** 開いた先の候補と確定済みの保存先を分けて持つ、保存先の回帰検査専用の偽の口。 */
function createSequencedTargetGateway(
  sequence: readonly (OpenSequenceItem | null)[],
): SequencedTargetGateway {
  const remaining = [...sequence];
  const files = new Map<string, Uint8Array>();
  const saveCalls: SaveCall[] = [];
  let target: string | null = null;
  let pending: { readonly token: string; readonly name: string } | null = null;
  let nextToken = 1;
  let asked = 0;

  for (const item of sequence) {
    if (item !== null) {
      files.set(item.name, new Uint8Array(item.bytes));
    }
  }

  const gateway: FileGateway = {
    openPcad(): Promise<PickedFile | null> {
      // 本物と同じく、次の「開く」で前の未確定候補を捨てる。
      pending = null;
      const item = remaining.shift();
      if (item === undefined || item === null) {
        return Promise.resolve(null);
      }
      const token = `token-${String(nextToken)}`;
      nextToken += 1;
      pending = { token, name: item.name };
      return Promise.resolve({
        name: item.name,
        bytes: new Uint8Array(item.bytes),
        saveTargetToken: token,
      });
    },
    savePcad(suggestedName, bytes, saveAs): Promise<string> {
      let name = saveAs ? null : target;
      if (name === null) {
        asked += 1;
        name = asked === 1 ? '新しい部品.pcad' : `新しい部品${String(asked)}.pcad`;
      }
      saveCalls.push({ suggestedName, bytes, saveAs });
      files.set(name, new Uint8Array(bytes));
      target = name;
      pending = null;
      return Promise.resolve(name);
    },
    hasSaveTarget(): boolean {
      return target !== null;
    },
    confirmSaveTarget(token): Promise<void> {
      if (pending?.token === token) {
        target = pending.name;
        pending = null;
      }
      return Promise.resolve();
    },
    clearSaveTarget(): void {
      target = null;
      pending = null;
    },
  };

  return { gateway, saveCalls, files: () => files, asked: () => asked };
}

/** 控えを消した回数だけを数える偽の自動保存(タスク24)。 */
function createFakeAutoSaver(): { readonly saver: AutoSaver; readonly discards: () => number } {
  let discards = 0;
  return {
    saver: {
      markDirty: () => undefined,
      saveNow: () => Promise.resolve(),
      stop: () => undefined,
      readLatest: () => Promise.resolve(null),
      discard: () => {
        discards += 1;
        return Promise.resolve();
      },
    },
    discards: () => discards,
  };
}

/** 点を 1 つかいた部品。空の部品と中身が違うので「保存していない変更」になる。 */
function partWithPoint(): PartDocument {
  const sketch = createEmptySketchDocument();
  const drawn = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(1, 2, 3)));
  return replaceSketch(createEmptyPartDocument(), drawn);
}

function useGateway(gateway: FileGateway): void {
  useAppStore.setState({ fileGateway: gateway });
}

function useFake(fake: FakeGateway): void {
  useGateway(fake.gateway);
}

/** 保存されたバイト列に入っていたサムネイル。入っていなければ undefined。 */
function thumbnailOf(picked: PickedFile | null): Uint8Array | undefined {
  if (picked === null) {
    throw new Error('まだ保存されていません');
  }
  const result = readPcadFile(picked.bytes);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.thumbnailPng;
}

/**
 * ZIP の中の入れ物の名前だけを書き換える。
 *
 * `packages/ui` は ZIP を作る道具(fflate)を依存に持たない(持たせるのは `packages/io`
 * の役目)ので、壊れ方の違うファイルは**正しい .pcad の名前を差し替えて**作る。
 * ZIP は名前そのものを検算しないので、同じ長さで書き換えれば中身は壊れない。
 */
function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) {
    throw new Error('置き換えは同じ長さでなければ ZIP の位置の記録が合わなくなります');
  }
  const target = [...from].map((character) => character.charCodeAt(0));
  const replacement = [...to].map((character) => character.charCodeAt(0));
  const copy = new Uint8Array(bytes);
  for (let start = 0; start + target.length <= copy.length; start += 1) {
    let hit = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (copy[start + offset] !== target[offset]) {
        hit = false;
        break;
      }
    }
    if (!hit) {
      continue;
    }
    for (let offset = 0; offset < replacement.length; offset += 1) {
      copy[start + offset] = replacement[offset];
    }
  }
  return copy;
}

/** 封筒の版だけを変えた .pcad。 */
function pcadWithSchema(schema: number): Uint8Array {
  return writePcadFile({ ...createEmptyPartDocument(), schemaVersion: schema });
}

/**
 * 移行が用意されていない、最も新しい「古すぎる版」(`SCHEMA_MIGRATIONS` の最小の鍵 − 1)。
 * `PCAD_SCHEMA_VERSION - 1` だと、版が上がるたびに新しい移行が足される版と重なってしまう
 * (P3 で版 2 → 3 の移行が増え、版 2 は「開ける版」になった)ので、移行表そのものから
 * 「開けない最も新しい版」を導く。
 */
const OLDEST_UNMIGRATABLE_SCHEMA_VERSION =
  Math.min(...Object.keys(SCHEMA_MIGRATIONS).map(Number)) - 1;

/** `document.json` が入っていない ZIP。 */
function zipWithoutDocument(): Uint8Array {
  return replaceAscii(writePcadFile(createEmptyPartDocument()), 'document.json', 'contents.json');
}

/**
 * 中身を好きな文字列に差し替えた .pcad。サムネイルは無圧縮で入るので、
 * サムネイルの場所へ文字列を入れ、名前を `document.json` へ付け替える。
 */
function pcadWithDocumentText(text: string): Uint8Array {
  const bytes = writePcadFile(createEmptyPartDocument(), {
    thumbnailPng: new TextEncoder().encode(text),
  });
  return replaceAscii(
    replaceAscii(bytes, 'document.json', 'contents.json'),
    'thumbnail.png',
    'document.json',
  );
}

/**
 * ZIP の CRC-32(検査専用の最小実装。`fflate` は `@pointercad/ui` の依存に無く
 * 〔依存の追加は禁止〕、`packages/ui/src/file/attachAutoSave.test.ts` の `crc32` と
 * 同じ手書きの実装をここでも使う)。
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 単一エントリの無圧縮(method 0) ZIP を手で組み立てる(検査専用。
 * `attachAutoSave.test.ts` の `storedZip` と同じ手法)。`declaredExpanded` を省略すると
 * 実際の長さと同じ(正常な ZIP)。中身の CRC は実際の `content` から正しく計算するので、
 * `declaredExpanded` だけを実際と違う値にすると「虚偽サイズ」「圧縮爆弾」を作れる。
 */
function storedZip(name: string, content: Uint8Array, declaredExpanded = content.length): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const localSize = 30 + nameBytes.length + content.length;
  const centralSize = 46 + nameBytes.length;
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  const checksum = crc32(content);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, content.length, true);
  view.setUint32(22, declaredExpanded, true);
  view.setUint16(26, nameBytes.length, true);
  bytes.set(nameBytes, 30);
  bytes.set(content, 30 + nameBytes.length);

  const central = localSize;
  view.setUint32(central, 0x02014b50, true);
  view.setUint16(central + 4, 20, true);
  view.setUint16(central + 6, 20, true);
  view.setUint16(central + 8, 0x0800, true);
  view.setUint16(central + 10, 0, true);
  view.setUint32(central + 16, checksum, true);
  view.setUint32(central + 20, content.length, true);
  view.setUint32(central + 24, declaredExpanded, true);
  view.setUint16(central + 28, nameBytes.length, true);
  bytes.set(nameBytes, central + 46);

  const end = central + centralSize;
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, centralSize, true);
  view.setUint32(end + 16, central, true);
  return bytes;
}

/**
 * 圧縮爆弾: 宣言した展開後サイズ(1バイト)より、実際に入っている中身がずっと大きい
 * document.json(P12-26。要件 NFR-RE-1・NFR-SE-1)。宣言だけを信じて小さな入れ物へ
 * 実物を流し込むと壊れる、という向きの偽装。もっと大きな規模(512MiB 境界)の確認は
 * `packages/io/src/pcad/readArchiveAllocation.test.ts` 側で済んでいるので、ここでは
 * 確保前に安全に断られることと、今の文書が変わらないことだけを確かめる。
 */
function zipBombPcad(): Uint8Array {
  return storedZip('document.json', new Uint8Array(4096).fill(48), 1);
}

/** 虚偽サイズ: 展開後の上限(512MiB、`packages/io/src/limits.ts`)を上回る値を宣言した document.json。 */
function forgedSizePcad(): Uint8Array {
  return storedZip('document.json', new TextEncoder().encode('{}'), 600 * 1024 * 1024);
}

/** CRC不一致: 宣言サイズは正しいまま、中身だけが壊れている document.json。 */
function crcMismatchPcad(): Uint8Array {
  const name = 'document.json';
  const bytes = storedZip(name, new TextEncoder().encode('{"length":20}'));
  const dataStart = 30 + new TextEncoder().encode(name).length;
  bytes[dataStart] = (bytes[dataStart] + 1) & 0xff; // 中身だけ変え、CRC欄は変えない
  return bytes;
}

beforeEach(() => {
  useAppStore.setState({ ...createInitialDocumentState(), saveDocumentEncoder: encodeSaveDocument, documentSaveOperation: null });
});

describe('表示用の名前', () => {
  it('まだ保存していなければ「名称未設定」(計画書の検証表)', () => {
    expect(displayFileName(null)).toBe('名称未設定');
  });

  it('保存してあればその名前をそのまま出す', () => {
    expect(displayFileName('部品1.pcad')).toBe('部品1.pcad');
  });

  it('空白だけの名前は「名称未設定」に落とす', () => {
    expect(displayFileName('   ')).toBe('名称未設定');
  });

  it('保存していない変更があると名前の右に印が付く', () => {
    expect(documentLabel(null, true)).toBe('名称未設定*');
    expect(documentLabel('部品1.pcad', true)).toBe('部品1.pcad*');
    expect(documentLabel('部品1.pcad', false)).toBe('部品1.pcad');
  });

  it('窓の見出しは、名前も変更も無いうちは製品名だけ', () => {
    expect(windowTitle(null, false)).toBe('PointerCAD');
    expect(windowTitle(null, true)).toBe('名称未設定* - PointerCAD');
    expect(windowTitle('部品1.pcad', false)).toBe('部品1.pcad - PointerCAD');
  });
});

describe('保存していない変更があるか', () => {
  it('起動直後の空の部品は「変更なし」(まだ何もしていない)', () => {
    expect(hasUnsavedChanges(createEmptyPartDocument(), null)).toBe(false);
  });

  it('何かかいた後は「変更あり」', () => {
    expect(hasUnsavedChanges(partWithPoint(), null)).toBe(true);
  });

  it('中身が同じなら別の入れ物でも「変更なし」(参照では比べない)', () => {
    expect(hasUnsavedChanges(partWithPoint(), partWithPoint())).toBe(false);
  });

  it('保存した後に文書を変えれば「変更あり」', () => {
    const saved = createEmptyPartDocument();
    expect(hasUnsavedChanges(partWithPoint(), saved)).toBe(true);
  });
});

describe('保存する(FR-806、FR-801)', () => {
  it('保存して開き直すと元の部品に戻り、ファイル名が入る', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    const document = partWithPoint();
    useAppStore.getState().applyDocument(document);

    await savePart(createFakeDeps(true).deps, false);
    expect(useAppStore.getState().fileName).toBe('部品1.pcad');

    // 別の部品を開いている状態から読み直しても、元の中身に戻る。
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    useAppStore.getState().setFileState(null, null);
    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toEqual(document);
    expect(state.fileName).toBe('部品1.pcad');
  });

  it('保存した直後は「保存していない変更」が無くなる', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    const state = useAppStore.getState();
    expect(hasUnsavedChanges(state.document, state.savedDocument)).toBe(false);
    expect(state.fileMessage).toEqual({ key: 'file.saved', failed: false });
  });

  it('保存した後に文書を変えると、また「保存していない変更」になる', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(createFakeDeps(true).deps, false);

    useAppStore.getState().applyDocument(createEmptyPartDocument());

    const state = useAppStore.getState();
    expect(hasUnsavedChanges(state.document, state.savedDocument)).toBe(true);
    // 形が変わったら「保存しました」の知らせは消える。
    expect(state.fileMessage).toBeNull();
  });

  it('候補名はファイル名から作り、.pcad を必ず付ける', async () => {
    const fake = createFakeGateway();
    useFake(fake);

    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls[0].suggestedName).toBe('名称未設定.pcad');
  });

  it('はじめの保存は場所を聞き、2 回目からは覚えた先へ黙って上書きする', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);
    expect(fake.saveCalls[0].saveAs).toBe(true);

    useAppStore.getState().applyDocument(createEmptyPartDocument());
    await savePart(createFakeDeps(true).deps, false);
    expect(fake.saveCalls[1].saveAs).toBe(false);
  });

  it('「名前を付けて保存」は覚えた先があっても必ず場所を聞く', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    await savePart(createFakeDeps(true).deps, false);

    await savePart(createFakeDeps(true).deps, true);

    expect(fake.saveCalls[1].saveAs).toBe(true);
  });

  it('サムネイルが作れなくても保存できる(サムネイルなしのファイルになる)', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true, null).deps, false);

    expect(thumbnailOf(fake.stored())).toBeUndefined();
  });

  it('サムネイルがあればファイルへ入る', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const thumbnail = new Uint8Array([137, 80, 78, 71]);

    await savePart(createFakeDeps(true, thumbnail).deps, false);

    expect(thumbnailOf(fake.stored())).toEqual(thumbnail);
  });

  it('保存を取り消すと、ファイル名も知らせも変わらない', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    const state = useAppStore.getState();
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    expect(state.fileMessage).toBeNull();
  });

  it('保存に成功したら現在の控えと旧控えを消す(計画書 タスク24)', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const autoSave = createFakeAutoSaver();
    useAppStore.setState({ autoSaver: autoSave.saver });
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    expect(autoSave.discards()).toBe(2);
  });

  it('保存に成功したら3欄つきの自分の控えと3欄なしの旧控えが両方消える', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const storage = createMemoryAutoSaveStorage();
    const legacy = {
      savedAt: '2026-09-03T09:30:00.000Z',
      bytes: writePcadFile(partWithPoint()),
      documentName: '旧控え',
    };
    await storage.write(legacy);
    await storage.write({
      ...legacy,
      kind: 'part',
      documentId: 'doc-1',
      sessionId: 'win-1',
      documentName: '自分の控え',
    });
    const saver = createAutoSaver({
      storage,
      kind: 'part',
      documentId: 'doc-1',
      sessionId: 'win-1',
      setTimeout: () => null,
      clearTimeout: () => undefined,
    });
    useAppStore.setState({ autoSaver: saver });
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    expect(await storage.listRecords()).toEqual([]);
    expect(await storage.read(DEFAULT_AUTO_SAVE_IDENTITY)).toBeNull();
    saver.stop();
  });

  it('保存を取り消したときは控えを消さない', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    useFake(fake);
    const autoSave = createFakeAutoSaver();
    useAppStore.setState({ autoSaver: autoSave.saver });
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    expect(autoSave.discards()).toBe(0);
  });

  it('保存が失敗したら理由を帯へ出し、保存済みの記録は作らない', async () => {
    const fake = createFakeGateway({ saveThrows: true });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    const state = useAppStore.getState();
    expect(state.fileMessage).toEqual({ key: 'file.saveFailed', failed: true });
    expect(state.savedDocument).toBeNull();
  });
});

describe('保存先を現在の文書と一緒に確定・解除する', () => {
  it('A を開いてから新規にすると、保存は場所を訊き、A のバイト列を変えない', async () => {
    const aBytes = writePcadFile(partWithPoint());
    const fake = createSequencedTargetGateway([{ name: 'A.pcad', bytes: aBytes }]);
    useGateway(fake.gateway);

    await openPart(createFakeDeps(true).deps);
    await newPart(createFakeDeps(true).deps);
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls[0]?.saveAs).toBe(true);
    expect(fake.asked()).toBe(1);
    expect(fake.files().get('A.pcad')).toEqual(aBytes);
  });

  it('A の表示中に読めない B を開いても、保存先は A のままで B を変えない', async () => {
    const aBytes = writePcadFile(partWithPoint());
    const bBytes = new Uint8Array([0, 1, 2, 3]);
    const fake = createSequencedTargetGateway([
      { name: 'A.pcad', bytes: aBytes },
      { name: 'B.pcad', bytes: bBytes },
    ]);
    useGateway(fake.gateway);

    await openPart(createFakeDeps(true).deps);
    await openPart(createFakeDeps(true).deps);
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls[0]?.saveAs).toBe(false);
    expect(fake.asked()).toBe(0);
    expect(fake.files().get('B.pcad')).toEqual(bBytes);
  });

  it('A の表示中に開く窓を取り消しても、保存先は A のまま', async () => {
    const fake = createSequencedTargetGateway([
      { name: 'A.pcad', bytes: writePcadFile(partWithPoint()) },
      null,
    ]);
    useGateway(fake.gateway);

    await openPart(createFakeDeps(true).deps);
    await openPart(createFakeDeps(true).deps);
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls[0]?.saveAs).toBe(false);
    expect(fake.asked()).toBe(0);
  });

  it('A を開いて保存した後の2回目の保存も、名前を訊かず A へ上書きする', async () => {
    const fake = createSequencedTargetGateway([
      { name: 'A.pcad', bytes: writePcadFile(partWithPoint()) },
    ]);
    useGateway(fake.gateway);

    await openPart(createFakeDeps(true).deps);
    await savePart(createFakeDeps(true).deps, false);
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls.map((call) => call.saveAs)).toEqual([false, false]);
    expect(fake.asked()).toBe(0);
  });

  it('新規の保存は、前の保存先が無いので名前を訊く', async () => {
    const fake = createSequencedTargetGateway([]);
    useGateway(fake.gateway);

    await newPart(createFakeDeps(true).deps);
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls[0]?.saveAs).toBe(true);
    expect(fake.asked()).toBe(1);
  });
});

describe('開く(FR-806、NFR-RE-1)', () => {
  it('取り消したときは文書も知らせも変わらない', async () => {
    const fake = createFakeGateway({ openCancels: true });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toBe(before);
    expect(state.fileMessage).toBeNull();
  });

  it('壊れたバイト列では理由を帯へ出し、今の文書は変えない', async () => {
    const fake = createFakeGateway({ openBytes: new Uint8Array([0, 1, 2, 3]) });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toBe(before);
    expect(state.fileName).toBeNull();
    expect(state.fileMessage).toEqual({ key: 'file.error.corrupted', failed: true });
  });

  it.each([
    ['圧縮爆弾(宣言よりずっと大きく展開されるdocument.json)', zipBombPcad] as const,
    ['虚偽サイズ(展開後の上限を超える値を宣言したdocument.json)', forgedSizePcad] as const,
    ['CRC不一致(宣言サイズは正しいが中身が壊れたdocument.json)', crcMismatchPcad] as const,
  ])('%s では理由を帯へ出し、今の文書は変えない(P12-26)', async (_label, makeBytes) => {
    const fake = createFakeGateway({ openBytes: makeBytes() });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    // 今の文書は変えない(NFR-RE-1)。
    expect(state.document).toBe(before);
    expect(state.fileName).toBeNull();
    expect(state.fileMessage).toEqual({ key: 'file.error.corrupted', failed: true });
  });

  it('中身が入っていない ZIP は「中身が見つからない」と断る', async () => {
    const fake = createFakeGateway({ openBytes: zipWithoutDocument() });
    useFake(fake);

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.missingDocument',
      failed: true,
    });
  });

  it('新しい版のファイルは「アプリを更新してください」と断る', async () => {
    const fake = createFakeGateway({ openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION + 1) });
    useFake(fake);

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.tooNew',
      failed: true,
    });
  });

  it('古い版のファイルは「古い形式」と断る', async () => {
    const fake = createFakeGateway({ openBytes: pcadWithSchema(OLDEST_UNMIGRATABLE_SCHEMA_VERSION) });
    useFake(fake);

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.error.tooOld', failed: true });
  });

  it('別のアプリのファイルは「部品ファイルではない」と断る', async () => {
    const other = `{"schema":${String(PCAD_SCHEMA_VERSION)},"kind":"part","app":"ほかのアプリ","savedAt":"2026-09-03T00:00:00.000Z","document":{}}`;
    useFake(createFakeGateway({ openBytes: pcadWithDocumentText(other) }));

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.wrongKind',
      failed: true,
    });
  });

  it('部品ではない種別(図面など)も「部品ファイルではない」と断る', async () => {
    const drawing = `{"schema":${String(PCAD_SCHEMA_VERSION)},"kind":"drawing","app":"PointerCAD","savedAt":"2026-09-03T00:00:00.000Z","document":{}}`;
    useFake(createFakeGateway({ openBytes: pcadWithDocumentText(drawing) }));

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.wrongKind',
      failed: true,
    });
  });

  it('欄の足りない部品は「壊れている」と断る', async () => {
    const broken = `{"schema":${String(PCAD_SCHEMA_VERSION)},"kind":"part","app":"PointerCAD","savedAt":"2026-09-03T00:00:00.000Z","document":{}}`;
    useFake(createFakeGateway({ openBytes: pcadWithDocumentText(broken) }));

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.corrupted',
      failed: true,
    });
  });

  it('口そのものが失敗したら「開けませんでした」を出す', async () => {
    const fake = createFakeGateway({ openThrows: true });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toBe(before);
    expect(state.fileMessage).toEqual({ key: 'file.openFailed', failed: true });
  });

  it('保存していない変更があれば確認し、断られたら開かない', async () => {
    const fake = createFakeGateway({ openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION) });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);
    const deps = createFakeDeps(false);

    await openPart(deps.deps);

    expect(deps.confirmed).toEqual(['file.discardConfirm']);
    expect(useAppStore.getState().document).toBe(before);
  });

  it('開いた後は新しい履歴から始まり、Undo で開く前の文書へ戻らない', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);
    await savePart(createFakeDeps(true).deps, false);
    useAppStore.getState().resetDocument(createEmptyPartDocument());

    await openPart(createFakeDeps(true).deps);

    // 開く前の文書へ戻れると、名前と上書き先は開いたファイルのまま中身だけが変わる(2026-10-05)。
    const opened = useAppStore.getState();
    expect(opened.canUndo).toBe(false);
    opened.undo();
    expect(useAppStore.getState().document).toBe(opened.document);
    expect(useAppStore.getState().fileName).toBe('部品1.pcad');
  });

  it('開くと documentVersion が進む(選んでいる欄の下書きを捨てる合図、9b)', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    await savePart(createFakeDeps(true).deps, false);
    const before = useAppStore.getState().documentVersion;

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });
});

describe('新規(FR-806、NFR-UX-3)', () => {
  it('保存していない変更があるときは確認し、断られたら何も変えない', async () => {
    useFake(createFakeGateway());
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);
    const deps = createFakeDeps(false);

    await newPart(deps.deps);

    expect(deps.confirmed).toEqual(['file.discardConfirm']);
    expect(useAppStore.getState().document).toBe(before);
  });

  it('了承すると空の部品になり、名前は消え、履歴も作り直される', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(createFakeDeps(true).deps, false);
    useAppStore.getState().applyDocument(createEmptyPartDocument());
    expect(useAppStore.getState().canUndo).toBe(true);

    const previousId = useAppStore.getState().document.id;
    await newPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toEqual({ ...createEmptyPartDocument(), id: state.document.id });
    expect(state.document.id).toMatch(/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(state.document.id).not.toBe(previousId);
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    expect(state.undoStack.past).toEqual([]);
    expect(state.undoStack.future).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it('何もしていないときは確認しない(まだ失うものが無い)', async () => {
    useFake(createFakeGateway());
    const deps = createFakeDeps(false);
    const previousId = useAppStore.getState().document.id;

    await newPart(deps.deps);

    expect(deps.confirmed).toEqual([]);
    const document = useAppStore.getState().document;
    expect(document).toEqual({ ...createEmptyPartDocument(), id: document.id });
    expect(document.id).toMatch(/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(document.id).not.toBe(previousId);
  });

  it('新規にすると documentVersion が進む(選んでいる欄の下書きを捨てる合図、9b)', async () => {
    useFake(createFakeGateway());
    const before = useAppStore.getState().documentVersion;

    await newPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });
});

describe('最近使ったファイル(FR-807、P6 タスク28)', () => {
  it('開けたファイルの名前が履歴に入る', async () => {
    useFake(
      createFakeGateway({
        openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION),
        openName: '読んだ.pcad',
      }),
    );
    const storage = createMemoryStorage();

    await openPart(createFakeDeps(true, null, storage).deps);

    const list = loadRecentFiles(storage);
    expect(list.map((entry) => entry.name)).toEqual(['読んだ.pcad']);
    // 時刻も一緒に残る(名前と時刻の 2 欄だけ、§0.a-0.38)。
    expect(Number.isFinite(Date.parse(list[0].at))).toBe(true);
  });

  it('開けなかったファイルは履歴に入らない(勧め直さない)', async () => {
    useFake(
      createFakeGateway({
        openBytes: pcadWithDocumentText('壊れています'),
        openName: 'こわれた.pcad',
      }),
    );
    const storage = createMemoryStorage();

    await openPart(createFakeDeps(true, null, storage).deps);

    expect(loadRecentFiles(storage)).toEqual([]);
  });

  it('取り消したときも履歴に入らない', async () => {
    useFake(createFakeGateway({ openCancels: true }));
    const storage = createMemoryStorage();

    await openPart(createFakeDeps(true, null, storage).deps);

    expect(loadRecentFiles(storage)).toEqual([]);
  });

  it('保存した名前も履歴に入り、別名保存の後は新しい名前が先頭・元の名前も残る', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    const storage = createMemoryStorage();
    useAppStore.getState().applyDocument(partWithPoint());

    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true, null, storage).deps, false);
    fake.setNextName('部品2.pcad');
    await savePart(createFakeDeps(true, null, storage).deps, true);

    expect(loadRecentFiles(storage).map((entry) => entry.name)).toEqual([
      '部品2.pcad',
      '部品1.pcad',
    ]);
  });

  it('保存が取り消されたら履歴に入らない', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    const storage = createMemoryStorage();
    fake.setNextName(null);

    await savePart(createFakeDeps(true, null, storage).deps, false);

    expect(loadRecentFiles(storage)).toEqual([]);
  });
});

describe('別名保存(FR-812、P6 §0.a-0.37)', () => {
  it('元のファイルは変わらず、以後の保存先が新しい名前になる', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    useAppStore.getState().applyDocument(partWithPoint());
    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true).deps, false);
    // 後で比べるために写しを取る(記憶上の入れ物ごと差し替えられても気づけるように)。
    const original = new Uint8Array(fake.files().get('部品1.pcad') ?? []);
    expect(original.byteLength).toBeGreaterThan(0);

    // 中身を変えてから別名保存する。
    useAppStore.getState().applyDocument(createEmptyPartDocument());
    fake.setNextName('部品2.pcad');
    await savePart(createFakeDeps(true).deps, true);

    expect(useAppStore.getState().fileName).toBe('部品2.pcad');
    expect(fake.files().get('部品2.pcad')).toBeDefined();
    // 元のファイルは 1 バイトも変わっていない(FR-812「元のファイルを変更せずに」)。
    expect(fake.files().get('部品1.pcad')).toEqual(original);
  });

  it('別名保存の後の「保存」は、名前を訊かずに新しい名前へ書く', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true).deps, false);
    fake.setNextName('部品2.pcad');
    await savePart(createFakeDeps(true).deps, true);
    const askedBefore = fake.asked();

    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.asked()).toBe(askedBefore);
    expect([...fake.files().keys()]).toEqual(['部品1.pcad', '部品2.pcad']);
    expect(useAppStore.getState().fileName).toBe('部品2.pcad');
  });

  it('別名保存を取り消すと、保存先も名前も変わらない', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true).deps, false);

    fake.setNextName(null);
    await savePart(createFakeDeps(true).deps, true);

    expect(useAppStore.getState().fileName).toBe('部品1.pcad');
    expect([...fake.files().keys()]).toEqual(['部品1.pcad']);
  });

  it('ストアの入口(saveDocumentAs)は saveAs を立てて保存する(入口の配線はタスク33)', async () => {
    const fake = createFakeGateway({ savedName: '別名.pcad' });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await useAppStore.getState().saveDocumentAs();

    expect(fake.saveCalls.map((call) => call.saveAs)).toEqual([true]);
    expect(useAppStore.getState().fileName).toBe('別名.pcad');
  });
});

/*
 * 添付(読み込んだ形・下絵)の受け渡し(P6 タスク32、タスク21 の申し送り)。
 *
 * 読み込んだ形の B-rep は再計算で作り直せない(§0.a-0.9 の例外)ので、保存のたびに
 * 一緒に書き、開いたときに受け取って持ち回らないと**開き直せない部品**ができる。
 */

/** 検査用の三角形 1 枚ぶんの網。 */
function oneTriangleMesh(): ImportedMeshBytes {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
  };
}

/** 読み込んだ形 1 つと読み込んだ三角形 1 つを履歴に持つ部品文書。 */
function importedDocument(): PartDocument {
  return {
    ...createEmptyPartDocument(),
    solids: [
      {
        id: 'importedSolid-1',
        kind: 'importedSolid',
        name: '読み込んだ形1',
        suppressed: false,
        shapeRef: 'importedSolid-1',
        source: { format: 'step', fileName: 'bracket.step', unit: 'mm', byteLength: 100 },
        bodyKind: 'solid',
      },
      {
        id: 'importedMesh-1',
        kind: 'importedMesh',
        name: '読み込んだ三角形の形1',
        suppressed: false,
        meshRef: 'importedMesh-1',
        source: { format: 'stl', fileName: 'cover.stl', unit: 'mm', byteLength: 684 },
        triangleCount: 1,
      },
    ],
  };
}

function importedAttachments(): PcadAttachments {
  return {
    shapes: new Map([['importedSolid-1', Uint8Array.from([1, 2, 3])]]),
    meshes: new Map([['importedMesh-1', oneTriangleMesh()]]),
    canvases: new Map(),
  };
}

describe('BRep/meshの文書跨ぎUndoの反例', () => {
  it.each(['same-ref', 'different-ref'] as const)('%sのA/Bを実openPartした後のUndo/Redoは前の文書へ戻らず、Bの全添付を保つ', async mode => {
    // 形状カーネルは接続しない。既存fixtureのBRepを添付として実codecへ渡すだけ。
    const documentA = { ...importedDocument(), name: 'A' };
    const shapeRefB = mode === 'same-ref' ? 'importedSolid-1' : 'shape-B';
    const meshRefB = mode === 'same-ref' ? 'importedMesh-1' : 'mesh-B';
    const documentB: PartDocument = { ...importedDocument(), name: 'B', solids: importedDocument().solids.map(feature =>
      feature.kind === 'importedSolid' ? { ...feature, shapeRef: shapeRefB }
        : feature.kind === 'importedMesh' ? { ...feature, meshRef: meshRefB } : feature) };
    const attachmentsA = importedAttachments();
    const meshB: ImportedMeshBytes = {
      positions: Float32Array.of(2, 3, 4, 5, 6, 7, 8, 9, 10),
      normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0), indices: Uint32Array.of(2, 1, 0),
    };
    const attachmentsB: PcadAttachments = { shapes: new Map([[shapeRefB, Uint8Array.of(9, 8, 7, 6, 5)]]),
      meshes: new Map([[meshRefB, meshB]]), canvases: new Map() };
    const fileA = writePcadFile(documentA, { attachments: attachmentsA });
    const fileB = writePcadFile(documentB, { attachments: attachmentsB });
    const originalFileA = fileA.slice(), originalFileB = fileB.slice();
    const deps: PartFileDeps = { ...createDefaultPartFileDeps(), captureThumbnail: () => null,
      confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };
    async function load(name: string, bytes: Uint8Array): Promise<FakeGateway> {
      const fake = createFakeGateway({ openName: name, openBytes: bytes });
      useAppStore.setState({ fileGateway: fake.gateway }); await openPart(deps); return fake;
    }
    function expectAttachments(document: PartDocument, actual: PcadAttachments,
      expectedDocument: PartDocument, expected: PcadAttachments, stage: string): void {
      expect.soft(document.name, `${stage}: document`).toBe(expectedDocument.name);
      for (const feature of expectedDocument.solids) {
        const current = document.solids.find(candidate => candidate.id === feature.id);
        expect.soft(current?.kind, `${stage}: feature kind`).toBe(feature.kind);
        if (feature.kind === 'importedSolid' && current?.kind === 'importedSolid') {
          expect.soft(actual.shapes.get(current.shapeRef), `${stage}: ${current.shapeRef} full BRep bytes`)
            .toEqual(expected.shapes.get(feature.shapeRef));
        } else if (feature.kind === 'importedMesh' && current?.kind === 'importedMesh') {
          const mesh = actual.meshes.get(current.meshRef), expectedMesh = expected.meshes.get(feature.meshRef);
          expect.soft(mesh?.positions, `${stage}: ${current.meshRef} all positions`).toEqual(expectedMesh?.positions);
          expect.soft(mesh?.normals, `${stage}: ${current.meshRef} all normals`).toEqual(expectedMesh?.normals);
          expect.soft(mesh?.indices, `${stage}: ${current.meshRef} all indices`).toEqual(expectedMesh?.indices);
        }
      }
    }
    async function expectCurrentAndSaved(fake: FakeGateway, document: PartDocument, attachments: PcadAttachments, stage: string): Promise<void> {
      const current = useAppStore.getState();
      expectAttachments(current.document, currentPcadAttachments(current.document), document, attachments, `${stage}/current`);
      expect(currentPcadAttachments(current.document).shapes.size).toBe(1);
      expect(currentPcadAttachments(current.document).meshes.size).toBe(1);
      const index = fake.saveCalls.length; await savePart(deps, false);
      const parsed = readPcadFile(fake.saveCalls[index].bytes);
      expect.soft(parsed.ok, `${stage}: saved ZIP readable`).toBe(true);
      if (parsed.ok) {
        expectAttachments(parsed.document, parsed.attachments, document, attachments, `${stage}/ZIP`);
        expect(parsed.attachments.shapes.size).toBe(1); expect(parsed.attachments.meshes.size).toBe(1);
      }
    }
    const fakeA = await load('A.pcad', fileA);
    const oldShapes = useAppStore.getState().importedShapes, oldMeshes = useAppStore.getState().importedMeshes;
    const oldShape = oldShapes.get('importedSolid-1'), oldMesh = oldMeshes.get('importedMesh-1');
    await expectCurrentAndSaved(fakeA, documentA, attachmentsA, 'open A');
    const fakeB = await load('B.pcad', fileB);
    const loadedB = useAppStore.getState();
    expect(loadedB.savedDocument).toBe(loadedB.document);
    expect(hasUnsavedChanges(loadedB.document, loadedB.savedDocument)).toBe(false);
    // 開いた文書は新しい履歴から始まる。Undo/Redo してもBのままで、未保存にもならない。
    expect(loadedB.canUndo).toBe(false);
    loadedB.undo();
    expect(useAppStore.getState().document).toBe(loadedB.document);
    expect(hasUnsavedChanges(useAppStore.getState().document, useAppStore.getState().savedDocument)).toBe(false);
    loadedB.redo();
    expect(useAppStore.getState().document).toBe(loadedB.document);
    expect(hasUnsavedChanges(useAppStore.getState().document, useAppStore.getState().savedDocument)).toBe(false);
    const newShapes = useAppStore.getState().importedShapes, newMeshes = useAppStore.getState().importedMeshes;
    const capturedShapes = new Map([...newShapes].map(([id, bytes]) => [id, bytes.slice()]));
    const capturedMeshes = new Map([...newMeshes].map(([id, mesh]) => [id, {
      positions: mesh.positions.slice(), normals: mesh.normals.slice(), indices: mesh.indices.slice(),
    }]));
    await expectCurrentAndSaved(fakeB, documentB, attachmentsB, 'open B');
    // Undo しても前の文書Aへ戻らないので、Bの上書き保存にAの中身・添付が入らない。
    useAppStore.getState().undo();
    await expectCurrentAndSaved(fakeB, documentB, attachmentsB, 'Undo stays B');
    useAppStore.getState().redo();
    await expectCurrentAndSaved(fakeB, documentB, attachmentsB, 'Redo stays B');
    // soft assertionsでUndoの失敗後もRedoと原本の不変性を必ず照合する。
    expect(oldShapes.get('importedSolid-1')).toBe(oldShape); expect(oldMeshes.get('importedMesh-1')).toBe(oldMesh);
    expect(oldShapes).toEqual(attachmentsA.shapes); expect(oldMeshes).toEqual(attachmentsA.meshes);
    expect(newShapes).toEqual(capturedShapes); expect(newMeshes).toEqual(capturedMeshes);
    expect(fileA).toEqual(originalFileA); expect(fileB).toEqual(originalFileB);
    const savedB = fakeB.saveCalls[fakeB.saveCalls.length - 1].bytes, savedCopy = savedB.slice();
    const reopened = await load('saved-B.pcad', savedB);
    expect(useAppStore.getState().savedDocument).toBe(useAppStore.getState().document);
    await expectCurrentAndSaved(reopened, documentB, attachmentsB, 'reopen B');
    useAppStore.getState().undo(); useAppStore.getState().undo();
    expectAttachments(useAppStore.getState().document, currentPcadAttachments(), documentB, attachmentsB, 'reopen Undo stays B');
    useAppStore.getState().redo(); useAppStore.getState().redo();
    await expectCurrentAndSaved(reopened, documentB, attachmentsB, 'reopen Redo B');
    expect(savedB).toEqual(savedCopy); expect(oldShapes).toEqual(attachmentsA.shapes); expect(oldMeshes).toEqual(attachmentsA.meshes);
  });
});

describe('保存と読み込みの添付(P6 §0.a-0.9・0.24)', () => {
  it('添付を渡さないと、読み込んだ形を含む部品は開き直せない(申し送りの再現)', async () => {
    const fake = createFakeGateway();
    const fakeDeps = createFakeDeps(true);
    useAppStore.setState({ fileGateway: fake.gateway });
    useAppStore.getState().resetDocument(importedDocument());

    await savePart(fakeDeps.deps, false);
    const stored = fake.stored();
    if (stored === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(stored.bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('missingField');
    }
  });

  it('attachmentsOf を渡すと、読み込んだ形を含む部品が開き直せる', async () => {
    const fake = createFakeGateway();
    const fakeDeps = createFakeDeps(true);
    const deps: PartFileDeps = { ...fakeDeps.deps, attachmentsOf: () => importedAttachments() };
    useAppStore.setState({ fileGateway: fake.gateway });
    const document = importedDocument();
    useAppStore.getState().resetDocument(document);

    await savePart(deps, false);
    const stored = fake.stored();
    if (stored === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(stored.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
      expect(parsed.attachments.shapes.get('importedSolid-1')).toEqual(Uint8Array.from([1, 2, 3]));
      expect(parsed.attachments.meshes.get('importedMesh-1')?.indices)
        .toEqual(Uint32Array.from([0, 1, 2]));
    }
  });

  it('サムネイルと添付は両方入る(片方が片方を落とさない)', async () => {
    const fake = createFakeGateway();
    const thumbnail = Uint8Array.from([137, 80, 78, 71]);
    const fakeDeps = createFakeDeps(true, thumbnail);
    const deps: PartFileDeps = { ...fakeDeps.deps, attachmentsOf: () => importedAttachments() };
    useAppStore.setState({ fileGateway: fake.gateway });
    useAppStore.getState().resetDocument(importedDocument());

    await savePart(deps, false);
    const stored = fake.stored();
    if (stored === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(stored.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.thumbnailPng).toEqual(thumbnail);
      expect(parsed.attachments.shapes.size).toBe(1);
    }
  });

  it('開くと、ファイルに入っていた添付を受け取れる', async () => {
    const document = importedDocument();
    const bytes = writePcadFile(document, { attachments: importedAttachments() });
    const fake = createFakeGateway({ openBytes: bytes, openName: '読み込んだ部品.pcad' });
    const fakeDeps = createFakeDeps(true);
    const received: PcadAttachments[] = [];
    const deps: PartFileDeps = {
      ...fakeDeps.deps,
      onAttachmentsLoaded: (attachments) => {
        received.push(attachments);
      },
    };
    useAppStore.setState({ fileGateway: fake.gateway });

    await openPart(deps);

    expect(useAppStore.getState().document).toEqual(document);
    expect(received).toHaveLength(1);
    expect(received[0].shapes.get('importedSolid-1')).toEqual(Uint8Array.from([1, 2, 3]));
    expect(received[0].meshes.size).toBe(1);
  });

  it('開けなかったときは添付を渡さない(今の文書も変えない)', async () => {
    const fake = createFakeGateway({ openBytes: Uint8Array.from([1, 2, 3]) });
    const fakeDeps = createFakeDeps(true);
    const received: PcadAttachments[] = [];
    const deps: PartFileDeps = {
      ...fakeDeps.deps,
      onAttachmentsLoaded: (attachments) => {
        received.push(attachments);
      },
    };
    useAppStore.setState({ fileGateway: fake.gateway });
    const before = useAppStore.getState().document;

    await openPart(deps);

    expect(received).toHaveLength(0);
    expect(useAppStore.getState().document).toBe(before);
  });

  it('添付を 1 つも持たないファイルを開いても、空の表が渡る(版 6 までのファイル)', async () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {});
    const fake = createFakeGateway({ openBytes: bytes, openName: '古い部品.pcad' });
    const fakeDeps = createFakeDeps(true);
    const received: PcadAttachments[] = [];
    const deps: PartFileDeps = {
      ...fakeDeps.deps,
      onAttachmentsLoaded: (attachments) => {
        received.push(attachments);
      },
    };
    useAppStore.setState({ fileGateway: fake.gateway });

    await openPart(deps);

    expect(received).toHaveLength(1);
    expect(received[0].shapes.size).toBe(0);
    expect(received[0].meshes.size).toBe(0);
    expect(received[0].canvases.size).toBe(0);
  });
});


describe('point-slot issuance save and dirty boundary', () => {
  it('returns all-Undo to saved content while retaining issuance, then saves and cold reads that issuance', async () => {
    const saved = partWithPoint();
    const fake = createFakeGateway(); useFake(fake);
    useAppStore.getState().resetDocument(saved);
    useAppStore.getState().setFileState('part.pcad', saved);
    useAppStore.getState().applyDocument({ ...saved, name: 'edited', patternSlotHighWater: { pattern: 9 } });
    expect(hasUnsavedChanges(useAppStore.getState().document, saved)).toBe(true);
    useAppStore.getState().undo();
    const undone = useAppStore.getState();
    expect(undone.document.name).toBe(saved.name);
    expect(undone.document.patternSlotHighWater).toEqual({ pattern: 9 });
    expect(undone.undoStack.present).toBe(undone.document);
    expect(hasUnsavedChanges(undone.document, saved)).toBe(false);
    await savePart(createFakeDeps(true).deps, false);
    const bytes = fake.stored()?.bytes;
    if (bytes === undefined) throw new Error('save missing');
    const cold = readPcadFile(bytes);
    expect(cold.ok).toBe(true);
    if (!cold.ok) throw new Error('cold read failed');
    expect(cold.document.patternSlotHighWater).toEqual({ pattern: 9 });
    expect(cold.document.sketches).toEqual(saved.sketches);
    expect(hasUnsavedChanges(cold.document, saved)).toBe(false);
    expect(hasUnsavedChanges({ ...cold.document, name: 'authored-change' }, saved)).toBe(true);
    await openPart(createFakeDeps(true).deps);
    expect(useAppStore.getState().document.patternSlotHighWater).toEqual({ pattern: 9 });
    await newPart(createFakeDeps(true).deps);
    expect(useAppStore.getState().document.patternSlotHighWater).toBeUndefined();
  });
  it.each([{ saveCancels: true }, { saveThrows: true }])('does not advance savedDocument for cancelled/failed ledger save (%j)', async options => {
    const saved = partWithPoint();
    useAppStore.getState().resetDocument(saved);
    useAppStore.getState().setFileState('part.pcad', saved);
    const current = { ...saved, patternSlotHighWater: { pattern: 11 } };
    useAppStore.getState().applyDocument(current);
    useFake(createFakeGateway(options));
    await savePart(createFakeDeps(true).deps, false);
    expect(useAppStore.getState().savedDocument).toBe(saved);
    expect(useAppStore.getState().document.patternSlotHighWater).toEqual({ pattern: 11 });
    expect(hasUnsavedChanges(useAppStore.getState().document, saved)).toBe(false);
  });
});

describe('new-part lineage and actual save/open stability', () => {
  it('two actual New operations issue distinct IDs and stay untouched without discard prompts', async () => {
    useFake(createFakeGateway());
    const deps = createFakeDeps(false);
    await newPart(deps.deps);
    const first = useAppStore.getState().document;
    expect(hasUnsavedChanges(first, null)).toBe(false);
    await newPart(deps.deps);
    const second = useAppStore.getState().document;
    expect(second.id).not.toBe(first.id);
    expect(second.id).toMatch(/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(hasUnsavedChanges(second, null)).toBe(false);
    expect(deps.confirmed).toEqual([]);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('Save, SaveAs, actual PCAD decode and Open preserve the entire tagged document', async () => {
    const gateway = createFakeGateway();
    useFake(gateway);
    const deps = createFakeDeps(true).deps;
    await newPart(deps);
    const original = useAppStore.getState().document;
    useAppStore.getState().applyDocument({ ...original, name: 'Saved lineage' });
    const source = useAppStore.getState().document;
    expect(gateway.gateway.hasSaveTarget()).toBe(false);
    await savePart(deps, false);
    expect(gateway.gateway.hasSaveTarget()).toBe(true);
    await savePart(deps, false);
    await savePart(deps, true);
    expect(gateway.saveCalls).toHaveLength(3);
    expect(gateway.saveCalls.map(call => call.saveAs)).toEqual([true, false, true]);
    for (const call of gateway.saveCalls) {
      const parsed = readPcadFile(call.bytes);
      if (!parsed.ok) throw new Error('Actual saved PCAD must decode');
      expect(parsed.document).toEqual(source);
      expect(parsed.document.id).toBe(original.id);
    }
    await newPart(deps);
    expect(useAppStore.getState().document.id).not.toBe(original.id);
    await openPart(deps);
    expect(useAppStore.getState().document).toEqual(source);
    expect(hasUnsavedChanges(useAppStore.getState().document, useAppStore.getState().savedDocument)).toBe(false);
  });
});

describe('secure fallback through real New and PCAD save/open', () => {
  it('getRandomValues-only New issues distinct IDs; real crypto SaveAs and Open preserve all saved fields', async () => {
    const entropy = globalThis.crypto;
    const gateway = createFakeGateway();
    useFake(gateway);
    const deps = createFakeDeps(true).deps;
    vi.stubGlobal('crypto', { getRandomValues: entropy.getRandomValues.bind(entropy) });
    try {
      await newPart(deps);
      const first = useAppStore.getState().document;
      await newPart(deps);
      const source = useAppStore.getState().document;
      expect(source.id).not.toBe(first.id);
      expect(source.id).toMatch(/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(source).toEqual({ ...createEmptyPartDocument(), id: source.id });
      expect(hasUnsavedChanges(source, null)).toBe(false);
      // End the ID-entropy-only New phase before real codec Save/Open.
      vi.unstubAllGlobals();
      await savePart(deps, false);
      await savePart(deps, true);
      for (const call of gateway.saveCalls) {
        const decoded = readPcadFile(call.bytes);
        if (!decoded.ok) throw new Error('Saved fallback document must decode');
        expect(decoded.document).toEqual(source);
      }
      await newPart(deps);
      await openPart(deps);
      expect(useAppStore.getState().document).toEqual(source);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('secure identity failure precedes New save-target release', () => {
  it('failed New preserves actual saved target, full document/history and busy state', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const deps = createFakeDeps(true).deps;
    await savePart(deps, false);
    expect(fake.gateway.hasSaveTarget()).toBe(true);
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: 'Existing edited document' });
    const releaseTarget = fake.gateway.clearSaveTarget?.bind(fake.gateway);
    if (releaseTarget === undefined) throw new Error('Actual save-target release required');
    const clears = vi.fn(() => { releaseTarget(); });
    useAppStore.getState().setFileGateway({ ...fake.gateway, clearSaveTarget: clears });
    const before = useAppStore.getState();
    const stored = fake.stored();
    vi.stubGlobal('crypto', {});
    try {
      await expect(newPart(deps)).resolves.toBeUndefined();
      const after = useAppStore.getState();
      expect(clears).not.toHaveBeenCalled();
      expect(fake.gateway.hasSaveTarget()).toBe(true);
      expect(fake.stored()).toBe(stored);
      expect(after.document).toBe(before.document);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.documentVersion).toBe(before.documentVersion);
      expect(after.activeDocumentId).toBe(before.activeDocumentId);
      expect(after.fileName).toBe(before.fileName);
      expect(after.savedDocument).toBe(before.savedDocument);
      expect(after.fileMessage).toEqual({ key: 'command.unavailable.action', failed: true });
      expect(after.documentSaveOperation).toBe(before.documentSaveOperation);
      expect(after.isComputing).toBe(before.isComputing);
      expect(after.assemblyReplacementBusy).toBe(before.assemblyReplacementBusy);
      expect(after.canUndo).toBe(before.canUndo);
      expect(after.canRedo).toBe(before.canRedo);
    } finally { vi.unstubAllGlobals(); }
    await savePart(deps, false);
    expect(fake.saveCalls.at(-1)?.saveAs).toBe(false);
    const saved = fake.stored();
    if (saved === null) throw new Error('Existing target must still save');
    const decoded = readPcadFile(saved.bytes);
    if (!decoded.ok) throw new Error('Existing target saved bytes must decode');
    expect(decoded.document).toEqual(before.document);
  });
});

describe('New identity notification does not swallow unrelated errors', () => {
  it('discard-confirmation rejection remains the original API rejection with no target/document mutation', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    await savePart(createFakeDeps(true).deps, false);
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: 'Unsaved existing part' });
    const before = useAppStore.getState();
    const failure = new Error('Original confirmation failure');
    const deps = { ...createFakeDeps(true).deps, confirmDiscard: () => Promise.reject(failure) };
    await expect(newPart(deps)).rejects.toBe(failure);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().fileMessage).toBe(before.fileMessage);
    expect(fake.gateway.hasSaveTarget()).toBe(true);
  });
});

describe('actual part callers refuse incomplete session preparation atomically', () => {
  it('New can obtain lineage but cannot clear a saved target when session entropy subsequently fails', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const deps = createFakeDeps(true).deps;
    await savePart(deps, false);
    const original = globalThis.crypto;
    let requests = 0;
    const entropy = vi.fn(() => {
      requests += 1;
      if (requests > 1) throw new Error('Session entropy unavailable after lineage');
      return original.randomUUID();
    });
    const before = useAppStore.getState();
    const stored = fake.stored();
    vi.stubGlobal('crypto', { randomUUID: entropy });
    try {
      await newPart(deps);
      expect(entropy).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState()).toEqual({ ...before,
        fileMessage: { key: 'command.unavailable.action', failed: true } });
      expect(fake.gateway.hasSaveTarget()).toBe(true);
      expect(fake.stored()).toBe(stored);
    } finally { vi.unstubAllGlobals(); }
  });
  it('actual PCAD Open cannot invoke attachments or confirm a new target before preparing the session', async () => {
    const loaded = { ...createEmptyPartDocument(), id: 'part-1', name: 'Stored legacy part' };
    const bytes = writePcadFile(loaded);
    const fake = createFakeGateway({ openBytes: bytes, openName: 'actual-stored.pcad' });
    useFake(fake);
    const deps = createFakeDeps(true).deps;
    await savePart(deps, false);
    const onAttachmentsLoaded = vi.fn<NonNullable<PartFileDeps['onAttachmentsLoaded']>>();
    const confirmTarget = vi.fn<NonNullable<FileGateway['confirmSaveTarget']>>();
    const clearTarget = vi.fn();
    useAppStore.getState().setFileGateway({ ...fake.gateway,
      confirmSaveTarget: confirmTarget, clearSaveTarget: clearTarget });
    const before = useAppStore.getState();
    const stored = fake.stored();
    vi.stubGlobal('crypto', {});
    try {
      await openPart({ ...deps, onAttachmentsLoaded });
      expect(onAttachmentsLoaded).not.toHaveBeenCalled();
      expect(confirmTarget).not.toHaveBeenCalled();
      expect(clearTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toEqual({ ...before,
        fileMessage: { key: 'file.openFailed', failed: true } });
      expect(fake.gateway.hasSaveTarget()).toBe(true);
      expect(fake.stored()).toBe(stored);
      const decoded = readPcadFile(bytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error('Actual input must remain valid PCAD');
      expect(decoded.document).toEqual(loaded);
    } finally { vi.unstubAllGlobals(); }
  });
});

it('session success followed by actual canvas collision entropy failure invokes no attachment commit', async () => {
  const original = globalThis.crypto;
  const oldCanvas = newSketchCanvas([], 'xy', 'Old.png', { width: 2, height: 1 }, 'canvas-1');
  const incomingCanvas = newSketchCanvas([], 'xy', 'Incoming.png', { width: 2, height: 1 }, 'canvas-1');
  const oldBytes = Uint8Array.of(1, 2, 3);
  const incomingBytes = Uint8Array.of(4, 5, 6);
  const incoming = { ...createEmptyPartDocument(), canvases: [incomingCanvas] };
  const bytes = writePcadFile(incoming, { attachments: {
    ...emptyPcadAttachments(), canvases: new Map([[incomingCanvas.imageId, incomingBytes]]) } });
  const fake = createFakeGateway({ openBytes: bytes, openName: 'collision.pcad' });
  useFake(fake);
  useAppStore.getState().addCanvas(oldCanvas, oldBytes);
  const deps = createFakeDeps(true).deps;
  await savePart(deps, false);
  const onAttachmentsLoaded = vi.fn<NonNullable<PartFileDeps['onAttachmentsLoaded']>>();
  const before = useAppStore.getState();
  const oldCanvases = new Map([...before.canvases].map(([id, value]) => [id, new Uint8Array(value)]));
  let requests = 0;
  const entropy = vi.fn(() => {
    requests += 1;
    if (requests > 1) throw new Error('Collision identity entropy unavailable after session');
    return original.randomUUID();
  });
  vi.stubGlobal('crypto', { randomUUID: entropy });
  try {
    await openPart({ ...deps, onAttachmentsLoaded });
    expect(entropy).toHaveBeenCalledTimes(2);
    expect(onAttachmentsLoaded).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toEqual({ ...before,
      fileMessage: { key: 'file.openFailed', failed: true } });
    expect(useAppStore.getState().canvases).toEqual(oldCanvases);
    expect(fake.gateway.hasSaveTarget()).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

describe('actual viewport thumbnail reason-only producer boundary', () => {
  it('preserves absent null throwing and success outcomes with exactly one call despite observer failure', () => {
    const original = useAppStore.getState().captureThumbnail;
    const journal = createThumbnailCaptureReasonJournal();
    const release = observeThumbnailCaptureReasons(journal.record);
    const releaseThrowing = observeThumbnailCaptureReasons(() => { throw new Error('observer only'); });
    const capture = createDefaultPartFileDeps().captureThumbnail;
    try {
      useAppStore.getState().setCaptureThumbnail(null); expect(capture()).toBeNull();
      const nullProducer = vi.fn(() => null); useAppStore.getState().setCaptureThumbnail(nullProducer);
      expect(capture()).toBeNull(); expect(nullProducer).toHaveBeenCalledTimes(1);
      const throwing = vi.fn(() => { throw new Error('actual image failure'); }); useAppStore.getState().setCaptureThumbnail(throwing);
      expect(capture()).toBeNull(); expect(throwing).toHaveBeenCalledTimes(1);
      const png = Uint8Array.of(1, 2, 3), success = vi.fn(() => png); useAppStore.getState().setCaptureThumbnail(success);
      expect(capture()).toBe(png); expect(success).toHaveBeenCalledTimes(1);
      expect(journal.snapshot().entries.map(entry => entry.reason)).toEqual(['producer:absent', 'producer:null', 'producer:throw', 'producer:success']);
    } finally { release(); releaseThrowing(); useAppStore.getState().setCaptureThumbnail(original); }
  });
});
