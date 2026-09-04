import { describe, expect, it } from 'vitest';

import { DEFAULT_ANGLE_UNIT, EXPRESSION_SYNTAX_VERSION } from './index.js';

describe('expression パッケージの骨組み', () => {
  // 1 → 2 は緩和ではなく仕様の変更(P4b タスク1、2026-09-04): 変数名にひらがな・カタカナ・
  // CJK統合漢字を許すよう識別子の文字集合を広げた(FR-207)。版1の式はすべて版2でも読める。
  it('式の記法バージョンは 2 である', () => {
    expect(EXPRESSION_SYNTAX_VERSION).toBe(2);
  });

  it('角度の既定単位は度である(FR-205)', () => {
    expect(DEFAULT_ANGLE_UNIT).toBe('degree');
  });
});
