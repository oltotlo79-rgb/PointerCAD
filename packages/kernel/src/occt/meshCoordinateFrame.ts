import type { Vec3Tuple } from '../types.js';

/** Double-precision world bounds in millimetres, before any Float32 conversion. */
export interface MeshCoordinateBounds {
  readonly minimum: Vec3Tuple;
  readonly maximum: Vec3Tuple;
}

/** A display-only translation. The BRep and its tolerances remain in world coordinates. */
export interface MeshCoordinateFrame {
  readonly origin: Vec3Tuple;
  readonly maximumFloat32ErrorMm: number;
}

const FLOAT32_MAX = 3.4028234663852886e38;
const FLOAT32_MIN_NORMAL = 2 ** -126;
const FLOAT32_HALF_SUBNORMAL_STEP = 2 ** -150;

function finitePoint(point: Vec3Tuple, name: string): void {
  if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
    throw new RangeError(`${name} must contain three finite coordinates`);
  }
}

function validFrame(frame: MeshCoordinateFrame): void {
  if (frame === null || typeof frame !== 'object'
    || !Number.isFinite(frame.maximumFloat32ErrorMm)
    || frame.maximumFloat32ErrorMm <= 0) {
    throw new RangeError('Float32 error budget must be finite and positive');
  }
  finitePoint(frame.origin, 'Mesh origin');
}

/** Conservative half-ULP bound, including the Float32 subnormal range. */
function float32RoundoffBound(magnitude: number): number {
  if (magnitude === 0) return 0;
  if (magnitude < FLOAT32_MIN_NORMAL) return FLOAT32_HALF_SUBNORMAL_STEP;
  return 2 ** (Math.floor(Math.log2(magnitude)) - 24);
}

function admitLocal(value: number, maximumError: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX) {
    throw new RangeError('Local mesh coordinate is outside finite Float32 range');
  }
  if (float32RoundoffBound(Math.abs(value)) > maximumError) {
    throw new RangeError('Local mesh extent exceeds the Float32 error budget');
  }
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || Math.abs(rounded - value) > maximumError) {
    throw new RangeError('Local mesh coordinate exceeds the Float32 error budget');
  }
  return rounded;
}

/**
 * Choose a finite origin from native-double bounds. The error budget is supplied by the
 * display consumer (for example, millimetres per CSS pixel at its current scale).
 * It applies to the whole box, not just to the vertices a caller happens to write.
 */
export function createMeshCoordinateFrame(
  bounds: MeshCoordinateBounds,
  maximumFloat32ErrorMm: number,
): MeshCoordinateFrame {
  if (bounds === null || typeof bounds !== 'object') {
    throw new RangeError('Mesh bounds are required');
  }
  finitePoint(bounds.minimum, 'Minimum bounds');
  finitePoint(bounds.maximum, 'Maximum bounds');
  if (!Number.isFinite(maximumFloat32ErrorMm) || maximumFloat32ErrorMm <= 0) {
    throw new RangeError('Float32 error budget must be finite and positive');
  }

  const origin: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const low = bounds.minimum[axis];
    const high = bounds.maximum[axis];
    if (low > high) throw new RangeError('Mesh bounds are reversed');
    const span = high - low;
    // The half-sum avoids overflow when finite endpoints straddle zero.
    const middle = Number.isFinite(span) ? low + span / 2 : low / 2 + high / 2;
    if (!Number.isFinite(middle) || middle < low || middle > high) {
      throw new RangeError('Mesh origin cannot be represented');
    }
    admitLocal(low - middle, maximumFloat32ErrorMm);
    admitLocal(high - middle, maximumFloat32ErrorMm);
    origin[axis] = middle;
  }
  return { origin, maximumFloat32ErrorMm };
}

/** Subtract in double precision before a display coordinate is rounded. */
export function worldToLocal(point: Vec3Tuple, frame: MeshCoordinateFrame): Vec3Tuple {
  finitePoint(point, 'World point');
  finitePoint(frame.origin, 'Mesh origin');
  const local: Vec3Tuple = [
    point[0] - frame.origin[0],
    point[1] - frame.origin[1],
    point[2] - frame.origin[2],
  ];
  finitePoint(local, 'Local point');
  return local;
}

/** Recover an approximate world point for display queries; BRep remains authoritative. */
export function localToWorld(point: Vec3Tuple, frame: MeshCoordinateFrame): Vec3Tuple {
  finitePoint(point, 'Local point');
  finitePoint(frame.origin, 'Mesh origin');
  const world: Vec3Tuple = [
    point[0] + frame.origin[0],
    point[1] + frame.origin[1],
    point[2] + frame.origin[2],
  ];
  finitePoint(world, 'World point');
  return world;
}

/** Write one native-double world vertex into an existing display buffer. */
export function writeLocalFloat32(
  target: Float32Array,
  offset: number,
  worldPoint: Vec3Tuple,
  frame: MeshCoordinateFrame,
): void {
  if (!(target instanceof Float32Array) || !Number.isSafeInteger(offset)
    || offset < 0 || offset > target.length - 3) {
    throw new RangeError('Float32 mesh target needs three writable elements');
  }
  validFrame(frame);
  const local = worldToLocal(worldPoint, frame);
  const x = admitLocal(local[0], frame.maximumFloat32ErrorMm);
  const y = admitLocal(local[1], frame.maximumFloat32ErrorMm);
  const z = admitLocal(local[2], frame.maximumFloat32ErrorMm);
  target[offset] = x;
  target[offset + 1] = y;
  target[offset + 2] = z;
}

/** Convert native-double triples only when an owning display consumer supplies a frame. */
export function localFloat32Coordinates(
  worldCoordinates: readonly number[] | Float64Array,
  frame: MeshCoordinateFrame,
): Float32Array {
  validFrame(frame);
  if (worldCoordinates.length % 3 !== 0) {
    throw new RangeError('Mesh coordinates must contain complete triples');
  }
  const local = new Float32Array(worldCoordinates.length);
  for (let offset = 0; offset < local.length; offset += 3) {
    writeLocalFloat32(local, offset,
      [worldCoordinates[offset], worldCoordinates[offset + 1], worldCoordinates[offset + 2]], frame);
  }
  return local;
}
