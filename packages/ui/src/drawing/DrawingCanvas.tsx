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
  const annotations = useMemo(() => drawing === null || source === null || fontStatus !== 'ready' ? []
    : displayDrawingAnnotations(drawing, source, library, drawingFont.outline), [drawing, source, library, fontStatus]);
  const shown = useMemo(() => {
    if (drawing === null || fontStatus !== 'ready') return null;
    const preview = drag.current !== null && drag.current.document === drawing && dragPoint !== null
      ? previewDrawingDimensionDrag(drag.current, dragPoint) : null;
    const document = preview === null ? drawing : { ...drawing, dimensions: drawing.dimensions.map((item) => item.id === preview.id ? preview : item) };
    const displays = dimensions.map((dimension) => displayDrawingDimension(document,
      preview !== null && preview.id === dimension.dimension.id ? { ...dimension, dimension: preview } : dimension, drawingFont.outline));
    const views = resolution?.ok === true ? resolution.projection.views : [];
    const rendered = renderDrawing({ document, views, elements: [...displays.map((display) => display.element), ...annotations] }, { outlineText: drawingFont.outline });
    const primitives = rendered.document.primitives.map((primitive) => {
      if (!selectedIds.includes(primitive.ownerId)) return primitive;
      return primitive.kind === 'path' ? { ...primitive, stroke: primitive.stroke === null ? null : { ...primitive.stroke, color: '#2563eb' },
        fill: primitive.fill === null ? null : '#2563eb' } : { ...primitive, fill: '#2563eb' };
    });
    return { svg: toSvg({ ...rendered.document, primitives }), height: rendered.document.heightMm, displays, views };
  }, [drawing, dimensions, annotations, resolution, selectedIds, dragPoint, fontStatus]);

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
        if (busy || event.button !== 0 || shown === null || drawing === null || source === null) return;
        const hit = paperPoint(event);
        if (hit === null) return;
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
          const picked = pickDrawingGeometry(drawing, source, shown.views, hit.point, hit.tolerance);
          if (picked !== null) pickDrawingTarget(picked, event.shiftKey || event.ctrlKey || (useAppStore.getState().drawingTool === 'dimension' && targets.length > 0));
          else useAppStore.getState().selectDrawingIds([]);
        }
        event.currentTarget.focus();
        event.preventDefault();
      }}
      onPointerMove={(event) => { const point = paperPoint(event); if (drag.current !== null && point !== null) setDragPoint(point.point); }}
      onPointerUp={(event) => {
        const point = paperPoint(event);
        if (drag.current !== null && point !== null) finishDrawingDimensionDrag(drag.current, point.point);
        drag.current = null; setDragPoint(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; setDragPoint(null); }}>
      {shown?.svg == null ? <p className="pcad-viewport__empty-text">{t(fontStatus === 'ready' ? 'drawing.viewport.empty' : 'drawing.status.computing')}</p>
        : <div className="pcad-drawing-svg" dangerouslySetInnerHTML={{ __html: shown.svg }} />}
    </div>
    {fontStatus === 'failed' ? <p role="alert" className="pcad-drawing-notice">{t('drawing.error.fontFailed')}</p> : null}
    {targets.length > 0 ? <p className="pcad-drawing-notice">{t('drawing.dimension.selectHint')}</p> : null}
    {tool === 'annotation' && targets.length === 1 ? <DrawingAnnotationPopover key={JSON.stringify(targets[0])} target={targets[0]} /> : null}
    {drawing?.dimensions.filter((dimension) => selectedIds.length === 1 && selectedIds[0] === dimension.id)
      .map((dimension) => <DrawingTolerancePopover key={`tolerance:${dimension.id}:${JSON.stringify([dimension.tolerance, dimension.fit])}`} dimension={dimension} />)}
  </div>;
}
