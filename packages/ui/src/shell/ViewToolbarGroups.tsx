import { executeCommand } from '../commands/commandRegistry.js';
import { toolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import { currentCommandLabel } from '../commands/commandLabels.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import { t } from '../i18n/t.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  ChainIcon,
  GridIcon,
  HomeIcon,
  PerspectiveIcon,
  PlaneSectionIcon,
  ShadedIcon,
  ShadedWithEdgesIcon,
  SnapIcon,
  WireframeIcon,
} from './icons.js';
import { SnapKindsMenu } from './menus/SnapKindsMenu.js';
import { ToolMenu } from './menus/ToolMenu.js';
import { PROJECTION_MENU_ITEMS } from './toolbarMenus.js';

export function ProjectionGroup(): React.JSX.Element {
  const projection = useAppStore((state) => state.projection);
  return (
    <div className="pcad-toolbar__group">
      <span className="pcad-toolbar__group-label" title={t('toolbar.projection.tooltip')}>
        {t('toolbar.projection.groupLabel')}
      </span>
      <div className="pcad-segmented">
        <ToolMenu
          items={PROJECTION_MENU_ITEMS}
          groupLabelKey="toolbar.projection.groupLabel"
          groupTooltipKey="toolbar.projection.tooltip"
          GroupIcon={PerspectiveIcon}
          activeTool={projection}
          /*
            投影は必ずどちらかが効いているので、畳んだボタンの押下表示は出さない
            (常に点いたままだと「押しっぱなし」に見える)。
            いま効いているほうは図柄が示す。
          */
          showPressed={false}
          commandGroup="projection"
        />
      </div>
    </div>
  );
}

export function DisplayStyleGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const displayStyle = useAppStore((state) => state.displayStyle);
  // 断面表示(FR-111)。**入切だけ**を取り出して、切る位置が動いただけでは
  // ツールバーを描き直さない(NFR-PF-1。他の札と同じ取り出し方)。
  const sectionViewOn = useAppStore((state) => state.sectionView !== null);
  return (
    <div
      className="pcad-toolbar__group"
      role="group"
      aria-label={t('toolbar.displayStyle.groupLabel')}
    >
      <span className="pcad-toolbar__group-label" title={t('toolbar.displayStyle.tooltip')}>
        {t('toolbar.displayStyle.groupLabel')}
      </span>
      {/*
        3 つの図柄がそのまま見え方(塗りだけ / 塗りと稜線 / 線だけ)を写しているので、
        文字を添えずに図柄だけで並べる。名前は読み上げ名とツールチップが持つ。
      */}
      <div className="pcad-segmented">
        <button
          type="button"
          className="pcad-button pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'shaded')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'shaded'), shortcutAssignments, documentKind)}: ${t('toolbar.displayStyle.shaded')}`}
          aria-label={t('toolbar.displayStyle.shaded')}
          aria-pressed={displayStyle === 'shaded'}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'shaded'));
          }}
        >
          <ShadedIcon />
        </button>
        <button
          type="button"
          className="pcad-button pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'shadedWithEdges')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'shadedWithEdges'), shortcutAssignments, documentKind)}: ${t('toolbar.displayStyle.shadedWithEdges')}`}
          aria-label={t('toolbar.displayStyle.shadedWithEdges')}
          aria-pressed={displayStyle === 'shadedWithEdges'}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'shadedWithEdges'));
          }}
        >
          <ShadedWithEdgesIcon />
        </button>
        <button
          type="button"
          className="pcad-button pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'wireframe')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'wireframe'), shortcutAssignments, documentKind)}: ${t('toolbar.displayStyle.wireframe')}`}
          aria-label={t('toolbar.displayStyle.wireframe')}
          aria-pressed={displayStyle === 'wireframe'}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'wireframe'));
          }}
        >
          <WireframeIcon />
        </button>
        {/*
          ビューの断面表示(FR-111)。**「表示」の区画に入口 1 つだけ**を
          足す(区画は増やさない、rules/04)。押すと今の作図面で切り、切る位置はビューポートの
          つまみとその場の数値入力で動かす。**形は切らない**(見た目だけのクリップ)。
          図柄は交差の印を当面そのまま使う(専用の図柄はまだ無い)。
        */}
        {documentKind === 'part' ? <button
          type="button"
          className="pcad-button pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'section')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'section'), shortcutAssignments, documentKind)}: ${t('toolbar.sectionView.tooltip')}`}
          aria-label={t('toolbar.sectionView.label')}
          aria-pressed={sectionViewOn}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'section'));
          }}
        >
          <PlaneSectionIcon />
        </button> : null}
      </div>
    </div>
  );
}

export function DrawingAidsGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const showGrid = useAppStore((state) => state.showGrid);
  const chaining = useAppStore((state) => state.chaining);
  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.support.groupLabel')}>
      <span className="pcad-toolbar__group-label" title={t('toolbar.support.tooltip')}>
        {t('toolbar.support.groupLabel')}
      </span>
      <div className="pcad-segmented">
        {/* 方眼の図柄そのままなので文字は添えない。「続けてかく」は狭い窓でだけ畳む。 */}
        <button
          type="button"
          className="pcad-button pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'grid')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'grid'), shortcutAssignments, documentKind)}: ${t('toolbar.grid.tooltip')}`}
          aria-label={t('toolbar.grid.label')}
          aria-pressed={showGrid}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'grid'));
          }}
        >
          <GridIcon />
        </button>
        {documentKind === 'part' ? <button
          type="button"
          className="pcad-button pcad-button--collapsible"
          data-command-id={toolbarCommandId('view', 'chaining')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'chaining'), shortcutAssignments, documentKind)}: ${t('toolbar.chain.tooltip')}`}
          aria-label={t('toolbar.chain.label')}
          aria-pressed={chaining}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'chaining'));
          }}
        >
          <ChainIcon />
          <span className="pcad-button__label">{t('toolbar.chain.label')}</span>
        </button> : null}
      </div>
    </div>
  );
}

export function SnapGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapKinds = useAppStore((state) => state.snapKinds);
  // 向きの吸着の角度の刻み(FR-110)。数だけを取り出して、他の表示設定の変化では描き直さない。
  const trackAngleStep = useAppStore((state) => state.displaySettings.trackAngleStep);
  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.snap.groupLabel')}>
      <span className="pcad-toolbar__group-label" title={t('toolbar.snap.tooltip')}>
        {t('toolbar.snap.groupLabel')}
      </span>
      <div className="pcad-segmented">
        <button
          type="button"
          className="pcad-button pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'snap')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'snap'), shortcutAssignments, documentKind)}: ${t('toolbar.snap.tooltip')}`}
          aria-label={t('toolbar.snap.label')}
          aria-pressed={snapEnabled}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'snap'));
          }}
        >
          <SnapIcon />
        </button>
        <SnapKindsMenu
          snapEnabled={snapEnabled}
          snapKinds={snapKinds}
          trackAngleStep={trackAngleStep}
        />
      </div>
    </div>
  );
}

export function ViewpointGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.view.groupLabel')}>
      <span className="pcad-toolbar__group-label" title={t('toolbar.view.tooltip')}>
        {t('toolbar.view.groupLabel')}
      </span>
      <div className="pcad-segmented">
        <button
          type="button"
          className="pcad-button pcad-button--action pcad-button--icon"
          data-command-id={toolbarCommandId('view', 'home')}
          title={`${currentCommandLabel(toolbarCommandId('view', 'home'), shortcutAssignments, documentKind)}: ${t('toolbar.home.tooltip')}`}
          aria-label={t('toolbar.home.label')}
          onClick={() => {
            executeCommand(toolbarCommandId('view', 'home'));
          }}
        >
          <HomeIcon />
        </button>
      </div>
    </div>
  );
}
