/**
 * 畳んだ一覧の 1 項目の形と、一覧に共通の決まりごと(トリガーの図柄・最後に使った道具・
 * ↑↓ の行き先)、それに区画の幅の見積もり(§0.a-0.14・0.15)。
 *
 * ここは React にも DOM にも触れない。分け方の決定は P6 タスク52(一覧ごとに 1 ファイル)。
 */

import type { MessageKey } from '../../i18n/t.js';
import type { IconComponent } from '../icons.js';

/**
 * 畳んだ一覧の 1 項目。項目は必ず**図柄と名前の両方**を持つ(名前だけの一覧は、
 * 開いたときに何の形なのかが読み取りにくかった。t12・t21 の申し送り)。
 */
export interface ToolMenuItem<Id extends string> {
  readonly id: Id;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly Icon: IconComponent;
  /**
   * 決まった文言ではなく**利用者が付けた名前**を出す行だけが持つ(P6 タスク33)。
   *
   * 保存したひな形の名前と、最近使ったファイルの名前がこれにあたる。あれば `labelKey` の
   * 代わりに出る。NFR-MA-5(文言は `ja.json` へ分ける)は決まった文言の話で、利用者が
   * 自分で付けた名前はその対象ではない——それでも `labelKey` を必須のままにしてあるのは、
   * 名前が空のときに出す言葉と、読み上げの手掛かりを必ず持たせるためである。
   *
   * ツールチップに同じ欄を作らないのは、`Toolbar.tsx` が「名前: 説明」と組み立てており、
   * 名前がここで差し替われば説明(`tooltipKey`)は決まった文言のままでよいからである。
   */
  readonly label?: string;
}

/**
 * 畳んだボタンに出す図柄のもとになる項目。
 *
 * ①いまその一覧の道具を使っているならその道具、②使っていなければ**最後にこの一覧から
 * 選んだ道具**、③一度も使っていなければ `null`(区画そのものの図柄を出す)。
 * ②は「よく使う道具は 1 クリック、それ以外は 2 クリック」にするための工夫で、
 * 世の中の道具箱つきボタン(Photoshop 等)と同じ振る舞い。
 */
export function triggerItemOf<Id extends string>(
  items: readonly ToolMenuItem<Id>[],
  activeToolId: string,
  recentId: Id | null,
): ToolMenuItem<Id> | null {
  const active = items.find((item) => item.id === activeToolId);
  if (active !== undefined) {
    return active;
  }
  return items.find((item) => item.id === recentId) ?? null;
}

/**
 * 「最後に使った道具」の記憶を更新する。一覧に無い id(別の区画の道具へ移ったときなど)では
 * 前の記憶をそのまま残す。道具の正本はストアで、これは畳んだボタンの見た目だけの記憶。
 */
export function rememberRecentTool<Id extends string>(
  items: readonly ToolMenuItem<Id>[],
  recentId: Id | null,
  chosenId: string,
): Id | null {
  const chosen = items.find((item) => item.id === chosenId);
  return chosen === undefined ? recentId : chosen.id;
}

/**
 * 開いている一覧の中で ↑↓ Home End を押したときの行き先(0 起点)。
 * 端では反対の端へ回り込む。一覧を動かさないキーは `null` を返し、押したキーは
 * ブラウザ既定(頁の縦送り)へそのまま渡す。決めるのは Enter / Space で、
 * これは焦点のあるボタンの既定の動きがそのまま使えるのでここでは扱わない。
 */
export function nextHighlightIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) {
    return null;
  }
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 幅の見積もり(1440 画素の窓で 1 段に収めるための予算、§0.a-0.14・0.15)
// ---------------------------------------------------------------------------
