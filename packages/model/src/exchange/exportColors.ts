/**
 * 外観の割り当て → 書き出しの色の写し(FR-1106、要件§12、計画書
 * docs/plans/P6-入出力.md §2.5・§2.5.1、§0.a-0.22、タスク15)。
 *
 * **色だけを写す。** 柄・透過率・光沢・粗さは書き出さない(§0.a-0.22 の決定)。
 * 柄(FR-1108)は Canvas 2D で描く繰り返し模様で画像にしないと他の形式へ渡せず、
 * 透過率・光沢・粗さは形式ごとに単位が違って 4 形式で意味の合う変換表を作れないため。
 * 柄を割り当てた面は**地の色だけ**が書かれる——地の色は `AppearanceSpec.color`
 * そのもの(`materialPresets.ts` の木材は `WoodSpeciesInfo.baseColor` を `color` に入れる)
 * なので、ここに柄を見る分岐は要らない。
 *
 * **色は sRGB の 0〜1** で返す(`#rrggbb` を 255 で割った値)。glTF の `baseColorFactor`
 * が要る線形への変換は kernel が行う(`docs/報告記録.md` 2026-09-06 06:53。model は
 * sRGB のまま渡す。P5 §6.10-10「`AppearanceSpec` と glTF の PBR の単位が違う」の対策で、
 * 変換の式を 2 か所に持たない)。
 *
 * **面の通し番号は照合し直さない。** 指紋(`SubShapeRef`)から面の通し番号を選び直す
 * 採点はカーネルにしか無い(P5 §0.a-0.2)ので、再計算のたびに返っている
 * `appearanceMatches`(`AppearanceMatchEntry`)の `faceIndex` をそのまま使う。
 *
 * ここに置くのは**純関数だけ**で、カーネルは呼ばない(rules/04-設計の規律.md の依存方向)。
 */

import { bodyAppearanceOf } from '../appearance/appearanceTable.js';
import { appearanceOf } from '../appearance/documentAppearance.js';
import { DEFAULT_APPEARANCE } from '../appearance/materialPresets.js';
import type { AppearanceMatchEntry } from '../kernelBridge.js';
import type { PartDocument } from '../part/types.js';

/**
 * 色 1 つ(sRGB の 0〜1)。
 *
 * kernel の `RgbTuple` / io の `ThreeMfColor` は同じ値を 3 要素の組で持つが、model の
 * 表は「どの成分か」を取り違えないよう名前つきにしてある。**配線(タスク16)は
 * `rgbTupleOf` で組に直して `ShapeExportItem.color` へ渡す**(換算を配線側に書かない)。
 */
export interface RgbColor {
  /** 赤 0〜1。 */
  readonly r: number;
  /** 緑 0〜1。 */
  readonly g: number;
  /** 青 0〜1。 */
  readonly b: number;
}

/** `#rrggbb` の形(大文字小文字の両方)。**3 桁の短縮形は受けない。** */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * `#rrggbb` を sRGB の 0〜1 へ解く(§2.5)。**大文字小文字の両方を受ける。**
 *
 * **3 桁の短縮形(`#abc`)は受けない。** P5 の外観はどこで作っても `#rrggbb` の 6 桁で
 * 保存している(`materialPresets.ts` の表、ui の色選び)ので、短縮形が来たら
 * 「壊れた値」であり、既定の色へ落とすほうが誤った色で書き出すより安全である。
 *
 * 解けないときは**例外を投げず `null` を返す**(NFR-RE-1)。呼び手が既定の色にする。
 */
export function parseHexColor(text: string): RgbColor | null {
  if (!HEX_COLOR_PATTERN.test(text)) {
    return null;
  }
  return {
    r: Number.parseInt(text.slice(1, 3), 16) / 255,
    g: Number.parseInt(text.slice(3, 5), 16) / 255,
    b: Number.parseInt(text.slice(5, 7), 16) / 255,
  };
}

/**
 * 色を割り当てていない立体・面の色(§2.5「割り当てが無い立体・面は既定の外観の色」)。
 *
 * **正本は `DEFAULT_APPEARANCE.color`(`'#b8bfcc'`)** で、ここはそれを解いた値である。
 * `??` の右は `parseHexColor` の戻りから `null` を外すためだけのもので、正本と同じ
 * `184/255`・`191/255`・`204/255` を書いてある(正本が 6 桁の 16 進でなくなる日が来たら
 * 検査が落ちて気づく——`exportColors.test.ts` が両者を突き合わせている)。
 */
export const DEFAULT_EXPORT_COLOR: RgbColor = parseHexColor(DEFAULT_APPEARANCE.color) ?? {
  r: 184 / 255,
  g: 191 / 255,
  b: 204 / 255,
};

/**
 * 色を kernel / io が受ける 3 要素の組へ直す(`ShapeExportItem.color`、`ThreeMfColor`)。
 * 並びは r・g・b の順。**この並べ替えを配線ごとに書かない**ためにここに置く。
 */
export function rgbTupleOf(color: RgbColor): readonly [number, number, number] {
  return [color.r, color.g, color.b];
}

/**
 * 立体ごとの色(FR-1106、§2.5)。渡した `bodyIds` すべてに**必ず 1 つ**色が入る
 * (割り当てが無ければ既定の色)ので、配線は引き当てが空になる場合を考えなくてよい。
 *
 * 面への割り当ては見ない(それは `faceColorsFor`)。**面の割り当てが立体より優先する**
 * という P5 の順(`documentAppearance.ts` の `resolveAppearanceFor`)は、配線が
 * 「面の表を先に見て、無ければ立体の表」と読むことで成り立つ。ここで先に混ぜてしまうと、
 * 立体の色(XCAF の形そのものへの色)と面の色(面のラベルへの色)を別々に書く
 * §2.5.1 の書き出しに渡せなくなる。
 *
 * 色の文字列が壊れていても例外は投げず、既定の色へ落とす(NFR-RE-1)。
 */
export function bodyColorsFor(
  document: PartDocument,
  bodyIds: readonly string[],
): ReadonlyMap<string, RgbColor> {
  const table = appearanceOf(document);
  const colors = new Map<string, RgbColor>();
  for (const bodyId of bodyIds) {
    const spec = bodyAppearanceOf(table, bodyId);
    const color = spec === null ? null : parseHexColor(spec.color);
    colors.set(bodyId, color ?? DEFAULT_EXPORT_COLOR);
  }
  return colors;
}

/**
 * 面ごとの色(FR-1106、§2.5.1)。ボディの id → 面の通し番号 → 色。
 *
 * **面の割り当てだけ**が入る。色を付けた面が 1 枚も無いボディは表に現れない
 * (空の表を作らない)ので、配線は「面の表を引いて、無ければ立体の色」と読める。
 *
 * `matches` は P5 が再計算のたびに返している照合の結果(`PartRecomputeResult.appearanceMatches`)
 * をそのまま渡す。**`faceIndex` が `null`(選び直せなかった面)は入れない**(§2.5.1)。
 * 割り当て自体は文書に残っており、形を戻せば復活する——ここで表に入れないのは
 * 「今回の書き出しでは既定の色になる」という意味だけである。
 *
 * `bodyIds` に無いボディの照合結果は落とす(書き出す立体だけの表にする)。
 */
export function faceColorsFor(
  document: PartDocument,
  bodyIds: readonly string[],
  matches: readonly AppearanceMatchEntry[],
): ReadonlyMap<string, ReadonlyMap<number, RgbColor>> {
  const table = appearanceOf(document);
  const exported = new Set(bodyIds);
  const byBody = new Map<string, Map<number, RgbColor>>();
  for (const match of matches) {
    if (match.faceIndex === null || !exported.has(match.bodyFeatureId)) {
      continue;
    }
    const entry = table.entries.find((candidate) => candidate.id === match.id);
    // 立体への割り当ては照合に出さない決め(`kernelBridge.ts`)なので普通は起きないが、
    // 古い結果を渡されても面以外を混ぜないようにここでも種類を確かめる。
    if (entry === undefined || entry.target.kind !== 'face') {
      continue;
    }
    const color = parseHexColor(entry.appearance.color);
    if (color === null) {
      // 壊れた色は「その面の指定が無かった」ことにする(立体の色、無ければ既定へ落ちる)。
      continue;
    }
    const faces = byBody.get(match.bodyFeatureId) ?? new Map<number, RgbColor>();
    faces.set(match.faceIndex, color);
    byBody.set(match.bodyFeatureId, faces);
  }
  return byBody;
}
