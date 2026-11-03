/**
 * Independent input for the planar sheet origin tests: a 40 x 30 mm rectangle of four saved lines on z = 0.
 * Every expectation here is derived from this input alone (line endpoints and IDs), never from a kernel run.
 */
import type { CurveSpec, Vec3Tuple } from '../types.js';
import type { PlanarSurfaceLineAnchor } from './planarSurfaceOrigins.js';

export const PLANAR_SKETCH_ID = 'saved-sketch';
export const PLANAR_FEATURE_ID = 'saved-sheet';
/** Area of the 40 x 30 mm rectangle (mm^2). */
export const RECTANGLE_AREA = 40 * 30;

export interface SourceLine {
  readonly id: string;
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
}

/** Counter-clockwise rectangle (0,0)-(40,0)-(40,30)-(0,30), each side one saved line feature. */
export const RECTANGLE_LINES: readonly SourceLine[] = [
  { id: 'line-bottom', from: [0, 0, 0], to: [40, 0, 0] },
  { id: 'line-right', from: [40, 0, 0], to: [40, 30, 0] },
  { id: 'line-top', from: [40, 30, 0], to: [0, 30, 0] },
  { id: 'line-left', from: [0, 30, 0], to: [0, 0, 0] },
];

/** The same closed loop in another native enumeration order: start at `start`, optionally walked backwards. */
export function reorderedLoop(lines: readonly SourceLine[], start: number, reversed: boolean): readonly SourceLine[] {
  const rotated = [...lines.slice(start), ...lines.slice(0, start)];
  return reversed ? [...rotated].reverse().map(line => ({ id: line.id, from: line.to, to: line.from })) : rotated;
}

/** The same geometry owned by other saved line IDs. */
export function renamedLoop(lines: readonly SourceLine[], prefix: string): readonly SourceLine[] {
  return lines.map(line => ({ ...line, id: `${prefix}${line.id}` }));
}

export function profileOf(lines: readonly SourceLine[]): readonly CurveSpec[] {
  return lines.map((line): CurveSpec => ({ kind: 'segment', from: line.from, to: line.to }));
}

export function anchorsOf(lines: readonly SourceLine[], sketchId = PLANAR_SKETCH_ID): readonly PlanarSurfaceLineAnchor[] {
  return lines.map((line): PlanarSurfaceLineAnchor => ({ sketchId, lineFeatureId: line.id, role: 'whole-line' }));
}

function samePoint(left: Vec3Tuple, right: Vec3Tuple): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Expected midpoint of each line, from its own input endpoints. */
export function expectedMidpoints(lines: readonly SourceLine[]): ReadonlyMap<string, Vec3Tuple> {
  return new Map(lines.map((line): [string, Vec3Tuple] => [line.id, [
    (line.from[0] + line.to[0]) / 2, (line.from[1] + line.to[1]) / 2, (line.from[2] + line.to[2]) / 2,
  ]]));
}

/** Expected corners: each input endpoint with the two line IDs that end there (ascending). */
export function expectedCorners(lines: readonly SourceLine[]): readonly { readonly position: Vec3Tuple;
  readonly lineFeatureIds: readonly [string, string] }[] {
  const corners: { position: Vec3Tuple; ids: string[] }[] = [];
  for (const line of lines) {
    for (const point of [line.from, line.to]) {
      const found = corners.find(corner => samePoint(corner.position, point));
      if (found === undefined) corners.push({ position: point, ids: [line.id] });
      else if (!found.ids.includes(line.id)) found.ids.push(line.id);
    }
  }
  return corners.map(corner => {
    if (corner.ids.length !== 2) throw new Error('Test input must be a simple closed loop');
    const [low, high] = [...corner.ids].sort(byCodeUnit);
    return { position: corner.position, lineFeatureIds: [low, high] };
  });
}

/** Expected saved face identity: the sheet feature and the ascending set of source line IDs. */
export function expectedFaceLineIds(lines: readonly SourceLine[]): readonly string[] {
  return lines.map(line => line.id).sort(byCodeUnit);
}
