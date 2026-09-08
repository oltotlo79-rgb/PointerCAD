/**
 * 2 つの三角形網の表面交差を、一様格子で絞って調べる純粋な数値計算(P7 タスク23)。
 *
 * 干渉の最終判断は B-rep の Common が行う。この格子は候補の優先順位付けと表示補助に
 * だけ使い、「表面が交差しない = 体積干渉なし」とは判断しない。完全包含では表面同士が
 * 交差しないためである。
 */

export type TrianglePoint = readonly [number, number, number];
export type Triangle3 = readonly [TrianglePoint, TrianglePoint, TrianglePoint];

/** 法線は交差判定に使わないため、位置と添字だけを受け取る。 */
export interface TriangleMeshData {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface TriangleOverlapPair {
  readonly aTriangle: number;
  readonly bTriangle: number;
}

export interface TriangleOverlapOptions {
  /** 省略時は、2 網を囲む箱の対角線の 1/20。 */
  readonly cellSizeMm?: number;
  /** 表示の有無だけを知りたい呼び出しでは 1 を渡せる。 */
  readonly maxOverlapCount?: number;
}

export interface TriangleOverlapResult {
  readonly overlaps: readonly TriangleOverlapPair[];
  readonly cellSizeMm: number;
  /** 同じ升目に入った、重複を除いた組の数。 */
  readonly candidatePairCount: number;
  /** 囲み箱も重なり、11 軸の判定まで進んだ組の数。 */
  readonly testedPairCount: number;
  readonly totalPairCount: number;
  readonly truncated: boolean;
}

const DEFAULT_GRID_DIVISIONS = 20;
const MAX_DENSE_GRID_CELLS = 2_000_000;
const RELATIVE_EPSILON = 1e-10;
const DEGENERATE_EPSILON = 1e-24;

interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface MeshFacts {
  readonly count: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** 三角形ごとの min/max 6 個。 */
  readonly bounds: Float64Array;
  /** xyz と長さの二乗。交差候補ごとに法線を作り直さない。 */
  readonly normals: Float64Array;
  readonly scales: Float64Array;
  readonly degenerate: Uint8Array;
  readonly overall: Bounds | null;
}

interface GridPlan extends Bounds {
  readonly cellSizeMm: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

interface PackedGrid {
  readonly plan: GridPlan;
  readonly cellStart: Int32Array;
  readonly items: Int32Array;
}

function finitePoint(point: TrianglePoint): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

function triangleScaleSquared(coordinates: ArrayLike<number>, offset: number): number {
  let largest = 0;
  for (let edge = 0; edge < 3; edge += 1) {
    const first = offset + edge * 3;
    const second = offset + ((edge + 1) % 3) * 3;
    const x = coordinates[second] - coordinates[first];
    const y = coordinates[second + 1] - coordinates[first + 1];
    const z = coordinates[second + 2] - coordinates[first + 2];
    largest = Math.max(largest, x * x + y * y + z * z);
  }
  return largest;
}

function normalOf(
  coordinates: ArrayLike<number>,
  offset: number,
): readonly [number, number, number, number] {
  const e1x = coordinates[offset + 3] - coordinates[offset];
  const e1y = coordinates[offset + 4] - coordinates[offset + 1];
  const e1z = coordinates[offset + 5] - coordinates[offset + 2];
  const e2x = coordinates[offset + 6] - coordinates[offset];
  const e2y = coordinates[offset + 7] - coordinates[offset + 1];
  const e2z = coordinates[offset + 8] - coordinates[offset + 2];
  const x = e1y * e2z - e1z * e2y;
  const y = e1z * e2x - e1x * e2z;
  const z = e1x * e2y - e1y * e2x;
  return [x, y, z, x * x + y * y + z * z];
}

function isDegenerate(coordinates: ArrayLike<number>, offset: number): boolean {
  for (let index = 0; index < 9; index += 1) {
    if (!Number.isFinite(coordinates[offset + index])) return true;
  }
  const scaleSquared = triangleScaleSquared(coordinates, offset);
  if (!(scaleSquared > 0)) return true;
  const normal = normalOf(coordinates, offset);
  return normal[3] <= DEGENERATE_EPSILON * scaleSquared * scaleSquared;
}

/**
 * 指定軸へ射影して分離しているかを調べる。A の先頭を原点としてから射影するため、
 * 大きな世界座標でも共通の平行移動による桁落ちを増やさない。
 */
function axisSeparates(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  axisX: number,
  axisY: number,
  axisZ: number,
  scale: number,
): boolean {
  const lengthSquared = axisX * axisX + axisY * axisY + axisZ * axisZ;
  if (!(lengthSquared > DEGENERATE_EPSILON)) return false;
  const originX = a[ao];
  const originY = a[ao + 1];
  const originZ = a[ao + 2];
  let minA = Number.POSITIVE_INFINITY;
  let maxA = Number.NEGATIVE_INFINITY;
  let minB = Number.POSITIVE_INFINITY;
  let maxB = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 3; corner += 1) {
    const ai = ao + corner * 3;
    const bi = bo + corner * 3;
    const projectedA = (a[ai] - originX) * axisX
      + (a[ai + 1] - originY) * axisY
      + (a[ai + 2] - originZ) * axisZ;
    const projectedB = (b[bi] - originX) * axisX
      + (b[bi + 1] - originY) * axisY
      + (b[bi + 2] - originZ) * axisZ;
    minA = Math.min(minA, projectedA);
    maxA = Math.max(maxA, projectedA);
    minB = Math.min(minB, projectedB);
    maxB = Math.max(maxB, projectedB);
  }
  const tolerance = RELATIVE_EPSILON * Math.sqrt(lengthSquared) * Math.max(1, scale);
  return maxA < minB - tolerance || maxB < minA - tolerance;
}

function coordinatesIntersect(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): boolean {
  if (isDegenerate(a, ao) || isDegenerate(b, bo)) return false;

  const normalA = normalOf(a, ao);
  const normalB = normalOf(b, bo);
  const scale = Math.sqrt(Math.max(
    triangleScaleSquared(a, ao),
    triangleScaleSquared(b, bo),
  ));

  return preparedCoordinatesIntersect(a, ao, normalA, 0, scale, b, bo, normalB, 0, scale);
}

function preparedCoordinatesIntersect(
  a: ArrayLike<number>,
  ao: number,
  normalsA: ArrayLike<number>,
  normalOffsetA: number,
  scaleA: number,
  b: ArrayLike<number>,
  bo: number,
  normalsB: ArrayLike<number>,
  normalOffsetB: number,
  scaleB: number,
): boolean {
  const normalAx = normalsA[normalOffsetA];
  const normalAy = normalsA[normalOffsetA + 1];
  const normalAz = normalsA[normalOffsetA + 2];
  const normalASquared = normalsA[normalOffsetA + 3];
  const normalBx = normalsB[normalOffsetB];
  const normalBy = normalsB[normalOffsetB + 1];
  const normalBz = normalsB[normalOffsetB + 2];
  const normalBSquared = normalsB[normalOffsetB + 3];
  const scale = Math.max(scaleA, scaleB);

  if (axisSeparates(a, ao, b, bo, normalAx, normalAy, normalAz, scale)) return false;
  if (axisSeparates(a, ao, b, bo, normalBx, normalBy, normalBz, scale)) return false;

  const crossNormalsX = normalAy * normalBz - normalAz * normalBy;
  const crossNormalsY = normalAz * normalBx - normalAx * normalBz;
  const crossNormalsZ = normalAx * normalBy - normalAy * normalBx;
  const crossNormalsSquared = crossNormalsX * crossNormalsX
    + crossNormalsY * crossNormalsY + crossNormalsZ * crossNormalsZ;
  const normalsParallel = crossNormalsSquared
    <= RELATIVE_EPSILON * RELATIVE_EPSILON * normalASquared * normalBSquared;

  // 共面では辺×辺の 9 軸がすべて面法線を向く。代わりに面内の 6 軸を直接調べる。
  if (normalsParallel) {
    for (let source = 0; source < 2; source += 1) {
      const coordinates = source === 0 ? a : b;
      const offset = source === 0 ? ao : bo;
      for (let edge = 0; edge < 3; edge += 1) {
        const first = offset + edge * 3;
        const second = offset + ((edge + 1) % 3) * 3;
        const ex = coordinates[second] - coordinates[first];
        const ey = coordinates[second + 1] - coordinates[first + 1];
        const ez = coordinates[second + 2] - coordinates[first + 2];
        const x = normalAy * ez - normalAz * ey;
        const y = normalAz * ex - normalAx * ez;
        const z = normalAx * ey - normalAy * ex;
        if (axisSeparates(a, ao, b, bo, x, y, z, scale)) return false;
      }
    }
    return true;
  }

  // 3 辺 × 3 辺の外積。上の 2 本と合わせて、非共面では 11 軸になる。
  for (let edgeA = 0; edgeA < 3; edgeA += 1) {
    const a0 = ao + edgeA * 3;
    const a1 = ao + ((edgeA + 1) % 3) * 3;
    const eax = a[a1] - a[a0];
    const eay = a[a1 + 1] - a[a0 + 1];
    const eaz = a[a1 + 2] - a[a0 + 2];
    for (let edgeB = 0; edgeB < 3; edgeB += 1) {
      const b0 = bo + edgeB * 3;
      const b1 = bo + ((edgeB + 1) % 3) * 3;
      const ebx = b[b1] - b[b0];
      const eby = b[b1 + 1] - b[b0 + 1];
      const ebz = b[b1 + 2] - b[b0 + 2];
      const x = eay * ebz - eaz * eby;
      const y = eaz * ebx - eax * ebz;
      const z = eax * eby - eay * ebx;
      if (axisSeparates(a, ao, b, bo, x, y, z, scale)) return false;
    }
  }
  return true;
}

/** 2 枚の三角形を 11 軸 SAT で調べる。接触は true、面積 0 は false。 */
export function trianglesIntersect(a: Triangle3, b: Triangle3): boolean {
  if (!a.every(finitePoint) || !b.every(finitePoint)) return false;
  const coordinatesA = new Float64Array(9);
  const coordinatesB = new Float64Array(9);
  for (let corner = 0; corner < 3; corner += 1) {
    coordinatesA.set(a[corner], corner * 3);
    coordinatesB.set(b[corner], corner * 3);
  }
  return coordinatesIntersect(coordinatesA, 0, coordinatesB, 0);
}

function collectFacts(mesh: TriangleMeshData): MeshFacts {
  const count = Math.floor(mesh.indices.length / 3);
  const bounds = new Float64Array(count * 6);
  const normals = new Float64Array(count * 4);
  const scales = new Float64Array(count);
  const degenerate = new Uint8Array(count);
  let overallMinX = Number.POSITIVE_INFINITY;
  let overallMinY = Number.POSITIVE_INFINITY;
  let overallMinZ = Number.POSITIVE_INFINITY;
  let overallMaxX = Number.NEGATIVE_INFINITY;
  let overallMaxY = Number.NEGATIVE_INFINITY;
  let overallMaxZ = Number.NEGATIVE_INFINITY;
  const vertexCount = Math.floor(mesh.positions.length / 3);

  for (let triangle = 0; triangle < count; triangle += 1) {
    const firstVertex = mesh.indices[triangle * 3];
    const secondVertex = mesh.indices[triangle * 3 + 1];
    const thirdVertex = mesh.indices[triangle * 3 + 2];
    if (!Number.isInteger(firstVertex) || !Number.isInteger(secondVertex) || !Number.isInteger(thirdVertex)
      || firstVertex < 0 || secondVertex < 0 || thirdVertex < 0
      || firstVertex >= vertexCount || secondVertex >= vertexCount || thirdVertex >= vertexCount) {
      degenerate[triangle] = 1;
      continue;
    }
    const ai = firstVertex * 3;
    const bi = secondVertex * 3;
    const ci = thirdVertex * 3;
    const ax = mesh.positions[ai];
    const ay = mesh.positions[ai + 1];
    const az = mesh.positions[ai + 2];
    const bx = mesh.positions[bi];
    const by = mesh.positions[bi + 1];
    const bz = mesh.positions[bi + 2];
    const cx = mesh.positions[ci];
    const cy = mesh.positions[ci + 1];
    const cz = mesh.positions[ci + 2];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)
      || !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)
      || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
      degenerate[triangle] = 1;
      continue;
    }
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const bcx = cx - bx;
    const bcy = cy - by;
    const bcz = cz - bz;
    const scaleSquared = Math.max(
      abx * abx + aby * aby + abz * abz,
      acx * acx + acy * acy + acz * acz,
      bcx * bcx + bcy * bcy + bcz * bcz,
    );
    const normalX = aby * acz - abz * acy;
    const normalY = abz * acx - abx * acz;
    const normalZ = abx * acy - aby * acx;
    const normalSquared = normalX * normalX + normalY * normalY + normalZ * normalZ;
    if (!(scaleSquared > 0) || normalSquared <= DEGENERATE_EPSILON * scaleSquared * scaleSquared) {
      degenerate[triangle] = 1;
      continue;
    }
    normals[triangle * 4] = normalX;
    normals[triangle * 4 + 1] = normalY;
    normals[triangle * 4 + 2] = normalZ;
    normals[triangle * 4 + 3] = normalSquared;
    scales[triangle] = Math.sqrt(scaleSquared);
    const bo = triangle * 6;
    const minX = Math.min(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const minZ = Math.min(az, bz, cz);
    const maxX = Math.max(ax, bx, cx);
    const maxY = Math.max(ay, by, cy);
    const maxZ = Math.max(az, bz, cz);
    bounds[bo] = minX;
    bounds[bo + 1] = minY;
    bounds[bo + 2] = minZ;
    bounds[bo + 3] = maxX;
    bounds[bo + 4] = maxY;
    bounds[bo + 5] = maxZ;
    overallMinX = Math.min(overallMinX, minX);
    overallMinY = Math.min(overallMinY, minY);
    overallMinZ = Math.min(overallMinZ, minZ);
    overallMaxX = Math.max(overallMaxX, maxX);
    overallMaxY = Math.max(overallMaxY, maxY);
    overallMaxZ = Math.max(overallMaxZ, maxZ);
  }
  const overall = Number.isFinite(overallMinX) ? {
    minX: overallMinX, minY: overallMinY, minZ: overallMinZ,
    maxX: overallMaxX, maxY: overallMaxY, maxZ: overallMaxZ,
  } : null;
  return { count, positions: mesh.positions, indices: mesh.indices,
    bounds, normals, scales, degenerate, overall };
}

function copyTriangle(facts: MeshFacts, triangle: number, target: Float64Array): void {
  const indexOffset = triangle * 3;
  for (let corner = 0; corner < 3; corner += 1) {
    const source = facts.indices[indexOffset + corner] * 3;
    const destination = corner * 3;
    target[destination] = facts.positions[source];
    target[destination + 1] = facts.positions[source + 1];
    target[destination + 2] = facts.positions[source + 2];
  }
}

function combinedBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

function cellCount(size: number, cellSizeMm: number): number {
  return Math.max(1, Math.ceil(size / cellSizeMm));
}

function makePlan(bounds: Bounds, requestedCellSize: number | undefined): GridPlan {
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const dz = bounds.maxZ - bounds.minZ;
  const diagonal = Math.hypot(dx, dy, dz);
  const cellSizeMm = requestedCellSize ?? (diagonal > 0 ? diagonal / DEFAULT_GRID_DIVISIONS : 1);
  if (!Number.isFinite(cellSizeMm) || !(cellSizeMm > 0)) {
    throw new RangeError('升目の大きさは 0 より大きい有限値にしてください。');
  }
  const nx = cellCount(dx, cellSizeMm);
  const ny = cellCount(dy, cellSizeMm);
  const nz = cellCount(dz, cellSizeMm);
  if (nx * ny * nz > MAX_DENSE_GRID_CELLS) {
    throw new RangeError('升目が細かすぎます。');
  }
  return { ...bounds, cellSizeMm, nx, ny, nz };
}

function cellIndex(value: number, minimum: number, cellSizeMm: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor((value - minimum) / cellSizeMm)));
}

function buildCellRanges(facts: MeshFacts, plan: GridPlan): Int32Array {
  const ranges = new Int32Array(facts.count * 6);
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] !== 0) continue;
    const boundsOffset = triangle * 6;
    ranges[boundsOffset] = cellIndex(facts.bounds[boundsOffset], plan.minX, plan.cellSizeMm, plan.nx);
    ranges[boundsOffset + 1] = cellIndex(facts.bounds[boundsOffset + 3], plan.minX, plan.cellSizeMm, plan.nx);
    ranges[boundsOffset + 2] = cellIndex(facts.bounds[boundsOffset + 1], plan.minY, plan.cellSizeMm, plan.ny);
    ranges[boundsOffset + 3] = cellIndex(facts.bounds[boundsOffset + 4], plan.minY, plan.cellSizeMm, plan.ny);
    ranges[boundsOffset + 4] = cellIndex(facts.bounds[boundsOffset + 2], plan.minZ, plan.cellSizeMm, plan.nz);
    ranges[boundsOffset + 5] = cellIndex(facts.bounds[boundsOffset + 5], plan.minZ, plan.cellSizeMm, plan.nz);
  }
  return ranges;
}

function buildGrid(facts: MeshFacts, ranges: Int32Array, plan: GridPlan): PackedGrid {
  const cellTotal = plan.nx * plan.ny * plan.nz;
  const counts = new Int32Array(cellTotal);
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] !== 0) continue;
    const offset = triangle * 6;
    for (let z = ranges[offset + 4]; z <= ranges[offset + 5]; z += 1) {
      for (let y = ranges[offset + 2]; y <= ranges[offset + 3]; y += 1) {
        for (let x = ranges[offset]; x <= ranges[offset + 1]; x += 1) {
          counts[(z * plan.ny + y) * plan.nx + x] += 1;
        }
      }
    }
  }
  const cellStart = new Int32Array(cellTotal + 1);
  for (let cell = 0; cell < cellTotal; cell += 1) {
    cellStart[cell + 1] = cellStart[cell] + counts[cell];
  }
  const items = new Int32Array(cellStart[cellTotal]);
  const cursor = cellStart.slice(0, cellTotal);
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] !== 0) continue;
    const offset = triangle * 6;
    for (let z = ranges[offset + 4]; z <= ranges[offset + 5]; z += 1) {
      for (let y = ranges[offset + 2]; y <= ranges[offset + 3]; y += 1) {
        for (let x = ranges[offset]; x <= ranges[offset + 1]; x += 1) {
          const cell = (z * plan.ny + y) * plan.nx + x;
          items[cursor[cell]] = triangle;
          cursor[cell] += 1;
        }
      }
    }
  }
  return { plan, cellStart, items };
}

function boundsOverlap(a: Float64Array, ao: number, b: Float64Array, bo: number): boolean {
  return a[ao] <= b[bo + 3] && b[bo] <= a[ao + 3]
    && a[ao + 1] <= b[bo + 4] && b[bo + 1] <= a[ao + 4]
    && a[ao + 2] <= b[bo + 5] && b[bo + 2] <= a[ao + 5];
}

/**
 * 同じ升目に入った組だけを 11 軸 SAT へ渡す。返す組は常に a,b の通し番号順で、
 * 同じ三角形が複数の升目に跨がっても 1 回だけ現れる。
 */
export function findTriangleOverlaps(
  meshA: TriangleMeshData,
  meshB: TriangleMeshData,
  options: TriangleOverlapOptions = {},
): TriangleOverlapResult {
  const a = collectFacts(meshA);
  const b = collectFacts(meshB);
  const overall = combinedBounds(a.overall, b.overall);
  const totalPairCount = a.count * b.count;
  if (overall === null) {
    const cellSizeMm = options.cellSizeMm ?? 1;
    if (!Number.isFinite(cellSizeMm) || !(cellSizeMm > 0)) {
      throw new RangeError('升目の大きさは 0 より大きい有限値にしてください。');
    }
    return { overlaps: [], cellSizeMm, candidatePairCount: 0, testedPairCount: 0,
      totalPairCount, truncated: false };
  }
  const plan = makePlan(overall, options.cellSizeMm);
  const rangesA = buildCellRanges(a, plan);
  const rangesB = buildCellRanges(b, plan);
  const grid = buildGrid(a, rangesA, plan);
  const seen = new Int32Array(a.count);
  const triangleA = new Float64Array(9);
  const triangleB = new Float64Array(9);
  const overlaps: TriangleOverlapPair[] = [];
  const maximum = options.maxOverlapCount === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.maxOverlapCount));
  let candidatePairCount = 0;
  let testedPairCount = 0;
  let truncated = false;

  outer: for (let bTriangle = 0; bTriangle < b.count; bTriangle += 1) {
    if (b.degenerate[bTriangle] !== 0) continue;
    let copiedB = false;
    const stamp = bTriangle + 1;
    const rangeOffset = bTriangle * 6;
    for (let z = rangesB[rangeOffset + 4]; z <= rangesB[rangeOffset + 5]; z += 1) {
      for (let y = rangesB[rangeOffset + 2]; y <= rangesB[rangeOffset + 3]; y += 1) {
        for (let x = rangesB[rangeOffset]; x <= rangesB[rangeOffset + 1]; x += 1) {
          const cell = (z * plan.ny + y) * plan.nx + x;
          for (let item = grid.cellStart[cell]; item < grid.cellStart[cell + 1]; item += 1) {
            const aTriangle = grid.items[item];
            if (seen[aTriangle] === stamp) continue;
            seen[aTriangle] = stamp;
            candidatePairCount += 1;
            if (!boundsOverlap(a.bounds, aTriangle * 6, b.bounds, bTriangle * 6)) continue;
            testedPairCount += 1;
            copyTriangle(a, aTriangle, triangleA);
            if (!copiedB) {
              copyTriangle(b, bTriangle, triangleB);
              copiedB = true;
            }
            if (!preparedCoordinatesIntersect(
              triangleA, 0, a.normals, aTriangle * 4, a.scales[aTriangle],
              triangleB, 0, b.normals, bTriangle * 4, b.scales[bTriangle],
            )) continue;
            if (overlaps.length >= maximum) {
              truncated = true;
              break outer;
            }
            overlaps.push({ aTriangle, bTriangle });
          }
        }
      }
    }
  }
  overlaps.sort((left, right) => left.aTriangle - right.aTriangle || left.bTriangle - right.bTriangle);
  return { overlaps, cellSizeMm: plan.cellSizeMm, candidatePairCount, testedPairCount,
    totalPairCount, truncated };
}
