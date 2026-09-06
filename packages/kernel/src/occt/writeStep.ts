import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from './allocations.js';
import { withVirtualFile } from './virtualFile.js';
import type { XcafShapeEntry } from './xcafDocument.js';
import { buildXcafDocument } from './xcafDocument.js';

/**
 * STEP の書き出し(計画書 P6 §2.3、タスク7。FR-803 / FR-804 / FR-1106)。
 *
 * **`STEPCAFControl_Writer` を使う**(§0.a-0.8)。素の `STEPControl_Writer` は
 * `Transfer` が列挙(`STEPControl_StepModelType`)を取るのに対し、
 * `Perform_2(doc, filename, range)` は**列挙を 1 つも取らない**うえ、
 * 名前と色も一緒に書ける。
 *
 * ---
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-3、-4):**
 * 20³ の箱 1 つ(名前と色つき)を書いた結果は 15,775 バイト・426 行で、
 *
 * ```
 * 1: ISO-10303-21;
 * 2: HEADER;
 * 3: FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');
 * 4: FILE_NAME('Open CASCADE Shape Model','2026-09-06T02:16:11',('Author'),(
 * 5:     'Open CASCADE'),'Open CASCADE STEP processor 7.6','Open CASCADE 7.6'
 * 6:   ,'Unknown');
 * 7: FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
 * 8: ENDSEC;
 * 9: DATA;
 * ...
 * 424: ENDSEC;
 * 425: END-ISO-10303-21;
 * ```
 *
 * - **書き出しは AP214**(`AUTOMOTIVE_DESIGN`)。§1.5-3 の「AP214 でなければ `Writer()` 経由で
 *   素の書き手を触る必要がある」という条件には**当たらない**ので、既定のまま使う。
 * - **時刻が入るのは 4 行目だけ**(§1.5-4)。決定性の比較(§0.a-0.62)はこの 1 行を除いて行う。
 *   なお同じ秒のうちに 2 回書けば 4 行目も一致する(実測で違う行は 0 行だった)。
 * - 名前は `#7 = PRODUCT('本体','本体','',(#8));` の形で入り、**日本語もそのまま**出る。
 *   名前を渡さなければ OCCT が `SOLID` と書く。
 * - 色は `#359 = COLOUR_RGB('',…);` と `STYLED_ITEM` の組で入る。色を渡さなければ
 *   どちらも 0 行になる。**`Quantity_TOC_sRGB` で渡した値がそのまま `COLOUR_RGB` に出る**
 *   (`xcafDocument.ts` の `resolveColorEnums` の注釈に根拠を書いた)。
 *   ただし**純色(赤など)は `DRAUGHTING_PRE_DEFINED_COLOUR('red')` になり `COLOUR_RGB` は出ない。**
 * - **立体が 1 つも無いと `Perform_2` は true を返すのにファイルを 1 つも作らない。**
 *   だから `buildXcafDocument` が先に断る(「書き出せる立体がありません。」)。
 * - 所要は 20³ の箱 1 つで約 100ms、箱 10 個で **494ms**(§2.17-1 の上限 5 秒に対して十分速い)。
 */

/**
 * STEP へ書き出す立体 1 つぶん(組み立ての依頼と同じ形)。
 *
 * **面ごとの色(タスク7b)もここを通る。** `XcafShapeEntry` に省略できる `faceColors`
 * (面の通し番号 → 色)が入っており、この別名がそのまま同じ形なので、
 * `writeStep` の側には 1 行の分岐も要らない(`buildXcafDocument` が
 * `xcafFaceColors.ts` の `applyFaceColors` を呼ぶ)。
 *
 * ```ts
 * writeStep(oc, [{ shape, name: '本体', color: null, faceColors: new Map([[0, [0.8, 0.27, 0.27]]]) }]);
 * ```
 *
 * **実測(2026-09-06、タスク7b):** 20³ の箱の 1 面だけを `#cc4444` にすると
 * `STYLED_ITEM` が 1 行・`COLOUR_RGB` が 1 行(立体の色も付ければどちらも 2)。
 * `STYLED_ITEM` は**色を割り当てた相手の数**、`COLOUR_RGB` は**色の種類の数**で、
 * 同じ色を何面へ付けても色は 1 つに束ねられる(`xcafFaceColors.ts` の実測の表)。
 */
export type StepWriteEntry = XcafShapeEntry;

/** 書き出しの細かい指定。 */
export interface StepWriteOptions {
  /** 色を書くか(既定 true。書き出しの画面から外せる。§0.a-0.22)。 */
  readonly withColors?: boolean;
}

/** 書き出しの結果。 */
export interface StepWriteResult {
  /** STEP ファイルの中身。 */
  readonly bytes: Uint8Array;
  /** 色を 1 つでも載せられたか。列挙が取れない環境では false になる(形は書けている)。 */
  readonly colorWritten: boolean;
}

/** OCCT が「書けなかった」と答えたとき(NFR-RE-1、FR-504)。 */
const WRITE_FAILED_MESSAGE = 'STEP ファイルを書き出せませんでした。';

/**
 * 立体の一覧を STEP のバイト列にする(§2.3)。
 *
 * ```ts
 * const { bytes } = writeStep(oc, [{ shape, name: '本体', color: [0.72, 0.75, 0.8] }]);
 * ```
 *
 * 立体が 1 つも無いときと、OCCT が書けなかったときは**日本語の理由**で断る。
 * 仮想ファイルは `withVirtualFile` が必ず片付ける(§2.2)。
 */
export function writeStep(
  oc: OpenCascadeInstance,
  entries: readonly StepWriteEntry[],
  options: StepWriteOptions = {},
): StepWriteResult {
  const withColors = options.withColors ?? true;
  const document = buildXcafDocument(oc, entries, { withColors });
  try {
    const { keep, release } = createAllocations();
    try {
      const writer = keep(new oc.STEPCAFControl_Writer_1());
      writer.SetColorMode(withColors);
      writer.SetNameMode(true);
      const range = keep(new oc.Message_ProgressRange_1());
      const files = withVirtualFile(oc, 'step', (path) => {
        // Perform_2 は成否を真偽で返す(例外を投げない)。false を黙って通すと
        // 中身の無いファイルを保存させてしまうので、ここで理由に変える。
        if (!writer.Perform_2(document.handle, path, range)) {
          throw new Error(WRITE_FAILED_MESSAGE);
        }
      });
      return { bytes: files[0].bytes, colorWritten: document.colorWritten };
    } finally {
      release();
    }
  } finally {
    document.delete();
  }
}
