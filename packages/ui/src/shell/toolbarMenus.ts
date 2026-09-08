/**
 * ツールバーの畳んだ一覧の入口(計画書 docs/plans/P4-スケッチ拡張.md タスク32、§0.a-0.14。
 * ソリッド側の組み替えは docs/plans/P5-高度なソリッド・外観と測定.md タスク51、§0.a-0.51。
 * FR-904、NFR-UX-7)。
 *
 * 画面(`Toolbar.tsx`)から表と判断を分けてあるのは 2 つの理由による。
 * ①**項目の追加を 1 行で済ませる**ため。トリム・延長・フィレット・面取り・ミラー・複写・
 *   配列複写(タスク22〜24)は、`menus/sketchMenuItems.ts` の `EDIT_MENU_ITEMS` へ 1 行
 *   足すだけで一覧・図柄・ツールチップ・キーボード操作・幅の見積もりのすべてに反映される。
 * ②DOM を持たない判断(トリガーに出す図柄、最後に使った道具の記憶、↑↓ の行き先、
 *   区画の幅の見積もり)を単体で検査できるようにするため(`toolbarMenus.test.ts`)。
 *
 * **中身は `menus/` の中に一覧ごとに置いてある**(P6 タスク52)。ここは束ねるだけなので、
 * 項目を足すときはこのファイルではなく、その一覧のファイルへ書く。
 * ここも React にも DOM にも触れない。
 */

export {
  triggerItemOf,
  rememberRecentTool,
  nextHighlightIndex,
  ICON_BUTTON_WIDTH_PIXELS,
  MENU_TRIGGER_WIDTH_PIXELS,
  segmentedWidthPixels,
  BASIC_SKETCH_TOOL_COUNT,
  SKETCH_MENU_COUNT,
  SOLID_MENU_COUNT,
  SINGLE_MENU_COUNT,
  FILE_ACTION_ICON_COUNT,
  FILE_MENU_COUNT,
} from './menus/menuItem.js';
export type { ToolMenuItem } from './menus/menuItem.js';
export {
  FILE_MENU_ITEMS,
  STORED_TEMPLATE_MENU_PREFIX,
  RECENT_FILE_MENU_PREFIX,
  isStoredTemplateMenuId,
  isRecentFileMenuId,
  storedTemplateIdOf,
  fileMenuItems,
} from './menus/fileMenuItems.js';
export type {
  FileMenuActionId,
  StoredTemplateMenuId,
  RecentFileMenuId,
  FileMenuItemId,
  NamedMenuEntry,
} from './menus/fileMenuItems.js';
export {
  SHAPE_MENU_ITEMS,
  EDIT_MENU_ITEMS,
  CONSTRAINT_MENU_ITEMS,
} from './menus/sketchMenuItems.js';
export {
  CREATE_MENU_ITEMS,
  COMBINE_MENU_ITEMS,
  MACHINING_MENU_ITEMS,
} from './menus/solidMenuItems.js';
export { PROJECTION_MENU_ITEMS, LOOK_MENU_ITEMS } from './menus/lookMenuItems.js';
export type { LookToolId, CanvasActionId, PrintCheckActionId } from './menus/lookMenuItems.js';
export { ASSEMBLY_MENU_ITEMS, MATE_MENU_ITEMS } from './menus/AssemblyGroup.js';
