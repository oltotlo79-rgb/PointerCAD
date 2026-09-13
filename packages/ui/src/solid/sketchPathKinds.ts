import type { SketchFeature } from '@pointercad/model';

const kinds = ['line', 'arc', 'rectangle', 'polygon', 'slot', 'ellipse', 'spline', 'offset',
  'projectedCurve', 'planeSection', 'functionCurve'] as const;
type PathFeature = Extract<SketchFeature, { kind: typeof kinds[number] }>;

/** 経路・輪郭・案内線で同じ種類を受け付け、関数の履歴参照も保持する。 */
export const SKETCH_PATH_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(kinds);
export function isSketchPathFeature(feature: SketchFeature): feature is PathFeature {
  return SKETCH_PATH_KINDS.has(feature.kind);
}
