import { drawingDimensionContext, moveDrawingManufacturing, resolveDrawingGdt, resolveDrawingWelds } from '@pointercad/model';
import { renderDrawing, renderDrawingElements, resolveStyle, toSvg, type DrawingDocument, type DrawingRenderElement, type Point2 } from '@pointercad/drawing';
import { resolveDimensionTarget, resolveDrawingDimensions } from '@pointercad/model';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingGdt } from './gdtDisplay.js';
import { displayDrawingWelds } from './weldDisplay.js';
import { displayDrawingDimension } from './dimensionDisplay.js';
import { beginDrawingDimensionDrag, finishDrawingDimensionDrag, pickDrawingTarget, previewDrawingDimensionsDrag,
  type DrawingDimensionDrag } from './dimensionCommands.js';
import { pickDrawingGeometry } from './drawingPick.js';
import { DrawingAnnotationPopover } from './DrawingAnnotationPopover.js';
import { displayDrawingAnnotations } from './annotationDisplay.js';
import { DrawingNotePopover } from './DrawingNotePopover.js';
import { drawingNoteBounds } from './noteDisplay.js';
import { displayDrawingTables } from './tableDisplay.js';
import { drawingProjectionRenderViews, selectedDrawingProjectionOwners } from './projectionDisplay.js';
import { selectedDrawingComponents, selectedDrawingTableRows } from './drawingSelection.js';
import { selectedDrawingElementIds } from './selectedDrawingElementIds.js';
import { beginDrawingTableDrag, commitDrawingBalloon, finishDrawingTableDrag, previewDrawingTableDrag, type DrawingTableDrag } from './tableCommands.js';
import { beginDrawingAnnotationDrag, finishDrawingAnnotationDrag, previewDrawingAnnotationDrag, type DrawingAnnotationDrag } from './noteCommands.js';
import { createDrawingSvgPreview, createDrawingTranslationPreview } from './drawingSvgPreview.js';
import { beginDrawingViewDrag, finishDrawingViewDrag, previewDrawingViewDrag, type DrawingViewDrag } from './viewDragCommands.js';

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
  const dimensionSvgPreview = useRef<ReturnType<typeof createDrawingSvgPreview> | null>(null);
  const viewDrag = useRef<DrawingViewDrag | null>(null);
  const viewSvgPreview = useRef<ReturnType<typeof createDrawingTranslationPreview> | null>(null);
  const noteDrag = useRef<DrawingAnnotationDrag | null>(null);
  const tableDrag = useRef<DrawingTableDrag | null>(null);
  const gdtDrag = useRef<{ readonly document: DrawingDocument; readonly ids: ReadonlySet<string>; readonly start: Point2 } | null>(null);
  const [notePlacement, setNotePlacement] = useState<{ readonly point: Point2; readonly anchor: Point2 } | null>(null);
  useEffect(() => useAppStore.subscribe((next, previous) => {
    if (next.drawing !== previous.drawing || next.drawingTool !== previous.drawingTool) {
      dimensionSvgPreview.current?.restore(); dimensionSvgPreview.current = null;
      viewSvgPreview.current?.restore(); viewSvgPreview.current = null; viewDrag.current = null;
      setNotePlacement(null); noteDrag.current = null; drag.current = null; tableDrag.current = null; gdtDrag.current = null;
    }
  }), []);
  useEffect(() => () => { dimensionSvgPreview.current?.restore(); viewSvgPreview.current?.restore(); }, []);
  const [fontStatus, setFontStatus] = useState(drawingFont.status);
  // ポインター中の表示だけ。離すまで保存文書・Undo履歴は変えない。
  const [dragPoint, setDragPoint] = useState<Point2 | null>(null);
  const [dimensionDragStart, setDimensionDragStart] = useState(0);
  useEffect(() => {
    let detached = false;
    void drawingFont.load().then((status) => { if (!detached) setFontStatus(status); });
    return () => { detached = true; };
  }, []);
  // 保存参照の照合は再評価結果を共有する。選択やドラッグの毎フレームには持ち込まない。
  const dimensions = useMemo(() => {
    if (drawing === null || source === null) return [];
    return resolution?.ok === true && resolution.document === drawing ? resolution.dimensions
      : resolveDrawingDimensions(drawing, drawingDimensionContext(source));
  }, [drawing, source, resolution]);
  const gdt = useMemo(() => drawing === null || source === null ? { datums: [], frames: [], unresolvedCount: 0 }
    : resolveDrawingGdt(drawing, drawingDimensionContext(source)), [drawing, source]);
  const welds = useMemo(() => drawing === null || source === null ? [] : resolveDrawingWelds(drawing, drawingDimensionContext(source)), [drawing, source]);
  const annotations = useMemo(() => drawing === null || fontStatus !== 'ready' ? []
    : displayDrawingAnnotations(drawing, source ?? { bodyIds: [], center: [0, 0, 0] }, library, drawingFont.outline), [drawing, source, library, fontStatus]);
  const shown = useMemo(() => {
    if (drawing === null || fontStatus !== 'ready') return null;
    const previews = drag.current !== null && drag.current.document === drawing && dragPoint !== null
      ? previewDrawingDimensionsDrag(drag.current, dragPoint) : null;
    const preview = new Map(previews?.map((item) => [item.id, item]));
    const annotationPreview = noteDrag.current !== null && noteDrag.current.document === drawing && dragPoint !== null
      ? previewDrawingAnnotationDrag(noteDrag.current, dragPoint) : null;
    const tablePreview = tableDrag.current !== null && tableDrag.current.document === drawing && dragPoint !== null
      ? previewDrawingTableDrag(tableDrag.current, dragPoint) : drawing;
    const manufacturingPreview = gdtDrag.current !== null && gdtDrag.current.document === drawing && dragPoint !== null
      ? moveDrawingManufacturing(tablePreview, gdtDrag.current.ids, [dragPoint[0] - gdtDrag.current.start[0], dragPoint[1] - gdtDrag.current.start[1]]) : tablePreview;
    const document = { ...manufacturingPreview,
      dimensions: previews === null ? drawing.dimensions : drawing.dimensions.map((item) => preview.get(item.id) ?? item),
      annotations: annotationPreview === null ? drawing.annotations : drawing.annotations.map((item) => item.id === annotationPreview.id ? annotationPreview : item) };
    const shownAnnotations = annotationPreview === null ? annotations : displayDrawingAnnotations(document,
      source ?? { bodyIds: [], center: [0, 0, 0] }, library, drawingFont.outline);
    const displays = dimensions.map((dimension) => {
      const changed = preview.get(dimension.dimension.id);
      return displayDrawingDimension(document, changed === undefined ? dimension : { ...dimension, dimension: changed },
        drawingFont.outline, { viewFrames: source?.viewFrames });
    });
    const views = resolution?.ok === true ? resolution.projection.views : [];
    const tables = displayDrawingTables(document, source, drawingFont.outline);
    const manufacturing = [...displayDrawingGdt(document, gdt, displays, drawingFont.outline), ...displayDrawingWelds(document, welds, drawingFont.outline)];
    const selectionLayer = document.layers.find((layer) => layer.visible);
    const targetMarkers: DrawingRenderElement[] = source === null || selectionLayer === undefined ? [] : targets.flatMap((target, index) => {
      const resolved = resolveDimensionTarget(target, document, drawingDimensionContext(source));
      if (resolved?.kind !== 'point') return [];
      return [{ ownerId: `drawing-target-${index}`, layerId: selectionLayer.id, style: { color: '#2563eb' },
        curves: [{ kind: 'arc', center: resolved.paperPoint, radius: 0.8, startAngle: 0, endAngle: Math.PI * 2 }],
        texts: [{ text: String(index + 1), position: [resolved.paperPoint[0] + 2, resolved.paperPoint[1] + 2], sizeMm: 3.5 }] }];
    });
    const rendered = renderDrawing({ document, views: drawingProjectionRenderViews(views),
      elements: [...displays.map((display) => display.element), ...shownAnnotations, ...tables.elements,
        ...manufacturing.map((display) => display.element), ...targetMarkers] }, { outlineText: drawingFont.outline });
    const displayedSelection = [...selectedDrawingElementIds(document, selectedIds)];
    const components = selectedDrawingComponents(document, displayedSelection, targets);
    const highlightedIds = new Set(selectedDrawingProjectionOwners(views, [...displayedSelection, ...[...components].map((id) => `component:${id}`)]));
    for (const item of document.balloons) if (item.componentIds.some((id) => components.has(id))) highlightedIds.add(item.id);
    for (const owner of selectedDrawingTableRows(tables.items, displayedSelection, components)) highlightedIds.add(owner);
    const primitives = rendered.document.primitives.map((primitive) => {
      if (!highlightedIds.has(primitive.ownerId)) return primitive;
      return primitive.kind === 'path' ? { ...primitive, stroke: primitive.stroke === null ? null : { ...primitive.stroke, color: '#2563eb' },
        fill: primitive.fill === null ? null : '#2563eb' } : { ...primitive, fill: '#2563eb' };
    });
    return { svg: toSvg({ ...rendered.document, primitives }), height: rendered.document.heightMm, displays, views, tables, manufacturing };
  }, [drawing, dimensions, annotations, resolution, selectedIds, targets, dragPoint, fontStatus, source, library, gdt, welds]);

  function paperPoint(event: React.PointerEvent): { readonly point: Point2; readonly tolerance: number } | null {
    const svg = container.current?.querySelector('svg');
    const matrix = svg?.getScreenCTM();
    if (matrix == null || shown === null) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const scale = Math.hypot(matrix.a, matrix.b);
    return { point: [point.x, shown.height - point.y], tolerance: 7 / Math.max(scale, 0.01) };
  }
  const previewDimension = useCallback((point: Point2): boolean => {
    const current = drag.current;
    if (current === null || drawing === null || current.document !== drawing || busy || shown === null) return false;
    const changed = previewDrawingDimensionsDrag(current, point);
    const svg = container.current?.querySelector('svg');
    if (changed === null || svg === null || svg === undefined) return false;
    const previews = [];
    for (const dimension of changed) {
      const resolved = dimensions.find((item) => item.dimension.id === dimension.id); if (resolved === undefined) return false;
      previews.push(displayDrawingDimension(drawing, { ...resolved, dimension }, drawingFont.outline, { viewFrames: source?.viewFrames }));
    }
    const changedIds = new Set(changed.map((item) => item.id));
    const attached = { ...gdt, datums: gdt.datums.filter((item) => changedIds.has(item.datum.sizeDimensionId ?? '')),
      frames: gdt.frames.filter((item) => changedIds.has(item.frame.sizeDimensionId ?? '')) };
    const manufacturing = displayDrawingGdt(drawing, attached, previews, drawingFont.outline);
    const elements = [...previews.map((item) => item.element), ...manufacturing.map((item) => item.element)]
      .map((element) => selectedIds.includes(element.ownerId) ? { ...element, style: { ...element.style, color: '#2563eb' } } : element);
    const rendered = renderDrawingElements(drawing, elements, { outlineText: drawingFont.outline });
    dimensionSvgPreview.current ??= createDrawingSvgPreview(svg, new Set(elements.map((element) => element.ownerId)));
    return dimensionSvgPreview.current.update(rendered.document);
  }, [drawing, busy, shown, dimensions, gdt, source, selectedIds]);
  // 選択表示のDOMが確定した時点で差替え枠と最初の輪郭を用意する。
  // 最初のpointermoveへ全SVGの走査・退避・解析の初期費用を持ち込まない。
  useLayoutEffect(() => {
    const current = drag.current;
    if (current !== null && current.document === drawing) previewDimension(current.start);
    return () => { dimensionSvgPreview.current?.restore(); dimensionSvgPreview.current = null; };
  }, [dimensionDragStart, drawing, previewDimension]);
  return <div className="pcad-drawing-viewport" data-testid="drawing-viewport">
    <div className="pcad-drawing-sheet" aria-label={drawing?.name ?? t('drawing.mode')}
      ref={container} tabIndex={0}
      onPointerDown={(event) => {
        if (busy || event.button !== 0 || shown === null || drawing === null) return;
        const hit = paperPoint(event);
        if (hit === null) return;
        if (tool === 'datum' || tool === 'gdt' || tool === 'weld') {
          const picked = source === null ? null : pickDrawingGeometry(drawing, source, shown.views, hit.point, hit.tolerance);
          if (picked?.kind === 'subShape' && picked.ref.fingerprint.kind !== 'vertex') pickDrawingTarget(picked, event.shiftKey || event.ctrlKey);
          else useAppStore.getState().setDrawingMessage(t(tool === 'weld' ? 'drawing.weld.pick' : 'drawing.gdt.pick'));
          event.currentTarget.focus(); event.preventDefault(); return;
        }
        const pickedGdt = shown.manufacturing.find((item) => resolveStyle(item.element, drawing.layers)?.visible === true
          && hit.point[0] >= item.bounds.left - hit.tolerance && hit.point[0] <= item.bounds.right + hit.tolerance
          && hit.point[1] >= item.bounds.bottom - hit.tolerance && hit.point[1] <= item.bounds.top + hit.tolerance);
        if (tool === 'select' && pickedGdt !== undefined) {
          const ids = event.ctrlKey || event.shiftKey ? selectedIds.includes(pickedGdt.id) ? selectedIds.filter((id) => id !== pickedGdt.id)
            : [...selectedIds, pickedGdt.id] : selectedIds.includes(pickedGdt.id) ? selectedIds : [pickedGdt.id];
          useAppStore.getState().selectDrawingIds(ids);
          if (ids.includes(pickedGdt.id)) gdtDrag.current = { document: drawing, ids: new Set(ids), start: hit.point };
          event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); event.preventDefault(); return;
        }
        if (tool === 'dimensionSeries') {
          const picked = source === null ? null : pickDrawingGeometry(drawing, source, shown.views, hit.point, hit.tolerance);
          if (picked !== null) pickDrawingTarget(picked, true);
          event.currentTarget.focus(); event.preventDefault(); return;
        }
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
          const id = dimension.element.ownerId;
          const ids = event.ctrlKey || event.shiftKey ? selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]
            : selectedIds.includes(id) ? selectedIds : [id];
          useAppStore.getState().selectDrawingIds(ids);
          drag.current = ids.includes(id) ? beginDrawingDimensionDrag(id, dimension.normal, dimension.textPosition, hit.point,
            shown.displays.filter((item) => ids.includes(item.element.ownerId)).map((item) => ({ id: item.element.ownerId, normal: item.normal, textPosition: item.textPosition }))) : null;
          if (drag.current !== null) {
            setDimensionDragStart((value) => value + 1);
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        } else {
          const picked = source === null ? null : pickDrawingGeometry(drawing, source, shown.views, hit.point, hit.tolerance);
          if (picked !== null && tool === 'select' && selectedIds.includes(picked.viewId) && !event.shiftKey && !event.ctrlKey) {
            const svg = container.current?.querySelector('svg');
            viewDrag.current = beginDrawingViewDrag(picked.viewId, hit.point,
              new Map(shown.displays.map((item) => [item.element.ownerId, item.normal])));
            if (viewDrag.current !== null && svg != null) {
              viewSvgPreview.current = createDrawingTranslationPreview(svg, picked.viewId, viewDrag.current.relatedIds);
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          } else if (picked !== null) pickDrawingTarget(picked, event.shiftKey || event.ctrlKey || (useAppStore.getState().drawingTool === 'dimension' && targets.length > 0));
          else useAppStore.getState().selectDrawingIds([]);
        }
        event.currentTarget.focus();
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (viewDrag.current !== null) {
          const point = paperPoint(event), current = viewDrag.current;
          if (!busy && point !== null && previewDrawingViewDrag(current, point.point) !== null) {
            viewSvgPreview.current?.update([point.point[0] - current.start[0], point.point[1] - current.start[1]]);
          }
          return;
        }
        if (drag.current === null && noteDrag.current === null && tableDrag.current === null && gdtDrag.current === null) return;
        const point = paperPoint(event); if (point === null || previewDimension(point.point)) return;
        dimensionSvgPreview.current?.restore(); dimensionSvgPreview.current = null;
        setDragPoint(point.point);
      }}
      onPointerUp={(event) => {
        const point = paperPoint(event);
        dimensionSvgPreview.current?.restore(); dimensionSvgPreview.current = null;
        viewSvgPreview.current?.restore(); viewSvgPreview.current = null;
        if (viewDrag.current !== null && point !== null) finishDrawingViewDrag(viewDrag.current, point.point);
        if (drag.current !== null && point !== null) finishDrawingDimensionDrag(drag.current, point.point);
        if (noteDrag.current !== null && point !== null) finishDrawingAnnotationDrag(noteDrag.current, point.point);
        if (tableDrag.current !== null && point !== null) finishDrawingTableDrag(tableDrag.current, point.point);
        if (gdtDrag.current !== null && point !== null) {
          const state = useAppStore.getState(), current = gdtDrag.current;
          if (!state.drawingBusy && state.drawing === current.document && state.drawingTool === 'select') {
            const next = moveDrawingManufacturing(current.document, current.ids, [point.point[0] - current.start[0], point.point[1] - current.start[1]]);
            if (next !== current.document) state.applyDrawing(next);
          }
        }
        drag.current = null; noteDrag.current = null; tableDrag.current = null; gdtDrag.current = null; viewDrag.current = null; setDragPoint(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dimensionSvgPreview.current?.restore(); dimensionSvgPreview.current = null;
        viewSvgPreview.current?.restore(); viewSvgPreview.current = null; viewDrag.current = null;
        drag.current = null; noteDrag.current = null; tableDrag.current = null; gdtDrag.current = null; setDragPoint(null); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { dimensionSvgPreview.current?.restore(); dimensionSvgPreview.current = null;
        viewSvgPreview.current?.restore(); viewSvgPreview.current = null; viewDrag.current = null;
        drag.current = null; noteDrag.current = null; tableDrag.current = null; gdtDrag.current = null; setDragPoint(null); } }}>
      {shown?.svg == null ? <p className="pcad-viewport__empty-text">{t(fontStatus === 'ready' ? 'drawing.viewport.empty' : 'drawing.status.computing')}</p>
        : <div className="pcad-drawing-svg" dangerouslySetInnerHTML={{ __html: shown.svg }} />}
    </div>
    {fontStatus === 'failed' ? <p role="alert" className="pcad-drawing-notice">{t('drawing.error.fontFailed')}</p> : null}
    {shown !== null && shown.tables.unresolved.length > 0 ? <p role="alert" className="pcad-drawing-notice">{t('drawing.table.unresolved')}</p> : null}
    {shown?.manufacturing.some((item) => item.unresolved) === true ? <div role="alert" className="pcad-drawing-notice"><p>{t('drawing.manufacturing.outputUnresolved')}</p>
      <ul>{shown.manufacturing.filter((item) => item.unresolved).map((item) => <li key={item.id}><button type="button" className="pcad-button"
        onClick={() => useAppStore.getState().selectDrawingIds([item.id])}>{item.id}: {item.messages.join(' ')}</button></li>)}</ul></div> : null}
    {targets.length > 0 ? <p className="pcad-drawing-notice">{t('drawing.dimension.selectHint')}</p> : null}
    {tool === 'note' && notePlacement !== null ? <DrawingNotePopover key={`new:${JSON.stringify(notePlacement.point)}`} position={notePlacement.point} anchor={notePlacement.anchor} /> : null}
    {tool === 'annotation' && targets.length === 1 ? <DrawingAnnotationPopover key={JSON.stringify(targets[0])} target={targets[0]} /> : null}
  </div>;
}
