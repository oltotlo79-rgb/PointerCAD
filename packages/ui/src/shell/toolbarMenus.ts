/**
 * ツールバーの畳んだ一覧(「作図」「編集」)の中身と、その決まりごとの純関数
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク32、§0.a-0.14。FR-904、NFR-UX-7)。
 *
 * 画面(`Toolbar.tsx`)から表と判断を分けてあるのは 2 つの理由による。
 * ①**項目の追加を 1 行で済ませる**ため。トリム・延長・フィレット・面取り・ミラー・複写・
 *   配列複写(タスク22〜24)は、この下の `EDIT_MENU_ITEMS` へ 1 行足すだけで一覧・図柄・
 *   ツールチップ・キーボード操作・幅の見積もりのすべてに反映される。
 * ②DOM を持たない判断(トリガーに出す図柄、最後に使った道具の記憶、↑↓ の行き先、
 *   区画の幅の見積もり)を単体で検査できるようにするため(`toolbarMenus.test.ts`)。
 *
 * ここは React にも DOM にも触れない。図柄は `icons.tsx` の関数への参照を持つだけで、
 * この場では呼ばない(JSX を書かないので拡張子は .ts のまま)。
 */

import type { MessageKey } from '../i18n/t.js';
import type { EditMenuToolId, ShapeToolId } from '../sketch/numericInput.js';

import {
  CircleToolIcon,
  CircularArrayToolIcon,
  CopyToolIcon,
  EllipseToolIcon,
  ExtendToolIcon,
  LinearArrayToolIcon,
  MirrorToolIcon,
  OffsetToolIcon,
  PolygonToolIcon,
  RectangleToolIcon,
  SlotToolIcon,
  SplineToolIcon,
  TrimToolIcon,
  TwoPointArcToolIcon,
  type IconComponent,
} from './icons.js';

/**
 * 畳んだ一覧の 1 項目。項目は必ず**図柄と名前の両方**を持つ(名前だけの一覧は、
 * 開いたときに何の形なのかが読み取りにくかった。t12・t21 の申し送り)。
 */
export interface ToolMenuItem<Id extends string> {
  readonly id: Id;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly Icon: IconComponent;
}

/**
 * 「作図」の一覧(FR-313〜318、FR-326)。よく使う基本の 6 道具(選択・点・線分・円弧・
 * 点列・面)は平置きのままにして、ここには「たまに使うが数は多い」形を入れる
 * (利用者の決定 2026-09-04「図柄付きの畳んだボタンで 1 段に戻す」)。
 * 並びがそのまま一覧の上からの順になる。
 */
export const SHAPE_MENU_ITEMS: readonly ToolMenuItem<ShapeToolId>[] = [
  {
    id: 'circle',
    labelKey: 'toolbar.tool.circle',
    tooltipKey: 'toolbar.tool.circleTooltip',
    Icon: CircleToolIcon,
  },
  {
    id: 'twoPointArc',
    labelKey: 'toolbar.tool.twoPointArc',
    tooltipKey: 'toolbar.tool.twoPointArcTooltip',
    Icon: TwoPointArcToolIcon,
  },
  {
    id: 'rectangle',
    labelKey: 'toolbar.tool.rectangle',
    tooltipKey: 'toolbar.tool.rectangleTooltip',
    Icon: RectangleToolIcon,
  },
  {
    id: 'polygon',
    labelKey: 'toolbar.tool.polygon',
    tooltipKey: 'toolbar.tool.polygonTooltip',
    Icon: PolygonToolIcon,
  },
  {
    id: 'slot',
    labelKey: 'toolbar.tool.slot',
    tooltipKey: 'toolbar.tool.slotTooltip',
    Icon: SlotToolIcon,
  },
  {
    id: 'ellipse',
    labelKey: 'toolbar.tool.ellipse',
    tooltipKey: 'toolbar.tool.ellipseTooltip',
    Icon: EllipseToolIcon,
  },
  {
    id: 'spline',
    labelKey: 'toolbar.tool.spline',
    tooltipKey: 'toolbar.tool.splineTooltip',
    Icon: SplineToolIcon,
  },
];

/**
 * 「編集」の一覧(FR-321〜324)。オフセット・トリム・延長。
 *
 * **タスク23・24 への申し送り**: スケッチのフィレット・スケッチの面取り・ミラー・複写・
 * 配列複写は、この表へ `{ id, labelKey, tooltipKey, Icon }` の 1 行を足すだけで一覧に並ぶ。
 * 押せる条件は `editCommands.ts` の `editToolReadiness` が道具 id で振り分けているので、
 * 「選んでから操作」でない道具を足すときはそちらへ 1 行足す(タスク22 でトリム・延長の
 * ぶんを足した)。一覧の項目が増えてもツールバーの幅は変わらない
 * (`segmentedWidthPixels` の注釈)。
 */
export const EDIT_MENU_ITEMS: readonly ToolMenuItem<EditMenuToolId>[] = [
  {
    id: 'offset',
    labelKey: 'toolbar.tool.offset',
    tooltipKey: 'toolbar.tool.offsetTooltip',
    Icon: OffsetToolIcon,
  },
  {
    id: 'trim',
    labelKey: 'toolbar.tool.trim',
    tooltipKey: 'toolbar.tool.trimTooltip',
    Icon: TrimToolIcon,
  },
  {
    id: 'extend',
    labelKey: 'toolbar.tool.extend',
    tooltipKey: 'toolbar.tool.extendTooltip',
    Icon: ExtendToolIcon,
  },
  {
    id: 'mirror',
    labelKey: 'toolbar.tool.mirror',
    tooltipKey: 'toolbar.tool.mirrorTooltip',
    Icon: MirrorToolIcon,
  },
  {
    id: 'copy',
    labelKey: 'toolbar.tool.copyMove',
    tooltipKey: 'toolbar.tool.copyMoveTooltip',
    Icon: CopyToolIcon,
  },
  {
    id: 'linearArray',
    labelKey: 'toolbar.tool.linearArray',
    tooltipKey: 'toolbar.tool.linearArrayTooltip',
    Icon: LinearArrayToolIcon,
  },
  {
    id: 'circularArray',
    labelKey: 'toolbar.tool.circularArray',
    tooltipKey: 'toolbar.tool.circularArrayTooltip',
    Icon: CircularArrayToolIcon,
  },
];

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

/** 「スケッチ」区画に置く畳んだ一覧の数(「作図」「編集」)。 */
export const SKETCH_MENU_COUNT = 2;
