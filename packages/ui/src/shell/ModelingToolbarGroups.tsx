import { executeCommand } from '../commands/commandRegistry.js';
import { toolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import { currentCommandLabel } from '../commands/commandLabels.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import { FunctionPlotDialog } from '../functionPlot/FunctionPlotDialog.js';
import { t } from '../i18n/t.js';
import { constraintToolReadinessOf } from '../sketch/constraintActions.js';
import { editToolReadiness } from '../sketch/editCommands.js';
import { workPlaneEntries } from '../sketch/referenceCommands.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { ConstraintGroupIcon, EditGroupIcon, MatchViewIcon, ShapeGroupIcon } from './icons.js';
import { LookGroup } from './menus/LookGroup.js';
import { PlaneMenu } from './menus/PlaneMenu.js';
import { TOOLS } from './menus/sketchToolTables.js';
import { SolidGroup } from './menus/SolidGroup.js';
import { ToolMenu } from './menus/ToolMenu.js';
import { CONSTRAINT_MENU_ITEMS, EDIT_MENU_ITEMS, SHAPE_MENU_ITEMS } from './toolbarMenus.js';

export function PartModelingTools(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const partDocument = useAppStore((state) => state.document);
  // 文書にある任意の作業平面(FR-328)。作図面の一覧に名前で並べる。
  const customPlanes = workPlaneEntries(partDocument);
  const bodies = useAppStore((state) => state.bodies);
  // ソリッド・加工の押せる条件の判定(solidToolReadiness)が要る形へ詰め替える
  // (subShapeBodiesOf の注釈)。
  const subShapeBodies = subShapeBodiesOf(bodies);
  const selection = useAppStore((state) => state.selection);
  return (
    <>
      <SketchToolsGroup />
      <SolidGroup
        document={partDocument}
        bodies={subShapeBodies}
        selection={selection}
        activeTool={activeTool}
      />
      <AppearanceTools />
      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.plane.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.plane.tooltip')}>
          {t('toolbar.plane.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <PlaneMenu
            workPlaneId={workPlaneId}
            activeTool={activeTool}
            customPlanes={customPlanes}
          />
          {/*
            いま見ている向きに最も近い作図面へ移る。視点の正本はビューポートの
            中にあるので、ここでは要求を数えるだけにしてビューポートに応えてもらう。
          */}
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            data-command-id={toolbarCommandId('view', 'matchWorkPlane')}
            title={`${currentCommandLabel(toolbarCommandId('view', 'matchWorkPlane'), shortcutAssignments, documentKind)}: ${t('toolbar.plane.matchViewTooltip')}`}
            aria-label={t('toolbar.plane.matchView')}
            onClick={() => {
              executeCommand(toolbarCommandId('view', 'matchWorkPlane'));
            }}
          >
            <MatchViewIcon />
          </button>
        </div>
      </div>
    </>
  );
}

function SketchToolsGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const activeTool = useAppStore((state) => state.activeTool);
  const selection = useAppStore((state) => state.selection);
  // 整形系(オフセット、FR-321)の押せる条件の判定に要る。
  const resolvedSketch = useAppStore((state) => state.resolvedSketch);
  // 拘束(FR-313)。いま選んでいる拘束の道具と、履歴そのもの(下見に要る)。
  const activeConstraintKind = useAppStore((state) => state.activeConstraintKind);
  useAppStore((state) => state.sketch);
  /*
   * 「拘束」の一覧の入り切り。材料(解決結果)を作るのは**一覧を開いたときだけ**なので、
   * ここで作った関数を渡す(`constraintToolReadinessOf` の注釈、NFR-PF-1)。
   * 上で `sketch` と `selection` を購読しているので、どちらかが変われば描き直される。
   */
  const constraintReadinessOf = constraintToolReadinessOf();
  const utilityPanel = useAppStore(state => state.utilityPanel);
  const functionOpen = utilityPanel === 'functionPlot';
  const setFunctionOpen = (open: boolean): void => useAppStore.getState().setUtilityPanelOpen('functionPlot', open);
  return (
    <div
      className="pcad-toolbar__group"
      role="group"
      aria-label={t('toolbar.sketch.groupLabel')}
    >
      <span className="pcad-toolbar__group-label" title={t('toolbar.sketch.tooltip')}>
        {t('toolbar.sketch.groupLabel')}
      </span>
      <div className="pcad-segmented">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="pcad-button pcad-button--collapsible"
            title={`${currentCommandLabel(toolbarCommandId('sketch', tool.id), shortcutAssignments, documentKind)}: ${t(tool.tooltipKey)}`}
            data-command-id={toolbarCommandId('sketch', tool.id)}
            aria-label={t(tool.labelKey)}
            aria-pressed={activeTool === tool.id}
            onClick={() => {
              executeCommand(toolbarCommandId('sketch', tool.id));
            }}
          >
            <tool.Icon />
            <span className="pcad-button__label">{t(tool.labelKey)}</span>
          </button>
        ))}
        {/*
          「作図」「編集」は基本の 6 道具と**同じ溝の中**へ図柄+▾ のボタンとして置く
          (利用者の決定)。区画(.pcad-toolbar__group)は縦積みなので、
          溝の外へ出すと道具の下の段に落ちてツールバーが 2〜3 段相当になってしまう
          (実測 97.5〜126.5px)。ここへ入れておけば、一覧に道具を
          いくつ足しても横幅は 31 画素のまま増えない(toolbarMenus.ts の幅の見積もり)。
        */}
        <ToolMenu
          items={SHAPE_MENU_ITEMS}
          groupLabelKey="toolbar.shape.groupLabel"
          groupTooltipKey="toolbar.shape.tooltip"
          GroupIcon={ShapeGroupIcon}
          activeTool={activeTool}
          commandGroup="shape"
        />
        {functionOpen ? <FunctionPlotDialog onClose={() => setFunctionOpen(false)} /> : null}
        <ToolMenu
          items={EDIT_MENU_ITEMS}
          groupLabelKey="toolbar.edit.groupLabel"
          groupTooltipKey="toolbar.edit.tooltip"
          GroupIcon={EditGroupIcon}
          activeTool={activeTool}
          /*
            整形系のうち「対象を選んでから操作」の道具は、押せない理由を一覧の
            項目にも出す(NFR-UX-5)。道具ごとの振り分けは `editToolReadiness`
            (editCommands.ts)の 1 か所に置いてある。トリム・延長は選択を使わないので
            いつでも押せる。
          */
          readinessOf={(id) => editToolReadiness(id, resolvedSketch, selection)}
          commandGroup="edit"
        />
        {/*
          「拘束」(FR-313)。区画も段も増やさず、畳んだ一覧を 1 つ足すだけ。
          溝の幅は 31 画素しか増えないので、1440 画素の窓では
          1 段(68.5 画素)のまま(`toolbarMenus.ts` の `segmentedWidthPixels`)。

          押した後の流れは `constraintActions.ts` の 1 か所に置く。選んでいるものだけで
          条件が足りていればその場で付き、足りなければ「道具を選んだ状態」になって
          ビューポートで押した要素を順に受け取る(トリムと同じ流儀)。
        */}
        <ToolMenu
          items={CONSTRAINT_MENU_ITEMS}
          groupLabelKey="toolbar.constraint.groupLabel"
          groupTooltipKey="toolbar.constraint.tooltip"
          GroupIcon={ConstraintGroupIcon}
          activeTool={activeConstraintKind ?? ''}
          readinessOf={constraintReadinessOf}
          commandGroup="constraint"
        />
      </div>
    </div>
  );
}

export function AppearanceTools(): React.JSX.Element {
  const activeTool = useAppStore((state) => state.activeTool);
  const partDocument = useAppStore((state) => state.document);
  const bodies = useAppStore((state) => state.bodies);
  const subShapeBodies = subShapeBodiesOf(bodies);
  const selection = useAppStore((state) => state.selection);
  // 外観(FR-1106〜1110)の押せる条件の判定に要る。
  const selectionKind = useAppStore((state) => state.selectionKind);
  const appearanceMatches = useAppStore((state) => state.appearanceMatches);
  return (
    <LookGroup
      document={partDocument}
      bodies={subShapeBodies}
      selection={selection}
      selectionKind={selectionKind}
      matches={appearanceMatches}
      activeTool={activeTool}
    />
  );
}
