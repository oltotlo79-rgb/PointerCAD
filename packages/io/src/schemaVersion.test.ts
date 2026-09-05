import { describe, expect, it } from 'vitest';

import { canRoundTrip, EXPORT_FORMATS, IMPORT_FORMATS, PCAD_SCHEMA_VERSION } from './index.js';

describe('入出力の骨組み', () => {
  // P0 は 1 を置いていたが、版 1 で保存されたファイルは 1 つも無い(保存機能が無かった)。
  // P2 で書式が確定して 2 になり、P3 が加工フィーチャー・ばねの種類を足して 3 になり
  // (§0.a-0.22 の統括承認)、P4 タスク31が construction・点列の layout・references の
  // 3件を「版3以前だけの寛容な読み」から「版4の必須欄」へ切り出して 4 になり(§0.a-0.24)、
  // P4b タスク21がパラメータ表(`parameters`)を版5の必須欄として足して 5 になり
  // (§0.a-0.17)、P5 タスク5が外観の割り当て(`appearance`)を版6の必須欄として足して
  // 6 になった(§0.a-0.15。計画書は「版5」と書いているが、P4b が先に版5を使ったため
  // 統括の決定によりこの節は版6に読み替える)。これは仕様変更であり、期待値の緩和ではない。
  it('.pcad のスキーマバージョンは 6 である(要件§8、§0.a-0.22、§0.a-0.24、§0.a-0.17、§0.a-0.15)', () => {
    expect(PCAD_SCHEMA_VERSION).toBe(6);
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
