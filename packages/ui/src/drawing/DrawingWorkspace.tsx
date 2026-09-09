import { useState } from 'react';
import { DrawingExportPopover } from './DrawingExportPopover.js';
import { printDrawing } from './printDrawing.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { CubeIcon, LayersIcon, PlaneSectionIcon } from '../shell/icons.js';
import { DrawingCanvas } from './DrawingCanvas.js';
import { DrawingTablePanel } from './DrawingTablePanel.js';
import { DrawingSheetPanel } from './DrawingSheetPanel.js';
import { DrawingViewPanel } from './DrawingViewPanel.js';
import { startDrawingDimension } from './dimensionCommands.js';
import { runDrawingAutoDimensions } from './autoDimensionCommands.js';
import { exportDrawingSvg } from './exportDrawingSvg.js';
import { startDrawingAnnotation } from './annotationCommands.js';
import { closeDrawingWithConfirmation } from './closeDrawing.js';
import { createDefaultPartFileDeps, openPart, savePart } from '../file/partFile.js';

export const DRAWING_DIMENSION_KINDS = [
  { key: 'drawing.dimension.length', kind: 'length', measurement: 'trueDistance' },
  { key: 'drawing.dimension.horizontal', kind: 'length', measurement: 'horizontal' },
  { key: 'drawing.dimension.vertical', kind: 'length', measurement: 'vertical' },
  { key: 'drawing.dimension.diameter', kind: 'diameter', measurement: 'radius' },
  { key: 'drawing.dimension.radius', kind: 'radius', measurement: 'radius' },
  { key: 'drawing.dimension.angle', kind: 'angle', measurement: 'angle' },
] as const;

export const DRAWING_TREE_KEYS = [
  'drawing.tree.sheet', 'drawing.tree.views', 'drawing.tree.dimensions',
  'drawing.tree.annotations', 'drawing.tree.layers',
] as const satisfies readonly MessageKey[];

export const DRAWING_TOOL_GROUPS = [
  {
    label: 'drawing.toolbar.views',
    tools: ['drawing.tool.baseView', 'drawing.tool.projectedView', 'drawing.tool.isometricView'],
  },
  {
    label: 'drawing.toolbar.sections',
    tools: ['drawing.tool.sectionView', 'drawing.tool.detailView', 'drawing.tool.auxiliaryView', 'drawing.tool.partialView', 'drawing.tool.brokenView'],
  },
  {
    label: 'drawing.toolbar.annotations',
    tools: ['drawing.tool.dimension', 'drawing.tool.note', 'drawing.tool.annotation', 'drawing.tool.centerMark'],
  },
  {
    label: 'drawing.toolbar.tables',
    tools: ['drawing.tool.table', 'drawing.tool.layer'],
  },
] as const satisfies readonly { readonly label: MessageKey; readonly tools: readonly MessageKey[] }[];

export const DRAWING_PROPERTY_KEYS = [
  'drawing.property.sheet', 'drawing.property.view', 'drawing.property.dimension',
  'drawing.property.annotation', 'drawing.property.table', 'drawing.property.layer',
] as const satisfies readonly MessageKey[];

export function DrawingToolbar(): React.JSX.Element {
  const [exportOpen, setExportOpen] = useState(false);
  const [copies, setCopies] = useState('1');
  const desktopPrint = useAppStore((state) => state.fileGateway.print !== undefined);
  const busy = useAppStore((state) => state.drawingBusy);
  const canUndo = useAppStore((state) => state.canUndo);
  const canRedo = useAppStore((state) => state.canRedo);
  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>
      <span className="pcad-badge">{t('drawing.mode')}</span>
      <div className="pcad-toolbar__actions">
        <button type="button" className="pcad-button" title={t('toolbar.file.openTooltip')}
          onClick={() => { void openPart(createDefaultPartFileDeps()); }}>{t('toolbar.file.open')}</button>
        <button type="button" className="pcad-button" title={t('toolbar.file.saveTooltip')}
          onClick={() => { void savePart(createDefaultPartFileDeps(), false); }}>{t('toolbar.file.save')}</button>
        <button type="button" className="pcad-button" title={t('toolbar.file.saveAsTooltip')}
          onClick={() => { void savePart(createDefaultPartFileDeps(), true); }}>{t('toolbar.file.saveAs')}</button>
        <button type="button" className="pcad-button" onClick={() => { void closeDrawingWithConfirmation(); }}>{t('drawing.file.returnToPart')}</button>
        <button type="button" className="pcad-button" disabled={!canUndo} onClick={() => useAppStore.getState().undo()}>{t('toolbar.history.undo')}</button>
        <button type="button" className="pcad-button" disabled={!canRedo} onClick={() => useAppStore.getState().redo()}>{t('toolbar.history.redo')}</button>
        {DRAWING_TOOL_GROUPS.map((group) => (
          <div className="pcad-toolbar__group" key={group.label}>
            <span className="pcad-toolbar__group-label">{t(group.label)}</span>
            <details className="pcad-drawing-tools">
              <summary>{t(group.label)}</summary>
              <div className="pcad-menu__panel" role="group" aria-label={t(group.label)}>
              {group.tools.map((key) => (
                <button key={key} type="button" className="pcad-button pcad-button--action" title={t(key)}
                  disabled={busy} onClick={(event) => { if (key === 'drawing.tool.dimension') startDrawingDimension();
                    else if (key === 'drawing.tool.annotation') startDrawingAnnotation();
                    else if (key === 'drawing.tool.note') { const state = useAppStore.getState(); state.setDrawingTool('note'); state.selectDrawingIds([]); state.setDrawingMessage(t('drawing.note.pickPosition')); }
                    event.currentTarget.closest('details')?.removeAttribute('open'); }}>
                  {t(key)}
                </button>
              ))}
              </div>
            </details>
          </div>
        ))}
        <select aria-label={t('drawing.tool.dimension')} disabled={busy} value="" onChange={(event) => {
          const selected = DRAWING_DIMENSION_KINDS.find((item) => item.key === event.target.value);
          if (selected !== undefined) startDrawingDimension({ kind: selected.kind, measurement: selected.measurement });
        }}>
          <option value="">{t('drawing.tool.dimension')}</option>
          {DRAWING_DIMENSION_KINDS.map((item) => <option key={item.key} value={item.key}>{t(item.key)}</option>)}
        </select>
        <button type="button" className="pcad-button" disabled={busy} onClick={() => { void runDrawingAutoDimensions(); }}>{t('drawing.dimension.auto')}</button>
        <button type="button" className="pcad-button" disabled={busy} onClick={() => { void exportDrawingSvg(); }}>{t('drawing.action.exportSvg')}</button>
        <button type="button" className="pcad-button" disabled={busy} onClick={() => setExportOpen(true)}>{t('drawing.export.title')}</button>
        {desktopPrint ? <label>{t('drawing.print.copies')}<input aria-label={t('drawing.print.copies')} value={copies} inputMode="numeric"
          style={{ width: 42 }} onChange={(event) => setCopies(event.target.value)} /></label> : null}
        <button type="button" className="pcad-button" disabled={busy} onClick={() => { void printDrawing(desktopPrint ? Number(copies) : 1); }}>{t('drawing.print.title')}</button>
        {exportOpen ? <DrawingExportPopover onClose={() => setExportOpen(false)} /> : null}
      </div>
    </header>
  );
}

export function DrawingTree(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const resolution = useAppStore((state) => state.drawingResolution);
  const selected = useAppStore((state) => state.drawingSelectedIds);
  const counts = [
    drawing === null ? 0 : 1,
    drawing?.views.length ?? 0,
    drawing?.dimensions.length ?? 0,
    drawing?.annotations.length ?? 0,
    drawing?.layers.length ?? 0,
  ];
  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('drawing.tree.title')}</h2>
      <div className="pcad-panel__body">
        <ul className="pcad-tree">
          {DRAWING_TREE_KEYS.map((key, index) => (
            <li className="pcad-tree__row pcad-tree__row--section" key={key}>
              {index === 4 ? <LayersIcon size={14} /> : <PlaneSectionIcon size={14} />}
              <span className="pcad-tree__label">{t(key)}</span>
              <span className="pcad-tree__count">{counts[index]}</span>
            </li>
          ))}
          {drawing?.views.map((view) => <li key={`view:${view.id}`} className="pcad-tree__row">
            <button type="button" className="pcad-button pcad-tree__label" aria-pressed={selected.includes(view.id)}
              onClick={() => useAppStore.getState().selectDrawingIds([view.id])}>{view.name}</button>
          </li>)}
          {drawing?.dimensions.map((dimension, index) => {
            const resolved = resolution?.ok === true ? resolution.dimensions.find((item) => item.dimension.id === dimension.id) : undefined;
            const name = DRAWING_DIMENSION_KINDS.find((item) => item.kind === dimension.kind && item.measurement === dimension.measurement);
            return <li key={`dimension:${dimension.id}`} className="pcad-tree__row">
              <button type="button" className="pcad-button pcad-drawing-tree-dimension" aria-pressed={selected.includes(dimension.id)}
                onClick={() => useAppStore.getState().selectDrawingIds([dimension.id])}
                style={resolved?.status === 'unresolved' ? { color: '#c2410c' } : undefined}>
                {index + 1}. {t(name?.key ?? 'drawing.tool.dimension')} — {resolved?.text ?? '…'}
              </button>
            </li>;
          })}
        </ul>
      </div>
    </section>
  );
}

export function DrawingPropertyPanel(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('drawing.property.title')}</h2>
      <div className="pcad-panel__body">
        {DRAWING_PROPERTY_KEYS.map((key) => (
          <section className="pcad-section" key={key}>
            <h3 className="pcad-section__title">{t(key)}</h3>
          </section>
        ))}
        {drawing === null ? null : (
          <dl className="pcad-properties">
            <dt className="pcad-properties__key">{t('drawing.tree.sheet')}</dt>
            <dd className="pcad-properties__value">{drawing.sheet.paperSizeId}</dd>
          </dl>
        )}
        <DrawingSheetPanel />
        <DrawingViewPanel />
        <DrawingTablePanel />
      </div>
    </section>
  );
}

export function DrawingViewport(): React.JSX.Element {
  return <DrawingCanvas />;
}

export function DrawingStatusBar(): React.JSX.Element {
  const message = useAppStore((state) => state.drawingMessage);
  const fileMessage = useAppStore((state) => state.fileMessage);
  const busy = useAppStore((state) => state.drawingBusy);
  const resolution = useAppStore((state) => state.drawingResolution);
  const unresolved = resolution?.ok === true ? resolution.unresolvedCount : 0;
  return (
    <footer className="pcad-statusbar">
      <span className="pcad-statusbar__message" aria-live="polite">
        <span className="pcad-statusbar__text">{fileMessage === null ? message ?? (busy ? t('drawing.status.computing')
          : unresolved > 0 ? t('drawing.dimension.unresolvedCount').replace('{count}', String(unresolved)) : t('drawing.status.ready')) : t(fileMessage.key)}</span>
      </span>
      <span className="pcad-statusbar__spacer" />
      <span className="pcad-statusbar__state">mm</span>
    </footer>
  );
}
