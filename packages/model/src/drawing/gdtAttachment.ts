import type { DrawingDocument, GdtFeature, GdtShapeTarget } from '@pointercad/drawing';
import { resolveDrawingDimensions, type DimensionResolveContext, type ResolvedDrawingDimension } from './dimensionTarget.js';
import { resolveGdtFeature, type ResolvedGdtFeature } from './gdt.js';
import { drawingMedianPlaneFeature } from './gdtMedianPlane.js';

const reference = (feature: GdtFeature): GdtShapeTarget => feature.kind === 'medianPlane' ? feature.targets[0] : feature.target;
function sameFeature(a: ResolvedGdtFeature, b: ResolvedGdtFeature): boolean {
  const ra = reference(a.feature), rb = reference(b.feature);
  if (ra.sourceRef !== rb.sourceRef || ra.viewId !== rb.viewId || ra.componentId !== rb.componentId || ra.ref.bodyFeatureId !== rb.ref.bodyFeatureId
    || a.kind !== b.kind || a.nominalSizeMm === null || b.nominalSizeMm === null || Math.abs(a.nominalSizeMm - b.nominalSizeMm) > 1e-7) return false;
  if (a.kind === 'medianPlane') return a.shapeKeys.length === b.shapeKeys.length && a.shapeKeys.every((key) => b.shapeKeys.includes(key));
  const u = a.direction, v = b.direction;
  if (u === null || v === null || 1 - Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) > 1e-7) return false;
  const delta = a.point.map((value, index) => value - b.point[index]), along = delta.reduce((sum, value, index) => sum + value * u[index], 0);
  return Math.hypot(...delta.map((value, index) => value - along * u[index])) <= 1e-7;
}

/** 公差対象と同じ実形状のサイズ寸法だけを候補にする。同じ表示値だけで関連付けない。 */
export function compatibleGdtSizeDimensions(feature: GdtFeature, document: DrawingDocument, context: DimensionResolveContext,
  dimensions: readonly ResolvedDrawingDimension[] = resolveDrawingDimensions(document, context)): readonly ResolvedDrawingDimension[] {
  const original = resolveGdtFeature(feature, document, context);
  if (original === null || (original.kind !== 'axis' && original.kind !== 'medianPlane')) return [];
  return dimensions.filter((item) => {
    if (item.status !== 'resolved' || item.value === null || original.nominalSizeMm === null || Math.abs(item.value - original.nominalSizeMm) > 1e-7) return false;
    const { dimension } = item;
    if (dimension.basic === true || dimension.reference || dimension.series !== undefined) return false;
    if (original.kind === 'axis') {
      const target = dimension.targets[0];
      if (dimension.kind !== 'diameter' || dimension.targets.length !== 1 || target?.kind !== 'subShape') return false;
      const current = resolveGdtFeature({ kind: 'axis', target }, document, context);
      return current !== null && sameFeature(original, current);
    }
    const [first, second] = dimension.targets;
    if (!['length', 'thickness'].includes(dimension.kind) || dimension.targets.length !== 2 || first?.kind !== 'subShape' || second?.kind !== 'subShape') return false;
    const candidate = drawingMedianPlaneFeature([first, second], document, context);
    const current = candidate === null ? null : resolveGdtFeature(candidate, document, context);
    return current !== null && sameFeature(original, current);
  });
}
