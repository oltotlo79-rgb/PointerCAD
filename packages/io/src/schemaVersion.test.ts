import { describe, expect, it } from 'vitest';
import { ASSEMBLY_SCHEMA_VERSION, DRAWING_SCHEMA_VERSION, PART_SCHEMA_VERSION } from '@pointercad/model';

import { canRoundTrip, EXPORT_FORMATS, IMPORT_FORMATS, PCAD_SCHEMA_VERSION } from './index.js';

describe('入出力の骨組み', () => {
  // P0 は 1 を置いていたが、版 1 で保存されたファイルは 1 つも無い(保存機能が無かった)。
  // P2 で書式が確定して 2 になり、P3 が加工フィーチャー・ばねの種類を足して 3 になり
  // (§0.a-0.22 の統括承認)、P4 タスク31が construction・点列の layout・references の
  // 3件を「版3以前だけの寛容な読み」から「版4の必須欄」へ切り出して 4 になり(§0.a-0.24)、
  // P4b タスク21がパラメータ表(`parameters`)を版5の必須欄として足して 5 になり
  // (§0.a-0.17)、P5 タスク5が外観の割り当て(`appearance`)を版6の必須欄として足して
  // 6 になった(§0.a-0.15。計画書は「版5」と書いているが、P4b が先に版5を使ったため
  // 統括の決定によりこの節は版6に読み替える)。P6 タスク21 が読み込んだ形のベースボディ
  // (`importedSolid` / `importedMesh`)・選択セット・下絵と、ZIP の添付のエントリ
  // (`shapes/*.brep` / `meshes/*.bin` / `canvases/*.png`)をまとめて足して 7 になった
  // (§0.a-0.55)。P7 タスク3 が封筒の新しい種別 `assembly`(アセンブリ文書、`.pcada`)を
  // 足して 8 になり、P8の図面種別を足して9になった(部品・アセンブリ・図面で版を分けない)。
  // P8-60/62/64で名前付き視点と構成を必須欄にし、旧版を移行して10になった。
  // P9で製作指示の配列を加えて11、P10で板金の展開条件を加えて12になった。
  // P11bでロフトの平滑化を必須欄にし、版12以前だけfalseを補って13になった。
  it(
    '.pcad のスキーマバージョンは 13 で、全部の文書種別が同じ系列である' +
      '(要件§8、§0.a-0.22、§0.a-0.24、§0.a-0.17、§0.a-0.15、§0.a-0.55、P7 §0.a-0.2)',
    () => {
      expect(PCAD_SCHEMA_VERSION).toBe(13);
      expect(PART_SCHEMA_VERSION).toBe(PCAD_SCHEMA_VERSION);
      expect(ASSEMBLY_SCHEMA_VERSION).toBe(PCAD_SCHEMA_VERSION);
      expect(DRAWING_SCHEMA_VERSION).toBe(PCAD_SCHEMA_VERSION);
    },
  );

  it('書き出しは STEP / STL / 3MF / OBJ / glTF に対応する(FR-803)', () => {
    expect([...EXPORT_FORMATS]).toEqual(['step', 'stl', '3mf', 'obj', 'glb']);
  });

  it('読み込める形式はすべて書き出しもできる', () => {
    for (const format of IMPORT_FORMATS) {
      expect(canRoundTrip(format), format).toBe(true);
    }
  });
});
