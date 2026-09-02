import { describe, expect, it } from 'vitest';

import { createBoxPartDocument, DEFAULT_BOX_SIZE } from './createBoxPartDocument.js';

describe('直方体1個の部品ドキュメント', () => {
  it('既定寸法は 40 x 60 x 20 mm', () => {
    expect(DEFAULT_BOX_SIZE).toEqual({ dx: 40, dy: 60, dz: 20 });
  });

  it('フィーチャーを1件だけ持つ', () => {
    const document = createBoxPartDocument();
    expect(document.features).toHaveLength(1);
    expect(document.features[0]?.kind).toBe('box');
    expect(document.features[0]?.name).toBe('直方体1');
  });

  it('寸法を指定するとフィーチャーへ反映される', () => {
    const document = createBoxPartDocument({ dx: 1, dy: 2, dz: 3 });
    expect(document.features[0]).toMatchObject({ dx: 1, dy: 2, dz: 3 });
  });
});
