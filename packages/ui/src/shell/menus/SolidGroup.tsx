/**
 * ソリッドの区画(作る・合わせる・加工)。一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import type { PartDocument } from '@pointercad/model';
import { SheetMetalMenu } from '../../sheetMetal/SheetMetalMenu.js';
import { t } from '../../i18n/t.js';
import type { NumericInputToolId } from '../../sketch/numericInput.js';
import {
  type SolidActionId,
  solidToolReadiness,
  type SolidToolReadiness,
} from '../../solid/solidCommands.js';
import type { SubShapeBody } from '../../solid/subShapeSelection.js';
import { CombineGroupIcon, CreateGroupIcon, MachiningGroupIcon } from '../icons.js';
import { COMBINE_MENU_ITEMS, CREATE_MENU_ITEMS, MACHINING_MENU_ITEMS } from '../toolbarMenus.js';
import { runCombineTool, runSolidTool } from './solidToolActions.js';
import { ToolMenu } from './ToolMenu.js';

interface SolidGroupProps {
  readonly document: PartDocument;
  readonly bodies: readonly SubShapeBody[];
  readonly selection: readonly string[];
  /** いま選んでいる道具。畳んだボタンの図柄と `aria-pressed` を決めるために使う。 */
  readonly activeTool: NumericInputToolId;
}

/**
 * ソリッドの区画(FR-401〜404、FR-414、FR-405〜408、FR-411、FR-412)。
 *
 * **P5 タスク51 でここを畳んだ一覧 3 つへ組み替えた**(§0.a-0.51、統括の決定 2026-09-05)。
 * P4b までは「ソリッド」区画に図柄 7 個(実測 200 画素)、その右の「加工」区画に図柄 6 個
 * (同 172 画素)が平置きされていて、1440 画素の窓で 1 段に必要な幅は実測 1437.3 画素・
 * 余裕 2.7 画素しか無かった。タスク18(基本形状 5)・27f(切断)・32(測る)・49(Should 群)で
 * ボタンがさらに 20 個ほど増えるため、計画書の順(32・50 の後)を待たずに前倒しした。
 *
 * 一覧の切り分けは「押したあとに何が起きるか」で決めてある。
 * ①**作る**(押し出し・回転・縫合・ばね): 面や点を選んでから**数値を聞いて**立体を作る。
 * ②**合わせる**(和・差・積): 立体を 2 つ選んで**押すだけで決まる**(§0.a-0.6)。
 * ③**加工**(穴・ねじ穴・R面取り・C面取り・直線/円形パターン): できた立体へ手を入れる。
 * 3 つとも同じ「ソリッド」区画の 1 つの溝に並ぶので、区画は増えない(要件§7.1)。
 *
 * 押せる条件と理由は `solidToolReadiness`(solidCommands.ts)1 か所で決める。加工 6 種の
 * 判定そのものは `machiningToolReadiness`(machiningCommands.ts)にあるが、
 * `solidToolReadiness` がすでにそこへ委譲しているのでここで 2 重に呼ばない。
 */
export function SolidGroup({
  document,
  bodies,
  selection,
  activeTool,
}: SolidGroupProps): React.JSX.Element {
  /*
    一覧を開いたときに項目ごとの押せる条件を引く関数。`SolidActionId` は
    「作る」「合わせる」「加工」の id をすべて含むので、3 つの一覧で同じ 1 つを使い回す。
  */
  const readinessOf = (id: SolidActionId): SolidToolReadiness =>
    solidToolReadiness(document, selection, id, bodies);

  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.solid.title')}>
      <span className="pcad-toolbar__group-label" title={t('toolbar.solid.tooltip')}>
        {t('toolbar.solid.title')}
      </span>
      <div className="pcad-segmented">
        <SheetMetalMenu />
        <ToolMenu
          items={CREATE_MENU_ITEMS}
          groupLabelKey="toolbar.create.groupLabel"
          groupTooltipKey="toolbar.create.tooltip"
          GroupIcon={CreateGroupIcon}
          activeTool={activeTool}
          readinessOf={readinessOf}
          onChoose={(id) => {
            runSolidTool(id, readinessOf(id));
          }}
        />
        <ToolMenu
          items={COMBINE_MENU_ITEMS}
          groupLabelKey="toolbar.combine.groupLabel"
          groupTooltipKey="toolbar.combine.tooltip"
          GroupIcon={CombineGroupIcon}
          /*
            和・差・積は道具として選ばれた状態にならない(押した瞬間に作って選択へ戻る)ので、
            畳んだボタンの図柄は `ToolMenu` が覚える「最後に使った道具」だけで決まる。
          */
          activeTool={activeTool}
          readinessOf={readinessOf}
          onChoose={(operation) => {
            runCombineTool(operation, readinessOf(operation));
          }}
        />
        <ToolMenu
          items={MACHINING_MENU_ITEMS}
          groupLabelKey="toolbar.machining.title"
          groupTooltipKey="toolbar.machining.tooltip"
          GroupIcon={MachiningGroupIcon}
          activeTool={activeTool}
          readinessOf={readinessOf}
          onChoose={(id) => {
            runSolidTool(id, readinessOf(id));
          }}
        />
      </div>
    </div>
  );
}
