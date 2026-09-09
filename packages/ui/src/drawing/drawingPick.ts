import { drawingViewBasis, type DimensionTarget, type DrawingDocument, type Point2, type Vector3 } from '@pointercad/drawing';
import { applyPlacementToPoint, drawingTargetFromProjection, resolveDimensionTarget, type DrawingSourceResolution, type ResolvedDrawingCurve, type ResolvedDrawingView } from '@pointercad/model';

function distanceToSegment(point: Point2, a: Point2, b: Point2): number {
  const x = b[0] - a[0], y = b[1] - a[1], denominator = x * x + y * y;
  const along = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * x + (point[1] - a[1]) * y) / denominator));
  return Math.hypot(point[0] - a[0] - along * x, point[1] - a[1] - along * y);
}
export function distanceToDrawingCurve(point: Point2, curve: ResolvedDrawingCurve): number {
  if (curve.kind === 'segment') return distanceToSegment(point, curve.from, curve.to);
  if (curve.kind === 'polyline') {
    let distance = Infinity;
    for (let i = 1; i < curve.points.length; i++) distance = Math.min(distance, distanceToSegment(point, curve.points[i - 1], curve.points[i]));
    if (curve.closed && curve.points.length > 1) distance = Math.min(distance, distanceToSegment(point, curve.points[curve.points.length - 1], curve.points[0]));
    return distance;
  }
  const sweep = curve.endAngle - curve.startAngle;
  const turn = Math.PI * 2;
  const angle = Math.atan2(point[1] - curve.center[1], point[0] - curve.center[0]);
  const along = ((sweep < 0 ? curve.startAngle - angle : angle - curve.startAngle) % turn + turn) % turn;
  if (Math.abs(sweep) >= turn - 1e-9 || along <= Math.abs(sweep)) return Math.abs(Math.hypot(point[0] - curve.center[0], point[1] - curve.center[1]) - curve.radius);
  return Math.min(...[curve.startAngle, curve.endAngle].map((end) => Math.hypot(point[0] - curve.center[0] - curve.radius * Math.cos(end), point[1] - curve.center[1] - curve.radius * Math.sin(end))));
}

/** 表示した線の由来を優先し、見えない頂点・由来不明の輪郭へ寸法を付けない。 */
export function pickDrawingGeometry(document: DrawingDocument, source: DrawingSourceResolution, views: readonly ResolvedDrawingView[],
  point: Point2, toleranceMm: number): DimensionTarget | null {
  const instances = source.dimensionInstances ?? [];
  const context = { instances, modelCenter: source.center };
  let nearest: DimensionTarget | null = null, distance = toleranceMm;
  let vertexTarget: DimensionTarget | null = null, vertexDistance = toleranceMm * 0.65;
  for (const view of views) {
    const drawingView = document.views.find((item) => item.id === view.viewId);
    if (drawingView === undefined || document.layers.find((layer) => layer.id === drawingView.layerId)?.visible !== true) continue;
    for (const item of view.visible) {
      const candidateDistance = distanceToDrawingCurve(point, item.curve);
      if (candidateDistance > toleranceMm) continue;
      const target = drawingTargetFromProjection(item, view.viewId, document.source.sourceRef, instances);
      if (target === null || target.kind !== 'subShape') continue;
      if (candidateDistance < distance) { nearest = target; distance = candidateDistance; }
      const instance = instances.find((entry) => entry.body.featureId === target.ref.bodyFeatureId && entry.componentId === target.componentId);
      const edge = instance?.body.edges.find((entry) => entry.index === target.ref.index);
      if (instance === undefined || edge === undefined || edge.curveKind !== 'line') continue;
      for (const vertex of instance.body.vertices) {
        if (![edge.start, edge.end].some((end) => Math.hypot(...end.map((value, axis) => value - vertex.position[axis])) < 1e-7)) continue;
        const candidate: DimensionTarget = { ...target, ref: { bodyFeatureId: target.ref.bodyFeatureId, index: vertex.index,
          fingerprint: { kind: 'vertex', position: vertex.position } } };
        const resolved = resolveDimensionTarget(candidate, document, context);
        if (resolved?.kind !== 'point' || distanceToDrawingCurve(resolved.paperPoint, item.curve) > 1e-7) continue;
        const currentDistance = Math.hypot(point[0] - resolved.paperPoint[0], point[1] - resolved.paperPoint[1]);
        if (currentDistance < vertexDistance) { vertexTarget = candidate; vertexDistance = currentDistance; }
      }
    }
  }
  return vertexTarget ?? nearest ?? pickDrawingFace(document, source, views, point);
}

/** 実メッシュの三角形を紙面へ写し、視線の手前の面を選ぶ。輪郭の矩形で穴を埋めない。 */
export function pickDrawingFace(document: DrawingDocument, source: DrawingSourceResolution, views: readonly ResolvedDrawingView[], point: Point2): DimensionTarget | null {
  for (const projected of views) {
    const view = document.views.find((item) => item.id === projected.viewId);
    if (view === undefined || document.layers.find((layer) => layer.id === view.layerId)?.visible !== true) continue;
    const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
    if (basis === null) continue;
    const scale = view.scale ?? document.sheet.scale;
    const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let nearest: DimensionTarget | null = null, depth = Infinity;
    for (const instance of source.dimensionInstances ?? []) {
      if (instance.sourceRef !== document.source.sourceRef) continue;
      const mesh = instance.body.mesh;
      const vertices: { readonly point: Point2; readonly depth: number }[] = [];
      for (let offset = 0; offset < mesh.positions.length; offset += 3) {
        const world = applyPlacementToPoint(instance.placement, [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]]);
        const relative: Vector3 = [world[0] - source.center[0], world[1] - source.center[1], world[2] - source.center[2]];
        vertices.push({ point: [view.position[0] + dot(relative, basis.x) * scale, view.position[1] + dot(relative, basis.y) * scale], depth: dot(relative, view.direction) });
      }
      for (const face of instance.body.faces) {
        for (let triangle = face.triangleOffset; triangle < face.triangleOffset + face.triangleCount; triangle++) {
          const a = vertices[mesh.indices[triangle * 3]], b = vertices[mesh.indices[triangle * 3 + 1]], c = vertices[mesh.indices[triangle * 3 + 2]];
          if (a === undefined || b === undefined || c === undefined) continue;
          const cross = (x: Point2, y: Point2, z: Point2): number => (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0]);
          const area = cross(a.point, b.point, c.point);
          if (Math.abs(area) < 1e-10) continue;
          const u = cross(point, b.point, c.point) / area, v = cross(point, c.point, a.point) / area, w = 1 - u - v;
          if (Math.min(u, v, w) < -1e-9) continue;
          const currentDepth = u * a.depth + v * b.depth + w * c.depth;
          if (currentDepth >= depth) continue;
          depth = currentDepth;
          nearest = { kind: 'subShape', viewId: view.id, sourceRef: instance.sourceRef,
            ...(instance.componentId === undefined ? {} : { componentId: instance.componentId }),
            ref: { bodyFeatureId: instance.body.featureId, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind,
              area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } } };
        }
      }
    }
    if (nearest !== null) return nearest;
  }
  return null;
}
