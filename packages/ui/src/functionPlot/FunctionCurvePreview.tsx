import { useEffect, useRef, useState } from 'react';
import type { FunctionDefinition, ResolvedSpline, Vec3 } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useFunctionPreviewFocus } from './useFunctionPreviewFocus.js';
import { createFunctionPreviewProjection } from './functionPreviewProjection.js';
import { drawFunctionCurve } from './drawFunctionCurve.js';

/** Rotate the actual CAD curves, preserving native cubic spans and separate clipped polylines. */
export function FunctionCurvePreview({ definition, curves }: {
  readonly definition: FunctionDefinition; readonly curves: readonly ResolvedSpline[];
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null), drag = useRef<{ x: number; y: number } | null>(null);
  const figure = useFunctionPreviewFocus();
  const [rotation, setRotation] = useState({ yaw: -Math.PI / 4, pitch: 0.6 });
  useEffect(() => {
    const element = canvas.current, context = element?.getContext('2d');
    if (!element || !context) return;
    const { X, Y, Z } = definition.bounds;
    const projection = createFunctionPreviewProjection([X.min.value, Y.min.value, Z.min.value],
      [X.max.value, Y.max.value, Z.max.value], rotation);
    const draw = () => {
      const size = element.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      const project = (point: Vec3): readonly [number, number] => {
        const [x,y] = projection(point,size.width,size.height); return [x*ratio,y*ratio];
      };
      element.width = Math.max(1, Math.round(size.width * ratio)); element.height = Math.max(1, Math.round(size.height * ratio));
      context.clearRect(0, 0, element.width, element.height);
      context.strokeStyle = getComputedStyle(element).color; context.lineWidth = ratio;
      const corners: Vec3[] = Array.from({ length: 8 }, (_, bits) => [bits & 1 ? X.max.value : X.min.value,
        bits & 2 ? Y.max.value : Y.min.value, bits & 4 ? Z.max.value : Z.min.value]);
      context.globalAlpha = 0.25; context.beginPath();
      corners.forEach((corner, index) => { for (const bit of [1, 2, 4]) if (!(index & bit)) {
        context.moveTo(...project(corner)); context.lineTo(...project(corners[index | bit]));
      } });
      context.stroke(); context.globalAlpha = 1; context.lineWidth = 1.5 * ratio; context.beginPath();
      for (const curve of curves) {
        drawFunctionCurve(context, curve, project);
      }
      context.stroke();
      context.fillStyle = context.strokeStyle; context.font = `${12 * ratio}px sans-serif`;
      for (const [label, corner] of [['X', corners[1]], ['Y', corners[2]], ['Z', corners[4]]] as const) context.fillText(label, ...project(corner));
    };
    const resize = new ResizeObserver(draw); resize.observe(element); draw();
    return () => resize.disconnect();
  }, [definition, curves, rotation]);
  return <figure ref={figure} className="pcad-function-preview">
    <canvas ref={canvas} aria-label={t('functionPlot.previewLabel')} onPointerDown={event => {
      drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const previous = drag.current; if (!previous) return;
      const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
      drag.current = { x: event.clientX, y: event.clientY };
      setRotation(value => ({ yaw: value.yaw + dx * 0.01, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, value.pitch + dy * 0.01)) }));
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    <figcaption>{t('functionPlot.previewHint')}</figcaption>
    <p role="status">{t('functionPlot.curveCount')}: {curves.length} / {t('functionPlot.closedCurveCount')}: {curves.filter(curve=>curve.closed).length}</p>
    <button type="button" onClick={() => setRotation({ yaw: -Math.PI / 4, pitch: 0.6 })}>{t('functionPlot.resetView')}</button>
  </figure>;
}
