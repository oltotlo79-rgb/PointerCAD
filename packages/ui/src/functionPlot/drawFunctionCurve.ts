import { sampleSpline, type ResolvedSpline, type Vec3 } from '@pointercad/model';

type CurveContext = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'closePath'>;
type Projection = (point: Vec3) => readonly [number, number];

/** Affine projection preserves a cubic Bézier exactly; its control polygon is not the curve. */
export function drawFunctionCurve(context: CurveContext, curve: ResolvedSpline, project: Projection): void {
  if (curve.mode === 'control' && curve.degree !== 1 && !curve.closed && curve.points.length === 4) {
    context.moveTo(...project(curve.points[0]));
    context.bezierCurveTo(...project(curve.points[1]), ...project(curve.points[2]), ...project(curve.points[3]));
    return;
  }
  const points = curve.degree === 1 ? curve.points : sampleSpline(curve);
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(...project(point)); else context.lineTo(...project(point));
  });
  if (curve.closed) context.closePath();
}
