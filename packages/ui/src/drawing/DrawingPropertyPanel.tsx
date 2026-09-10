import { useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { DRAWING_PROPERTY_KINDS, drawingPropertySectionKey, type DrawingPropertyKind } from '../shell/propertySectionKeys.js';
import { drawingPropertySelection } from './drawingPropertySelection.js';
import { setDrawingElementLayer } from './elementLayerCommands.js';
import { DrawingSheetPanel } from './DrawingSheetPanel.js';
import { DrawingViewPanel } from './DrawingViewPanel.js';
import { DrawingTablePanel } from './DrawingTablePanel.js';
import { DrawingLayerPanel } from './DrawingLayerPanel.js';
import { DrawingNotePopover } from './DrawingNotePopover.js';
import { DrawingTolerancePopover } from './DrawingTolerancePopover.js';
import { DrawingBalloonPanel } from './DrawingBalloonPanel.js';
import { DrawingAnnotationPopover } from './DrawingAnnotationPopover.js';
import { DrawingDimensionSeriesPanel } from './DrawingDimensionSeriesPanel.js';
import { DrawingGdtPanel } from './DrawingGdtPanel.js';
import { DrawingWeldPanel } from './DrawingWeldPanel.js';

const labels: Readonly<Record<DrawingPropertyKind, MessageKey>> = {
  sheet: 'drawing.property.sheet', view: 'drawing.property.view', dimension: 'drawing.property.dimension',
  annotation: 'drawing.property.annotation', table: 'drawing.property.table', layer: 'drawing.property.layer',
};

export function DrawingPropertyPanel(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const documentId = useAppStore((state) => state.activeDocumentId);
  const selectedIds = useAppStore((state) => state.drawingSelectedIds);
  const editor = useAppStore((state) => state.drawingEditor);
  const busy = useAppStore((state) => state.drawingBusy);
  const selection = drawingPropertySelection(drawing, selectedIds);
  const selectedKind = selection.kind === 'balloon' ? 'table' : selection.kind === 'datum' || selection.kind === 'gdt' || selection.kind === 'weld'
    ? 'annotation' : selection.kind === 'multiple' || selection.kind === 'empty' ? null : selection.kind;
  const activeKind = editor?.kind ?? selectedKind;
  const context = JSON.stringify([documentId, selectedIds, editor]);
  const [expansion, setExpansion] = useState<{ readonly context: string; readonly kinds: readonly DrawingPropertyKind[] } | null>(null);
  const expanded = expansion?.context === context ? expansion.kinds : activeKind === null ? [] : [activeKind];
  const singleElement = 'element' in selection && selection.kind !== 'layer' ? selection.element : null;

  function content(kind: DrawingPropertyKind): React.ReactNode {
    if (drawing === null) return null;
    if (selection.kind === 'multiple' && kind !== 'sheet' && kind !== 'layer') {
      return <p className="pcad-drawing-property-hint">{t('drawing.property.selectElement')}</p>;
    }
    if (kind === 'sheet') return <DrawingSheetPanel embedded />;
    if (kind === 'view') return <DrawingViewPanel embedded />;
    if (kind === 'table') return selection.kind === 'balloon'
      ? <DrawingBalloonPanel key={JSON.stringify(selection.element)} balloon={selection.element} /> : <DrawingTablePanel embedded />;
    if (kind === 'layer') return <DrawingLayerPanel allowCreate embedded />;
    if (kind === 'dimension' && editor?.kind === 'dimension') return <DrawingDimensionSeriesPanel />;
    if (kind === 'dimension' && selection.kind === 'dimension') return <DrawingTolerancePopover inline
      key={JSON.stringify(selection.element)} dimension={selection.element} />;
    if (kind === 'annotation' && editor?.kind === 'annotation' && editor.manufacturingKind === 'weld') return <DrawingWeldPanel key={JSON.stringify(editor)}
      symbol={drawing.weldSymbols.find((entry) => entry.id === editor.elementId)} />;
    if (kind === 'annotation' && selection.kind === 'weld') return <DrawingWeldPanel key={JSON.stringify(selection.element)} symbol={selection.element} />;
    if (kind === 'annotation' && editor?.kind === 'annotation' && editor.manufacturingKind !== 'weld') return <DrawingGdtPanel key={JSON.stringify(editor)} kind={editor.manufacturingKind}
      datum={drawing.datums.find((entry) => entry.id === editor.elementId)} frame={drawing.gdtFrames.find((entry) => entry.id === editor.elementId)} />;
    if (kind === 'annotation' && selection.kind === 'datum') return <DrawingGdtPanel key={JSON.stringify(selection.element)} kind="datum" datum={selection.element} />;
    if (kind === 'annotation' && selection.kind === 'gdt') return <DrawingGdtPanel key={JSON.stringify(selection.element)} kind="gdt" frame={selection.element} />;
    if (kind === 'annotation' && selection.kind === 'annotation') {
      const annotation = selection.element;
      if (annotation.sourceTarget !== undefined && (annotation.kind === 'surfaceFinish' || annotation.machiningFeatureId !== undefined)) {
        return <DrawingAnnotationPopover inline key={JSON.stringify(annotation)} annotation={annotation} target={annotation.sourceTarget} />;
      }
      if ((annotation.kind === 'note' || annotation.kind === 'leaderNote') && annotation.sourceTarget === undefined) {
        return <DrawingNotePopover inline key={JSON.stringify(annotation)} annotation={annotation} />;
      }
    }
    return <p className="pcad-drawing-property-hint">{t('drawing.property.selectElement')}</p>;
  }

  return <section className="pcad-panel pcad-panel--right">
    <h2 className="pcad-panel__title">{t('drawing.property.title')}</h2>
    <div className="pcad-panel__body" key={documentId}>
      {selection.kind === 'multiple' ? <p>{t('drawing.property.multiple').replace('{count}', String(selection.count))}</p> : null}
      {singleElement === null || drawing === null ? null : <label className="pcad-drawing-element-layer">
        {t('drawing.property.elementLayer')}
        <select className="pcad-field__input" aria-label={t('drawing.property.elementLayer')} value={singleElement.layerId} disabled={busy}
          onChange={(event) => setDrawingElementLayer(selection, event.target.value)}>
          {drawing.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
        </select>
      </label>}
      {DRAWING_PROPERTY_KINDS.map((kind) => <details className="pcad-drawing-property-section" data-property-kind={kind}
        data-help-topic={kind === 'sheet' ? 'drawing-scale' : kind === 'layer' ? 'drawing-layer'
          : kind === 'view' ? (editor?.kind === 'view' && editor.constructionKind === 'section' ? 'drawing-section' : 'drawing-views')
            : kind === 'dimension' ? (editor?.kind === 'dimension' ? 'dimension-series' : 'dimension-tolerance') : kind === 'annotation' ? 'drawing-note' : 'drawing'}
        key={drawingPropertySectionKey(kind, documentId)} open={expanded.includes(kind)}>
        <summary className="pcad-section__title" onClick={(event) => {
          event.preventDefault(); setExpansion({ context, kinds: expanded.includes(kind) ? expanded.filter((item) => item !== kind) : [...expanded, kind] });
        }}>{t(labels[kind])}</summary>
        {expanded.includes(kind) ? content(kind) : null}
      </details>)}
    </div>
  </section>;
}
