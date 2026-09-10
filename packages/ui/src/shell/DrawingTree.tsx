import { useMemo, useState } from 'react';
import { paperSizeOf, type DrawingDocument } from '@pointercad/drawing';
import { drawingDimensionContext, resolveDrawingGdt, resolveDrawingWelds, type DrawingGdtResolution, type DrawingRefreshResult, type ResolvedWeldSymbol } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { LayersIcon, PlaneSectionIcon } from './icons.js';
import { drawingTreeGroups, type DrawingTreeGroupId, type DrawingTreeLabels } from './drawingTreeRows.js';

const groupLabels = {
  views: 'drawing.tree.views', dimensions: 'drawing.tree.dimensions', annotations: 'drawing.tree.annotations',
  tables: 'drawing.tree.tables', layers: 'drawing.tree.layers',
} as const satisfies Readonly<Record<DrawingTreeGroupId, MessageKey>>;

const rowLabels: DrawingTreeLabels = {
  dimension: (dimension, index) => `${index}. ${t(dimension.series !== undefined ? 'drawing.series.progressive' : dimension.kind === 'angle' ? 'drawing.dimension.angle'
    : dimension.kind === 'diameter' ? 'drawing.dimension.diameter' : dimension.kind === 'radius' ? 'drawing.dimension.radius'
      : dimension.kind === 'arcLength' ? 'drawing.dimension.arcLength'
        : dimension.kind === 'sphereDiameter' ? 'drawing.dimension.sphereDiameter'
          : dimension.kind === 'sphereRadius' ? 'drawing.dimension.sphereRadius'
            : dimension.kind === 'coordinate' ? 'drawing.dimension.coordinate'
      : dimension.measurement === 'horizontal' ? 'drawing.dimension.horizontal'
        : dimension.measurement === 'vertical' ? 'drawing.dimension.vertical' : 'drawing.dimension.length')}`,
  annotation: (_kind, index) => `${t('drawing.tree.annotations')} ${index}`,
  table: (kind, index) => `${t(kind === 'bom' ? 'drawing.table.bom' : kind === 'hole' ? 'drawing.table.hole' : 'drawing.table.revisionTable')} ${index}`,
  balloon: (number) => `${t('drawing.table.balloon')} ${number}`,
  manufacturing: (kind, index) => `${t(kind === 'datum' ? 'drawing.gdt.datum' : kind === 'gdt' ? 'drawing.gdt.title' : 'drawing.weld.title')} ${index}`,
};

export function DrawingTree(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const resolution = useAppStore((state) => state.drawingResolution);
  const selected = useAppStore((state) => state.drawingSelectedIds);
  const source = useAppStore((state) => state.drawingSourceResolution);
  const gdt = useMemo(() => drawing === null || source === null ? undefined : resolveDrawingGdt(drawing, drawingDimensionContext(source)), [drawing, source]);
  const welds = useMemo(() => drawing === null || source === null ? undefined : resolveDrawingWelds(drawing, drawingDimensionContext(source)), [drawing, source]);
  return <TreeBody key={drawing?.id ?? 'empty'} drawing={drawing} resolution={resolution} selected={selected} gdt={gdt} welds={welds} />;
}

function TreeBody({ drawing, resolution, selected, gdt, welds }: {
  readonly drawing: DrawingDocument | null;
  readonly resolution: DrawingRefreshResult | null;
  readonly selected: readonly string[];
  readonly gdt?: DrawingGdtResolution;
  readonly welds?: readonly ResolvedWeldSymbol[];
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<DrawingTreeGroupId>>(() => new Set());
  const groups = drawingTreeGroups(drawing, resolution, rowLabels, gdt, welds);
  const select = (id: string, additive: boolean): void => {
    useAppStore.getState().selectDrawingIds(additive
      ? selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
      : [id]);
  };
  return <section className="pcad-panel pcad-panel--left">
    <h2 className="pcad-panel__title">{t('drawing.tree.title')}</h2>
    <div className="pcad-panel__body">
      {drawing === null ? null : <button type="button" className="pcad-button pcad-drawing-tree-sheet"
        title={drawing.name} aria-pressed={selected.length === 0}
        onClick={() => useAppStore.getState().selectDrawingIds([])}>{drawing.name} — {paperSizeOf(drawing.sheet.paperSizeId)?.label ?? t('drawing.tree.sheet')}</button>}
      {groups.map((group) => <details className="pcad-drawing-tree-group" key={group.key}
        open={!collapsed.has(group.id)} onToggle={(event) => {
          const open = event.currentTarget.open;
          setCollapsed((previous) => {
            if (previous.has(group.id) === !open) return previous;
            const next = new Set(previous);
            if (open) next.delete(group.id); else next.add(group.id);
            return next;
          });
        }}>
        <summary className="pcad-tree__row pcad-tree__row--section" title={t(groupLabels[group.id])}>
          {group.id === 'layers' ? <LayersIcon size={14} /> : <PlaneSectionIcon size={14} />}
          <span className="pcad-tree__label">{t(groupLabels[group.id])}</span>
          <span className="pcad-tree__count">{group.rows.length}</span>
        </summary>
        <ul className="pcad-tree">
          {group.rows.length === 0 ? <li className="pcad-drawing-tree-empty">{t('drawing.tree.empty')}</li> : null}
          {group.rows.map((row) => <li key={row.key} className="pcad-tree__row">
            <button type="button" className={`pcad-button pcad-tree__label${row.kind === 'dimension' ? ' pcad-drawing-tree-dimension' : ''}`}
              title={row.label} aria-pressed={selected.includes(row.id)}
              onClick={(event) => select(row.id, event.ctrlKey || event.metaKey)}>
              {row.unresolved ? <span className="pcad-drawing-tree-unresolved" aria-label={t('drawing.dimension.unresolvedCount').replace('{count}', '1')}>!</span> : null}
              {row.label}
            </button>
          </li>)}
        </ul>
      </details>)}
    </div>
  </section>;
}
