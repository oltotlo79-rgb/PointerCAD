/**
 * Independent EX05 test oracle. Only known input matrices and elementary vector arithmetic enter here;
 * no OCCT frame, product transform, resolved plan or generated geometry supplies an expectation.
 */
import type { Vec3Tuple } from '../types.js';

export type HoleOracleMatrix = readonly [Vec3Tuple, Vec3Tuple, Vec3Tuple];

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function holeOracleTimes(matrix: HoleOracleMatrix, vector: Vec3Tuple): Vec3Tuple {
  return [dot(matrix[0], vector), dot(matrix[1], vector), dot(matrix[2], vector)];
}

export function holeOraclePlus(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaled(a: Vec3Tuple, s: number): Vec3Tuple { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const identity: HoleOracleMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// Rz(atan2(4,3)) Ry(atan2(5,12)); entries are exact rational input constants.
const rotation: HoleOracleMatrix = [[36 / 65, -4 / 5, 3 / 13], [48 / 65, 3 / 5, 4 / 13], [-5 / 13, 0, 12 / 13]];
const mirrored: HoleOracleMatrix = [[36 / 65, 4 / 5, 3 / 13], [48 / 65, -3 / 5, 4 / 13], [-5 / 13, 0, 12 / 13]];
export const CYLINDER_ORACLE_PLACEMENTS = [
  { name: 'identity', matrix: identity, translation: [0, 0, 0] as Vec3Tuple, reflected: false },
  { name: 'translated rotation', matrix: rotation, translation: [13, -17, 23] as Vec3Tuple, reflected: false },
  { name: 'translated reflection', matrix: mirrored, translation: [-31, 19, 7] as Vec3Tuple, reflected: true },
].flatMap(placement => [37, -53, 37 + 360, -53 - 360].map(degrees => ({ ...placement, degrees })));

/** W1's X/Z columns and right-handed Z cross X construction, unchanged (cylinder R=10, bottom z=-5). */
export function cylinderPlacementOracle(matrix: HoleOracleMatrix, translation: Vec3Tuple, height: number, angle: number) {
  const x = holeOracleTimes(matrix, [1, 0, 0]), z = holeOracleTimes(matrix, [0, 0, 1]);
  const y = cross(z, x);
  const radial = holeOraclePlus(scaled(x, Math.cos(angle)), scaled(y, Math.sin(angle)));
  const axialPoint = holeOraclePlus(translation, holeOracleTimes(matrix, [0, 0, height - 5]));
  const expected = holeOraclePlus(axialPoint, scaled(radial, 10));
  return { x, y, z, radial, axialPoint, expected };
}
