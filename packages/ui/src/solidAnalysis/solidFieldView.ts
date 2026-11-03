import type { CadSolidOutcome } from '@pointercad/fem';

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
export type SolidStrainQuantity = typeof SOLID_STRAIN_QUANTITIES[number];
export const SOLID_LINEAR_FIELD_QUANTITIES = [...SOLID_FIELD_QUANTITIES, ...SOLID_STRAIN_QUANTITIES] as const;
export type SolidLinearFieldQuantity = typeof SOLID_LINEAR_FIELD_QUANTITIES[number];
const STRAIN_COMPONENT: Readonly<Record<SolidStrainQuantity, number>> = {
  strainXx: 0, strainYy: 1, strainZz: 2, strainYz: 3, strainXz: 4, strainXy: 5,
};
export function isSolidStrainQuantity(quantity: SolidLinearFieldQuantity): quantity is SolidStrainQuantity {
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
  /** Value of each element in solidFieldUnit(quantity), indexed by the original element order. */
  readonly elementValues: readonly number[];
  readonly legend: SolidFieldLegend;
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
  const faces = new Map<string, { readonly element: number; readonly corners: readonly [number, number, number] } | null>();
  elements.forEach((element, index) => {
    const [a, b, c, d] = element.nodes;
    for (const corners of [[a, c, b], [a, b, d], [a, d, c], [b, c, d]] as const) {
      const key = [...corners].sort((left, right) => left - right).join(',');
      faces.set(key, faces.has(key) ? null : { element: index, corners });
    }
  });
  const positions: number[] = [], triangleElements: number[] = [];
  for (const face of faces.values()) {
    if (face === null) continue;
    for (const node of face.corners) {
      const point = nodes[node], move = displacement[node];
      if (point === undefined || move === undefined) return null;
      positions.push(point[0] + scale * move[0], point[1] + scale * move[1], point[2] + scale * move[2]);
    }
    triangleElements.push(face.element);
  }
  if (positions.some(value => !Number.isFinite(value))) return null;
  return { quantity, deformationScale: scale, positions, triangleElements, elementValues, legend };
}
