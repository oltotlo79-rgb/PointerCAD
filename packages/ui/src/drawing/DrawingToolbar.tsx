import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { executeCommand } from '../commands/commandRegistry.js';
import { toolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import { currentCommandLabel } from '../commands/commandLabels.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import { useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { HelpButton } from '../help/HelpButton.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import { useAppStore } from '../store/useAppStore.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { CubeIcon, OpenFileIcon, SaveIcon, UndoIcon, RedoIcon } from '../shell/icons.js';
import { ToolMenu } from '../shell/menus/ToolMenu.js';
import { SavePointsDialogHost } from '../shell/SavePointsButton.js';
import { DrawingExportPopover } from './DrawingExportPopover.js';
import { printDrawing } from './printDrawing.js';
import { DRAWING_TABLE_ACTIONS, DRAWING_TOOL_GROUPS, type DrawingToolbarAction } from './drawingToolbarItems.js';

export function DrawingToolbar(): React.JSX.Element {
  const utilityPanel = useAppStore(state => state.utilityPanel);
  const panel = utilityPanel === 'drawingExport' ? 'export' : utilityPanel === 'drawingPrint' ? 'print' : null;
  const setPanel = (next: 'export' | 'print' | null): void => {
    if (next !== null) useAppStore.getState().setUtilityPanelOpen(next === 'export' ? 'drawingExport' : 'drawingPrint', true);
    else if (utilityPanel === 'drawingExport' || utilityPanel === 'drawingPrint') useAppStore.getState().setUtilityPanelOpen(utilityPanel, false);
  };
  const assignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const [copies, setCopies] = useState('1');
  const printRef = useRef<HTMLElement>(null);
  // 印刷の窓: 開いた時は中の最初の欄へ、閉じた時は開いた釦へ焦点を戻す(C-03)。
  useDialogFocus(() => printRef.current, panel === 'print');
  const busy = useAppStore((state) => state.drawingBusy);
  const canUndo = useAppStore((state) => state.canUndo), canRedo = useAppStore((state) => state.canRedo);
  const sourceKind = useAppStore((state) => state.drawing?.source.sourceKind);
  const tool = useAppStore((state) => state.drawingTool);
  const choose = (action: DrawingToolbarAction): void => { executeCommand(toolbarCommandId('drawing', action)); };
  return <>
    <header className="pcad-toolbar pcad-toolbar--drawing" data-testid="drawing-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>
      <div className="pcad-toolbar__actions">
        <div className="pcad-segmented">
          <button type="button" className="pcad-button pcad-button--icon" aria-label={t('toolbar.file.open')} data-command-id="file.open" title={currentCommandLabel('file.open', assignments, 'drawing')} onClick={() => choose('open')}><OpenFileIcon /></button>
          <button type="button" className="pcad-button pcad-button--icon" aria-label={t('toolbar.file.save')} data-command-id="file.save" title={currentCommandLabel('file.save', assignments, 'drawing')} onClick={() => choose('save')}><SaveIcon /></button>
          <button type="button" className="pcad-button pcad-button--icon" aria-disabled={canUndo ? undefined : true} aria-label={t('toolbar.history.undo')} data-command-id="history.undo" title={canUndo ? currentCommandLabel('history.undo', assignments, 'drawing') : t('toolbar.history.undoUnavailable')} onClick={() => executeCommand('history.undo')}><UndoIcon /></button>
          <button type="button" className="pcad-button pcad-button--icon" aria-disabled={canRedo ? undefined : true} aria-label={t('toolbar.history.redo')} data-command-id="history.redo" title={canRedo ? currentCommandLabel('history.redo', assignments, 'drawing') : t('toolbar.history.redoUnavailable')} onClick={() => executeCommand('history.redo')}><RedoIcon /></button>

        </div>
        <span className="pcad-badge">{t('drawing.mode')}</span>
        {DRAWING_TOOL_GROUPS.map((group) => <div className="pcad-toolbar__group" key={group.label}
          data-help-topic={group.helpTopic}>
          <span className="pcad-toolbar__group-label" title={t(group.tooltip)}>{t(group.label)}</span>
          <div className="pcad-segmented">
            <ToolMenu<DrawingToolbarAction> items={group.items} groupLabelKey={'menuLabel' in group ? group.menuLabel : group.label} groupTooltipKey={group.tooltip}
              GroupIcon={group.Icon} activeTool={tool} showPressed={group.label !== 'toolbar.file.title'}
              readinessOf={(id) => ({ ready: !busy || id === 'saveAs' || id === 'savePoints', reasonKey: busy && id !== 'savePoints' ? 'drawing.status.computing' : null })}
              commandGroup="drawing" />
          </div>
        </div>)}
        <div className="pcad-toolbar__group">
          <span className="pcad-toolbar__group-label" title={t('drawing.toolbar.tableHint')}>{t('drawing.toolbar.tables')}</span>
          <div className="pcad-segmented">
            {DRAWING_TABLE_ACTIONS.map((action) => <button key={action.id} type="button" className="pcad-button pcad-button--icon"
              aria-disabled={busy || action.id === 'bom' && sourceKind !== 'assembly' ? true : undefined} aria-label={t(action.labelKey)}
              title={`${t(action.labelKey)}: ${t(busy ? 'drawing.status.computing' : action.id === 'bom' && sourceKind !== 'assembly' ? 'drawing.toolbar.assemblyOnly' : action.tooltipKey)}`}
              data-command-id={toolbarCommandId('drawing', action.id)}
              data-help-topic={action.id === 'bom' ? 'drawing-bom' : 'drawing-table'}
              onClick={() => choose(action.id)}><action.Icon /></button>)}
          </div>
        </div>
        <SettingsPanel />
        <HelpButton />
      </div>
      {/* 効かないボタンの理由は、常時の注記にせず、ボタンの title と焦点・ホバーの案内の箱で出す(UI の点検の指摘 10。
          ボタンは aria-disabled で焦点が入るので、キーボードでも理由を読める〔R20〕)。 */}
    </header>
    <SavePointsDialogHost />
    {panel === 'export' ? <DrawingExportPopover onClose={() => setPanel(null)} /> : null}
    {panel === 'print' ? <section ref={printRef} className="pcad-popover pcad-drawing-print" role="dialog" aria-label={t('drawing.print.title')}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setPanel(null); } }}>
      <DraggableWindowTitle as="h3">{t('drawing.print.title')}</DraggableWindowTitle>
      <label title={t('drawing.print.copies.controlHint')}>{t('drawing.print.copies')}<input className="pcad-field__input" aria-label={t('drawing.print.copies')} value={copies} inputMode="numeric"
        onChange={(event) => setCopies(event.target.value)} /></label>
      {busy ? <p role="status">{t('drawing.status.computing')}</p> : null}
      <div className="pcad-popover__actions">
        <button type="button" className="pcad-button" aria-disabled={busy ? true : undefined} title={t(busy ? 'drawing.status.computing' : 'drawing.toolbar.printHint')}
          onClick={() => { if (!busy) void printDrawing(Number(copies)); }}>{t('drawing.print.title')}</button>
        <button type="button" className="pcad-button" title={t('drawing.action.close')} onClick={() => setPanel(null)}>{t('drawing.action.close')}</button>
      </div>
    </section> : null}
  </>;
}
