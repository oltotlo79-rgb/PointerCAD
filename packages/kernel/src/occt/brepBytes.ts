import type {
  Message_ProgressRange,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from './allocations.js';
import { withVirtualFile, withVirtualFileInput } from './virtualFile.js';

/**
 * 形(B-rep)とバイト列の相互変換(計画書 P6 §0.a-0.9・§0.a-0.10、タスク9。FR-802 / FR-801)。
 *
 * 読み込んだ形(STEP から取り込んだ部品)は**再計算で導出できない**ので、`.pcad` の中へ
 * バイト列のまま抱き込む(§0.a-0.9 の利用者承認。`rules/04-設計の規律.md` の
 * 「導出できるものは保存しない」への唯一の例外で、**導出できないもの**だから趣旨に反しない)。
 * このファイルはその「形 ↔ バイト列」の 1 段だけを受け持つ。`.pcad` の封筒(ZIP の
 * `shapes/<id>.brep` エントリ)へ入れるのは io 側(タスク20・21)。
 *
 * ---
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-8):**
 *
 * - **`BinTools` は実行時に存在する**(`.test.ts` の 1 件目が毎回確かめる)。
 *   `Write_1`〜`Write_4` / `Read_1` / `Read_2` の 6 つとも関数として束縛されている。
 *   `BRepTools`(文字列の形式)も同じ 6 つが揃っており、後退先としても使えた。
 * - **採ったのは `BinTools.Write_3(shape, file, range): boolean` と
 *   `BinTools.Read_2(shape, file, range): boolean`**(§0.a-0.10 の第一候補)。
 *   選んだ理由は 3 つ。
 *   ① **ファイル名を取る版**なので `oc.FS`(仮想ファイル)経由でバイト列にできる。
 *      `Write_1` / `Read_1` は `Standard_OStream` / `Standard_IStream` を取るが、
 *      JS からその実体を作れない(計画書 §1.4-2)。
 *   ② **列挙(`enum`)を 1 つも取らない。** `Write_4` は `BinTools_FormatVersion` を
 *      取るため述語ガードが 1 つ要る(P6 の上限 6 のうち 5 使用済み)。`Write_3` なら要らない。
 *   ③ **数値をそのまま(2 進で)持つので往復で丸めが起きない。** 文字列の `BRepTools` は
 *      桁を十進へ直して書くため、往復のたびに最後の桁が動く危険がある。
 * - **大きさの比較(20³ の箱、三角形分割なし):** `BinTools` = **4,494 バイト**、
 *   `BRepTools` = 2,565 バイト。**文字列のほうが小さかった**(計画書 §0.10 の「バイナリの
 *   ほうが小さい」という見込みとは逆。数値 1 個が 2 進では常に 8 バイト、十進では
 *   `0`・`20` のような短い桁だと 1〜2 バイトで済むため)。ただし `.pcad` は ZIP なので
 *   deflate 後は **694 バイト対 599 バイト**まで差が縮む。上の理由③(丸めが起きない)を
 *   優先して `BinTools` を採る。
 * - **半径 10 の球は 939 バイト。** B-rep は厳密な球面を 1 枚の面として持つので、
 *   三角形に分けた場合(数万バイト)とは桁が違う。
 * - **同じ形から 2 回書くとバイト列が完全に一致する**(§0.a-0.62 の決定性)。
 *   時刻や連番のような、書くたびに変わるものは入らない。
 * - **往復して読み直した形をもう一度書くと、20³ の箱で 6 バイトだけ値が変わる**
 *   (長さは 4,494 のまま。読み込みが辺の向きや「同じ媒介変数」の印を整えるため)。
 *   **2 周目からは 1 バイトも動かない。** つまり `.pcad` を開いて保存し直すと 1 回だけ
 *   中身が変わり、それ以降は同じになる。形(体積・面・辺・頂点)は変わらない。
 * - **`Write_3` は三角形分割も一緒に書く**(OCCT 7.6 の既定。三角形あり・法線なし)。
 *   実測で、偏差 0.1 の三角形分割を掛けた 20³ の箱は 4,494 → **6,931 バイト**に増えた。
 *   外す版は `Write_4` だが列挙が要るので採らない(上の②)。**呼び出し側が三角形の
 *   付いていない形を渡せば増えない。**
 * - **壊れたバイト列と 0 バイトのファイルでは、`Read_2` が C++ の例外を投げる。**
 *   JS へは `Error` ではなく**数値**(WASM の中の番地。実測 18974056 など)として届き、
 *   `message` も `name` も持たない。標準エラーへ
 *   `BinTools_ShapeSet::Read: File was not written with this version of the topology`
 *   と出るだけなので、**受け取れる手掛かりは「失敗した」ことだけ**。だから握って
 *   日本語の理由に変える(NFR-RE-1。落とさない)。
 * - **ファイルが無いときだけは例外ではなく `false` が返る。** 戻り値も必ず見る。
 * - **中身の無い形(`IsNull()`)でも `Write_3` は成功し、154 バイトを書く。**
 *   読み直しても中身は無いので、書く前にこちらで断る。
 * - 所要は 20³ の箱で書き **約 1.0ms**、読み **約 1.4ms**(20 回の平均)。
 */

/** 中身の無い形を渡されたとき(FR-504、NFR-RE-1)。 */
export const BREP_EMPTY_SHAPE_MESSAGE = '保存できる形がありません。';

/** OCCT が「書けなかった」と答えたとき。 */
export const BREP_WRITE_FAILED_MESSAGE = 'この形を保存できませんでした。';

/** バイト列から形を組み立てられなかったとき(壊れている・空・別の形式)。 */
export const BREP_READ_FAILED_MESSAGE =
  '保存されていた形を読めませんでした。データが壊れているおそれがあります。';

/**
 * 仮想ファイルに付ける名前。
 *
 * `BinTools` は拡張子で形式を見分けないが、置き場の中身を人が見たときに
 * 何のファイルか分かるよう `.brep` を付ける(`.pcad` の中の `shapes/<id>.brep` と同じ)。
 */
const VIRTUAL_EXTENSION = 'brep';
const VIRTUAL_INPUT_NAME = `shape.${VIRTUAL_EXTENSION}`;

/**
 * 形をバイト列にする(§2.2 の書き出しと同じ流儀)。
 *
 * ```ts
 * const bytes = writeBrepBytes(oc, shape);   // .pcad の shapes/<id>.brep へ入れる
 * ```
 *
 * 渡された形は**読むだけ**で、三角形分割を掛け直したり中身を書き換えたりしない
 * (キャッシュに載っている形をそのまま渡してよい)。仮想ファイルは
 * `withVirtualFile` が必ず片付ける。
 */
export function writeBrepBytes(oc: OpenCascadeInstance, shape: TopoDS_Shape): Uint8Array {
  if (shape.IsNull()) {
    // 中身の無い形でも OCCT は 154 バイトを書いてしまう(実測)。
    // 空のまま保存すると開き直したときに部品が消えるので、ここで断る。
    throw new Error(BREP_EMPTY_SHAPE_MESSAGE);
  }
  const { keep, release } = createAllocations();
  try {
    const range = keep(new oc.Message_ProgressRange_1());
    const files = withVirtualFile(oc, VIRTUAL_EXTENSION, (path) => {
      // Write_3 は成否を真偽で返す(例外は投げない)。false を黙って通すと
      // 中身の無いファイルを保存させてしまうので、ここで理由に変える。
      if (!oc.BinTools.Write_3(shape, path, range)) {
        throw new Error(BREP_WRITE_FAILED_MESSAGE);
      }
    });
    return files[0].bytes;
  } finally {
    release();
  }
}

/**
 * OCCT に形を読ませて、成否だけを持ち帰る。
 *
 * `Read_2` は壊れたバイト列に対して**数値の C++ 例外**を投げ(実測)、
 * ファイルが無いときは `false` を返す。どちらも呼び出し側では「読めなかった」の
 * 一言に変わるので、ここで真偽へ揃える。例外の中身は番地の数値だけで
 * 手掛かりを含まないため、握りつぶしても失われる情報は無い。
 */
function readShapeInto(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  path: string,
  range: Message_ProgressRange,
): boolean {
  try {
    return oc.BinTools.Read_2(shape, path, range);
  } catch {
    return false;
  }
}

/**
 * バイト列から形を組み立てる(§2.2 の読み込みと同じ流儀)。
 *
 * ```ts
 * const shape = readBrepBytes(oc, bytes);
 * try {
 *   // 形を使う
 * } finally {
 *   shape.delete();
 * }
 * ```
 *
 * **返した形の持ち主は呼び手**で、使い終わったら `delete()` する。
 * `makeBox` などの `OcctShapeHandle`(形+解放手続き)の形にしていないのは、
 * ここで確保するものが**返す形 1 つだけ**で、一緒に解放する道具が無いため
 * (`Message_ProgressRange` はこの関数の中で閉じる)。
 *
 * 読めなかったとき(壊れている・0 バイト・別の形式)は**日本語の理由で断り**、
 * 途中まで作った形はその場で解放する(NFR-RE-1。アプリは落とさない)。
 */
export function readBrepBytes(oc: OpenCascadeInstance, bytes: Uint8Array): TopoDS_Shape {
  if (bytes.length === 0) {
    // 0 バイトのファイルは OCCT に渡すと例外になる。渡す前に同じ理由で断る。
    throw new Error(BREP_READ_FAILED_MESSAGE);
  }
  // 読み先の形は「成功したら呼び手のもの、失敗したらこの場で解放する」ので、
  // まとめて解放する控え(createAllocations)には積まない。
  const shape = new oc.TopoDS_Shape();
  try {
    const { keep, release } = createAllocations();
    let read = false;
    try {
      const range = keep(new oc.Message_ProgressRange_1());
      read = withVirtualFileInput(oc, VIRTUAL_INPUT_NAME, bytes, (path) =>
        readShapeInto(oc, shape, path, range),
      );
    } finally {
      release();
    }
    if (!read || shape.IsNull()) {
      throw new Error(BREP_READ_FAILED_MESSAGE);
    }
  } catch (error) {
    shape.delete();
    throw error;
  }
  return shape;
}
