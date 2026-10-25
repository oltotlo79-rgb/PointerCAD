import { formatDisplayLength, type LengthUnit, type SolidBody } from '@pointercad/model';

/** A blank or malformed detail value never reaches the export request. */
export function parseExportDeviationMm(source: string): number | null {
  const decimal = source.trim();
  if (!/^[+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(decimal)) return null;
  const value = Number(decimal);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Display bounds combine local Float32 vertices with their double-precision origins. */
export function displayMeshDimensionsMm(
  meshes: readonly { readonly positions: Float32Array; readonly coordinateFrame?: SolidBody['coordinateFrame'] }[],
): readonly [number, number, number] | null {
  if (meshes.length === 0) return null;
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let vertices = 0;
  for (const mesh of meshes) {
    const frame = mesh.coordinateFrame;
    const origin = frame?.origin ?? [0, 0, 0];
    if (frame !== undefined && (frame.space !== 'local' || !Array.isArray(origin) || origin.length !== 3
      || ![0, 1, 2].every(axis => Object.hasOwn(origin, axis) && Number.isFinite(origin[axis]))
      || !Number.isFinite(frame.maximumFloat32ErrorMm) || frame.maximumFloat32ErrorMm <= 0)) return null;
    if (mesh.positions.length < 9 || mesh.positions.length % 3 !== 0) return null;
    for (let index = 0; index < mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = mesh.positions[index + axis] + origin[axis];
        if (!Number.isFinite(coordinate)) return null;
        minimum[axis] = Math.min(minimum[axis], coordinate);
        maximum[axis] = Math.max(maximum[axis], coordinate);
      }
      vertices += 1;
    }
  }
  if (vertices === 0) return null;
  return [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]];
}

/** Float32 display coordinates carry about seven decimal significant digits. */
const DISPLAY_MESH_SIGNIFICANT_DIGITS = 6;

/** Existing measurement formatting keeps mm/inch units consistent. */
export function formatDisplayMeshDimensions(
  dimensionsMm: readonly [number, number, number],
  unit: LengthUnit,
): string {
  return dimensionsMm.map(value => formatDisplayLength(
    Number(value.toPrecision(DISPLAY_MESH_SIGNIFICANT_DIGITS)), unit,
  )).join(' × ');
}
