import { describe, expect, it } from 'vitest';

import { DEFAULT_PAPER_SIZE_ID, PAPER_SIZES, paperSizeOf } from './paperSize.js';

describe('図面の用紙', () => {
  it('A0〜A4の縦横を10件持つ', () => {
    expect(PAPER_SIZES).toHaveLength(10);
    expect(new Set(PAPER_SIZES.map((paper) => paper.id))).toHaveLength(10);
  });

  it.each([
    ['A0-landscape', 1189, 841],
    ['A0-portrait', 841, 1189],
    ['A1-landscape', 841, 594],
    ['A1-portrait', 594, 841],
    ['A2-landscape', 594, 420],
    ['A2-portrait', 420, 594],
    ['A3-landscape', 420, 297],
    ['A3-portrait', 297, 420],
    ['A4-landscape', 297, 210],
    ['A4-portrait', 210, 297],
  ] as const)('%s は %d × %d mm', (id, width, height) => {
    expect(paperSizeOf(id)).toMatchObject({ width, height });
  });

  it('既定の用紙は既存どおりA3横である', () => {
    expect(DEFAULT_PAPER_SIZE_ID).toBe('A3-landscape');
  });

  it('A0の面積は1平方メートルに近い', () => {
    expect(841 * 1189).toBe(999_949);
  });

  it('知らない用紙はundefinedを返す', () => {
    expect(paperSizeOf('B4-landscape')).toBeUndefined();
  });
});
