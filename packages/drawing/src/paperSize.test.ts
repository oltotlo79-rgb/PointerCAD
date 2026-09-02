import { describe, expect, it } from 'vitest';

import { DEFAULT_PAPER_SIZE_ID, PAPER_SIZES, STANDARD_SCALES } from './index.js';

describe('図面の用紙と縮尺', () => {
  it('既定の用紙は A3 横である(FR-701)', () => {
    const paper = PAPER_SIZES.find((size) => size.id === DEFAULT_PAPER_SIZE_ID);
    expect(paper).toMatchObject({ width: 420, height: 297 });
  });

  it('A4 は縦横どちらも用意されている', () => {
    const ids = PAPER_SIZES.map((size) => size.id);
    expect(ids).toContain('A4-landscape');
    expect(ids).toContain('A4-portrait');
  });

  it('縮尺は小さい順に並び、等倍を含む(FR-703)', () => {
    expect(STANDARD_SCALES).toContain(1);
    expect([...STANDARD_SCALES].sort((a, b) => a - b)).toEqual([...STANDARD_SCALES]);
  });
});
