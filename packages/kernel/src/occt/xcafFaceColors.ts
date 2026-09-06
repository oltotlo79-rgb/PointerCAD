import type {
  OpenCascadeInstance,
  Quantity_Color,
  TopoDS_Shape,
  XCAFDoc_ColorTool,
} from 'opencascade.js/dist/opencascade.full.js';

import type { Allocations } from './allocations.js';
import { INVALID_EXPORT_COLOR_MESSAGE } from './exchangeShared.js';
import { faceAt } from './subShapes.js';
import type { ColorEnums, RgbTuple } from './xcafDocument.js';

/**
 * 面ごとの色(計画書 P6 §2.5.1、タスク7b・13b。FR-803 / FR-1106 / 要件§12)。
 *
 * 立体まるごとの色は `xcafDocument.ts` が付ける。ここが受け持つのは
 * **「面の通し番号 → 色」の表を XCAF の文書へ載せる**ことだけで、
 * STEP(`writeStep.ts`)と OBJ / glTF(`writeCafMesh.ts`)の両方がこの表を使う。
 *
 * ---
 *
 * ## 実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-29)
 *
 * **① `XCAFDoc_ColorTool.SetColor_5` の第 1 引数へ面(`TopoDS_Face`)を直接渡すと色が付く。**
 * 20³ の箱を `AddShape(shape, false, true)`(下ごしらえ true)で載せてから、`faceAt` で
 * 引いた面をそのまま `SetColor_5(face, color, XCAFDoc_ColorSurf)` へ渡したところ **true**
 * が返り、書いた STEP に面ぶんの `STYLED_ITEM` が出た。**`XCAFDoc_ShapeTool.AddSubShape_1`
 * を経由する必要は無い**(実行時に存在することも確かめたが、同じ結果になるだけで
 * 手数が増える。下の表を参照)。
 *
 * | 立体の色 | 面の色 | `STYLED_ITEM` | `COLOUR_RGB` | 色ラベル | 経路 |
 * |---|---|---|---|---|---|
 * | あり | 1 面 | 2 | 2 | 2 | 面へ直接 |
 * | あり | 1 面 | 2 | 2 | 2 | `AddSubShape_1` + `SetColor_1` |
 * | あり | 6 面すべて別色 | 7 | 7 | 7 | 面へ直接 |
 * | あり | 6 面すべて別色 | 7 | 7 | 7 | `AddSubShape_1` + `SetColor_1` |
 * | あり | 6 面・うち 3 面が同色(別色 3) | 7 | 5 | 5 | 面へ直接 |
 * | なし | 1 面 | 1 | 1 | 1 | 面へ直接 |
 *
 * **`STYLED_ITEM` の行数の意味は「色を割り当てた相手の数」**(立体 1 つ + 色を付けた面の枚数)
 * であって色の種類の数ではない。同じ色を 3 面へ付けても `STYLED_ITEM` は 3 行のままで、
 * **`COLOUR_RGB` と色ラベルのほうが 1 つに束ねられる**(6 面のうち 3 面が同色なら、
 * 色は 立体 1 + 面 4 種 = 5)。`writeStep.ts` の既存の検査(箱 10 個が同じ色 →
 * `COLOUR_RGB` 1・`STYLED_ITEM` 10)と同じ性質である。
 *
 * **② 同じ色をまとめるのは XCAF 側が勝手にやる。** 上の 5 行目のとおり、同じ値の
 * `Quantity_Color` を別々に作って渡しても色ラベルは 1 つになる。したがって
 * `FindColor_3` / `AddColor_1` で自分で束ねる必要は無い。
 *
 * **③ それでも自前の `Map` で色を使い回す理由(手順 4 の実測、2000 回あたり):**
 *
 * | 呼び出し | 所要 | 1 回あたり |
 * |---|---|---|
 * | `new Quantity_Color_3(...)` + `delete()` | 17.5 ms | 8.8 µs |
 * | `FindColor_3(color)`(+ 戻りのラベルの解放) | 22.9 ms | 11.5 µs |
 * | `SetColor_5(face, color, type)` | 45.8 ms | 22.9 µs |
 * | `faceAt(oc, shape, i)` | 240.7 ms | 120 µs |
 *
 * **`FindColor_3` は色を作るより高くつく**うえ、探すのに `Quantity_Color` を 1 つ作って
 * 渡さねばならない(探索で色の生成を省けない)。だから**色の値を鍵にした自前の `Map`**
 * で `Quantity_Color` を色の種類ぶんだけ作って使い回す。同じ色の面が多いほど確保が減る。
 *
 * **④ 主費用は `faceAt`(120 µs)である。** `faceAt` は呼ぶたびに `TopExp.MapShapes_2` で
 * 部分形状の表を作り直すので、色を付ける面の枚数に対しておおむね二乗で効く。それでも
 * ここで使っているのは、**面の通し番号の並びの正本を 1 か所(`subShapes.ts`)に保つ**ため
 * ——同じ並びを書き写すと、選択(P3)と書き出しで面の番号がずれる。数百面へ色を付ける
 * 場面が実際に出たら、`subShapes.ts` の側に「面をまとめて引く口」を足して差し替える。
 *
 * **⑤ 解放(rules/06 10.13)。** `faceAt` の戻りと `Quantity_Color_3` は**呼び出した側が
 * 解放する**ので、どちらも渡された控え(`Allocations`)へ積む。`colorTool` は
 * `Handle.get()` の借り物なので触らない。
 */

/** 面ごとの色の表: **面の通し番号**(`collectSubShapes` / `faceAt` と同じ並び)→ sRGB の 0〜1。 */
export type FaceColorMap = ReadonlyMap<number, RgbTuple>;

/**
 * 色を付ける面が見つからないとき(通し番号が範囲の外・負・整数でない)の断り(NFR-RE-1)。
 *
 * **落とさずに日本語の理由で断る。** 面の割り当ては P5 の指紋の照合から来るので、
 * 形が変わって面の枚数が減れば範囲の外を指しうる(P5 §0.a-0.62・0.63)。
 * ただし `faceIndex: null`(選び直せなかった面)は表に載らない約束(§2.5.1)なので、
 * ここへ来るのは呼び出し側の取り違えである。
 */
export function faceColorNotFoundMessage(faceIndex: number): string {
  return `色を付ける面が見つかりません(面の番号 ${String(faceIndex)})。`;
}

/**
 * 色の 3 つの値が 0〜1 の有限の数であることを確かめる。違えば日本語の理由で断る。
 *
 * **書き出しの色の検査はここが正本。** `xcafDocument.ts`(STEP)と `writeCafMesh.ts`
 * (OBJ / glTF)が同じ判定をしていたので、文言(`exchangeShared.ts` の
 * `INVALID_EXPORT_COLOR_MESSAGE`)だけでなく判定そのものもここへ寄せた。
 * この関数は OCCT を呼ばない素の JavaScript なので、純関数の側からも輸入できる。
 */
export function checkExportColor(color: RgbTuple): void {
  for (const value of color) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(INVALID_EXPORT_COLOR_MESSAGE);
    }
  }
}

/**
 * 面ごとの色の表を、形へ触れる前に確かめる(番号は 0 以上の整数、色は 0〜1)。
 *
 * **範囲の外かどうかはここでは分からない**(面の枚数は形を見ないと決まらない)。
 * それは `applyFaceColors` / `writeCafMesh` が面を引いた時点で断る。
 */
export function checkFaceColors(faceColors: FaceColorMap): void {
  for (const [faceIndex, color] of faceColors) {
    if (!Number.isInteger(faceIndex) || faceIndex < 0) {
      throw new Error(faceColorNotFoundMessage(faceIndex));
    }
    checkExportColor(color);
  }
}

/**
 * 色の値を鍵にする文字列(同じ色を 1 つにまとめるため)。
 *
 * `Map` の鍵に配列は使えない(同じ中身でも別物として扱われる)ので文字列にする。
 * 区切りを入れるのは `[0.1, 0.23]` と `[0.12, 0.3]` を取り違えないため。
 */
export function exportColorKey(color: RgbTuple): string {
  return `${String(color[0])}/${String(color[1])}/${String(color[2])}`;
}

/**
 * 面ごとの色を XCAF の文書へ載せる(§2.5.1)。
 *
 * `shape` は既に `XCAFDoc_ShapeTool.AddShape(shape, false, true)` で文書へ載っていること。
 * **下ごしらえ(第 3 引数 true)が部分形状の登録を済ませているので、面のラベルを
 * 自分で作る必要は無い**(冒頭の実測 ①)。
 *
 * ```ts
 * const applied = applyFaceColors(oc, colorTool, shape, new Map([[0, [0.8, 0.27, 0.27]]]), palette, keep);
 * ```
 *
 * @returns 実際に色が付いた面の枚数(`SetColor_5` が true を返した数)。
 */
export function applyFaceColors(
  oc: OpenCascadeInstance,
  colorTool: XCAFDoc_ColorTool,
  shape: TopoDS_Shape,
  faceColors: FaceColorMap,
  palette: ColorEnums,
  keep: Allocations['keep'],
): number {
  // 形へ触れる前に表そのものを確かめる(途中まで色を付けてから断るのを避ける)。
  checkFaceColors(faceColors);

  // **面の通し番号の昇順**にたどる。`Map` の並び(入れた順)に結果を左右させないため
  // ——同じ表からは必ず同じ文書ができる(§0.a-0.62 の決定性)。
  const faceIndices = [...faceColors.keys()].sort((left, right) => left - right);
  const colorCache = new Map<string, Quantity_Color>();
  let applied = 0;

  for (const faceIndex of faceIndices) {
    const rgb = faceColors.get(faceIndex);
    if (rgb === undefined) {
      continue;
    }
    const face = faceAt(oc, shape, faceIndex);
    if (face === null) {
      throw new Error(faceColorNotFoundMessage(faceIndex));
    }
    keep(face);

    const key = exportColorKey(rgb);
    let color = colorCache.get(key);
    if (color === undefined) {
      // 同じ色は 1 つの `Quantity_Color` を使い回す(冒頭の実測 ③)。
      color = keep(new oc.Quantity_Color_3(rgb[0], rgb[1], rgb[2], palette.typeOfColor));
      colorCache.set(key, color);
    }
    if (colorTool.SetColor_5(face, color, palette.colorType)) {
      applied += 1;
    }
  }

  return applied;
}
