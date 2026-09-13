/** Resource and topology preflight, completed before allocating OCCT handles. */
import type { Vec3Tuple } from '../types.js';
import { validateFunctionClipBox, type FunctionClipBox } from './clipFunctionShape.js';

export const MAX_FUNCTION_SURFACE_FACES = 100_000;
export const MAX_FUNCTION_SURFACE_VERTICES = 100_000;
export interface FunctionSurfaceGeometrySpec {
  readonly vertices: readonly Vec3Tuple[];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly bounds: FunctionClipBox;
}
export type FunctionSurfaceInput=FunctionSurfaceGeometrySpec|import('./functionSurfacePrimitiveSpec.js').FunctionSurfacePrimitiveSpec;
function array(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
export function checkedFunctionSurface(spec: FunctionSurfaceGeometrySpec): FunctionSurfaceGeometrySpec {
  validateFunctionClipBox(spec.bounds);
  if (!array(spec.vertices) || !array(spec.triangles) || spec.vertices.length > MAX_FUNCTION_SURFACE_VERTICES
    || spec.triangles.length > MAX_FUNCTION_SURFACE_FACES) throw new Error('関数曲面の点または面の数が上限を超えています。');
  const vertices: Vec3Tuple[] = [];
  for (const value of spec.vertices) {
    if (!array(value) || value.length !== 3) throw new Error('関数曲面の各点にXYZを指定してください。');
    const x = value[0], y = value[1], z = value[2];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number'
      || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('関数曲面の座標は有限の実数にしてください。');
    vertices.push([x,y,z]);
  }
  const readIndex = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= vertices.length) {
      throw new Error('関数曲面が参照する点の番号を確認してください。');
    }
    return value;
  };
  const triangles: [number,number,number][] = [], faces = new Set<string>(), edgeOrientations = new Map<string,number[]>();
  for (const value of spec.triangles) {
    if (!array(value) || value.length !== 3) throw new Error('関数曲面の三角形には3点を指定してください。');
    const a = readIndex(value[0]), b = readIndex(value[1]), c = readIndex(value[2]);
    if (a === b || a === c || b === c) throw new Error('関数曲面の面に同じ点番号が重複しています。');
    const triangle: [number,number,number] = [a,b,c], faceKey = [...triangle].sort((x,y)=>x-y).join(',');
    if (faces.has(faceKey)) throw new Error('関数曲面の同じ面が重複しています。');
    faces.add(faceKey);
    for (let index = 0; index < 3; index++) {
      const start = triangle[index], end = triangle[(index+1)%3], key = `${Math.min(start,end)},${Math.max(start,end)}`;
      const orientations = edgeOrientations.get(key) ?? []; orientations.push(start < end ? 1 : -1);
      if (orientations.length > 2 || orientations.length === 2 && orientations[0] === orientations[1]) {
        throw new Error('関数曲面のつながりまたは面の向きが正しくありません。');
      }
      edgeOrientations.set(key,orientations);
    }
    triangles.push(triangle);
  }
  return { vertices, triangles, bounds: {
    minimum:[spec.bounds.minimum[0],spec.bounds.minimum[1],spec.bounds.minimum[2]],
    maximum:[spec.bounds.maximum[0],spec.bounds.maximum[1],spec.bounds.maximum[2]],
  } };
}
