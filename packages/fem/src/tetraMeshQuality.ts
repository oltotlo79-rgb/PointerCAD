import { TETRA_LIMITS } from './tetraMesh.js';
import { exactTetrahedronOrientation } from './plcTopology.js';

export interface TetraMeshQualityLimits {
  /** Dimensionless, inclusive lower bound in [0, 1]. No default is imposed. */
  readonly minimumMeanRatio: number;
  /** Dimensionless, inclusive upper bound >= 1. */
  readonly maximumEdgeRatio: number;
}
export interface TetrahedronQuality {
  readonly element: number;
  readonly meanRatio: number;
  readonly edgeRatio: number;
  readonly volumeMm3: number;
  readonly minimumEdgeMm: number;
  readonly maximumEdgeMm: number;
  readonly violations: readonly ('mean-ratio' | 'edge-ratio')[];
}
export interface TetraMeshQuality {
  readonly units: 'mm';
  readonly limits: TetraMeshQualityLimits;
  readonly elements: readonly TetrahedronQuality[];
  readonly failingElements: readonly number[];
  readonly meetsRequestedLimits: boolean;
  readonly physicsValidated: false;
  readonly boundaryValidated: false;
}
function requireQuality(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`tetra-quality: ${message}`);
}
/** Capture the explicit policy before an asynchronous mesh request. */
export function readTetraMeshQualityLimits(value: unknown): TetraMeshQualityLimits {
  requireQuality(typeof value === 'object' && value !== null, 'explicit limits required');
  requireQuality('minimumMeanRatio' in value && 'maximumEdgeRatio' in value, 'missing limits');
  const minimum = value.minimumMeanRatio, maximum = value.maximumEdgeRatio;
  requireQuality(typeof minimum === 'number' && Number.isFinite(minimum) && minimum >= 0 && minimum <= 1
    && typeof maximum === 'number' && Number.isFinite(maximum) && maximum >= 1, 'invalid limits');
  return { minimumMeanRatio: minimum, maximumEdgeRatio: maximum };
}
function denseNumbers(value: unknown, maximum: number, stride: number): asserts value is number[] {
  requireQuality(Array.isArray(value) && value.length > 0 && value.length <= maximum
    && value.length % stride === 0, 'bounded dense dimensions required');
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    requireQuality(Object.hasOwn(value, i) && typeof item === 'number' && Number.isFinite(item), 'nonfinite or sparse array');
  }
}
type V3 = readonly [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Geometric diagnostics only. This does not certify a CAD boundary, material or solver.
 * Coordinates are millimetres. Positive orientation is never silently repaired.
 * Mean ratio = 12 (3V)^(2/3) / sum of the six squared edge lengths; regular tetrahedron = 1.
 * Local scaling avoids cubing physical lengths to compute dimensionless metrics.
 */
export function diagnoseTetraMeshQuality(value: unknown, requested: TetraMeshQualityLimits): TetraMeshQuality {
  const limits = readTetraMeshQualityLimits(requested);
  requireQuality(typeof value === 'object' && value !== null && 'coordinates' in value && 'tetrahedra' in value,
    'coordinates and tetrahedra required');
  const xyz = value.coordinates, cells = value.tetrahedra;
  denseNumbers(xyz, TETRA_LIMITS.nodes * 3, 3);
  denseNumbers(cells, TETRA_LIMITS.tetrahedra * 4, 4);
  const nodeCount = xyz.length / 3;
  for (const index of cells) requireQuality(Number.isSafeInteger(index) && index >= 0 && index < nodeCount, 'index outside nodes');
  // Bounded preflight storage only; no per-element result is allocated until all cells pass.
  const seen = new Set<string>();
  for (let i = 0; i < cells.length; i += 4) {
    const nodes = [cells[i], cells[i + 1], cells[i + 2], cells[i + 3]];
    requireQuality(new Set(nodes).size === 4, 'repeated node in tetrahedron');
    const key = nodes.sort((a, b) => a - b).join(',');
    requireQuality(!seen.has(key), 'duplicate tetrahedron'); seen.add(key);
  }
  const orientation = exactTetrahedronOrientation(xyz);
  const measure = (offset: number): Omit<TetrahedronQuality, 'element' | 'violations'> => {
    const a = cells[offset], b = cells[offset + 1], c = cells[offset + 2], d = cells[offset + 3];
    requireQuality(orientation(a, b, c, d) > 0, 'zero or reversed tetrahedron');
    const delta = (i: number, j: number): V3 => [xyz[3 * j] - xyz[3 * i],
      xyz[3 * j + 1] - xyz[3 * i + 1], xyz[3 * j + 2] - xyz[3 * i + 2]];
    const edges = [delta(a, b), delta(a, c), delta(a, d), delta(b, c), delta(b, d), delta(c, d)];
    let scale = 0;
    for (const edge of edges) for (const component of edge) {
      requireQuality(Number.isFinite(component), 'unrepresentable coordinate difference');
      scale = Math.max(scale, Math.abs(component));
    }
    requireQuality(scale > 0, 'zero extent');
    const normalize = (edge: V3): V3 => [edge[0] / scale, edge[1] / scale, edge[2] / scale];
    const lengths = edges.map(edge => Math.hypot(...normalize(edge)));
    const determinant = dot(normalize(edges[0]), cross(normalize(edges[1]), normalize(edges[2])));
    requireQuality(Number.isFinite(determinant) && determinant > 0, 'unresolved floating orientation');
    const minimum = Math.min(...lengths), maximum = Math.max(...lengths);
    const sumSquares = edges.reduce((sum, edge) => { const n = normalize(edge); return sum + dot(n, n); }, 0);
    const meanRatio = 12 * Math.cbrt(determinant / 2) ** 2 / sumSquares;
    const edgeRatio = maximum / minimum;
    // Reject unrepresentable dimensional outputs; never clamp infinity/underflow to a valid value.
    const volumeMm3 = (determinant / 6 * scale) * scale * scale;
    const minimumEdgeMm = minimum * scale, maximumEdgeMm = maximum * scale;
    requireQuality([meanRatio, edgeRatio, volumeMm3, minimumEdgeMm, maximumEdgeMm]
      .every(n => Number.isFinite(n) && n > 0), 'unrepresentable quality or dimensional value');
    return { meanRatio, edgeRatio, volumeMm3, minimumEdgeMm, maximumEdgeMm };
  };
  for (let i = 0; i < cells.length; i += 4) measure(i);
  const elements: TetrahedronQuality[] = [], failingElements: number[] = [];
  for (let i = 0; i < cells.length; i += 4) {
    const metrics = measure(i), element = i / 4;
    const violations: ('mean-ratio' | 'edge-ratio')[] = [];
    if (metrics.meanRatio < limits.minimumMeanRatio) violations.push('mean-ratio');
    if (metrics.edgeRatio > limits.maximumEdgeRatio) violations.push('edge-ratio');
    if (violations.length > 0) failingElements.push(element);
    elements.push({ element, ...metrics, violations });
  }
  return { units: 'mm', limits, elements, failingElements, meetsRequestedLimits: failingElements.length === 0,
    physicsValidated: false, boundaryValidated: false };
}
