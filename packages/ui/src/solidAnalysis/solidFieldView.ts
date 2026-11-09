import type { CadSolidOutcome } from '@pointercad/fem';
import { crossVec3, dotVec3 } from '@pointercad/model/vec3';
import type { MessageKey } from '../i18n/t.js';

/**
 * Display-only field of one completed linear Tet4 solid result (never saved, never a new analysis).
 * Indices are those of the analysed input mesh: `prepared.input.nodes[i]` pairs with `result.displacementMm[i]`
 * and `prepared.input.elements[e]` with `result.elements[e]`. Tet4 stresses and engineering strains are constant per element, so every
 * boundary triangle carries exactly its owning element's value: no interpolation between elements.
 */
export const SOLID_FIELD_QUANTITIES = ['vonMises', 'xx', 'yy', 'zz', 'yz', 'xz', 'xy'] as const;
/** Stress-only choices remain shared with the finite-deformation Cauchy-stress adapter. */
export type SolidFieldQuantity = typeof SOLID_FIELD_QUANTITIES[number];
export const SOLID_STRAIN_QUANTITIES = ['strainXx', 'strainYy', 'strainZz', 'strainYz', 'strainXz', 'strainXy'] as const;
 type SolidStrainQuantity = typeof SOLID_STRAIN_QUANTITIES[number];
export const SOLID_LINEAR_FIELD_QUANTITIES = [...SOLID_FIELD_QUANTITIES, ...SOLID_STRAIN_QUANTITIES] as const;
export type SolidLinearFieldQuantity = typeof SOLID_LINEAR_FIELD_QUANTITIES[number];
const STRAIN_COMPONENT: Readonly<Record<SolidStrainQuantity, number>> = {
  strainXx: 0, strainYy: 1, strainZz: 2, strainYz: 3, strainXz: 4, strainXy: 5,
};
 function isSolidStrainQuantity(quantity: SolidLinearFieldQuantity): quantity is SolidStrainQuantity {
  return SOLID_STRAIN_QUANTITIES.some(value => value === quantity);
}
/** Display unit only; engineering shear is already gamma, never divided or multiplied by two. */
export function solidFieldUnit(quantity: SolidLinearFieldQuantity): 'MPa' | 'dimensionless' {
  return isSolidStrainQuantity(quantity) ? 'dimensionless' : 'MPa';
}
type SolidResult = Extract<CadSolidOutcome, { kind: 'result' }>;
type Stress = SolidResult['result']['elements'][number]['stressMPa'];

const COMPONENT: Readonly<Record<Exclude<SolidFieldQuantity, 'vonMises'>, number>> = { xx: 0, yy: 1, zz: 2, yz: 3, xz: 4, xy: 5 };

/** Von Mises equivalent stress (MPa) of Cauchy [xx, yy, zz, yz, xz, xy] (tensor shear components). */
export function vonMisesMPa(stress: Stress): number {
  const [x, y, z, yz, xz, xy] = stress;
  const dxy = x - y, dyz = y - z, dzx = z - x;
  const largest = Math.max(Math.abs(dxy), Math.abs(dyz), Math.abs(dzx), Math.abs(yz), Math.abs(xz), Math.abs(xy));
  // Textbook sum (no rounded 1/sqrt(2) factor) only while every term is in [1e-150, 1e150]: the sum then stays
  // below 1.05e301 and the largest square above 1e-300, so nothing overflows or meaningfully underflows. The band
  // uses the stress differences and shears, never the hydrostatic magnitude. Elsewhere the original form.
  if (largest >= 1e-150 && largest <= 1e150) {
    return Math.sqrt(0.5 * (dxy ** 2 + dyz ** 2 + dzx ** 2) + 3 * (xy ** 2 + yz ** 2 + xz ** 2));
  }
  return Math.hypot((x - y) / Math.SQRT2, (y - z) / Math.SQRT2, (z - x) / Math.SQRT2,
    Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * xz);
}
export function solidFieldValue(stress: Stress, quantity: SolidFieldQuantity): number {
  return quantity === 'vonMises' ? vonMisesMPa(stress) : stress[COMPONENT[quantity]];
}

/** Finite ordered bounds of the shown values; `constant` when every element has the same value (incl. all zero). */
export interface SolidFieldLegend {
  readonly minimum: number;
  readonly maximum: number;
  readonly constant: boolean;
}
export function solidFieldLegend(values: readonly number[]): SolidFieldLegend | null {
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) return null;
  let minimum = values[0], maximum = values[0];
  for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  return { minimum: minimum, maximum: maximum, constant: minimum === maximum };
}
/** Position of a value in the legend, 0..1; a constant field maps to the middle (0.5), never NaN. */
export function solidFieldFraction(value: number, legend: SolidFieldLegend): number {
  return legend.constant ? 0.5 : (value - legend.minimum) / (legend.maximum - legend.minimum);
}

export interface SolidFieldMesh {
  readonly quantity: SolidLinearFieldQuantity;
  readonly deformationScale: number;
  /** xyz per triangle corner in mm (deformed by `deformationScale` times the node displacement). */
  readonly positions: readonly number[];
  /** Owning element of each boundary triangle. */
  readonly triangleElements: readonly number[];
  /** Original node index of each triangle corner (3 per triangle), when the adapter knows the analysed nodes. */
  readonly triangleNodes?: readonly number[];
  /** Value of each element in solidFieldUnit(quantity), indexed by the original element order. */
  readonly elementValues: readonly number[];
  readonly legend: SolidFieldLegend;
}

interface BoundaryFace { readonly element: number; readonly corners: readonly [number, number, number] }
/** Faces used by exactly one tetrahedron, outward for the positive orientation, in first-seen order. */
function solidBoundaryFaces(elements: SolidResult['prepared']['input']['elements']): BoundaryFace[] {
  const faces = new Map<string, BoundaryFace | null>();
  elements.forEach((element, index) => {
    const [a, b, c, d] = element.nodes;
    for (const corners of [[a, c, b], [a, b, d], [a, d, c], [b, c, d]] as const) {
      const key = [...corners].sort((left, right) => left - right).join(',');
      faces.set(key, faces.has(key) ? null : { element: index, corners });
    }
  });
  return [...faces.values()].filter((face): face is BoundaryFace => face !== null);
}

/**
 * Boundary triangles (faces used by exactly one tetrahedron) of the analysed mesh, outward for the positive
 * orientation, deformed by `scale`. Null when the result is not self-consistent or values are not finite.
 */
export function buildSolidFieldMesh(outcome: SolidResult, quantity: SolidLinearFieldQuantity, scale: number): SolidFieldMesh | null {
  const { nodes, elements } = outcome.prepared.input;
  const displacement = outcome.result.displacementMm, stresses = outcome.result.elements;
  if (!Number.isFinite(scale) || scale < 0 || displacement.length !== nodes.length || stresses.length !== elements.length) return null;
  const source = outcome.prepared.input.source, resultSource = outcome.result.source;
  if (source.documentId !== resultSource.documentId || source.revision !== resultSource.revision
    || source.meshKey !== resultSource.meshKey || !SOLID_LINEAR_FIELD_QUANTITIES.some(value => value === quantity)) return null;
  const finiteSix = (values: readonly number[]): boolean => values.length === 6 && Array.from(values).every(Number.isFinite);
  if (stresses.some(element => !finiteSix(element.strain) || !finiteSix(element.stressMPa))) return null;
  const elementValues = stresses.map(element => isSolidStrainQuantity(quantity)
    ? element.strain[STRAIN_COMPONENT[quantity]] : solidFieldValue(element.stressMPa, quantity));
  const legend = solidFieldLegend(elementValues);
  if (legend === null) return null;
  const positions: number[] = [], triangleElements: number[] = [], triangleNodes: number[] = [];
  for (const face of solidBoundaryFaces(elements)) {
    for (const node of face.corners) {
      const point = nodes[node], move = displacement[node];
      if (point === undefined || move === undefined) return null;
      positions.push(point[0] + scale * move[0], point[1] + scale * move[1], point[2] + scale * move[2]);
      triangleNodes.push(node);
    }
    triangleElements.push(face.element);
  }
  if (positions.some(value => !Number.isFinite(value))) return null;
  return { quantity, deformationScale: scale, positions, triangleElements, triangleNodes, elementValues, legend };
}

/** Distinct elements and analysed nodes of a drawn field; `nodes` is null when the adapter carries no node indices. */
export function solidFieldOverlayCounts(field: SolidFieldMesh): { readonly triangles: number; readonly elements: number;
  readonly nodes: number | null } {
  const nodes = field.triangleNodes;
  return { triangles: field.triangleElements.length, elements: new Set(field.triangleElements).size,
    nodes: nodes === undefined || nodes.length !== field.triangleElements.length * 3 ? null : new Set(nodes).size };
}

/** The three conditions under which a shown stress must not be read as a converged, mesh-independent value. */
export const SOLID_RESULT_WARNINGS = ['singular', 'notConverged', 'averaging'] as const;
type SolidResultWarning = typeof SOLID_RESULT_WARNINGS[number];
export const SOLID_RESULT_WARNING_KEYS = {
  singular: 'solidAnalysis.warningSingular', notConverged: 'solidAnalysis.warningNotConverged',
  averaging: 'solidAnalysis.warningAveraging',
} as const satisfies Readonly<Record<SolidResultWarning, MessageKey>>;
/**
 * The only thresholds of the result warnings. Display only: no result is accepted or refused here, and the FEM
 * acceptance (packages/fem/src/solidAnalysisResults.ts: relative free-DOF residual <= 1e-8, scaled pivot > 1e-12) and the
 * W71/W72 verification tolerances are unchanged.
 * - reentrantTurnDegrees: a boundary edge is re-entrant when its two outward face normals turn by more than 45 degrees
 *   towards the outside (interior angle above 225 degrees). Linear elasticity is singular at any re-entrant corner; the
 *   45 degrees only keeps facets of a smooth concave surface from being reported (the panel's default angular deflection
 *   0.3 rad turns at most 17 degrees per facet; a user value above 0.785 rad can report such facets). Shallower
 *   re-entrant corners (180-225 degrees) are not detected.
 * - residual: 1e-10, one hundredth of the FEM acceptance 1e-8. A healthy double LDL^T solve leaves about 1e-13; a
 *   residual in the top two accepted decades means lost digits. It is ten times inside the strictest solid W71 tolerance
 *   (modal 1e-9), so no warning-free result can carry a solver error of that size.
 * - pivot: 1e-6. The smallest symmetrically scaled pivot p amplifies rounding by about eps / p; at p = 1e-6 that is
 *   2.2e-10, again inside the strictest solid W71 tolerance 1e-9. Smaller pivots mean a nearly unsupported model.
 * - averagingFraction: 0.1. Constant-stress Tet4 values jump between elements; the jump between an element value and
 *   its nodal average is the recovered-stress error estimate of Zienkiewicz and Zhu (Int. J. Numer. Meth. Eng. 24,
 *   1987). Ten percent of the peak von Mises stress is this product's display choice, not a published limit. A uniform
 *   field (every W71 single-element comparison) has a difference of exactly 0, so the threshold cannot conflict with
 *   the W71/W72 tolerances (<= 1e-3).
 */
export const SOLID_RESULT_WARNING_LIMITS = Object.freeze({
  reentrantTurnDegrees: 45, residual: 1e-10, pivot: 1e-6, averagingFraction: 0.1,
});
export interface SolidResultWarnings {
  /** In SOLID_RESULT_WARNINGS order; empty when no condition holds. */
  readonly warnings: readonly SolidResultWarning[];
  readonly peakVonMisesMPa: number;
  /** Elements holding the peak von Mises stress, original element order. */
  readonly peakElements: readonly number[];
  /** Nodes on a re-entrant boundary edge, with a non-zero concentrated nodal load or with a point/line support. */
  readonly singularNodes: readonly number[];
  /** max over elements of |element von Mises - mean of its four nodal averages| / peak von Mises (0 for a zero peak). */
  readonly averagingFraction: number;
}
type Point = readonly [number, number, number];
const minus = (left: Point, right: Point): Point => [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
const dot: (left: Point, right: Point) => number = dotVec3;
const cross: (left: Point, right: Point) => Point = crossVec3;

/**
 * Evaluates the three warning conditions of one linear Tet4 result on the undeformed mesh (never the display scale).
 * singular: a peak element touches a singular node. notConverged: residual above or scaled pivot below its limit.
 * averaging: averagingFraction above its limit. Null when the result is not self-consistent or not finite.
 */
export function solidResultWarnings(outcome: SolidResult): SolidResultWarnings | null {
  try {
    const { nodes, elements, constraints, nodalLoads } = outcome.prepared.input;
    const { elements: stresses, maximumRelativeEquilibriumResidual: residual, minimumScaledPivot: pivot } = outcome.result;
    if (elements.length === 0 || stresses.length !== elements.length || !Number.isFinite(residual) || !Number.isFinite(pivot)
      || elements.some(element => element.nodes.some(node => !Number.isSafeInteger(node) || node < 0 || node >= nodes.length))) return null;
    const vonMises = stresses.map(element => vonMisesMPa(element.stressMPa));
    if (vonMises.some(value => !Number.isFinite(value))) return null;
    const peak = vonMises.reduce((maximum, value) => Math.max(maximum, value), 0);
    const peakElements = vonMises.flatMap((value, index) => value === peak ? [index] : []);

    const singular = new Set<number>();
    for (const load of nodalLoads) if (load.forceN.some(value => value !== 0)) singular.add(load.node);
    const supported = new Set(constraints.filter(item => item.fixed.some(Boolean)).map(item => item.node));
    const faces = solidBoundaryFaces(elements), areaSupported = new Set<number>();
    for (const face of faces) if (face.corners.every(node => supported.has(node))) face.corners.forEach(node => areaSupported.add(node));
    for (const node of supported) if (!areaSupported.has(node)) singular.add(node);
    const edges = new Map<string, number[]>();
    faces.forEach((face, index) => face.corners.forEach((node, corner) => {
      const next = face.corners[(corner + 1) % 3], key = node < next ? `${node},${next}` : `${next},${node}`;
      edges.set(key, [...edges.get(key) ?? [], index]);
    }));
    const normal = (face: BoundaryFace): Point => {
      const [a, b, c] = face.corners.map(node => nodes[node]);
      return cross(minus(b, a), minus(c, a));
    };
    const turnLimit = Math.cos(SOLID_RESULT_WARNING_LIMITS.reentrantTurnDegrees * Math.PI / 180);
    for (const [key, list] of edges) {
      if (list.length !== 2) continue;
      const [first, second] = [faces[list[0]], faces[list[1]]], [p, q] = key.split(',').map(Number);
      const other = second.corners.find(node => node !== p && node !== q);
      if (other === undefined) continue;
      const n1 = normal(first), n2 = normal(second), length = Math.sqrt(dot(n1, n1) * dot(n2, n2));
      if (!(length > 0)) continue;
      // Concave (re-entrant) when the second face rises to the outward side of the first face's plane.
      if (dot(n1, n2) / length < turnLimit && dot(minus(nodes[other], nodes[p]), n1) > 0) { singular.add(p); singular.add(q); }
    }

    const sums = nodes.map(() => 0), counts = nodes.map(() => 0);
    elements.forEach((element, index) => element.nodes.forEach(node => { sums[node] += vonMises[index]; counts[node] += 1; }));
    let worst = 0;
    elements.forEach((element, index) => {
      const smoothed = element.nodes.reduce((total, node) => total + sums[node] / counts[node], 0) / 4;
      worst = Math.max(worst, Math.abs(vonMises[index] - smoothed));
    });
    const averagingFraction = peak > 0 ? worst / peak : 0;
    if (!Number.isFinite(averagingFraction)) return null;
    const limits = SOLID_RESULT_WARNING_LIMITS;
    const holds: Readonly<Record<SolidResultWarning, boolean>> = {
      singular: peak > 0 && peakElements.some(index => elements[index].nodes.some(node => singular.has(node))),
      notConverged: residual > limits.residual || pivot < limits.pivot,
      averaging: averagingFraction > limits.averagingFraction,
    };
    return { warnings: SOLID_RESULT_WARNINGS.filter(kind => holds[kind]), peakVonMisesMPa: peak, peakElements,
      singularNodes: [...singular].sort((left, right) => left - right), averagingFraction };
  } catch { return null; }
}
const warningCache = new WeakMap<object, SolidResultWarnings | null>();
/** Cached per result object; the panel re-renders on every keystroke. */
export function solidResultWarningsOf(outcome: SolidResult): SolidResultWarnings | null {
  if (warningCache.has(outcome)) return warningCache.get(outcome) ?? null;
  const warnings = solidResultWarnings(outcome);
  warningCache.set(outcome, warnings);
  return warnings;
}
