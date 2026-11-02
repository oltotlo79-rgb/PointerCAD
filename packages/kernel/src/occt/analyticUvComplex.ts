import type { UvPoint } from './analysisSurfaceCertificate.js';

type ExactUv = readonly [bigint, bigint];
type LocalTriangle = readonly [number, number, number];

/** Preserve every binary64 coordinate exactly, including subnormal UV lifts. */
function exactUvNodes(nodes: readonly UvPoint[]): readonly ExactUv[] {
  const view = new DataView(new ArrayBuffer(8));
  const parts: { mantissa: bigint; exponent: number }[] = [];
  let minimumExponent = 0;
  for (const node of nodes) for (const coordinate of node) {
    if (!Number.isFinite(coordinate)) throw new Error('analytic-certificate: nonfinite UV complex');
    view.setFloat64(0, coordinate, false);
    const word = view.getBigUint64(0, false);
    const exponentBits = Number((word >> 52n) & 2047n);
    let mantissa = word & ((1n << 52n) - 1n);
    const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    if (exponentBits !== 0) mantissa += 1n << 52n;
    if ((word >> 63n) !== 0n) mantissa = -mantissa;
    if (mantissa !== 0n) minimumExponent = Math.min(minimumExponent, exponent);
    parts.push({ mantissa, exponent });
  }
  const integers = parts.map(({ mantissa, exponent }) => mantissa === 0n ? 0n
    : mantissa << BigInt(exponent - minimumExponent));
  return nodes.map((_, index): ExactUv => [integers[2 * index], integers[2 * index + 1]]);
}

function orientUv(a: ExactUv, b: ExactUv, c: ExactUv): bigint {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onUvSegment(p: ExactUv, a: ExactUv, b: ExactUv): boolean {
  const between = (value: bigint, first: bigint, last: bigint): boolean => first <= last
    ? first <= value && value <= last : last <= value && value <= first;
  return orientUv(a, b, p) === 0n && between(p[0], a[0], b[0]) && between(p[1], a[1], b[1]);
}

function uvContactAllowed(points: readonly ExactUv[], a: LocalTriangle, b: LocalTriangle): boolean {
  const common = a.filter(index => b.includes(index));
  if (common.length === 3) return false;
  const allowed = (point: ExactUv): boolean => common.length === 1
    ? point[0] === points[common[0]][0] && point[1] === points[common[0]][1]
    : common.length === 2 && onUvSegment(point, points[common[0]], points[common[1]]);
  const inside = (point: ExactUv, triangle: LocalTriangle): boolean => {
    const signs = triangle.map((index, side) => orientUv(points[index], points[triangle[(side + 1) % 3]], point));
    return signs.every(value => value >= 0n) || signs.every(value => value <= 0n);
  };
  for (const index of a) if (inside(points[index], b) && !allowed(points[index])) return false;
  for (const index of b) if (inside(points[index], a) && !allowed(points[index])) return false;
  const opposite = (first: bigint, last: bigint): boolean => (first < 0n && last > 0n) || (first > 0n && last < 0n);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const p = points[a[i]], q = points[a[(i + 1) % 3]];
    const r = points[b[j]], s = points[b[(j + 1) % 3]];
    if (opposite(orientUv(p, q, r), orientUv(p, q, s))
      && opposite(orientUv(r, s, p), orientUv(r, s, q))) return false;
    for (const point of [p, q]) if (onUvSegment(point, r, s) && !allowed(point)) return false;
    for (const point of [r, s]) if (onUvSegment(point, p, q) && !allowed(point)) return false;
  }
  return true;
}

/**
 * Prove an embedded, connected, oriented POLYGONAL UV complex with precisely the supplied boundary.
 * Loops repeat their first local node at the end and follow the triangle orientation. Internal edges
 * cancel exactly; every boundary occurrence must appear once, including both distinct seam lifts.
 * This proves neither correspondence to the analytic trim curves nor the native-tolerance gap tube.
 * A complete curved-face certificate still requires both independent obligations.
 */
export function validateAnalyticUvComplex(nodes: readonly UvPoint[], triangles: readonly LocalTriangle[],
  boundaryLoops: readonly (readonly number[])[], checkpoint: () => void): void {
  checkpoint();
  if (nodes.length < 3 || nodes.length > 1024 || triangles.length === 0 || triangles.length > 2048
    || boundaryLoops.length === 0 || boundaryLoops.length > triangles.length * 3) {
    throw new Error('analytic-certificate: UV complex budget');
  }
  for (let index = 0; index < nodes.length; index += 1) {
    if (!Object.hasOwn(nodes, index) || nodes[index].length !== 2
      || !Object.hasOwn(nodes[index], 0) || !Object.hasOwn(nodes[index], 1)) {
      throw new Error('analytic-certificate: sparse UV node');
    }
  }
  const points = exactUvNodes(nodes);
  const edges = new Map<string, { from: number; to: number; triangles: number[] }>();
  const neighbours: number[][] = Array.from({ length: triangles.length }, () => []);
  const used = new Set<number>();
  const validNode = (index: number): boolean => Number.isSafeInteger(index) && index >= 0 && index < nodes.length;
  let orientation: bigint | undefined;
  const boxes = triangles.map((triangle, triangleIndex) => {
    if (triangle.length !== 3) throw new Error('analytic-certificate: invalid UV triangle');
    for (let side = 0; side < 3; side += 1) {
      if (!Object.hasOwn(triangle, side) || !validNode(triangle[side])) {
        throw new Error('analytic-certificate: invalid UV triangle index');
      }
      used.add(triangle[side]);
    }
    const signedArea = orientUv(points[triangle[0]], points[triangle[1]], points[triangle[2]]);
    if (signedArea === 0n) throw new Error('analytic-certificate: degenerate UV triangle');
    const sign = signedArea > 0n ? 1n : -1n;
    orientation ??= sign;
    if (sign !== orientation) throw new Error('analytic-certificate: inconsistent UV orientation');
    for (let side = 0; side < 3; side += 1) {
      const from = triangle[side], to = triangle[(side + 1) % 3];
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const previous = edges.get(key);
      if (previous === undefined) edges.set(key, { from, to, triangles: [triangleIndex] });
      else {
        if (previous.triangles.length !== 1 || previous.from !== to || previous.to !== from) {
          throw new Error('analytic-certificate: nonmanifold UV edge');
        }
        neighbours[triangleIndex].push(previous.triangles[0]);
        neighbours[previous.triangles[0]].push(triangleIndex);
        previous.triangles.push(triangleIndex);
      }
    }
    return { index: triangleIndex, minU: Math.min(...triangle.map(index => nodes[index][0])),
      maxU: Math.max(...triangle.map(index => nodes[index][0])), minV: Math.min(...triangle.map(index => nodes[index][1])),
      maxV: Math.max(...triangle.map(index => nodes[index][1])) };
  });
  if (Object.keys(triangles).length !== triangles.length || used.size !== nodes.length) {
    throw new Error('analytic-certificate: sparse triangle or unused UV node');
  }
  const pending = [0], reached = new Set<number>();
  while (pending.length > 0) {
    const index = pending.pop();
    if (index === undefined) break;
    if (reached.has(index)) continue;
    reached.add(index);
    pending.push(...neighbours[index]);
  }
  if (reached.size !== triangles.length) throw new Error('analytic-certificate: disconnected UV complex');
  const expected = new Set<string>(), boundaryNodes = new Set<number>();
  for (let loopIndex = 0; loopIndex < boundaryLoops.length; loopIndex += 1) {
    if (!Object.hasOwn(boundaryLoops, loopIndex)) throw new Error('analytic-certificate: sparse UV boundary');
    const loop = boundaryLoops[loopIndex];
    if (loop.length < 4 || loop.length > nodes.length + 1 || loop[0] !== loop[loop.length - 1]) {
      throw new Error('analytic-certificate: incomplete UV boundary loop');
    }
    for (let index = 0; index < loop.length - 1; index += 1) {
      const from = loop[index], to = loop[index + 1];
      if (!Object.hasOwn(loop, index) || !Object.hasOwn(loop, index + 1) || !validNode(from) || !validNode(to)
        || boundaryNodes.has(from)) throw new Error('analytic-certificate: pinched or invalid UV boundary');
      boundaryNodes.add(from);
      expected.add(`${from}:${to}`);
    }
  }
  for (const edge of edges.values()) if (edge.triangles.length === 1) {
    if (!expected.delete(`${edge.from}:${edge.to}`)) throw new Error('analytic-certificate: unmatched UV boundary edge');
  }
  if (expected.size !== 0) throw new Error('analytic-certificate: missing UV boundary edge');
  boxes.sort((a, b) => a.minU - b.minU);
  let comparisons = 0;
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i], b = boxes[j];
    if (b.minU > a.maxU) break;
    if ((comparisons++ & 127) === 0) checkpoint();
    if (a.maxV < b.minV || b.maxV < a.minV) continue;
    if (!uvContactAllowed(points, triangles[a.index], triangles[b.index])) {
      throw new Error('analytic-certificate: overlapping UV triangles');
    }
  }
  checkpoint();
}

