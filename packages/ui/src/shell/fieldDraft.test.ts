/**
 * プロパティ欄の打ちかけの下書きと文書の版の照合(`fieldDraft.ts`)。
 * 対応: docs/報告記録.md 2026-09-04 14:05 の 9b。
 */

import { describe, expect, it } from 'vitest';

import { initialDraftVersionState, reconcileDraftVersion, type DraftVersionState } from './fieldDraft.js';

interface SampleDraft {
  readonly path: string;
  readonly source: string;
}

describe('initialDraftVersionState', () => {
  it('下書きは無く、渡した版を最後に見た版として覚える', () => {
    expect(initialDraftVersionState<SampleDraft>(3)).toEqual({ draft: null, seenVersion: 3 });
  });
});

describe('reconcileDraftVersion(9b: 文書の差し替えで下書きを捨てる判定)', () => {
  it('版が変わっていなければ同じ参照をそのまま返す(下書きも残す)', () => {
    const state: DraftVersionState<SampleDraft> = {
      draft: { path: 'at.x', source: '10*' },
      seenVersion: 5,
    };
    const result = reconcileDraftVersion(state, 5);
    expect(result).toBe(state);
    expect(result.draft).toEqual({ path: 'at.x', source: '10*' });
  });

  it('版が変わっていれば下書きを捨て、見た版を新しい値へ進める', () => {
    const state: DraftVersionState<SampleDraft> = {
      draft: { path: 'at.x', source: '10*' },
      seenVersion: 5,
    };
    const result = reconcileDraftVersion(state, 6);
    expect(result).toEqual({ draft: null, seenVersion: 6 });
  });

  it('下書きが無くても版が変われば別の参照を返す(呼び出し側が変化を検知できる)', () => {
    const state: DraftVersionState<SampleDraft> = { draft: null, seenVersion: 1 };
    const result = reconcileDraftVersion(state, 2);
    expect(result).not.toBe(state);
    expect(result).toEqual({ draft: null, seenVersion: 2 });
  });

  it('版が戻る(Undo で古い版番号に相当する状況)場合も、値が違えば差し替えとみなす', () => {
    const state: DraftVersionState<SampleDraft> = {
      draft: { path: 'turns', source: '9' },
      seenVersion: 4,
    };
    const result = reconcileDraftVersion(state, 3);
    expect(result).toEqual({ draft: null, seenVersion: 3 });
  });
});
