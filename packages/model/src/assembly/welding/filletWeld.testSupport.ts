import { expressionValueFromNumber } from '@pointercad/expression';

import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from '../../kernelBridge.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { Quaternion } from '../placementMath.js';
import type { AssemblyDocument, Placement } from '../types.js';
import type { WeldBodyLookup } from './planFilletWeld.js';
import type { FilletWeldRequest, WeldEdgeSelection, WeldFaceSelection } from './types.js';

/** 抱き込んだ部品の内容の版(検査用の値)。 */
export const WELD_TEST_REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);

export function weldTestPlacement(position: Vec3, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return {
    position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]), expressionValueFromNumber(position[2])],
    rotation,
  };
}

/** 立板(component-1、部品 standing)と底板(component-2、部品 base)の T 継手。 */
export function teeJoint(standing: Placement, base: Placement): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: standing }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: base }));
}

export function planeFace(componentId: string, partRef: string, centroid: Vec3, normal: Vec3): WeldFaceSelection {
  return {
    componentId, sourceKey: `part:${partRef}@${WELD_TEST_REVISIONS.get(partRef) ?? ''}`,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 100, position: centroid, axis: normal, radius: null } },
    centroid, normal,
  };
}

export function lineEdge(midpoint: Vec3, direction: Vec3, length: number): WeldEdgeSelection {
  return {
    edge: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
      kind: 'edge', curveKind: 'line', length, position: midpoint, axis: direction, radius: null } },
    midpoint, direction, length,
  };
}

/**
 * 部品座標の選択: 立板(x 0〜100、y 0〜8、z 0〜50)の側面 y=8(外向き +Y、重心 (50,8,25))と下の辺
 * (中点 (50,8,0)、+X、長さ 100)、底板(x 0〜100、y 0〜60、z 0〜10)の上面 z=10(+Z、重心 (50,30,10))。
 * 立板を (0,26,10) に置くと、辺は底板の上面にちょうど載る。
 */
export function teeRequest(overrides: Partial<FilletWeldRequest> = {}): FilletWeldRequest {
  return {
    first: planeFace('component-1', 'standing', [50, 8, 25], [0, 1, 0]),
    second: planeFace('component-2', 'base', [50, 30, 10], [0, 0, 1]),
    edge: lineEdge([50, 8, 0], [1, 0, 0], 100),
    legOnSecond: 6, legOnFirst: 8,
    segments: [{ start: 10, length: 20 }, { start: 40, length: 15 }, { start: 70, length: 25 }],
    materialId: 'aluminum',
    ...overrides,
  };
}

/** 上の選択どおりに組んだ T 継手(どちらも回転なし)。 */
export function plainTee(): AssemblyDocument {
  return teeJoint(weldTestPlacement([0, 26, 10]), weldTestPlacement([0, 0, 0]));
}

type Quad = readonly [Vec3, Vec3, Vec3, Vec3];

interface PlanarFaceSpec {
  readonly normal: Vec3;
  /** 面を覆う四角形(重ならない)。三角形 2 枚ずつに分ける。 */
  readonly quads: readonly Quad[];
}

interface CircleEdgeSpec {
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly radius: number;
}

function quadArea(quad: Quad): number {
  const [a, b, , d] = quad;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
}

/**
 * 検査用のボディ(実カーネルの結果と同じ形の `SolidBody`)。平面の面は四角形の分割、辺は直線と円。
 * `origin` を渡すと局所の座標系(位置は origin からの差)で持つ。
 */
export function weldTestBody(
  faces: readonly PlanarFaceSpec[], lines: readonly (readonly [Vec3, Vec3])[], circles: readonly CircleEdgeSpec[] = [],
  origin?: Vec3,
): SolidBody {
  const positions: number[] = [];
  const indices: number[] = [];
  const shift = origin ?? [0, 0, 0];
  const faceEntries = faces.map((face, index): SolidFaceEntry => {
    const triangleOffset = indices.length / 3;
    for (const quad of face.quads) {
      const base = positions.length / 3;
      for (const corner of quad) positions.push(corner[0] - shift[0], corner[1] - shift[1], corner[2] - shift[2]);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const first = face.quads[0];
    const centroid: Vec3 = first === undefined ? [0, 0, 0] : [
      (first[0][0] + first[2][0]) / 2, (first[0][1] + first[2][1]) / 2, (first[0][2] + first[2][2]) / 2];
    return { index, surfaceKind: 'plane', area: face.quads.reduce((sum, quad) => sum + quadArea(quad), 0), centroid,
      axis: face.normal, radius: null, triangleOffset, triangleCount: face.quads.length * 2 };
  });
  const lineEntries = lines.map(([start, end], index): SolidEdgeEntry => {
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    return { index, curveKind: 'line', length, start, end,
      midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      axis: [(end[0] - start[0]) / length, (end[1] - start[1]) / length, (end[2] - start[2]) / length],
      radius: null, segmentOffset: 0, segmentCount: 0 };
  });
  const circleEntries = circles.map((circle, offset): SolidEdgeEntry => {
    const point: Vec3 = [circle.center[0] + circle.radius, circle.center[1], circle.center[2]];
    return { index: lines.length + offset, curveKind: 'circle', length: 2 * Math.PI * circle.radius, start: point, end: point,
      midpoint: [circle.center[0] - circle.radius, circle.center[1], circle.center[2]], axis: circle.axis,
      axisOrigin: circle.center, radius: circle.radius, segmentOffset: 0, segmentCount: 0 };
  });
  return {
    featureId: 'extrude-1',
    mesh: { positions: new Float32Array(positions), normals: new Float32Array(positions.length), indices: new Uint32Array(indices),
      edgePositions: new Float32Array(0), triangleCount: indices.length / 3 },
    ...(origin === undefined ? {} : { coordinateFrame: { space: 'local' as const, origin, maximumFloat32ErrorMm: 1e-4 } }),
    volume: 1, isValid: true, faces: faceEntries, edges: [...lineEntries, ...circleEntries], vertices: [], threadMarks: [],
  };
}

/** 長方形 [x0,x1]×[y0,y1] から穴 [hx0,hx1]×[hy0,hy1] を抜いた、z 一定の面の四角形。 */
function rectangleWithHole(x0: number, x1: number, y0: number, y1: number, z: number,
  hole?: readonly [number, number, number, number]): readonly Quad[] {
  const quad = (a: number, b: number, c: number, d: number): Quad => [[a, c, z], [b, c, z], [b, d, z], [a, d, z]];
  if (hole === undefined) return [quad(x0, x1, y0, y1)];
  const [hx0, hx1, hy0, hy1] = hole;
  return [quad(x0, hx0, y0, y1), quad(hx1, x1, y0, y1), quad(hx0, hx1, y0, hy0), quad(hx0, hx1, hy1, y1)];
}

export interface WeldTestBoxOptions {
  /** 上面(+Z)の四角い穴 [x0, x1, y0, y1]。穴の 4 辺も上面の辺として持つ。 */
  readonly topHole?: readonly [number, number, number, number];
  /** 上面の上にある円の辺(穴の縁など)。 */
  readonly topCircles?: readonly CircleEdgeSpec[];
  readonly origin?: Vec3;
}

/** 箱 [min, max] のボディ(面 6 枚・辺 12 本、上面の穴は任意)。 */
export function weldTestBox(min: Vec3, max: Vec3, options: WeldTestBoxOptions = {}): SolidBody {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces: PlanarFaceSpec[] = [
    { normal: [-1, 0, 0], quads: [[[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]] },
    { normal: [1, 0, 0], quads: [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]] },
    { normal: [0, -1, 0], quads: [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]] },
    { normal: [0, 1, 0], quads: [[[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]] },
    { normal: [0, 0, -1], quads: rectangleWithHole(x0, x1, y0, y1, z0) },
    { normal: [0, 0, 1], quads: rectangleWithHole(x0, x1, y0, y1, z1, options.topHole) },
  ];
  const corners = (z: number): Vec3[] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  const lines: (readonly [Vec3, Vec3])[] = [];
  for (const z of [z0, z1]) {
    const ring = corners(z);
    ring.forEach((corner, index) => lines.push([corner, ring[(index + 1) % 4] ?? corner]));
  }
  corners(z0).forEach((corner) => lines.push([corner, [corner[0], corner[1], z1]]));
  if (options.topHole !== undefined) {
    const [hx0, hx1, hy0, hy1] = options.topHole;
    const ring: Vec3[] = [[hx0, hy0, z1], [hx1, hy0, z1], [hx1, hy1, z1], [hx0, hy1, z1]];
    ring.forEach((corner, index) => lines.push([corner, ring[(index + 1) % 4] ?? corner]));
  }
  return weldTestBody(faces, lines, options.topCircles ?? [], options.origin);
}

/** 立板(x 0〜100、y 0〜8、z 0〜50)と底板(x 0〜100、y 0〜60、z 0〜10)のボディ。 */
export const STANDING_BOX = weldTestBox([0, 0, 0], [100, 8, 50]);
export const BASE_BOX = weldTestBox([0, 0, 0], [100, 60, 10]);

/** 部品(partRef)ごとのボディ。既定は上の 2 つ。部品を置き換えて形の違いを試す。 */
export function teeBodies(overrides: { readonly standing?: readonly SolidBody[] | null; readonly base?: readonly SolidBody[] | null } = {}): WeldBodyLookup {
  return (component) => {
    if (component.source.kind !== 'part') return null;
    if (component.source.partRef === 'standing') return overrides.standing === undefined ? [STANDING_BOX] : overrides.standing;
    if (component.source.partRef === 'base') return overrides.base === undefined ? [BASE_BOX] : overrides.base;
    return null;
  };
}

/** 既定の形の T 継手のボディ。 */
export const TEE_BODIES: WeldBodyLookup = teeBodies();
