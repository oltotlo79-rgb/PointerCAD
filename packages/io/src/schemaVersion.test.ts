import { describe, expect, it } from 'vitest';

import { canRoundTrip, EXPORT_FORMATS, IMPORT_FORMATS, PCAD_SCHEMA_VERSION } from './index.js';

describe('入出力の骨組み', () => {
  // P0 は 1 を置いていたが、版 1 で保存されたファイルは 1 つも無い(保存機能が無かった)。
  // P2 で書式が確定したので 2 から始める(§0.a-0.3 の統括承認)。期待値の緩和ではない。
  it('.pcad のスキーマバージョンは 2 である(要件§8、§0.a-0.3)', () => {
    expect(PCAD_SCHEMA_VERSION).toBe(2);
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
