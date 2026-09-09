import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssemblyDocument } from '@pointercad/model';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { HOME_ORBIT } from './cameraMath.js';
import { namedCameraFromOrbit } from './namedCamera.js';
import { runNamedViewAction } from './namedViewActions.js';

const state = () => useAppStore.getState();
const captured = namedCameraFromOrbit({ ...HOME_ORBIT, zoom: 2 }, 'orthographic');
const restore = vi.fn(() => true);
describe('名前付き視点の文書操作とUndo(FR-113)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    restore.mockClear();
    state().setViewCameraController({ capture: () => captured, restore });
  });
  it('保存は部品文書に1件追加するが形の再計算を始めない', () => {
    const before = state().document;
    expect(runNamedViewAction({ kind: 'save', name: '点検' })).toEqual({ ok: true });
    expect(state().document.namedViews.at(-1)).toMatchObject({ name: '点検', ...captured });
    expect(state().document.solids).toBe(before.solids);
    expect(state().isComputing).toBe(false);
  });
  it('保存をUndo1回で戻し、Redoで同じ視点を復元する', () => {
    const before = state().document;
    runNamedViewAction({ kind: 'save', name: '点検' });
    const after = state().document;
    state().undo(); expect(state().document).toBe(before);
    state().redo(); expect(state().document).toBe(after);
  });
  it('呼出しは表示だけを変え、Undoに何も追加しない', () => {
    const before = state().document;
    const undoBefore = state().canUndo;
    expect(runNamedViewAction({ kind: 'restore', id: before.namedViews[0].id })).toEqual({ ok: true });
    expect(restore).toHaveBeenCalledExactlyOnceWith(before.namedViews[0]);
    expect(state().document).toBe(before);
    expect(state().canUndo).toBe(undoBefore);
  });
  it('改名と削除もそれぞれUndoで戻る', () => {
    const first = state().document.namedViews[0];
    runNamedViewAction({ kind: 'rename', id: first.id, name: '検査正面' });
    expect(state().document.namedViews[0].name).toBe('検査正面');
    state().undo(); expect(state().document.namedViews[0]).toBe(first);
    runNamedViewAction({ kind: 'delete', id: first.id });
    expect(state().document.namedViews).not.toContain(first);
    state().undo(); expect(state().document.namedViews[0]).toBe(first);
  });
  it('同じ名前への改名は履歴を増やさない', () => {
    const before = state().document;
    const view = before.namedViews[0];
    expect(runNamedViewAction({ kind: 'rename', id: view.id, name: view.name })).toEqual({ ok: true });
    expect(state().document).toBe(before);
    expect(state().canUndo).toBe(false);
  });
  it.each(['', '正面'])('空名・重複名を断って文書を変えない: %s', (name) => {
    const before = state().document;
    expect(runNamedViewAction({ kind: 'save', name }).ok).toBe(false);
    expect(state().document).toBe(before);
  });
  it('視点の準備前に保存できたと報告しない', () => {
    state().setViewCameraController(null);
    expect(runNamedViewAction({ kind: 'save', name: '点検' })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('消えた視点の呼出し・削除で別の視点を触らない', () => {
    expect(runNamedViewAction({ kind: 'restore', id: 'gone' })).toEqual({ ok: false, reason: 'notFound' });
    expect(runNamedViewAction({ kind: 'delete', id: 'gone' })).toEqual({ ok: false, reason: 'notFound' });
    expect(restore).not.toHaveBeenCalled();
  });
  it('アセンブリへ保存した視点は隠れた部品文書を変えない', () => {
    const part = state().document;
    state().openAssembly(createAssemblyDocument('組立'));
    expect(runNamedViewAction({ kind: 'save', name: '組立確認' })).toEqual({ ok: true });
    expect(state().assembly?.namedViews.at(-1)).toMatchObject({ name: '組立確認' });
    expect(state().document).toBe(part);
    state().undo(); expect(state().assembly?.namedViews).toHaveLength(4);
  });
});
