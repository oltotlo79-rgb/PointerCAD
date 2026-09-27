/**
 * 読み直し・閉じる前の未保存の確認(P12-24)の検査。
 *
 * 確かめること:
 *  - 保存していない変更がある間だけ、頁を離れる前の確認を求める(`preventDefault`)。
 *  - 起動直後・保存した直後・開いた直後・保存に失敗した後は、その時点の状態どおりに判定する。
 *  - 図面の後ろに残る部品の未保存の変更も守る。
 *  - 取り外した後は何もしない。
 */
import { writePcadFile } from '@pointercad/io';
import {
  absoluteCoordinate,
  appendFeature,
  createDrawingDocument,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FileGateway, PickedFile } from './fileGateway.js';
import { openPart, savePart, type PartFileDeps } from './partFile.js';
import {
  attachUnsavedChangesGuard,
  hasUnsavedWork,
  type UnloadEvent,
  type UnloadTarget,
} from './unsavedChangesGuard.js';

type Listener = (event: UnloadEvent) => void;

/** `window` の代わりの的。取り付けられた受け手を持ち、頁を離れる操作を再現する。 */
function createTarget() {
  const listeners = new Set<Listener>();
  const target: UnloadTarget = {
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  /** 頁を離れようとして、ブラウザーが確認を出すか(= 既定の動作が止められたか)を返す。 */
  const leave = (): { readonly prompted: boolean; readonly returnValue: unknown } => {
    let prompted = false;
    // ブラウザーと同じく returnValue は空の文字列から始まる。
    const event: UnloadEvent = { preventDefault: () => { prompted = true; }, returnValue: '' };
    for (const listener of listeners) listener(event);
    const returnValue: unknown = event.returnValue;
    return { prompted, returnValue };
  };
  return { target, leave, count: () => listeners.size };
}

function partWithPoint(): PartDocument {
  const sketch = createEmptySketchDocument();
  const drawn = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(1, 2, 3)));
  return replaceSketch(createEmptyPartDocument(), drawn);
}

/** 記憶上で保存・読込みを往復する偽の口。`failSave` で保存を失敗させる。 */
function createGateway(options: { readonly failSave?: boolean; readonly open?: PickedFile } = {}): FileGateway {
  let hasTarget = false;
  return {
    openPcad: () => Promise.resolve(options.open ?? null),
    savePcad: (suggestedName) => {
      if (options.failSave === true) return Promise.reject(new Error('保存できませんでした'));
      hasTarget = true;
      return Promise.resolve(suggestedName);
    },
    hasSaveTarget: () => hasTarget,
  };
}

/** 確認には「はい」と答え、履歴はどこにも残さない口。 */
function deps(): PartFileDeps {
  return {
    captureThumbnail: () => null,
    confirmDiscard: () => Promise.resolve(true),
    recentFilesStorage: null,
  };
}

beforeEach(() => {
  useAppStore.setState(createInitialDocumentState());
});

describe('頁を離れる前の未保存の確認(P12-24)', () => {
  it('起動直後の何もしていない部品では確認を出さない', () => {
    const { target, leave } = createTarget();
    attachUnsavedChangesGuard(target);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(false);
    expect(leave().prompted).toBe(false);
  });

  it('保存していない変更がある間だけ確認を出し、古いブラウザー向けの値も入れる', () => {
    const { target, leave } = createTarget();
    attachUnsavedChangesGuard(target);
    useAppStore.getState().applyDocument(partWithPoint());
    const result = leave();
    expect(result.prompted).toBe(true);
    expect(result.returnValue).toBe(true);
  });

  it('保存した直後は確認を出さず、その後に変えるとまた確認を出す', async () => {
    const { target, leave } = createTarget();
    attachUnsavedChangesGuard(target);
    useAppStore.setState({ fileGateway: createGateway() });
    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(deps(), false);
    expect(useAppStore.getState().fileName).not.toBeNull();
    expect(leave().prompted).toBe(false);
    useAppStore.getState().applyDocument(createEmptyPartDocument());
    expect(leave().prompted).toBe(true);
  });

  it('保存に失敗したときは変更が残っているので確認を出す', async () => {
    const { target, leave } = createTarget();
    attachUnsavedChangesGuard(target);
    useAppStore.setState({ fileGateway: createGateway({ failSave: true }) });
    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(deps(), false);
    expect(useAppStore.getState().fileMessage?.failed).toBe(true);
    expect(leave().prompted).toBe(true);
  });

  it('ファイルを開いた直後は確認を出さない', async () => {
    const bytes = writePcadFile(partWithPoint(), { savedAt: '2026-09-27T00:00:00.000Z' });
    const { target, leave } = createTarget();
    attachUnsavedChangesGuard(target);
    useAppStore.setState({ fileGateway: createGateway({ open: { name: '部品.pcad', bytes, saveTargetToken: null } }) });
    await openPart(deps());
    expect(useAppStore.getState().fileName).toBe('部品.pcad');
    expect(useAppStore.getState().document.sketches[0]?.features.length).toBe(1);
    expect(leave().prompted).toBe(false);
  });

  it('図面の後ろに残る部品の未保存の変更も守り、図面だけの変更も守る', () => {
    const source = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'box.pcad', path: '',
      contentHash: 'hash', importedAt: '2026-09-09T00:00:00.000Z' } as const;
    const { target, leave } = createTarget();
    attachUnsavedChangesGuard(target);
    // 保存済みの図面を開いただけ: 部品も図面も変更なし。
    useAppStore.getState().openDrawing(createDrawingDocument('図面', source), { saved: true });
    expect(leave().prompted).toBe(false);
    // 図面を変えると確認する。
    const drawing = useAppStore.getState().drawing;
    if (drawing === null) throw new Error('図面が開いていません');
    useAppStore.getState().applyDrawing({ ...drawing, name: '変更した図面' });
    expect(leave().prompted).toBe(true);
    // 部品に未保存の変更があるまま図面を開いた場合(図面は保存済みでも)確認する。
    useAppStore.setState(createInitialDocumentState());
    useAppStore.getState().applyDocument(partWithPoint());
    useAppStore.getState().openDrawing(createDrawingDocument('図面', source), { saved: true });
    expect(leave().prompted).toBe(true);
  });

  it('取り外した後は変更があっても確認を出さない', () => {
    const { target, leave, count } = createTarget();
    const stop = attachUnsavedChangesGuard(target);
    expect(count()).toBe(1);
    useAppStore.getState().applyDocument(partWithPoint());
    stop();
    expect(count()).toBe(0);
    expect(leave().prompted).toBe(false);
  });
});
