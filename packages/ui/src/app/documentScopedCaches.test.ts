import { appearanceFromPreset, appendSolid, assignBodyAppearance, createEmptyPartDocument, createPrimitiveFeature } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { clearCachesOnDocumentChange } from './documentScopedCaches.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('持ち回る覚え書き(板金への変換の認識を含む)を、文書が替わったら空にする', () => {
  it('ふつうの編集では空にせず、取り消し・やり直し・新規で documentVersion が進むたびに全部を空にし、止めた後は空にしない', () => {
    const caches = [{ clear: vi.fn() }, { clear: vi.fn() }];
    const cleared = (): number[] => caches.map(cache => cache.clear.mock.calls.length);
    const stop = clearCachesOnDocumentChange(caches.slice(0, 1), caches[1]);
    const empty = createEmptyPartDocument();
    useAppStore.getState().applyDocument(appendSolid(empty, createPrimitiveFeature(empty, 'box')));
    useAppStore.getState().setSelection([]);
    expect(cleared()).toEqual([0, 0]);
    useAppStore.getState().undo();
    expect(cleared()).toEqual([1, 1]);
    useAppStore.getState().redo();
    expect(cleared()).toEqual([2, 2]);
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(cleared()).toEqual([3, 3]);
    stop();
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(cleared()).toEqual([3, 3]);
  });

  it('外観だけの取り消し・やり直しでは板金の認識を残し、同じ形を別文書として開けば捨てる', () => {
    const empty = createEmptyPartDocument(), box = createPrimitiveFeature(empty, 'box');
    const part = appendSolid(empty, box);
    useAppStore.getState().resetDocument(part);
    const cache = { clear: vi.fn() }, recognition = { clear: vi.fn() };
    const stop = clearCachesOnDocumentChange([cache], recognition);
    try {
      const initial = useAppStore.getState();
      initial.applyDocument(assignBodyAppearance(initial.document, box.id, appearanceFromPreset('steel')));
      useAppStore.getState().undo();
      useAppStore.getState().redo();
      expect(useAppStore.getState().documentVersion).toBe(initial.documentVersion + 2);
      expect(cache.clear).toHaveBeenCalledTimes(2);
      expect(recognition.clear).not.toHaveBeenCalled();

      const current = useAppStore.getState();
      current.resetDocument(current.document);
      expect(useAppStore.getState().activeDocumentId).not.toBe(current.activeDocumentId);
      expect(cache.clear).toHaveBeenCalledTimes(3);
      expect(recognition.clear).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });
});
