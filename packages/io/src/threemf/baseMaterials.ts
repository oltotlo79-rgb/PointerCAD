/**
 * 3MF の面ごとの色を `<basematerials>` の並びへ組み替える(FR-803、FR-1106、要件§12、
 * 計画書 docs/plans/P6-入出力.md §2.6 の「面ごとの色」、タスク14b)。
 *
 * 3MF は「色の一覧(`<basematerials>`)」と「三角形ごとの添字(`<triangle p1=…>`)」で
 * 面ごとの色を表す。**その組み替えだけをここで行い、XML の文字列は作らない**
 * (作るのは `writeThreeMf.ts` の 1 か所。三角形の行を組む場所を 2 つに増やさないため)。
 *
 * **OCCT を呼ばない**(§0.a-0.19)。面ごとの三角形の範囲は引数で受け取る。`packages/io` は
 * `packages/kernel` へ依存できない(依存方向 `apps → ui → model → kernel`。
 * `rules/04-設計の規律.md`)ので、kernel の `tessellate.ts` の `FaceTriangleRange` と
 * **同じ形の型 `ThreeMfFaceRange`** をこちら側に置く(2026-09-06 に Read で確かめた実測の形は
 * `{ triangleOffset, triangleCount }` で、**面の通し番号は配列の位置そのもの**)。
 *
 * **決定的にする**(§0.a-0.62)。色の並びは `Map` の挿入順に頼らず、
 * **「最初にその色が現れた面の通し番号」の昇順**へ明示的に並べ替える。同じ文書からは
 * いつ書いても同じ `<base>` の並び・同じ `p1` になる(検査で固定してある)。
 */

/**
 * 色(sRGB の 0〜1 の r / g / b)。`#rrggbb` を 255 で割った値。
 *
 * kernel の `RgbTuple`(`occt/xcafDocument.ts`)と同じ形だが、io は kernel へ依存できない
 * のでこちらにも置く。`writeThreeMf.ts` からも同じ名前で輸出しているので、
 * 読み手はどちらから取り込んでも同じ型を指す。
 */
export type ThreeMfColor = readonly [number, number, number];

/**
 * 面 1 枚ぶんの三角形の範囲。kernel の `FaceTriangleRange`(`occt/tessellate.ts`)と同じ形。
 *
 * **面の通し番号は配列の位置**である(kernel は三角形分割が付かなかった面も
 * `triangleCount: 0` で必ず 1 つ積むので、位置と面の番号がずれない)。だから面の番号を
 * 欄として持たない——持つと 2 つの通し番号ができ、片方だけずれたときに気づけない。
 */
export interface ThreeMfFaceRange {
  /** この面の最初の三角形の通し番号(立体の中での通し)。 */
  readonly triangleOffset: number;
  /** この面の三角形の枚数。三角形分割が付かなかった面は 0。 */
  readonly triangleCount: number;
}

/** `buildBaseMaterials` の結果。 */
export interface ThreeMfBaseMaterials {
  /**
   * この立体の色の一覧。**先頭(添字 0)は必ず立体の色**で、そのあとに面の色が
   * 「最初に現れた面の通し番号」の昇順で並ぶ。重複は除いてある。
   */
  readonly colors: readonly ThreeMfColor[];
  /**
   * 三角形の通し番号 → `colors` の添字。**立体の色(添字 0)の三角形は入れない**
   * (`p1` を書かない三角形なので、持っても使わない)。
   *
   * 面の色が 1 つも効かなかったときは `null`。書く側はこのときタスク14 と同じ道を通り、
   * **面の色を渡さない書き出しは 1 バイトも変わらない**。
   */
  readonly triangleColors: ReadonlyMap<number, number> | null;
}

/**
 * 色を突き合わせる鍵。
 *
 * **丸めた `#rrggbb` ではなく元の数で見る。** 丸めで見ると、わずかに違う 2 色が同じ
 * `<base>` にまとめられ、色の表の中身が書き出しの丸め方に左右されてしまう。
 * 数で見ておけば、「同じ色を指した面は必ず同じ `<base>` を指す」とだけ言える。
 */
function colorKey(color: ThreeMfColor): string {
  return `${String(color[0])},${String(color[1])},${String(color[2])}`;
}

/** 面の範囲として使える値か(三角形が 1 枚も無い面と、壊れた値をここで落とす)。 */
function isUsableRange(range: ThreeMfFaceRange): boolean {
  return (
    Number.isInteger(range.triangleOffset) &&
    range.triangleOffset >= 0 &&
    Number.isInteger(range.triangleCount) &&
    range.triangleCount > 0
  );
}

/**
 * 立体の色と面ごとの色から、`<basematerials>` の並びと三角形ごとの添字を作る。
 *
 * `faceColors` は「面の通し番号 → 色」で、model の `faceColorsFor`(タスク15)が返す
 * 内側の表をそのまま渡せる。**面の色が立体の色より優先する**(§2.5.1)ので、表に載って
 * いる面はその色、載っていない面は立体の色になる——この「載っていない面は書かない」
 * という形が、そのまま `p1` を書かない三角形になる。
 *
 * **`faceRanges` に無い面の番号は黙って読み飛ばす**(警告を出さない)。面の色は文書側に
 * 残ったまま形だけが変わることがあり(P5 の指紋の選び直しが外れた面)、書き出しのたびに
 * 断りを出すと、直しようのない警告が毎回出てしまう。model の側で既に警告を出している。
 *
 * 色の値そのもの(0〜1 か)は確かめない。**断りは書く側の 1 か所**(`writeThreeMf.ts` の
 * `formatDisplayColor`)に置き、立体の色と面の色で断り方が違わないようにする。
 */
export function buildBaseMaterials(
  bodyColor: ThreeMfColor,
  faceColors?: ReadonlyMap<number, ThreeMfColor>,
  faceRanges?: readonly ThreeMfFaceRange[],
): ThreeMfBaseMaterials {
  if (faceColors === undefined || faceColors.size === 0 || faceRanges === undefined) {
    return { colors: [bodyColor], triangleColors: null };
  }

  const colors: ThreeMfColor[] = [bodyColor];
  // 立体の色を先に登録しておく。面の色が立体の色と同じなら添字 0 になり、`p1` が付かない。
  const slotOfColor = new Map<string, number>([[colorKey(bodyColor), 0]]);
  const triangleColors = new Map<number, number>();

  // 面の通し番号の昇順に見る(`Map` の挿入順に頼らない。決定性)。
  const faceIndices = Array.from(faceColors.keys()).sort((left, right) => left - right);
  for (const faceIndex of faceIndices) {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= faceRanges.length) {
      continue;
    }
    const range = faceRanges[faceIndex];
    if (!isUsableRange(range)) {
      continue;
    }
    const color = faceColors.get(faceIndex);
    if (color === undefined) {
      continue;
    }
    const key = colorKey(color);
    const known = slotOfColor.get(key);
    // 三角形を 1 枚も持たない面で `<base>` を増やさないよう、範囲を確かめた後で登録する。
    const slot = known ?? colors.length;
    if (known === undefined) {
      colors.push(color);
      slotOfColor.set(key, slot);
    }
    if (slot === 0) {
      continue;
    }
    for (let offset = 0; offset < range.triangleCount; offset += 1) {
      triangleColors.set(range.triangleOffset + offset, slot);
    }
  }

  return {
    colors,
    // 効いた面が 1 枚も無ければ、面の色を渡さなかったときと同じ形に戻す(バイト列を変えない)。
    triangleColors: triangleColors.size === 0 ? null : triangleColors,
  };
}
