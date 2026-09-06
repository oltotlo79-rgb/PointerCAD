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

/** 図柄だけのボタンの幅。`appShell.css` の `.pcad-button--icon` と同じ値。 */
export const ICON_BUTTON_WIDTH_PIXELS = 26;

/**
 * 畳んだ一覧のボタン(図柄+小さな ▾)の幅。`appShell.css` の
 * `.pcad-menu__trigger--icon` と同じ値。図柄 16 + 隙間 1 + ▾ 9 = 26 に、
 * 押せる面を図柄だけのボタンより少しだけ広げるぶんを足してある。
 */
export const MENU_TRIGGER_WIDTH_PIXELS = 31;

/** 溝(`.pcad-segmented`)の内側の隙間・内余白・枠線。`appShell.css` と同じ値。 */
const SEGMENTED_GAP_PIXELS = 2;

const SEGMENTED_PADDING_PIXELS = 2;

const SEGMENTED_BORDER_PIXELS = 1;

/**
 * 溝 1 つぶんの幅(画素)。ツールバーが 1440 画素の窓で 1 段に収まるかの予算を、
 * 実測の前に見積もるために使う(実測は撮影の手順で行い、報告に残す)。
 *
 * **引数が「個数」だけであること自体が要点**で、畳んだ一覧の中に項目をいくつ足しても
 * 溝の幅は変わらない。タスク22〜24 が「編集」へ 7 つの道具を足しても、ツールバーの幅は
 * 1 画素も増えない(検査 `toolbarMenus.test.ts` がこれを固定している)。
 */
export function segmentedWidthPixels(iconButtons: number, menuTriggers: number): number {
  const buttons = iconButtons + menuTriggers;
  if (buttons <= 0) {
    return 0;
  }
  return (
    iconButtons * ICON_BUTTON_WIDTH_PIXELS +
    menuTriggers * MENU_TRIGGER_WIDTH_PIXELS +
    (buttons - 1) * SEGMENTED_GAP_PIXELS +
    2 * SEGMENTED_PADDING_PIXELS +
    2 * SEGMENTED_BORDER_PIXELS
  );
}

/** 「スケッチ」区画に平置きする基本の道具の数(選択・点・線分・円弧・点列・面)。 */
export const BASIC_SKETCH_TOOL_COUNT = 6;

/**
 * 「スケッチ」区画に置く畳んだ一覧の数(「作図」「編集」「拘束」)。
 * P4b タスク13 で「拘束」を足して 2 → 3 になった。溝の幅は 31 画素だけ増える
 * (`segmentedWidthPixels`)ので、1440 画素の窓では 1 段(68.5 画素)のまま。
 */
export const SKETCH_MENU_COUNT = 3;

/**
 * 「ソリッド」区画に置く畳んだ一覧の数(「作る」「合わせる」「加工」、P5 タスク51)。
 *
 * P4b までは 図柄 7 個の「ソリッド」区画(実測 200 画素)と 図柄 6 個の「加工」区画
 * (同 172 画素)が別々に並んでいた。3 つの一覧へ畳んで 1 つの溝へまとめると
 * `segmentedWidthPixels(0, 3)` = 103 画素になり、区画のあいだの隙間(6 画素)も 1 つ減る。
 */
export const SOLID_MENU_COUNT = 3;

/** 「投影」「見た目」の区画に置く畳んだ一覧の数(どちらも 1 つ、P5 タスク51)。 */
export const SINGLE_MENU_COUNT = 1;

/**
 * 「ファイル」の溝に平置きする図柄のボタンの数(新規・開く・保存、§0.a-0.15、§0.57)。
 * **この 3 つは畳まない**(最もよく使うので 1 クリックで届かせる)。
 */
export const FILE_ACTION_ICON_COUNT = 3;

/**
 * 「ファイル」の溝に置く畳んだ一覧の数(P6 §0.57、タスク31)。
 *
 * 溝は `segmentedWidthPixels(3, 0)` = 88 画素から `segmentedWidthPixels(3, 1)` = 121 画素へ
 * 33 画素だけ広がる(畳んだボタン 31 + 隙間 2)。**一覧の中へ項目をいくつ足しても
 * ここから先は 1 画素も増えない**ので、§0.57 の残り 6 項目(タスク32・33)も幅に効かない。
 * 実測は 1440×900 で必要幅 1172.3 → 1205.3 画素、余裕 267.7 → 234.7 画素(報告に記載)。
 */
export const FILE_MENU_COUNT = 1;
