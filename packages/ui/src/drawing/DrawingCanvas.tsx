import { renderDrawing, resolveStyle, toSvg, type Point2 } from '@pointercad/drawing';
import { resolveDrawingDimensions } from '@pointercad/model';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingDimension } from './dimensionDisplay.js';
import { beginDrawingDimensionDrag, finishDrawingDimensionDrag, pickDrawingTarget, previewDrawingDimensionDrag,
  type DrawingDimensionDrag } from './dimensionCommands.js';
import { pickDrawingGeometry } from './drawingPick.js';
import { DrawingTolerancePopover } from './DrawingTolerancePopover.js';
import { DrawingAnnotationPopover } from './DrawingAnnotationPopover.js';
import { displayDrawingAnnotations } from './annotationDisplay.js';
import { DrawingNotePopover } from './DrawingNotePopover.js';
import { drawingNoteBounds } from './noteDisplay.js';
import { displayDrawingTables } from './tableDisplay.js';
import { drawingProjectionRenderViews, selectedDrawingProjectionOwners } from './projectionDisplay.js';
import { selectedDrawingComponents, selectedDrawingTableRows } from './drawingSelection.js';
import { beginDrawingTableDrag, commitDrawingBalloon, finishDrawingTableDrag, previewDrawingTableDrag, type DrawingTableDrag } from './tableCommands.js';
import { beginDrawingAnnotationDrag, finishDrawingAnnotationDrag, previewDrawingAnnotationDrag, type DrawingAnnotationDrag } from './noteCommands.js';

export function DrawingCanvas(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const resolution = useAppStore((state) => state.drawingResolution);
  const selectedIds = useAppStore((state) => state.drawingSelectedIds);
  const source = useAppStore((state) => state.drawingSourceResolution);
  const targets = useAppStore((state) => state.drawingTargets);
  const busy = useAppStore((state) => state.drawingBusy);
  const tool = useAppStore((state) => state.drawingTool);
  const library = useAppStore((state) => state.drawingSources);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<DrawingDimensionDrag | null>(null);
  const noteDrag = useRef<DrawingAnnotationDrag | null>(null);
  const tableDrag = useRef<DrawingTableDrag | null>(null);
  const [notePlacement, setNotePlacement] = useState<{ readonly point: Point2; readonly anchor: Point2 } | null>(null);
  useEffect(() => useAppStore.subscribe((next, previous) => {
    if (next.drawing?.id !== previous.drawing?.id || next.drawingTool !== previous.drawingTool) {
      setNotePlacement(null); noteDrag.current = null; drag.current = null; tableDrag.current = null;
    }
  }), []);
  const [fontStatus, setFontStatus] = useState(drawingFont.status);
  // ポインター中の表示だけ。離すまで保存文書・Undo履歴は変えない。
  const [dragPoint, setDragPoint] = useState<Point2 | null>(null);
  useEffect(() => {
    let detached = false;
    void drawingFont.load().then((status) => { if (!detached) setFontStatus(status); });
    return () => { detached = true; };
  }, []);
  // 保存参照の照合は再評価結果を共有する。選択やドラッグの毎フレームには持ち込まない。
  const dimensions = useMemo(() => {
    if (drawing === null || source === null) return [];
    return resolution?.ok === true && resolution.document === drawing ? resolution.dimensions
      : resolveDrawingDimensions(drawing, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
  }, [drawing, source, resolution]);
  const annotations = useMemo(() => drawing === null || fontStatus !== 'ready' ? []
    : displayDrawingAnnotations(drawing, source ?? { bodyIds: [], center: [0, 0, 0] }, library, drawingFont.outline), [drawing, source, library, fontStatus]);
  const shown = useMemo(() => {
    if (drawing === null || fontStatus !== 'ready') return null;
    const preview = drag.current !== null && drag.current.document === drawing && dragPoint !== null
      ? previewDrawingDimensionDrag(drag.current, dragPoint) : null;
    const annotationPreview = noteDrag.current !== null && noteDrag.current.document === drawing && dragPoint !== null
      ? previewDrawingAnnotationDrag(noteDrag.current, dragPoint) : null;
    const tablePreview = tableDrag.current !== null && tableDrag.current.document === drawing && dragPoint !== null
      ? previewDrawingTableDrag(tableDrag.current, dragPoint) : drawing;
    const document = { ...tablePreview,
      dimensions: preview === null ? drawing.dimensions : drawing.dimensions.map((item) => item.id === preview.id ? preview : item),
      annotations: annotationPreview === null ? drawing.annotations : drawing.annotations.map((item) => item.id === annotationPreview.id ? annotationPreview : item) };
    const shownAnnotations = annotationPreview === null ? annotations : displayDrawingAnnotations(document,
      source ?? { bodyIds: [], center: [0, 0, 0] }, library, drawingFont.outline);
    const displays = dimensions.map((dimension) => displayDrawingDimension(document,
      preview !== null && preview.id === dimension.dimension.id ? { ...dimension, dimension: preview } : dimension, drawingFont.outline));
    const views = resolution?.ok === true ? resolution.projection.views : [];
    const tables = displayDrawingTables(document, source, drawingFont.outline);
    const rendered = renderDrawing({ document, views: drawingProjectionRenderViews(views),
      elements: [...displays.map((display) => display.element), ...shownAnnotations, ...tables.elements] }, { outlineText: drawingFont.outline });
    const components = selectedDrawingComponents(document, selectedIds, targets);
    const highlightedIds = new Set(selectedDrawingProjectionOwners(views, [...selectedIds, ...[...components].map((id) => `component:${id}`)]));
    for (const item of document.balloons) if (item.componentIds.some((id) => components.has(id))) highlightedIds.add(item.id);
    for (const owner of selectedDrawingTableRows(tables.items, selectedIds, components)) highlightedIds.add(owner);
    const primitives = rendered.document.primitives.map((primitive) => {
      if (!highlightedIds.has(primitive.ownerId)) return primitive;
      return primitive.kind === 'path' ? { ...primitive, stroke: primitive.stroke === null ? null : { ...primitive.stroke, color: '#2563eb' },
        fill: primitive.fill === null ? null : '#2563eb' } : { ...primitive, fill: '#2563eb' };
    });
    return { svg: toSvg({ ...rendered.document, primitives }), height: rendered.document.heightMm, displays, views, tables };
  }, [drawing, dimensions, annotations, resolution, selectedIds, targets, dragPoint, fontStatus, source, library]);

  function paperPoint(event: React.PointerEvent): { readonly point: Point2; readonly tolerance: number } | null {
    const svg = container.current?.querySelector('svg');
    const matrix = svg?.getScreenCTM();
    if (matrix == null || shown === null) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const scale = Math.hypot(matrix.a, matrix.b);
    return { point: [point.x, shown.height - point.y], tolerance: 7 / Math.max(scale, 0.01) };
  }
  return <div className="pcad-drawing-viewport" data-testid="drawing-viewport">
    <div className="pcad-drawing-sheet" aria-label={drawing?.name ?? t('drawing.mode')}
      ref={container} tabIndex={0}
      onPointerDown={(event) => {
        if (busy || event.button !== 0 || shown === null || drawing === null) return;
        const hit = paperPoint(event);
        if (hit === null) return;
        if (tool === 'balloon') {
          if (targets.length === 1) commitDrawingBalloon(hit.point);
          else if (source !== null) {
            const picked = pickDrawingGeometry(drawing, source, shown.views, hit.point, hit.tolerance);
            if (picked?.kind === 'subShape' && picked.componentId !== undefined) pickDrawingTarget(picked);
          }
          event.preventDefault(); return;
        }
        const pickedTable = shown.tables.items.find((item) => {
          const element = drawing.tables.find((table) => table.id === item.id) ?? drawing.balloons.find((entry) => entry.id === item.id);
          return element !== undefined && resolveStyle(element, drawing.layers)?.visible === true
            && hit.point[0] >= item.bounds.left - hit.tolerance && hit.point[0] <= item.bounds.right + hit.tolerance
            && hit.point[1] >= item.bounds.bottom - hit.tolerance && hit.point[1] <= item.bounds.top + hit.tolerance;
        });
        if (pickedTable !== undefined && tool === 'select') {
          let y = pickedTable.bounds.top;
          let componentIds = pickedTable.rowHeights.length === 0 ? pickedTable.rowComponentIds[0] ?? [] : [];
          for (let index = 0; index < pickedTable.rowHeights.length; index++) {
            const nextY = y - pickedTable.rowHeights[index];
            if (index > 0 && hit.point[1] <= y && hit.point[1] >= nextY) componentIds = pickedTable.rowComponentIds[index - 1] ?? [];
            y = nextY;
          }
          // 関連する風船は描画だけで強調する。削除の対象へ追加しない。
          useAppStore.getState().selectDrawingIds([pickedTable.id, ...componentIds.map((id) => `component:${id}`)]);
          tableDrag.current = beginDrawingTableDrag(pickedTable.id, hit.point);
          event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); event.preventDefault(); return;
        }
        if (tool === 'note') {
          setNotePlacement({ point: hit.point, anchor: [event.clientX, event.clientY] });
          useAppStore.getState().selectDrawingIds([]); event.preventDefault(); return;
        }
        const pickedNote = drawing.annotations.find((annotation) => {
          const bounds = drawingNoteBounds(annotation, drawingFont.outline);
          return bounds !== null && resolveStyle(annotation, drawing.layers)?.visible === true
            && hit.point[0] >= bounds.left - hit.tolerance && hit.point[0] <= bounds.right + hit.tolerance
            && hit.point[1] >= bounds.bottom - hit.tolerance && hit.point[1] <= bounds.top + hit.tolerance;
        });
        if (pickedNote !== undefined) {
          useAppStore.getState().selectDrawingIds([pickedNote.id]);
          setNotePlacement({ point: pickedNote.position, anchor: [event.clientX, event.clientY] });
          noteDrag.current = beginDrawingAnnotationDrag(pickedNote.id, hit.point);
          event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); event.preventDefault(); return;
        }
        const dimension = shown.displays.find((display) => {
          const bounds = display.bounds;
          return bounds !== null && resolveStyle(display.element, drawing.layers)?.visible === true
            && hit.point[0] >= bounds.left - hit.tolerance && hit.point[0] <= bounds.right + hit.tolerance
            && hit.point[1] >= bounds.bottom - hit.tolerance && hit.point[1] <= bounds.top + hit.tolerance;
        });
        if (dimension !== undefined) {
          useAppStore.getState().selectDrawingIds([dimension.element.ownerId]);
          drag.current = beginDrawingDimensionDrag(dimension.element.ownerId, dimension.normal, dimension.textPosition, hit.point);
          event.currentTarget.setPointerCapture(event.pointerId);
        } else {
          const picked = source === null ? null : pickDrawingGeometry(drawing, source, shown.views, hit.point, hit.tolerance);
          if (picked !== null) pickDrawingTarget(picked, event.shiftKey || event.ctrlKey || (useAppStore.getState().drawingTool === 'dimension' && targets.length > 0));
          else useAppStore.getState().selectDrawingIds([]);
        }
        event.currentTarget.focus();
        event.preventDefault();
      }}
      onPointerMove={(event) => { const point = paperPoint(event); if ((drag.current !== null || noteDrag.current !== null || tableDrag.current !== null) && point !== null) setDragPoint(point.point); }}
      onPointerUp={(event) => {
        const point = paperPoint(event);
        if (drag.current !== null && point !== null) finishDrawingDimensionDrag(drag.current, point.point);
        if (noteDrag.current !== null && point !== null) finishDrawingAnnotationDrag(noteDrag.current, point.point);
        if (tableDrag.current !== null && point !== null) finishDrawingTableDrag(tableDrag.current, point.point);
        drag.current = null; noteDrag.current = null; tableDrag.current = null; setDragPoint(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; noteDrag.current = null; tableDrag.current = null; setDragPoint(null); }}>
      {shown?.svg == null ? <p className="pcad-viewport__empty-text">{t(fontStatus === 'ready' ? 'drawing.viewport.empty' : 'drawing.status.computing')}</p>
        : <div className="pcad-drawing-svg" dangerouslySetInnerHTML={{ __html: shown.svg }} />}
    </div>
    {fontStatus === 'failed' ? <p role="alert" className="pcad-drawing-notice">{t('drawing.error.fontFailed')}</p> : null}
    {shown !== null && shown.tables.unresolved.length > 0 ? <p role="alert" className="pcad-drawing-notice">{t('drawing.table.unresolved')}</p> : null}
    {targets.length > 0 ? <p className="pcad-drawing-notice">{t('drawing.dimension.selectHint')}</p> : null}
    {tool === 'note' && notePlacement !== null ? <DrawingNotePopover key={`new:${JSON.stringify(notePlacement.point)}`} position={notePlacement.point} anchor={notePlacement.anchor} /> : null}
    {tool === 'select' ? drawing?.annotations.filter((annotation) => selectedIds.length === 1 && selectedIds[0] === annotation.id
      && (annotation.kind === 'note' || annotation.kind === 'leaderNote') && annotation.sourceTarget === undefined)
      .map((annotation) => <DrawingNotePopover key={`note:${JSON.stringify(annotation)}`} annotation={annotation}
        {...(notePlacement === null ? {} : { anchor: notePlacement.anchor })} />) : null}
    {tool === 'annotation' && targets.length === 1 ? <DrawingAnnotationPopover key={JSON.stringify(targets[0])} target={targets[0]} /> : null}
    {drawing?.dimensions.filter((dimension) => selectedIds.length === 1 && selectedIds[0] === dimension.id)
      .map((dimension) => <DrawingTolerancePopover key={`tolerance:${dimension.id}:${JSON.stringify([dimension.tolerance, dimension.fit])}`} dimension={dimension} />)}
  </div>;
}
