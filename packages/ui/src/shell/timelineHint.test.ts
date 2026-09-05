/**
 * タイムラインのつまみの初回の案内(FR-507、利用者の決定①、タスク22b)の検査。
 */

import { describe, expect, it } from 'vitest';

import { shouldShowTimelineHint, TIMELINE_HINT_MIN_SOLIDS } from './timelineHint.js';

describe('つまみの初回の案内', () => {
  it('段数が初めて 2 に届いた瞬間だけ出す', () => {
    expect(TIMELINE_HINT_MIN_SOLIDS).toBe(2);
    expect(shouldShowTimelineHint(1, 2, false)).toBe(true);
    // 開いた文書がいきなり 3 段でも、0 → 3 は「初めて 2 に届いた」に当たる。
    expect(shouldShowTimelineHint(0, 3, false)).toBe(true);
  });

  it('1 段のあいだは出さない(戻す先が無い)', () => {
    expect(shouldShowTimelineHint(0, 1, false)).toBe(false);
    expect(shouldShowTimelineHint(0, 0, false)).toBe(false);
  });

  it('すでに 2 段以上だったら、段が増えても出さない', () => {
    expect(shouldShowTimelineHint(2, 3, false)).toBe(false);
    expect(shouldShowTimelineHint(3, 2, false)).toBe(false);
  });

  it('もう見せていれば二度と出さない(端末に覚える)', () => {
    expect(shouldShowTimelineHint(1, 2, true)).toBe(false);
    expect(shouldShowTimelineHint(0, 5, true)).toBe(false);
  });
});
