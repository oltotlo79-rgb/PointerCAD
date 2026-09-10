import type { DrawingDocument, GdtFeature, GdtShapeTarget, Point2, Vector3 } from '@pointercad/drawing';
import { applyPlacementToDirection, applyPlacementToPoint } from '../assembly/placementMath.js';
import { rematchSubShapeRef, type SolidEdgeEntry, type SolidFaceEntry } from '../kernelBridge.js';
import { drawingModelPointToPaper, resolvedDimensionView, type DimensionResolveContext, type DrawingDimensionInstance } from './dimensionTarget.js';
import { createDrawingSurfaceAnchor } from './drawingSurfaceAnchor.js';

export interface ResolvedGdtFeature {
  readonly feature: GdtFeature;
  readonly kind: 'plane' | 'surface' | 'line' | 'curve' | 'axis' | 'medianPlane';
  readonly geometry: SolidFaceEntry['surfaceKind'] | SolidEdgeEntry['curveKind'];
  readonly point: Vector3;
  readonly direction: Vector3 | null;
  readonly paperPoint: Point2;
  /** 二面幅・円筒・閉円だけを実体公差のサイズ形体として扱う。 */
  readonly sizeFeature: boolean;
  readonly nominalSizeMm: number | null;
  /** 照合後の実形状の鍵。同名・同featureIdの別配置を取り違えない。 */
  readonly shapeKeys: readonly string[];
}

interface MatchedShape {
  readonly instance: DrawingDimensionInstance;
  readonly face?: SolidFaceEntry;
  readonly edge?: SolidEdgeEntry;
  readonly key: string;
}
function match(target: GdtShapeTarget, document: DrawingDocument, context: DimensionResolveContext): MatchedShape | null {
  if (target.sourceRef !== document.source.sourceRef) return null;
  const candidates = context.instances.filter((instance) => instance.sourceRef === target.sourceRef
    && instance.componentId === target.componentId && instance.body.featureId === target.ref.bodyFeatureId);
  if (candidates.length !== 1) return null;
  const instance = candidates[0], ref = rematchSubShapeRef([instance.body], target.ref);
  if (ref === null || ref.fingerprint.kind === 'vertex') return null;
  const key = JSON.stringify([target.sourceRef, target.componentId ?? null, instance.body.featureId, ref.fingerprint.kind, ref.index]);
  if (ref.fingerprint.kind === 'face') {
    const face = instance.body.faces.find((item) => item.index === ref.index);
    return face === undefined ? null : { instance, face, key };
  }
  const edge = instance.body.edges.find((item) => item.index === ref.index);
  return edge === undefined ? null : { instance, edge, key };
}

function unit(value: Vector3): Vector3 | null {
  const length = Math.hypot(...value);
  return Number.isFinite(length) && length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : null;
}
const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 軸は解析曲面/円の軸、中心平面は実際に離れた平行二面から解く。紙面の線から推測しない。 */
export function resolveGdtFeature(feature: GdtFeature, document: DrawingDocument, context: DimensionResolveContext): ResolvedGdtFeature | null {
  const target = feature.kind === 'medianPlane' ? feature.targets[0] : feature.target;
  const view = resolvedDimensionView(target.viewId, document, context), first = match(target, document, context);
  if (view === undefined || first === null) return null;
  const placedPoint = (point: Vector3): Vector3 => applyPlacementToPoint(first.instance.placement, point);
  const placedDirection = (direction: Vector3): Vector3 | null => unit(applyPlacementToDirection(first.instance.placement, direction));
  const finish = (kind: ResolvedGdtFeature['kind'], geometry: ResolvedGdtFeature['geometry'], point: Vector3,
    direction: Vector3 | null, nominalSizeMm: number | null = null, shapeKeys: readonly string[] = [first.key], anchor?: Point2): ResolvedGdtFeature | null => {
    const paperPoint = anchor ?? drawingModelPointToPaper(point, view, document.sheet.scale, context);
    if (!point.every(Number.isFinite) || paperPoint === null || !paperPoint.every(Number.isFinite)
      || (nominalSizeMm !== null && (!Number.isFinite(nominalSizeMm) || nominalSizeMm <= 0))) return null;
    return { feature, kind, geometry, point, direction, paperPoint, sizeFeature: nominalSizeMm !== null, nominalSizeMm, shapeKeys };
  };
  if (feature.kind === 'medianPlane') {
    const secondTarget = feature.targets[1], second = match(secondTarget, document, context);
    if (secondTarget.viewId !== target.viewId || second === null || second.instance !== first.instance || second.key === first.key
      || first.face?.surfaceKind !== 'plane' || second.face?.surfaceKind !== 'plane' || first.face.axis === null || second.face.axis === null) return null;
    const normal = placedDirection(first.face.axis), otherNormal = placedDirection(second.face.axis);
    if (normal === null || otherNormal === null || 1 - Math.abs(dot(normal, otherNormal)) > 1e-7) return null;
    const a = placedPoint(first.face.centroid), b = placedPoint(second.face.centroid), distance = dot(subtract(b, a), normal);
    if (Math.abs(distance) <= 1e-7) return null;
    return finish('medianPlane', 'plane', [a[0] + normal[0] * distance / 2, a[1] + normal[1] * distance / 2,
      a[2] + normal[2] * distance / 2], normal, Math.abs(distance), [first.key, second.key]);
  }
  const { face, edge } = first;
  if (feature.kind === 'surface') {
    if (face === undefined) return null;
    const direction = face.axis === null ? null : placedDirection(face.axis);
    if (face.surfaceKind === 'plane' && direction === null) return null;
    const resolved = (anchor?: Point2): ResolvedGdtFeature | null =>
      finish(face.surfaceKind === 'plane' ? 'plane' : 'surface', face.surfaceKind, placedPoint(face.centroid), direction, null, [first.key], anchor);
    const mesh = first.instance.body.mesh;
    if (mesh.positions.length === 0 && mesh.indices.length === 0) return resolved();
    if (!Number.isSafeInteger(face.triangleOffset) || !Number.isSafeInteger(face.triangleCount)
      || face.triangleOffset < 0 || face.triangleCount < 0 || (face.triangleOffset + face.triangleCount) * 3 > mesh.indices.length) return null;
    const pick = createDrawingSurfaceAnchor(view, document.sheet.scale, context); if (pick === null) return null;
    let area = -1, anchor: Point2 | null = null;
    for (let index = face.triangleOffset; index < face.triangleOffset + face.triangleCount; index++) {
      const world: Vector3[] = [];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = mesh.indices[index * 3 + corner] * 3;
        if (vertex + 2 >= mesh.positions.length) return null;
        world.push(placedPoint([mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]]));
      }
      const current = pick([world[0], world[1], world[2]]);
      if (current !== null && current.area > area) { area = current.area; anchor = current.paperPoint; }
    }
    // 孔内・切り抜き外・断面で取り去った部分へ指示点を置かない。
    return anchor === null ? null : resolved(anchor);
  }
  if (feature.kind === 'line') {
    if (edge === undefined || !Number.isFinite(edge.length) || edge.length <= 0) return null;
    const direction = edge.curveKind === 'line' ? placedDirection(subtract(edge.end, edge.start))
      : edge.axis === null ? null : placedDirection(edge.axis);
    return edge.curveKind === 'line' && direction === null ? null
      : finish(edge.curveKind === 'line' ? 'line' : 'curve', edge.curveKind, placedPoint(edge.midpoint), direction);
  }
  if (face !== undefined) {
    if ((face.surfaceKind !== 'cylinder' && face.surfaceKind !== 'cone') || face.axisOrigin == null || face.axis === null) return null;
    const direction = placedDirection(face.axis);
    if (direction === null) return null;
    return finish('axis', face.surfaceKind, placedPoint(face.axisOrigin), direction,
      face.surfaceKind === 'cylinder' && face.radius !== null ? face.radius * 2 : null);
  }
  if (edge === undefined || edge.curveKind !== 'circle' || edge.axisOrigin == null || edge.axis === null
    || edge.radius === null || !Number.isFinite(edge.length) || edge.radius <= 0) return null;
  const direction = placedDirection(edge.axis);
  if (direction === null) return null;
  const closed = Math.abs(edge.length - 2 * Math.PI * edge.radius) <= 1e-7 * Math.max(1, edge.length)
    && Math.hypot(...subtract(edge.start, edge.end)) <= 1e-7;
  return finish('axis', 'circle', placedPoint(edge.axisOrigin), direction, closed ? edge.radius * 2 : null);
}

export type { DatumDefinition, DatumId, DatumReference, GdtFrameSegment, GdtFeature, GeometricToleranceFrame,
  MaterialRequirement, ToleranceCharacteristic, ToleranceZone } from '@pointercad/drawing';
