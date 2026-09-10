import type { DrawingDocument, GdtFeature, GdtShapeTarget, Vector3 } from '@pointercad/drawing';
import { rematchSubShapeRef, type SolidBody, type SolidEdgeEntry, type SolidFaceEntry } from '../kernelBridge.js';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { resolveGdtFeature } from './gdt.js';

const EPSILON_MM = 1e-7;
const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 無限平面への一致だけでは、別の場所にある同一平面の面を選んでしまう。実三角形内も確認する。 */
function faceContainsPoint(face: SolidFaceEntry, body: SolidBody, point: Vector3): boolean {
  const { mesh } = body;
  if (!Number.isSafeInteger(face.triangleOffset) || !Number.isSafeInteger(face.triangleCount)
    || face.triangleOffset < 0 || face.triangleCount <= 0 || (face.triangleOffset + face.triangleCount) * 3 > mesh.indices.length) return false;
  for (let triangle = face.triangleOffset; triangle < face.triangleOffset + face.triangleCount; triangle++) {
    const points: Vector3[] = [];
    for (let corner = 0; corner < 3; corner++) {
      const offset = mesh.indices[triangle * 3 + corner] * 3;
      if (offset + 2 >= mesh.positions.length) return false;
      points.push([mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]]);
    }
    const [a, b, c] = points, u = subtract(b, a), v = subtract(c, a), p = subtract(point, a);
    const uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), pu = dot(p, u), pv = dot(p, v), denominator = uu * vv - uv * uv;
    if (!Number.isFinite(denominator) || denominator <= 0) continue;
    const s = (pu * vv - pv * uv) / denominator, t = (pv * uu - pu * uv) / denominator;
    const residual = Math.hypot(...p.map((value, index) => value - s * u[index] - t * v[index]));
    // OCCTの解析面はdouble、表示メッシュはFloat32。面との距離は上流で厳密に照合する。
    const meshToleranceMm = Math.max(EPSILON_MM, ...points.flatMap((vertex) => vertex.map((value) => Math.abs(value) * 2 ** -22)));
    const tolerance = meshToleranceMm / Math.max(meshToleranceMm, Math.min(Math.sqrt(uu), Math.sqrt(vv)));
    if (residual <= meshToleranceMm && s >= -tolerance && t >= -tolerance && s + t <= 1 + tolerance) return true;
  }
  return false;
}

function incidentPlanes(edge: SolidEdgeEntry, body: SolidBody): readonly SolidFaceEntry[] {
  if (edge.curveKind !== 'line') return [];
  const midpoint: Vector3 = [(edge.start[0] + edge.end[0]) / 2, (edge.start[1] + edge.end[1]) / 2, (edge.start[2] + edge.end[2]) / 2];
  return body.faces.filter((face) => {
    if (face.surfaceKind !== 'plane' || face.axis === null) return false;
    const normal = face.axis, length = Math.hypot(...normal);
    return length > 0 && Number.isFinite(length) && [edge.start, midpoint, edge.end].every((point) =>
      Math.abs(dot(subtract(point, face.centroid), normal)) / length <= EPSILON_MM && faceContainsPoint(face, body, point));
  });
}

/** 投影辺2本が属する平行二面を一意に照合し、保存対象を実面の参照へ変える。 */
export function drawingMedianPlaneFeature(targets: readonly GdtShapeTarget[], document: DrawingDocument,
  context: DimensionResolveContext): Extract<GdtFeature, { readonly kind: 'medianPlane' }> | null {
  const [first, second] = targets;
  if (targets.length !== 2 || first.viewId !== second.viewId || first.sourceRef !== document.source.sourceRef
    || first.sourceRef !== second.sourceRef || first.componentId !== second.componentId || first.ref.bodyFeatureId !== second.ref.bodyFeatureId) return null;
  const instances = context.instances.filter((instance) => instance.sourceRef === first.sourceRef && instance.componentId === first.componentId
    && instance.body.featureId === first.ref.bodyFeatureId);
  if (instances.length !== 1) return null;
  const body = instances[0].body;
  const candidates = (target: GdtShapeTarget): readonly GdtShapeTarget[] => {
    const ref = rematchSubShapeRef([body], target.ref);
    if (ref === null || ref.fingerprint.kind === 'vertex') return [];
    const edge = ref.fingerprint.kind === 'edge' ? body.edges.find((item) => item.index === ref.index) : undefined;
    const faces = ref.fingerprint.kind === 'face' ? body.faces.filter((item) => item.index === ref.index && item.surfaceKind === 'plane')
      : edge === undefined ? [] : incidentPlanes(edge, body);
    return faces.map((face) => ({ ...target, ref: { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
      kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid, axis: face.axis, radius: face.radius,
    } } }));
  };
  const matches = new Map<string, Extract<GdtFeature, { readonly kind: 'medianPlane' }>>();
  for (const a of candidates(first)) for (const b of candidates(second)) {
    const feature = { kind: 'medianPlane' as const, targets: [a, b] as const };
    const resolved = resolveGdtFeature(feature, document, context);
    if (resolved !== null) matches.set(JSON.stringify([...resolved.shapeKeys].sort()), feature);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
