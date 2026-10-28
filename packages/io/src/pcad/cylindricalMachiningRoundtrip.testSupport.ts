/** EX-05.PERSIST: independent frame/volume oracle; no product placement or transform helpers. */
import { expect } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import {
  absoluteCoordinate, appendSolid, createDirectKernelBridge, createEmptyPartDocument,
  createSubShapeReference, recomputePart,
  type HoleFeature, type PartDocument, type PartRecomputeResult, type PrimitiveFeature,
  type SolidBody, type ThreadHoleFeature, type TransformFeature,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';

export type Vector = readonly [number, number, number];
type Matrix = readonly [Vector, Vector, Vector];
export type Machining = 'blind' | 'through' | 'counterbore' | 'simplified' | 'modeled';
export type Transformation = 'rigid' | 'mirrorXY' | 'mirrorYZ' | 'scalePlain' | 'scaleThread';
export const SAVED_AT = '2026-10-25T00:00:00.000Z';
export const LOCATIONS2 = [{ height: 13, angle: 37 }, { height: 27, angle: -53 }] as const;
export const numeric = (value: number) => ({ source: String(value), display: String(value), value });
const POSITION = 1e-6, DIRECTION = 1e-9, VOLUME_RELATIVE = 1e-5;
export const add = (a: Vector, b: Vector): Vector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const times = (a: Vector, s: number): Vector => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vector): Vector => times(v, 1 / Math.hypot(...v));
const apply = (m: Matrix, v: Vector): Vector => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
const distance = (a: Vector, b: Vector): number => Math.hypot(...subtract(a, b));
const radians = (d: number): number => d * Math.PI / 180;
const cy = Math.cos(radians(30)), sy = Math.sin(radians(30));
const cz = Math.cos(radians(50)), sz = Math.sin(radians(50));
const RIGID: Matrix = [[cz * cy, -sz, cz * sy], [sz * cy, cz, sz * sy], [-sy, 0, cy]];

export interface OracleFrame {
  readonly location: Vector;
  readonly x: Vector;
  readonly z: Vector;
  readonly radius: number;
  readonly height: number;
}
export interface OraclePlacement { readonly entry: Vector; readonly drill: Vector; readonly radial: Vector }
export function expectedPlacements(frame: OracleFrame, locations: readonly { height: number; angle: number }[] = LOCATIONS2): readonly OraclePlacement[] {
  const y = cross(frame.z, frame.x);
  return locations.map(({ height, angle }) => {
    const radial = add(times(frame.x, Math.cos(radians(angle))), times(y, Math.sin(radians(angle))));
    return { entry: add(add(frame.location, times(frame.z, height)), times(radial, frame.radius)), radial, drill: times(radial, -1) };
  });
}

export function primitive(id = 'cylinder-1', base: Vector = [0, 0, 0], radius = 10, height = 40): PrimitiveFeature {
  return { id, name: id, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(...base) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: numeric(radius), height: numeric(height) } };
}
export function onlyBody(result: PartRecomputeResult, id: string): SolidBody {
  const bodies = result.bodies.filter((b) => b.featureId === id);
  expect(bodies).toHaveLength(1);
  const body = bodies[0];
  if (body === undefined) throw new Error(`Missing body ${id}`);
  return body;
}
export function sideReference(body: SolidBody): HoleFeature['face'] {
  const faces = body.faces.filter((f) => f.surfaceKind === 'cylinder');
  expect(faces).toHaveLength(1);
  const side = faces[0];
  if (side === undefined) throw new Error('Cylinder side missing');
  const reference = createSubShapeReference(body, 'face', side.index);
  if (reference === null) throw new Error('Side reference missing');
  return reference;
}
export function machining(kind: Machining, targetFeatureId: string, face: HoleFeature['face']): HoleFeature | ThreadHoleFeature {
  const common = { id: 'hole-1', name: 'machining', suppressed: false, targetFeatureId, face, centers: [],
    tiltAngle: numeric(0), tiltAzimuth: numeric(0),
    cylindrical: { kind: 'cylinder-face' as const, locations: LOCATIONS2.map(({ height, angle }) => ({ height: numeric(height), angle: numeric(angle) })) } };
  if (kind === 'blind' || kind === 'through' || kind === 'counterbore') {
    return { ...common, kind: 'hole', diameter: numeric(4),
      depth: kind === 'through' ? { kind: 'through' } : { kind: 'blind', depth: numeric(kind === 'blind' ? 4 : 6) },
      ...(kind === 'counterbore' ? { entry: { kind: 'counterbore' as const, diameter: numeric(8), depth: numeric(2) } } : {}) };
  }
  return { ...common, kind: 'threadHole', designation: 'M6', series: 'coarse', pitch: numeric(1), drillDiameter: numeric(4.917),
    depth: { kind: 'blind', depth: numeric(kind === 'modeled' ? 4 : 8) }, threadLength: numeric(kind === 'modeled' ? 1 : 6), representation: kind,
    ...(kind === 'modeled' ? { entry: { kind: 'counterbore' as const, diameter: numeric(8), depth: numeric(2) } } : {}) };
}

/** Same Simpson 4000-panel integral and total-body relative tolerance as the existing placement tests. */
function lens(r: number, radius: number): number {
  const intervals = 4000, step = Math.PI / intervals;
  let sum = 0;
  for (let i = 0; i <= intervals; i += 1) {
    const t = -Math.PI / 2 + i * step;
    sum += (i === 0 || i === intervals ? 1 : i % 2 === 1 ? 4 : 2)
      * r ** 2 * Math.cos(t) ** 2 * Math.sqrt(radius ** 2 - r ** 2 * Math.sin(t) ** 2);
  }
  return sum * step / 3;
}
export function removal(kind: Machining, radius: number): number {
  const rd = 4.917 / 2;
  const blind = (r: number, depth: number) => 2 * lens(r, radius) - (radius - depth) * Math.PI * r ** 2;
  if (kind === 'blind') return blind(2, 4);
  if (kind === 'through') return 4 * lens(2, radius);
  if (kind === 'counterbore') return blind(4, 2) + 4 * Math.PI * 2 ** 2;
  if (kind === 'simplified') return blind(rd, 8);
  // One full M6x1 turn, analytic integral of triangular groove f(r)=0.3(3-r)/(3-rd).
  const crest = 3 - rd;
  const groove = 4 * Math.PI * 0.3 * crest * (rd / 2 + crest / 6) - Math.PI * 0.09 * crest * (rd / 3 + crest / 12);
  return blind(4, 2) + 2 * Math.PI * rd ** 2 + groove;
}
export function expectVolume(body: SolidBody, expected: number): void {
  expect(Math.abs(body.volume - expected) / expected, `actual=${body.volume}, independent=${expected}`).toBeLessThan(VOLUME_RELATIVE);
}
export function expectPlane(body: SolidBody, p: OraclePlacement, depth: number, area?: number): void {
  const center = add(p.entry, times(p.drill, depth));
  const planes = body.faces.filter((f) => f.surfaceKind === 'plane' && f.axis !== null
    && distance(f.axis, p.radial) < DIRECTION && Math.abs(dot(subtract(f.centroid, p.entry), p.drill) - depth) < POSITION);
  expect(planes, `signed plane at ${JSON.stringify(center)}`).toHaveLength(1);
  const plane = planes[0];
  if (plane === undefined) throw new Error('Floor missing');
  if (area !== undefined) {
    expect(Math.abs(plane.area - area)).toBeLessThan(DIRECTION);
    expect(distance(plane.centroid, center)).toBeLessThan(POSITION);
    // Recover the mouth from the signed bottom. A line alone cannot detect theta+180 degrees.
    expect(distance(subtract(plane.centroid, times(p.drill, depth)), p.entry)).toBeLessThan(POSITION);
  }
}
export function expectBore(body: SolidBody, radius: number, p: OraclePlacement): void {
  const matches = body.faces.filter((f) => {
    if (f.surfaceKind !== 'cylinder' || f.radius === null || Math.abs(f.radius - radius) >= DIRECTION || f.axis === null || f.axisOrigin == null) return false;
    const offset = subtract(p.entry, f.axisOrigin);
    return Math.hypot(...subtract(offset, times(f.axis, dot(offset, f.axis)))) < POSITION
      && Math.min(distance(f.axis, p.drill), distance(f.axis, p.radial)) < DIRECTION;
  });
  expect(matches.length).toBeGreaterThanOrEqual(1);
  for (const face of matches) expect(face.cylinderExterior).toBe(false);
}
function expectGeometry(body: SolidBody, kind: Machining, frame: OracleFrame): void {
  const placements = expectedPlacements(frame);
  const thread = kind === 'simplified' || kind === 'modeled';
  const radius = thread ? 4.917 / 2 : 2;
  for (const p of placements) {
    expectBore(body, radius, p);
    if (kind === 'through') {
      expect(body.faces.filter((f) => f.surfaceKind === 'plane' && f.axis !== null && Math.abs(f.area - Math.PI * 4) < DIRECTION
        && Math.abs(Math.abs(dot(f.axis, p.drill)) - 1) < DIRECTION)).toHaveLength(0);
    } else {
      const depth = kind === 'blind' || kind === 'modeled' ? 4 : kind === 'counterbore' ? 6 : 8;
      expectPlane(body, p, depth, Math.PI * radius ** 2);
      if (kind === 'counterbore' || kind === 'modeled') {
        expectBore(body, 4, p);
        expectPlane(body, p, 2, kind === 'counterbore' ? Math.PI * 12 : undefined);
      }
    }
  }
  if (thread) {
    const length = kind === 'modeled' ? 1 : 6;
    expect(body.threadMarks).toHaveLength(placements.length);
    placements.forEach((p, i) => {
      const mark = body.threadMarks[i];
      if (mark === undefined) throw new Error('Thread mark missing');
      expect(distance(mark.origin, p.entry)).toBeLessThan(POSITION);
      expect(distance(mark.direction, p.drill)).toBeLessThan(DIRECTION);
      expect(mark.majorDiameter).toBe(6); expect(mark.length).toBe(length);
      expect(distance(add(mark.origin, times(mark.direction, mark.length)), add(p.entry, times(p.drill, length)))).toBeLessThan(POSITION);
    });
  }
}

export async function regenerateFresh(document: PartDocument): Promise<PartRecomputeResult> {
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  const before = serializeDocument(document, { savedAt: SAVED_AT });
  try {
    const result = await recomputePart(document, bridge);
    expect(result.cacheHits).toBe(0); expect(result.cancelled).toBe(false);
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(before);
    return result;
  } finally { bridge.dispose(); }
}
export function reopenBoth(document: PartDocument): readonly PartDocument[] {
  const json = serializeDocument(document, { savedAt: SAVED_AT });
  const parsed = parseDocument(json);
  const zipped = readPcadFile(writePcadFile(document, { savedAt: SAVED_AT }));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  if (!zipped.ok) throw new Error(JSON.stringify(zipped.error));
  for (const reopened of [parsed.document, zipped.document]) {
    expect(reopened).toEqual(document);
    expect(serializeDocument(reopened, { savedAt: SAVED_AT })).toBe(json);
  }
  return [parsed.document, zipped.document];
}

function fixture(transformation: Transformation): { document: PartDocument; target: string; frame: OracleFrame; keepOriginal: boolean } {
  let base: Vector = transformation === 'rigid' ? [0, 0, 0] : [30, 0, 0];
  if (transformation === 'scaleThread') base = [15, 0, 0];
  const reduced = transformation === 'scaleThread';
  let document = appendSolid(createEmptyPartDocument(), primitive('cylinder-1', base, reduced ? 5 : 10, reduced ? 20 : 40));
  let linear: Matrix, translation: Vector = [0, 0, 0], factor = 1, target: string;
  if (transformation === 'rigid') {
    const turn: TransformFeature = { id: 'turn-1', name: 'turn', kind: 'transform', suppressed: false, targetFeatureId: 'cylinder-1',
      translation: [numeric(0), numeric(0), numeric(0)], rotationAxis: { kind: 'world', axis: 'y' }, rotationAngle: numeric(30) };
    document = appendSolid(appendSolid(document, turn), { ...turn, id: 'move-1', targetFeatureId: 'turn-1',
      translation: [numeric(40), numeric(-25), numeric(15)], rotationAxis: { kind: 'world', axis: 'z' }, rotationAngle: numeric(50) });
    linear = RIGID; translation = [40, -25, 15]; target = 'move-1';
  } else if (transformation === 'mirrorXY' || transformation === 'mirrorYZ') {
    const xy = transformation === 'mirrorXY';
    document = appendSolid(document, { id: 'mirror-1', name: 'mirror', kind: 'mirror', suppressed: false, targetFeatureId: 'cylinder-1',
      plane: { kind: 'workPlane', planeId: xy ? 'xy' : 'yz' } });
    linear = xy ? [[1, 0, 0], [0, 1, 0], [0, 0, -1]] : [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]; target = 'mirror-1';
  } else {
    document = appendSolid(document, { id: 'scale-1', name: 'scale', kind: 'scale', suppressed: false, targetFeatureId: 'cylinder-1',
      origin: { kind: 'origin' }, factor: { kind: 'uniform', value: numeric(2) } });
    linear = [[2, 0, 0], [0, 2, 0], [0, 0, 2]]; factor = 2; target = 'scale-1';
  }
  return { document, target, keepOriginal: transformation === 'mirrorXY' || transformation === 'mirrorYZ',
    frame: { location: add(apply(linear, base), translation), x: unit(apply(linear, [1, 0, 0])), z: unit(apply(linear, [0, 0, 1])),
      radius: (reduced ? 5 : 10) * factor, height: (reduced ? 20 : 40) * factor } };
}

export async function runMachiningRoundtrip(transformation: Transformation, kind: Machining): Promise<void> {
  const f = fixture(transformation);
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  try {
    const base = await recomputePart(f.document, bridge);
    expect(base.errors).toEqual([]);
    const document = appendSolid(f.document, machining(kind, f.target, sideReference(onlyBody(base, f.target))));
    const before = serializeDocument(document, { savedAt: SAVED_AT });
    const directResult = await recomputePart(document, bridge);
    expect(directResult.errors).toEqual([]); expect(directResult.cancelled).toBe(false);
    const direct = onlyBody(directResult, 'hole-1');
    expectGeometry(direct, kind, f.frame);
    for (const reopened of reopenBoth(document)) {
      const result = await regenerateFresh(reopened);
      expect(result.errors).toEqual([]);
      const body = onlyBody(result, 'hole-1');
      expect(body.volume).toBe(direct.volume); expect(body.faces).toEqual(direct.faces); expect(body.threadMarks).toEqual(direct.threadMarks);
      expectGeometry(body, kind, f.frame);
      expect(result.bodies.map((b) => b.featureId).sort()).toEqual(f.keepOriginal ? ['cylinder-1', 'hole-1'] : ['hole-1']);
      if (f.keepOriginal) expect(onlyBody(result, 'cylinder-1').volume).toBe(onlyBody(base, 'cylinder-1').volume);
    }
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(before);
    if (kind === 'blind') {
      const flipped = expectedPlacements(f.frame, LOCATIONS2.map((p) => ({ ...p, angle: p.angle + 180 })));
      const wrongX = expectedPlacements({ ...f.frame, x: times(f.frame.x, -1) });
      for (const wrong of [flipped, wrongX]) {
        const first = wrong[0];
        if (first === undefined) throw new Error('Negative oracle missing');
        expect(() => expectPlane(direct, first, 4, Math.PI * 4)).toThrow();
      }
    }
    // Compare last so a native volume mismatch still leaves JSON/ZIP, signed geometry and fresh-cache evidence.
    expectVolume(direct, Math.PI * f.frame.radius ** 2 * f.frame.height - LOCATIONS2.length * removal(kind, f.frame.radius));
  } finally { bridge.dispose(); }
}
