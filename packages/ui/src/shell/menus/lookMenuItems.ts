/**
 * 「投影」と「見た目」の畳んだ一覧の中身(FR-102、FR-1101・FR-1102、FR-1106〜1110、
 * FR-332、FR-815)。
 *
 * 分け方の決定は P6 タスク52(一覧ごとに 1 ファイル)。
 */

import type { AppearanceToolId, MeasureToolId } from '../../sketch/numericInput.js';
import type { ProjectionMode } from '../../store/viewSlice.js';
import {
  AppearanceIcon,
  MeasureIcon,
  OrthographicIcon,
  PerspectiveIcon,
  PlaneIcon,
  PrintCheckIcon,
} from '../icons.js';
import type { ToolMenuItem } from './menuItem.js';

/**
 * 「投影」の一覧(FR-102。P5 タスク51、§0.a-0.51)。
 *
 * 2 つしかないが、畳んだボタンには**いま効いているほうの図柄が出る**(`triggerItemOf` が
 * `activeTool` = いまの投影と一致する項目を返す)ので、畳んでも今の見え方は読み取れる
 * (`PlaneMenu` のトリガーに作図面の名前を出すのと同じ考え方)。
 */
export const PROJECTION_MENU_ITEMS: readonly ToolMenuItem<ProjectionMode>[] = [
  {
    id: 'perspective',
    labelKey: 'toolbar.projection.perspective',
    tooltipKey: 'toolbar.projection.perspectiveTooltip',
    Icon: PerspectiveIcon,
  },
  {
    id: 'orthographic',
    labelKey: 'toolbar.projection.orthographic',
    tooltipKey: 'toolbar.projection.orthographicTooltip',
    Icon: OrthographicIcon,
  },
];

/**
 * 「見た目」の一覧に並ぶ道具の id(P5 タスク51・32)。
 *
 * 外観(FR-1106〜1110)と測る(FR-1101、FR-1102)は、どちらも**立体を作らず**
 * 「選んでいるものについて何かをする」道具なので、同じ一覧に入る。
 */
export type LookToolId = AppearanceToolId | MeasureToolId | CanvasActionId | PrintCheckActionId | 'strength';

/**
 * 下絵(FR-332、P6 タスク39)の入口の id。
 *
 * **道具ではなく操作**(押すと画像を選ぶ窓が出て、選んだ画像がその場で作図面に貼られる)なので
 * `activeTool` にはならない。「測る」(`measure`)と同じ扱いで、`Toolbar.tsx` の
 * `onChoose` が最初に分岐して受け止める。
 */
export type CanvasActionId = 'canvas';

/**
 * 3D プリントの点検(FR-815、P6 §0.53、タスク46)の入口の id。
 *
 * **道具ではなく操作**(押すとその場で点検が走り、問題のある三角形が色で塗られる)なので
 * `activeTool` にはならない。下絵(`canvas`)・測る(`measure`)と同じ扱いで、
 * `Toolbar.tsx` の `onChoose` が分岐して受け止める。
 *
 * **同じ行をもう一度押すと点検を閉じる**(色が消えて元の外観に戻る)。「同じ道具を
 * もう一度選んだら解除」という他の一覧と同じ約束(NFR-UX-3)を、道具ではないこの行にも
 * そのまま当てはめた——閉じる口を別の場所にだけ置くと、出した本人が消し方を探すことになる
 * (プロパティの節にも「点検を閉じる」を置いてあるので、閉じ方は 2 通りある)。
 */
export type PrintCheckActionId = 'printCheck';

/**
 * 「見た目」の一覧(FR-1106〜1110、FR-1101、FR-1102。P5 タスク51、タスク32)。
 *
 * **「測る」は 2 行目**(§0.a-0.29 が「測る」をボタン 1 つと決めているので、区画を増やさずに
 * この一覧へ足せる。要件§7.1 の「固定の区画は増やさない」)。この 1 行を足しても
 * ツールバーの幅は 1 画素も増えない(`segmentedWidthPixels` は溝に並ぶボタンの個数しか
 * 見ない。§0.a-0.80)。
 */
export const LOOK_MENU_ITEMS: readonly ToolMenuItem<LookToolId>[] = [
  {
    id: 'appearance',
    labelKey: 'toolbar.appearance.assign',
    tooltipKey: 'toolbar.appearance.assignTooltip',
    Icon: AppearanceIcon,
  },
  {
    id: 'measure',
    labelKey: 'toolbar.measure.title',
    tooltipKey: 'toolbar.measure.tooltip',
    Icon: MeasureIcon,
  },
  {
    id: 'strength',
    labelKey: 'strength.title',
    tooltipKey: 'strength.tooltip',
    Icon: MeasureIcon,
  },
  /*
    下絵(FR-332、P6 タスク39)。**3 行目**。外観・測ると同じく「立体を作らず、選んで
    いるものや見え方について何かをする」ものなので同じ一覧に入り、区画は増えない
    (要件§7.1)。図柄は作図面(`PlaneIcon`)を借りる——下絵は作図面に貼る紙なので。
  */
  {
    id: 'canvas',
    labelKey: 'toolbar.canvas.label',
    tooltipKey: 'toolbar.canvas.tooltip',
    Icon: PlaneIcon,
  },
  /*
    3D プリントの点検(FR-815、P6 タスク46)。**4 行目**。形を 1 つも変えず「いま在る
    立体について何かを調べる」ものなので、測る(2 行目)と同じ性質でこの一覧に入り、
    区画は増えない(要件§7.1)。この 1 行を足してもツールバーの幅は 1 画素も増えない
    (`segmentedWidthPixels` は溝に並ぶボタンの個数しか見ない。§0.a-0.80)。
  */
  {
    id: 'printCheck',
    labelKey: 'toolbar.look.printCheck',
    tooltipKey: 'toolbar.look.printCheckTooltip',
    Icon: PrintCheckIcon,
  },
];
