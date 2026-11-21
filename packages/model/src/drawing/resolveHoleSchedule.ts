import { belowMagnitude } from '../numericTolerance.js';
import { edgeDistanceCenters } from '@pointercad/kernel';
import { createSubShapeReferenceResolver, type KernelBridge, type SolidRecomputeOptions } from '../kernelBridge.js';
import type { SolidBody, SolidFaceEntry } from '../kernelBridge/solidContracts.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { PartDocument } from '../part/types.js';
import type { ResolvedPart } from '../part/resolvePart.js';
import { buildHoleSchedule, type HoleScheduleContext, type HoleScheduleFrame, type HoleScheduleResult } from './holeSchedule.js';
import { crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';

export type ResolvedHoleScheduleResult = HoleScheduleResult
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'kernelFailed'; readonly message?: string };

type EdgeDistancePlacement = Parameters<NonNullable<HoleScheduleContext['resolveEdgeDistance']>>[2];

/** 表示用の三角形(Float32)で側を聞く点を辺から離す量の下限(mm)。三角形の座標の誤差より十分大きくする。 */
const MESH_PROBE_MM = 1e-3;

/**
 * 面の表示用の三角形で、平面の上の点が面の中にあるかを聞く(辺からの距離の穴の側の判定と、中心の確かめ)。
 * 計算部は OCCT の面の分類で同じことを聞く。平らな面の直線の縁は三角形の辺と一致するので、縁から離した点の答えは同じになる。
 */
function insideFaceMesh(body: SolidBody, face: SolidFaceEntry, normal: Vec3, margin: number): (point: Vec3) => boolean {
  const origin: Vec3 = body.coordinateFrame?.origin ?? [0, 0, 0];
  const helper: Vec3 = belowMagnitude(normal[0], 0.9) ? [1, 0, 0] : [0, 1, 0];
  const uSize = lengthVec3(crossVec3(normal, helper));
  const u = scaleVec3(crossVec3(normal, helper), 1 / uSize);
  const v = crossVec3(normal, u);
  const { positions, indices } = body.mesh;
  const corner = (vertex: number): readonly [number, number] => {
    const world: Vec3 = [positions[vertex * 3] + origin[0], positions[vertex * 3 + 1] + origin[1], positions[vertex * 3 + 2] + origin[2]];
    return [dotVec3(world, u), dotVec3(world, v)];
  };
  return (point) => {
    const px = dotVec3(point, u), py = dotVec3(point, v);
    for (let triangle = face.triangleOffset; triangle < face.triangleOffset + face.triangleCount; triangle += 1) {
      const [ax, ay] = corner(indices[triangle * 3]);
      const [bx, by] = corner(indices[triangle * 3 + 1]);
      const [cx, cy] = corner(indices[triangle * 3 + 2]);
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue;
      const s = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const t = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const r = 1 - s - t;
      const scale = Math.sqrt(Math.abs(area));
      if (s * scale >= -margin && t * scale >= -margin && r * scale >= -margin) return true;
    }
    return false;
  };
}

/** 辺からの距離の穴(M-02)の中心を、加工する直前の形の面・辺から、計算部と同じ式で求める。 */
function resolveEdgeDistanceOnBody(body: SolidBody, face: SubShapeRef, placement: EdgeDistancePlacement,
  resolveReference: ReturnType<typeof createSubShapeReferenceResolver>): readonly Vec3[] | null {
  const faceMatch = resolveReference(body, face);
  if (faceMatch.status !== 'matched') return null;
  const faceGeometry = faceMatch.match.geometry;
  if (faceGeometry.kind !== 'face' || faceGeometry.surfaceKind !== 'plane' || faceGeometry.axis === null) return null;
  const faceEntry = body.faces.find((entry) => entry.index === faceMatch.match.reference.index);
  if (faceEntry === undefined) return null;
  const edgeLine = (edge: SubShapeRef): { readonly start: Vec3; readonly end: Vec3 } | null => {
    const match = resolveReference(body, edge);
    if (match.status !== 'matched') return null;
    const geometry = match.match.geometry;
    if (geometry.kind !== 'edge' || geometry.curveKind !== 'line' || geometry.axis === null) return null;
    if (faceEntry.boundaryEdgeIndices !== undefined && !faceEntry.boundaryEdgeIndices.includes(match.match.reference.index)) return null;
    const half = scaleVec3(geometry.axis, geometry.length / (2 * lengthVec3(geometry.axis)));
    return { start: subVec3(geometry.position, half), end: [geometry.position[0] + half[0], geometry.position[1] + half[1], geometry.position[2] + half[2]] };
  };
  const first = edgeLine(placement.edge1);
  const second = edgeLine(placement.edge2);
  if (first === null || second === null) return null;
  const probe = Math.max(MESH_PROBE_MM, 100 * (body.coordinateFrame?.maximumFloat32ErrorMm ?? 0));
  const inside = insideFaceMesh(body, faceEntry, faceGeometry.axis, probe / 10);
  const result = edgeDistanceCenters({ origin: faceGeometry.position, normal: faceGeometry.axis }, [first, second],
    placement.locations.map((p) => ({ distance1: p.distance1.value, distance2: p.distance2.value })), inside,
    { tolerance: Math.max(1e-6, probe / 10), probe });
  if (!result.ok || !result.centers.every(inside)) return null;
  return result.centers;
}

/**
 * 辺からの距離の穴(M-02)の中心を、今の形の 1 つの立体(表示用の三角形と面・辺の表)から、計算部と同じ式で位置の順に求める。
 * 穴表と、穴の欄を開いている間の 3D の寸法線(ui の予告)が同じ道を通る。面・辺が選び直せない・側が決まらない・中心が面の外なら null。
 */
export function edgeDistanceHoleCenters(body: SolidBody, face: SubShapeRef, placement: EdgeDistancePlacement): readonly Vec3[] | null {
  return resolveEdgeDistanceOnBody(body, face, placement, createSubShapeReferenceResolver());
}

/**
 * 消費済みの加工対象も形状キャッシュから取り出し、現在の面へ中心を投影する。
 * 表示用の文書・ストア・visibleの元配列を変更しない。
 */
export async function resolveHoleSchedule(
  document: PartDocument, resolved: ResolvedPart, kernel: Pick<KernelBridge, 'recomputeSolids'>,
  frame: HoleScheduleFrame, options: SolidRecomputeOptions,
): Promise<ResolvedHoleScheduleResult> {
  if (options.shouldCancel?.() === true) return { ok: false, reason: 'cancelled' };
  const targets = new Set(document.solids.flatMap((feature) =>
    !feature.suppressed && (feature.kind === 'hole' || feature.kind === 'threadHole') ? [feature.targetFeatureId] : []));
  if (targets.size === 0) return buildHoleSchedule(document, { sketches: resolved.sketches, frame, resolvePlane: () => null });
  const steps = resolved.steps.map((step) => ({ ...step, visible: targets.has(step.featureId) }));
  const result = await kernel.recomputeSolids(steps, options);
  if (result.cancelled || options.shouldCancel?.() === true) return { ok: false, reason: 'cancelled' };
  if (result.failures.length > 0) return { ok: false, reason: 'kernelFailed', message: result.failures[0].message };
  const bodies = new Map(result.bodies.map((body) => [body.featureId, body]));
  const resolveReference = createSubShapeReferenceResolver();
  return buildHoleSchedule(document, { sketches: resolved.sketches, frame, resolvePlane: (targetId, face) => {
    const body = bodies.get(targetId);
    if (body === undefined) return null;
    const resolution = resolveReference(body, face);
    const selected = resolution.status === 'matched' ? resolution.match.geometry : null;
    return selected?.kind === 'face' && selected.surfaceKind === 'plane' && selected.axis !== null
      ? { origin: selected.position, normal: selected.axis,
          ...(selected.planarBasis === undefined ? {} : { planarBasis: selected.planarBasis }) } : null;
  }, resolveEdgeDistance: (targetId, face, placement) => {
    const body = bodies.get(targetId);
    return body === undefined ? null : resolveEdgeDistanceOnBody(body, face, placement, resolveReference);
  } });
}
