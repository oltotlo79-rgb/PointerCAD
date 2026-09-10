import { useState } from 'react';
import { t } from '../i18n/t.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppStore } from '../store/useAppStore.js';
import { CubeIcon, OpenFileIcon, SaveIcon, UndoIcon, RedoIcon } from '../shell/icons.js';
import { ToolMenu } from '../shell/menus/ToolMenu.js';
import { DrawingExportPopover } from './DrawingExportPopover.js';
import { printDrawing } from './printDrawing.js';
import { DRAWING_TABLE_ACTIONS, DRAWING_TOOL_GROUPS, type DrawingToolbarAction } from './drawingToolbarItems.js';
import { runDrawingToolbarAction } from './drawingToolbarActions.js';

export function DrawingToolbar(): React.JSX.Element {
  const [panel, setPanel] = useState<'export' | 'print' | null>(null);
  const [copies, setCopies] = useState('1');
  const desktopPrint = useAppStore((state) => state.fileGateway.print !== undefined);
  const busy = useAppStore((state) => state.drawingBusy);
  const canUndo = useAppStore((state) => state.canUndo), canRedo = useAppStore((state) => state.canRedo);
  const sourceKind = useAppStore((state) => state.drawing?.source.sourceKind);
  const tool = useAppStore((state) => state.drawingTool);
  const choose = (action: DrawingToolbarAction): void => {
    const next = runDrawingToolbarAction(action);
    if (next === 'print' && !desktopPrint) { void printDrawing(1); return; }
    if (next !== null) setPanel(next);
  };
  return <>
    <header className="pcad-toolbar" data-testid="drawing-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>
      <div className="pcad-toolbar__actions">
        <div className="pcad-segmented">
          <button type="button" className="pcad-button pcad-button--icon" aria-label={t('toolbar.file.open')} title={t('toolbar.file.openTooltip')} onClick={() => choose('open')}><OpenFileIcon /></button>
          <button type="button" className="pcad-button pcad-button--icon" aria-label={t('toolbar.file.save')} title={t('toolbar.file.saveTooltip')} onClick={() => choose('save')}><SaveIcon /></button>
          <button type="button" className="pcad-button pcad-button--icon" disabled={!canUndo} aria-label={t('toolbar.history.undo')} title={t('toolbar.history.undo')} onClick={() => useAppStore.getState().undo()}><UndoIcon /></button>
          <button type="button" className="pcad-button pcad-button--icon" disabled={!canRedo} aria-label={t('toolbar.history.redo')} title={t('toolbar.history.redo')} onClick={() => useAppStore.getState().redo()}><RedoIcon /></button>
        </div>
        <span className="pcad-badge">{t('drawing.mode')}</span>
        {DRAWING_TOOL_GROUPS.map((group) => <div className="pcad-toolbar__group" key={group.label}
          data-help-topic={group.helpTopic}>
          <span className="pcad-toolbar__group-label" title={t(group.tooltip)}>{t(group.label)}</span>
          <div className="pcad-segmented">
            <ToolMenu<DrawingToolbarAction> items={group.items} groupLabelKey={group.label} groupTooltipKey={group.tooltip}
              GroupIcon={group.Icon} activeTool={tool} showPressed={group.label !== 'toolbar.file.title'}
              readinessOf={(id) => ({ ready: !busy || id === 'open' || id === 'save' || id === 'saveAs', reasonKey: busy ? 'drawing.status.computing' : null })}
              onChoose={(id) => choose(id)} />
          </div>
        </div>)}
        <div className="pcad-toolbar__group">
          <span className="pcad-toolbar__group-label" title={t('drawing.toolbar.tableHint')}>{t('drawing.toolbar.tables')}</span>
          <div className="pcad-segmented">
            {DRAWING_TABLE_ACTIONS.map((action) => <button key={action.id} type="button" className="pcad-button pcad-button--icon"
              disabled={busy || action.id === 'bom' && sourceKind !== 'assembly'} aria-label={t(action.labelKey)}
              title={`${t(action.labelKey)}: ${t(action.id === 'bom' && sourceKind !== 'assembly' ? 'drawing.toolbar.assemblyOnly' : action.tooltipKey)}`}
              onClick={() => choose(action.id)}><action.Icon /></button>)}
          </div>
        </div>
        <HelpButton />
      </div>
    </header>
    {panel === 'export' ? <DrawingExportPopover onClose={() => setPanel(null)} /> : null}
    {panel === 'print' ? <section className="pcad-popover pcad-drawing-print" role="dialog" aria-label={t('drawing.print.title')}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setPanel(null); } }}>
      <h3>{t('drawing.print.title')}</h3>
      <label>{t('drawing.print.copies')}<input className="pcad-field__input" aria-label={t('drawing.print.copies')} value={copies} inputMode="numeric"
        onChange={(event) => setCopies(event.target.value)} /></label>
      <div className="pcad-popover__actions">
        <button type="button" className="pcad-button" disabled={busy} title={t('drawing.toolbar.printHint')}
          onClick={() => { void printDrawing(Number(copies)); }}>{t('drawing.print.title')}</button>
        <button type="button" className="pcad-button" title={t('drawing.action.close')} onClick={() => setPanel(null)}>{t('drawing.action.close')}</button>
      </div>
    </section> : null}
  </>;
}
