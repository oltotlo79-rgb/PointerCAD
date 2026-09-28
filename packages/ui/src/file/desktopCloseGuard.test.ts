/**
 * デスクトップ版の窓を閉じるときの未保存の確認(レビュー R03)の画面側の検査。
 *
 * 両アプリの入口が呼ぶ `attachUnsavedChangesGuard` へ、本体の問合せの口(preload が出す形)を渡す。
 * 確かめること:
 *  - 未保存が無ければ聞かずに「閉じてよい」と答える。あれば本体の3択を1回だけ出す。
 *  - 「戻る」・保存の取消・保存の失敗では閉じず、編集はそのまま残る。成功のときだけ閉じる。
 *  - 「保存せずに閉じる」は保存しないで閉じる。
 *  - 部品・組立・図面と、図面の後ろに残る元の部品の未保存を対象にする。
 *  - 未保存の有無が変わったときだけ本体へ知らせる(Windows の終了要求の判断に使う)。
 */
import {
  absoluteCoordinate,
  appendFeature,
  createAssemblyDocument,
  createDrawingDocument,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  embedDrawingSource,
  emptyDrawingSourceLibrary,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FileGateway } from './fileGateway.js';
import type { PartFileDeps } from './partFile.js';
import { attachUnsavedChangesGuard, hasUnsavedWork, type CloseChoice, type CloseRequestTarget } from './unsavedChangesGuard.js';

beforeEach(resetTestStore);

function partWithPoint(): PartDocument {
  const sketch = createEmptySketchDocument();
  const drawn = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(1, 2, 3)));
  return replaceSketch(createEmptyPartDocument(), drawn);
}

const deps = (): PartFileDeps => ({ captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null });

/** 保存の口。`answers` の順に、保存した名前・取消(null)・失敗(Error)を返す。 */
function installGateway(answers: Array<string | null | Error> = []) {
  let target = false;
  const savePcad = vi.fn<FileGateway['savePcad']>((name) => {
    const answer = answers.length > 0 ? answers.shift() : name;
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer !== null && answer !== undefined) target = true;
    return Promise.resolve(answer ?? null);
  });
  const gateway: FileGateway = { savePcad, openPcad: () => Promise.resolve(null), hasSaveTarget: () => target,
    clearSaveTarget: () => { target = false; } };
  useAppStore.setState({ fileGateway: gateway });
  return savePcad;
}

/** preload が出す口の偽物。本体の3択には `choices` の順に答える。 */
function createDesktop(choices: CloseChoice[] = []) {
  let listener: ((requestId: string) => void) | null = null;
  const answers = new Map<string, boolean>();
  const reports: boolean[] = [];
  const asked: string[] = [];
  const registered: unknown[] = [];
  const target: CloseRequestTarget = {
    closeGuardReady: (texts) => { registered.push(texts); return Promise.resolve(true); },
    reportUnsavedWork: (unsaved) => { reports.push(unsaved); return Promise.resolve(true); },
    onCloseRequest: (next) => { listener = next; return () => { listener = null; }; },
    chooseCloseAction: (requestId) => { asked.push(requestId); return Promise.resolve(choices.shift() ?? 'cancel'); },
    answerCloseRequest: (requestId, close) => { answers.set(requestId, close); return Promise.resolve(true); },
  };
  /** 本体が×を受けて問い合わせたときと同じく呼び、画面の答えを待つ。 */
  const requestClose = async (requestId: string): Promise<boolean> => {
    if (listener === null) throw new Error('問合せの受け手がありません');
    listener(requestId);
    await vi.waitFor(() => { expect(answers.has(requestId)).toBe(true); });
    return answers.get(requestId) === true;
  };
  return { target, requestClose, reports, asked, registered, listening: () => listener !== null };
}

async function openSavableDrawing(): Promise<void> {
  const source = { sourceKind: 'part' as const, document: createEmptyPartDocument() };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'part.pcad', '');
  useAppStore.getState().openDrawing(createDrawingDocument('試験図面', embedded.source), { sources: embedded.library });
  const drawing = useAppStore.getState().drawing;
  if (drawing === null) throw new Error('図面が開いていません');
  useAppStore.getState().applyDrawing({ ...drawing, name: '変更した図面' });
}

describe('デスクトップ版の窓を閉じるときの確認(R03)', () => {
  it('用意の知らせに ja.json の文言を渡し、未保存が無ければ聞かずに閉じてよいと答える', async () => {
    const desktop = createDesktop();
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    expect(desktop.registered).toEqual([{
      message: t('file.closeGuard.message'), detail: t('file.closeGuard.detail'),
      save: t('file.closeGuard.save'), discard: t('file.closeGuard.discard'), cancel: t('file.closeGuard.cancel'),
      unresponsiveMessage: t('file.closeGuard.unresponsiveMessage'),
      unresponsiveDetail: t('file.closeGuard.unresponsiveDetail'), forceClose: t('file.closeGuard.forceClose'),
    }]);
    expect(desktop.reports).toEqual([false]);
    expect(await desktop.requestClose('r1')).toBe(true);
    expect(desktop.asked).toEqual([]);
  });

  it('戻るを選ぶと閉じず、編集はそのまま残る', async () => {
    const desktop = createDesktop(['cancel']);
    const savePcad = installGateway();
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    const document = partWithPoint();
    useAppStore.getState().applyDocument(document);
    expect(await desktop.requestClose('r1')).toBe(false);
    expect(desktop.asked).toEqual(['r1']);
    expect(savePcad).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(document);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(true);
  });

  it('保存せずに閉じるを選ぶと、保存しないで閉じてよいと答える', async () => {
    const desktop = createDesktop(['discard']);
    const savePcad = installGateway();
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    useAppStore.getState().applyDocument(partWithPoint());
    expect(await desktop.requestClose('r1')).toBe(true);
    expect(savePcad).not.toHaveBeenCalled();
  });

  it('保存して閉じるは、保存に成功したときだけ閉じる', async () => {
    const desktop = createDesktop(['save']);
    const savePcad = installGateway(['部品.pcad']);
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    useAppStore.getState().applyDocument(partWithPoint());
    expect(desktop.reports).toEqual([false, true]);
    expect(await desktop.requestClose('r1')).toBe(true);
    expect(savePcad).toHaveBeenCalledOnce();
    expect(savePcad.mock.calls[0]?.[2]).toBe(true);
    expect(useAppStore.getState().fileName).toBe('部品.pcad');
    expect(desktop.reports).toEqual([false, true, false]);
  });

  it('保存の取消と保存の失敗では閉じず、失敗は理由を出して編集を残す', async () => {
    const desktop = createDesktop(['save', 'save']);
    const savePcad = installGateway([null, new Error('書けませんでした')]);
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    const document = partWithPoint();
    useAppStore.getState().applyDocument(document);
    expect(await desktop.requestClose('cancelled')).toBe(false);
    expect(useAppStore.getState().fileMessage).toBeNull();
    expect(await desktop.requestClose('failed')).toBe(false);
    expect(savePcad).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.saveFailed', failed: true });
    expect(useAppStore.getState().document).toBe(document);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(true);
  });

  it('組立の未保存も対象にし、保存して閉じる', async () => {
    const desktop = createDesktop(['save']);
    const savePcad = installGateway(['組立.pcada']);
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
    useAppStore.getState().setAssemblyFileState(null, null);
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('組立が開いていません');
    useAppStore.setState({ assembly: { ...assembly, name: '変更した組立' } });
    expect(hasUnsavedWork(useAppStore.getState())).toBe(true);
    expect(await desktop.requestClose('r1')).toBe(true);
    expect(savePcad.mock.calls[0]?.[3]).toBe('assembly');
  });

  it('図面と、図面の後ろに残る元の部品の両方を保存してから閉じる', async () => {
    const desktop = createDesktop(['save']);
    const savePcad = installGateway(['図面.pcadd', '部品.pcad']);
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    const part = partWithPoint();
    useAppStore.getState().applyDocument(part);
    await openSavableDrawing();
    expect(await desktop.requestClose('r1')).toBe(true);
    expect(savePcad.mock.calls.map((call) => call[3])).toEqual(['drawing', undefined]);
    expect(useAppStore.getState().savedDocument).toBe(part);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(false);
  });

  it('図面は保存できても元の部品の保存を取り消したら閉じず、部品の変更を残す', async () => {
    const desktop = createDesktop(['save']);
    const savePcad = installGateway(['図面.pcadd', null]);
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    const part = partWithPoint();
    useAppStore.getState().applyDocument(part);
    await openSavableDrawing();
    expect(await desktop.requestClose('r1')).toBe(false);
    expect(savePcad).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().document).toBe(part);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(true);
  });

  it('図面の保存に失敗したら元の部品へ進まず、閉じない', async () => {
    const desktop = createDesktop(['save']);
    const savePcad = installGateway([new Error('書けませんでした')]);
    attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    useAppStore.getState().applyDocument(partWithPoint());
    await openSavableDrawing();
    expect(await desktop.requestClose('r1')).toBe(false);
    expect(savePcad).toHaveBeenCalledOnce();
    expect(useAppStore.getState().drawing).not.toBeNull();
  });

  it('答える前に重ねて届いた問合せでは、3択を重ねて出さない', async () => {
    let resolveChoice: (choice: CloseChoice) => void = () => { throw new Error('未準備'); };
    const desktop = createDesktop();
    const target: CloseRequestTarget = { ...desktop.target, chooseCloseAction: (requestId) => {
      desktop.asked.push(requestId);
      return new Promise((resolve) => { resolveChoice = resolve; });
    } };
    attachUnsavedChangesGuard(target, useAppStore.getState, deps);
    useAppStore.getState().applyDocument(partWithPoint());
    const first = desktop.requestClose('r1');
    await vi.waitFor(() => { expect(desktop.asked).toEqual(['r1']); });
    const second = desktop.requestClose('r2');
    await vi.waitFor(() => { expect(desktop.asked).toEqual(['r1']); });
    resolveChoice('cancel');
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(desktop.asked).toEqual(['r1']);
  });

  it('取り外した後は問合せを受けず、変化も知らせない', () => {
    const desktop = createDesktop();
    const stop = attachUnsavedChangesGuard(desktop.target, useAppStore.getState, deps);
    expect(desktop.listening()).toBe(true);
    stop();
    expect(desktop.listening()).toBe(false);
    useAppStore.getState().applyDocument(partWithPoint());
    expect(desktop.reports).toEqual([false]);
  });
});
