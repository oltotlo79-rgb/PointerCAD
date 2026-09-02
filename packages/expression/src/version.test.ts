import { describe, expect, it } from 'vitest';

import { DEFAULT_ANGLE_UNIT, EXPRESSION_SYNTAX_VERSION } from './index.js';

describe('expression パッケージの骨組み', () => {
  it('式の記法バージョンは 1 である', () => {
    expect(EXPRESSION_SYNTAX_VERSION).toBe(1);
  });

  it('角度の既定単位は度である(FR-205)', () => {
    expect(DEFAULT_ANGLE_UNIT).toBe('degree');
  });
});
