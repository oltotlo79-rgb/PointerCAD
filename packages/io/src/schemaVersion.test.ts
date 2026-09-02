import { describe, expect, it } from 'vitest';

import { canRoundTrip, EXPORT_FORMATS, IMPORT_FORMATS, PCAD_SCHEMA_VERSION } from './index.js';

describe('入出力の骨組み', () => {
  it('.pcad のスキーマバージョンは 1 である(要件§8)', () => {
    expect(PCAD_SCHEMA_VERSION).toBe(1);
  });

  it('書き出しは STEP / STL / 3MF / OBJ / glTF に対応する(FR-803)', () => {
    expect([...EXPORT_FORMATS]).toEqual(['step', 'stl', '3mf', 'obj', 'glb']);
  });

  it('読み込める形式はすべて書き出しもできる', () => {
    for (const format of IMPORT_FORMATS) {
      expect(canRoundTrip(format), format).toBe(true);
    }
  });
});
