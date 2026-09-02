import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  createUndoStack,
  pushUndo,
  redo,
  undo,
  UNDO_COALESCE_MS,
  UNDO_LIMIT,
} from './undoStack.js';

describe('createUndoStack', () => {
  it('present がそのまま入り、canUndo / canRedo はどちらも false', () => {
    const stack = createUndoStack('a');
    expect(stack.present).toBe('a');
    expect(canUndo(stack)).toBe(false);
    expect(canRedo(stack)).toBe(false);
  });
});

describe('pushUndo → undo → redo', () => {
  it('undo で present が元へ戻り、canRedo が true になる', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { now: 0 });
    const s2 = undo(s1);
    expect(s2.present).toBe('a');
    expect(canRedo(s2)).toBe(true);
  });

  it('undo → redo で元の present へ戻る', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { now: 0 });
    const s2 = undo(s1);
    const s3 = redo(s2);
    expect(s3.present).toBe('b');
  });

  it('undo → 新しい pushUndo で future が空になる(canRedo が false)', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { now: 0 });
    const s2 = undo(s1);
    const s3 = pushUndo(s2, 'c', { now: 1000 });
    expect(s3.future.length).toBe(0);
    expect(canRedo(s3)).toBe(false);
  });
});

describe('pushUndo の基本挙動', () => {
  it('同じ値を pushUndo しても何も変わらない(past.length が増えない)', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'a', { now: 0 });
    expect(s1.past.length).toBe(0);
    expect(s1.present).toBe('a');
  });

  it('201 回 pushUndo すると past.length === 200 で最初の値が捨てられている', () => {
    let stack = createUndoStack(0);
    for (let i = 1; i <= 201; i += 1) {
      // coalesceKey を指定しないので毎回必ず別の段になる。now は無関係に離す。
      stack = pushUndo(stack, i, { now: i * 10_000 });
    }
    expect(stack.past.length).toBe(UNDO_LIMIT);
    expect(stack.present).toBe(201);
    // 初期値 0(最初の present)が捨てられている(past は直近 200 個の 1〜200 だけ残る)。
    expect(stack.past).not.toContain(0);
    expect(stack.past[0]).toBe(1);
    expect(stack.past[stack.past.length - 1]).toBe(200);
  });

  it('空のスタックで undo しても同じスタックがそのまま返る(例外にならない)', () => {
    const stack = createUndoStack('a');
    const result = undo(stack);
    expect(result).toBe(stack);
  });

  it('空のスタックで redo しても同じスタックがそのまま返る(例外にならない)', () => {
    const stack = createUndoStack('a');
    const result = redo(stack);
    expect(result).toBe(stack);
  });
});

describe('束ね(coalesce、UNDO_COALESCE_MS = 800ms)', () => {
  it('同じ coalesceKey で now が +500ms なら past.length は増えず present だけ新しくなる', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { coalesceKey: 'field:f1:x', now: 0 });
    const s2 = pushUndo(s1, 'c', { coalesceKey: 'field:f1:x', now: 500 });
    expect(s2.past.length).toBe(s1.past.length);
    expect(s2.present).toBe('c');
  });

  it('同じ coalesceKey で now が +900ms なら past.length が1増える(800ms を超えたので別の段)', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { coalesceKey: 'field:f1:x', now: 0 });
    const s2 = pushUndo(s1, 'c', { coalesceKey: 'field:f1:x', now: 900 });
    expect(s2.past.length).toBe(s1.past.length + 1);
    expect(s2.present).toBe('c');
  });

  it('違う coalesceKey で now が +100ms でも past.length が1増える', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { coalesceKey: 'field:f1:x', now: 0 });
    const s2 = pushUndo(s1, 'c', { coalesceKey: 'field:f1:y', now: 100 });
    expect(s2.past.length).toBe(s1.past.length + 1);
  });

  it('coalesceKey なしを2回押すと past.length が2増える', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { now: 0 });
    const s2 = pushUndo(s1, 'c', { now: 100 });
    expect(s2.past.length).toBe(2);
  });

  it('undo の後は束ねない(直後に同じ鍵で pushUndo すると新しい段になる)', () => {
    const s0 = createUndoStack('a');
    const s1 = pushUndo(s0, 'b', { coalesceKey: 'field:f1:x', now: 0 });
    const s2 = undo(s1);
    expect(s2.coalesceKey).toBeNull();
    const s3 = pushUndo(s2, 'c', { coalesceKey: 'field:f1:x', now: 100 });
    // 束ねていれば past.length は 0 のままだが、undo 後は必ず新しい段になるので 1 増える。
    expect(s3.past.length).toBe(s2.past.length + 1);
  });

  it('UNDO_COALESCE_MS は 800', () => {
    expect(UNDO_COALESCE_MS).toBe(800);
  });

  it('UNDO_LIMIT は 200', () => {
    expect(UNDO_LIMIT).toBe(200);
  });
});
