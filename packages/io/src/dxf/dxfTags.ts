/**
 * DXF の字句(タグの列)の読み書き(要件 FR-813、計画書 docs/plans/P6-入出力.md §2.7 タスク22)。
 *
 * DXF テキストの構文は「**奇数行がグループコード(整数)、偶数行がその値**」の繰り返しだけで、
 * それ以上の入れ子も区切り記号も無い。だから読み込みを 2 段に分け、この字句の段では
 * 「行をコードと値の対に畳む」ことしかしない。実体(`LINE` / `CIRCLE` …)へ畳むのは
 * `dxfEntities.ts`(P6 タスク24)の仕事。**2 段に分けるのは、字句の検査と実体の検査を
 * 別々に固定するため**(計画書 §0.a-0.31)。
 *
 * 外部の DXF ライブラリは入れない(計画書 §1「外部依存の判断」。扱う実体を 9 種に絞ったので
 * タグの列を畳むだけで済み、断りの文言(NFR-UX-5)も日本語で出せる)。
 *
 * ## 決めごと
 *
 * - **改行は `\r\n` と `\n` の両方を受ける**(古い CAD は `\r\n`、テキスト処理を経たものは `\n`)。
 *   **書くときは必ず `\r\n`**(DXF の慣習。計画書 §2.7)。
 * - **コードの前後の空白は落とす。** 桁を揃えるために `"  0"` のように空白で埋めて書く
 *   実装があり、それを断る理由が無いため。
 * - **値の前後の空白は落とさない。** 値はレイヤー名やブロック名にもなり、
 *   `" 外形 "` と `"外形"` は別の名前だから(勝手に詰めると別のレイヤーに化ける)。
 * - **末尾の改行はちょうど 1 つを「最後の行の終わり」とみなして落とす。** DXF は必ず
 *   `0` / `EOF` の対で終わり、その後ろに改行が 1 つ付く。それより多い空行は 1 行として数え、
 *   値の位置なら空の値、コードの位置なら整数でないので断る。**空行を黙って読み飛ばさない**のは、
 *   行の対応がずれた壊れたファイルを「読めた」ことにしないため。
 * - **空の文字列はタグ 0 個**(断らない)。まだ何も書いていない入れ物として正しいため。
 *
 * ## 往復について
 *
 * `formatDxfTags(parseDxfTags(x))` は、**`x` が正規形**(改行がちょうど各行の後ろに 1 つずつ、
 * コードに余分な空白や `+` / `-0` のような表記が無い)のとき、改行を `\r\n` に揃えた `x` と一致する。
 * 正規形でない `x`(末尾の改行が無い、コードが `"  0 "` で書かれている等)は、
 * 往復すると正規形へ整う。読み書きの往復で内容が変わらないことは
 * `dxfTags.test.ts` の「往復」の検査で固定している。
 */

/** DXF のタグ 1 つ。`code` がグループコード、`value` は値の文字列(数値への変換は実体の段で行う)。 */
export interface DxfTag {
  readonly code: number;
  readonly value: string;
}

/**
 * 字句として読めなかったときに利用者へ見せる日本語(NFR-UX-5)。
 * バイナリ DXF・行数が奇数・コードが整数でない、のいずれもこの 1 文で断る
 * (利用者にとっては「この入れ物では開けない」という同じ 1 つの事実のため)。
 */
export const DXF_UNSUPPORTED_FORMAT_MESSAGE = 'この DXF の形式には対応していません。';

/** 書き出すときの改行。DXF の慣習に合わせて `\r\n` に固定する(計画書 §2.7)。 */
const OUTPUT_LINE_BREAK = '\r\n';

/** 読むときに受ける改行。`\r\n` を先に置いて、`\r` が値の側へ残らないようにする。 */
const INPUT_LINE_BREAK = /\r\n|\n/;

/**
 * グループコードとして認める書き方。10 進の整数だけで、
 * 小数(`1.5`)・指数(`1e3`)・16 進(`0x10`)・空文字は認めない。
 * 符号は認める(拡張データで負のコードを使う方言があるため。範囲の是非は実体の段で見る)。
 */
const GROUP_CODE_PATTERN = /^[+-]?[0-9]+$/;

/**
 * DXF のテキストをタグの列へ畳む。
 *
 * @param text DXF のテキスト全体。
 * @returns 読めたタグの列(前から順)。
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。行数が奇数、
 *   またはコードの行が 10 進の整数でないとき。**途中まで読めた分を返さない**のは、
 *   対応がずれたまま実体の段へ渡すと、別の図形として読めてしまうため。
 */
export function parseDxfTags(text: string): readonly DxfTag[] {
  // `String.prototype.split` は必ず 1 個以上返すので、末尾の要素は常に存在する。
  const lines = text.split(INPUT_LINE_BREAK);
  // 末尾の改行 1 つぶんの空文字だけを落とす(`"0\nEOF\n"` の最後の要素)。
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (lineCount % 2 !== 0) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }

  const tags: DxfTag[] = [];
  for (let index = 0; index < lineCount; index += 2) {
    const codeText = lines[index].trim();
    if (!GROUP_CODE_PATTERN.test(codeText)) {
      throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    }
    const parsed = Number.parseInt(codeText, 10);
    // `"-0"` は `-0` になる。以後の比較(`Object.is`)で 0 と食い違うので 0 へ寄せる。
    tags.push({ code: parsed === 0 ? 0 : parsed, value: lines[index + 1] });
  }
  return tags;
}

/**
 * タグの列を DXF のテキストへ戻す。1 タグにつき「コードの行」「値の行」の 2 行を書き、
 * **最後の行にも改行を付ける**(DXF の慣習。他の CAD はこの形を期待する)。
 *
 * 値の中に改行が入っていると読み直せない列になるが、そういう値は
 * 実体の段(書き出し)が作らないので、ここでは検査しないで素通しする
 * (書き出しの側で作った列をそのまま文字にするだけの役目に留める)。
 *
 * @param tags 書き出すタグの列。
 * @returns DXF のテキスト。タグが 0 個なら空の文字列(改行だけの行を作らない)。
 */
export function formatDxfTags(tags: readonly DxfTag[]): string {
  if (tags.length === 0) {
    return '';
  }
  const lines: string[] = [];
  for (const tag of tags) {
    lines.push(String(tag.code), tag.value);
  }
  return lines.join(OUTPUT_LINE_BREAK) + OUTPUT_LINE_BREAK;
}
