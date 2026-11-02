import type { AnalysisMaterialCapacity, BeamAnalysisDocument, BeamAnalysisResult, BeamElementResult, Vector6 } from './analysisModel.js';
import { checkFibreSection, elementFibreStresses, type AnalysedSection, type BeamFibreSection, type FibreExtreme } from './beamFibreStress.js';
import type { SolidAnalysisInput, SolidAnalysisResult, SolidVector3, SolidVector6 } from './solidAnalysisModel.js';

/** Explicit condition-specific evidence; absence never falls back to a grade name or elastic modulus. */
export type StaticCapacityByMaterial = ReadonlyMap<string, AnalysisMaterialCapacity | null>;

export interface StaticYieldRatio {
  readonly capacity: AnalysisMaterialCapacity | null;
  readonly safetyFactor: number | null;
  readonly reason: string | null;
}

export interface StaticCapacitySummary {
  readonly maximumVonMisesMPa: number | null;
  readonly minimumSafetyFactor: number | null;
  readonly reason: string | null;
  readonly structuralCertification: false;
}

export interface StaticFibrePoint {
  readonly yM: number;
  readonly zM: number;
  readonly stressMPa: number;
  readonly axialMPa: number;
  readonly bendingYMPa: number;
  readonly bendingZMPa: number;
  readonly strain: number;
}

export interface BeamStaticEndCapacity extends StaticYieldRatio {
  readonly end: 'start' | 'end';
  readonly tension: StaticFibrePoint;
  readonly compression: StaticFibrePoint;
  /** Magnitude at the outer radius of a circle/tube; zero for zero torque. */
  readonly maximumTorsionShearMPa: number | null;
  readonly maximumTorsionShearStrain: number | null;
  readonly maximumVonMisesMPa: number | null;
}

export interface BeamStaticElementCapacity extends StaticYieldRatio {
  readonly element: number;
  readonly memberId: string;
  readonly materialId: string | null;
  readonly ends: readonly BeamStaticEndCapacity[];
  readonly maximumVonMisesMPa: number | null;
}

export interface BeamStaticCapacity extends StaticCapacitySummary {
  readonly kind: 'beam-static-capacity';
  readonly elements: readonly BeamStaticElementCapacity[];
}

export interface SolidStaticElementCapacity extends StaticYieldRatio {
  readonly element: number;
  /** A linear tet4 has one constant stress/strain state throughout the element. */
  readonly integrationPoint: 0;
  readonly materialId: string;
  readonly stressMPa: SolidVector6 | null;
  /** Descending eigenvalues of the symmetric Cauchy stress tensor. */
  readonly principalStressMPa: SolidVector3 | null;
  readonly maximumVonMisesMPa: number | null;
  /** Isotropic elastic engineering strains in xx, yy, zz, yz, xz, xy order. */
  readonly strain: SolidVector6 | null;
}

export interface SolidStaticCapacity extends StaticCapacitySummary {
  readonly kind: 'solid-static-capacity';
  readonly elements: readonly SolidStaticElementCapacity[];
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

function sourcedCapacity(value: AnalysisMaterialCapacity | null | undefined): AnalysisMaterialCapacity | null {
  if (!value || !positive(value.yieldMPa) || !value.materialConditionId.trim() || !value.condition.trim()
    || !value.sourceId.trim() || !(value.thicknessMm === null || positive(value.thicknessMm))
    || !['supplier-excerpt', 'manufacturer-reference', 'measured-reference', 'standard-draft'].includes(value.evidence)
    || !['minimum', 'reference'].includes(value.basis)) return null;
  return { ...value };
}

function yieldRatio(stress: number | null, capacity: AnalysisMaterialCapacity | null, reason: string | null = null): StaticYieldRatio {
  if (reason !== null) return { capacity, safetyFactor: null, reason };
  if (stress === null || !Number.isFinite(stress) || stress < 0) return { capacity, safetyFactor: null, reason: 'invalid-equivalent-stress' };
  if (capacity === null) return { capacity, safetyFactor: null, reason: 'missing-sourced-capacity' };
  if (stress === 0) return { capacity, safetyFactor: null, reason: 'zero-equivalent-stress' };
  const ratio = capacity.yieldMPa / stress;
  return positive(ratio) ? { capacity, safetyFactor: ratio, reason: null }
    : { capacity, safetyFactor: null, reason: 'unrepresentable-yield-ratio' };
}

function summarize(rows: readonly (StaticYieldRatio & { readonly maximumVonMisesMPa: number | null })[]): StaticCapacitySummary {
  if (rows.length === 0) return { maximumVonMisesMPa: null, minimumSafetyFactor: null, reason: 'no-elements', structuralCertification: false };
  let maximum = 0, minimum: number | null = null, stressMissing = false;
  let reason: string | null = null;
  for (const row of rows) {
    if (row.maximumVonMisesMPa === null) stressMissing = true;
    else maximum = Math.max(maximum, row.maximumVonMisesMPa);
    if (row.safetyFactor !== null) minimum = minimum === null ? row.safetyFactor : Math.min(minimum, row.safetyFactor);
    else if (row.reason !== 'zero-equivalent-stress') reason ??= row.reason ?? 'incomplete-evaluation';
  }
  return { maximumVonMisesMPa: stressMissing ? null : maximum,
    minimumSafetyFactor: reason === null ? minimum : null,
    reason: reason ?? (minimum === null ? 'zero-equivalent-stress' : null), structuralCertification: false };
}

function negate(value: Vector6): Vector6 {
  return [-value[0], -value[1], -value[2], -value[3], -value[4], -value[5]];
}

function fibrePoint(point: FibreExtreme, forces: Vector6, section: AnalysedSection, youngPa: number): StaticFibrePoint {
  return { yM: point.yM, zM: point.zM, stressMPa: point.stressPa / 1e6,
    axialMPa: forces[0] / section.areaM2 / 1e6,
    bendingYMPa: forces[4] * point.zM / section.iyM4 / 1e6,
    bendingZMPa: -forces[5] * point.yM / section.izM4 / 1e6,
    strain: point.stressPa / youngPa };
}

function finiteFibrePoint(point: StaticFibrePoint): boolean {
  return [point.yM, point.zM, point.stressMPa, point.axialMPa, point.bendingYMPa, point.bendingZMPa, point.strain].every(Number.isFinite);
}

function beamElementCapacity(element: BeamElementResult, document: BeamAnalysisDocument,
  capacityById: StaticCapacityByMaterial, outlines: ReadonlyMap<string, BeamFibreSection>, scale: number): BeamStaticElementCapacity {
  const member = document.members.find(row => row.id === element.memberId);
  const material = document.materials.find(row => row.id === member?.materialId);
  const section = document.sections.find(row => row.id === member?.sectionId);
  const outline = member ? outlines.get(member.sectionId) : undefined;
  const capacity = sourcedCapacity(member ? capacityById.get(member.materialId) : null);
  const invalid = (reason: string): BeamStaticElementCapacity => ({ element: element.solverElement, memberId: element.memberId,
    materialId: member?.materialId ?? null, ends: [], maximumVonMisesMPa: null, ...yieldRatio(null, capacity, reason) });
  if (!member || !material || !section || !outline) return invalid('missing-member-material-section-or-outline');
  if (element.nodeIds[0] !== member.startNodeId || element.nodeIds[1] !== member.endNodeId
    || element.componentId !== member.componentId
    || element.occurrencePath.length !== member.occurrencePath.length
    || element.occurrencePath.some((id, index) => id !== member.occurrencePath[index])) return invalid('result-member-mismatch');
  const analysed = { areaM2: section.area * scale ** 2, iyM4: section.iy * scale ** 4, izM4: section.iz * scale ** 4 };
  const check = checkFibreSection(outline, analysed);
  if (check.status !== 'supported') return invalid(`section-${check.status}`);
  const youngPa = material.youngModulus / scale ** 2, shearPa = material.shearModulus / scale ** 2;
  const torsionM4 = section.torsionConstant * scale ** 4;
  if (![youngPa, shearPa, torsionM4].every(positive)) return invalid('invalid-elastic-properties');
  if (![...element.start, ...element.end].every(Number.isFinite)) return invalid('non-finite-resultants');
  const start = negate(element.start), end = element.end;
  // Native end actions point outwards; the fibre helper expects the +x cut face.
  let fibres: ReturnType<typeof elementFibreStresses>;
  try {
    fibres = elementFibreStresses([{ element: element.solverElement, memberId: element.memberId, segment: 0,
      start: [start], end: [end] }], check.section, analysed);
  } catch {
    return invalid('non-finite-fibre-stress');
  }
  const ends = fibres.map((fibre): BeamStaticEndCapacity => {
    const forces = fibre.end === 'start' ? start : end;
    const tension = fibrePoint(fibre.tension, forces, analysed, youngPa);
    const compression = fibrePoint(fibre.compression, forces, analysed, youngPa);
    let reason: string | null = null;
    let torsion: number | null = 0;
    if (forces[3] !== 0) {
      if (check.section.kind === 'rectangle') reason = 'unsupported-rectangular-torsion';
      else if (Math.abs(torsionM4 - analysed.iyM4 - analysed.izM4) > 1e-6 * torsionM4) reason = 'inconsistent-polar-torsion-constant';
      else {
        const radius = (check.section.kind === 'circle' ? check.section.diameterM : check.section.outsideDiameterM) / 2;
        torsion = Math.abs(forces[3]) * radius / torsionM4 / 1e6;
        if (!Number.isFinite(torsion)) reason = 'non-finite-torsion-stress';
      }
      if (reason !== null) torsion = null;
    }
    if (forces[1] !== 0 || forces[2] !== 0) reason = 'unsupported-transverse-shear';
    const shearStrain = torsion === null ? null : torsion * 1e6 / shearPa;
    const equivalent = reason === null && torsion !== null
      ? Math.hypot(Math.max(Math.abs(tension.stressMPa), Math.abs(compression.stressMPa)), Math.sqrt(3) * torsion) : null;
    return { end: fibre.end, tension, compression, maximumTorsionShearMPa: torsion,
      maximumTorsionShearStrain: shearStrain, maximumVonMisesMPa: equivalent,
      ...yieldRatio(equivalent, capacity, reason) };
  });
  if (ends.some(row => !finiteFibrePoint(row.tension) || !finiteFibrePoint(row.compression)
    || ![row.maximumTorsionShearStrain, row.maximumVonMisesMPa].every(value => value === null || Number.isFinite(value)))) {
    return invalid('non-finite-stress-or-strain');
  }
  const summary = summarize(ends);
  return { element: element.solverElement, memberId: member.id, materialId: material.id, ends,
    maximumVonMisesMPa: summary.maximumVonMisesMPa,
    ...yieldRatio(summary.maximumVonMisesMPa, capacity, summary.reason) };
}

/** Pure postprocessing of an already decoded static result. The caller retains responsibility for
 * result/input hash validation. The explicit outline is in metres even for an N-mm document.
 * Current static inputs have nodal loads: normal stress is linear along each member, so endpoint
 * extremes suffice. Nonzero transverse shear and noncircular torsion remain unevaluated. */
export function beamStaticCapacity(result: BeamAnalysisResult, document: BeamAnalysisDocument,
  capacityById: StaticCapacityByMaterial, outlineBySectionId: ReadonlyMap<string, BeamFibreSection>): BeamStaticCapacity {
  const empty = (reason: string): BeamStaticCapacity => ({ kind: 'beam-static-capacity', elements: [],
    maximumVonMisesMPa: null, minimumSafetyFactor: null, reason, structuralCertification: false });
  if (document.units !== 'N-m' && document.units !== 'N-mm') return empty('unknown-units');
  if (result.analysisId !== document.id || result.analysisRevision !== document.revision
    || result.source.documentId !== document.source.documentId || result.source.documentRevision !== document.source.documentRevision
    || result.source.geometryRevision !== document.source.geometryRevision
    || result.elements.length !== document.members.length
    || new Set(result.elements.map(row => row.memberId)).size !== document.members.length) return empty('result-document-mismatch');
  const elements = result.elements.map(row => beamElementCapacity(row, document, capacityById, outlineBySectionId,
    document.units === 'N-mm' ? 0.001 : 1));
  return { kind: 'beam-static-capacity', elements, ...summarize(elements) };
}

function vonMises(stress: SolidVector6): number {
  const [x, y, z, yz, xz, xy] = stress;
  // Divide before subtracting to avoid overflow for finite opposite signed stresses.
  return Math.hypot(x / Math.SQRT2 - y / Math.SQRT2, y / Math.SQRT2 - z / Math.SQRT2,
    z / Math.SQRT2 - x / Math.SQRT2, Math.sqrt(3) * yz, Math.sqrt(3) * xz, Math.sqrt(3) * xy);
}

function principalStresses(stress: SolidVector6): SolidVector3 {
  const scale = Math.max(...stress.map(Math.abs));
  if (scale === 0) return [0, 0, 0];
  const [x, y, z, yz, xz, xy] = stress.map(value => value / scale);
  const matrix = [[x, xy, xz], [xy, y, yz], [xz, yz, z]];
  // Jacobi rotations on a scaled symmetric 3x3 matrix also handle repeated eigenvalues.
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let p = 0, q = 1;
    for (const [a, b] of [[0, 2], [1, 2]]) if (Math.abs(matrix[a][b]) > Math.abs(matrix[p][q])) { p = a; q = b; }
    if (Math.abs(matrix[p][q]) <= Number.EPSILON) break;
    const angle = Math.atan2(2 * matrix[p][q], matrix[q][q] - matrix[p][p]) / 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    const pp = matrix[p][p], qq = matrix[q][q], pq = matrix[p][q];
    matrix[p][p] = c * c * pp - 2 * s * c * pq + s * s * qq;
    matrix[q][q] = s * s * pp + 2 * s * c * pq + c * c * qq;
    matrix[p][q] = 0; matrix[q][p] = 0;
    for (let k = 0; k < 3; k += 1) {
      if (k === p || k === q) continue;
      const kp = matrix[k][p], kq = matrix[k][q];
      matrix[k][p] = c * kp - s * kq; matrix[p][k] = matrix[k][p];
      matrix[k][q] = s * kp + c * kq; matrix[q][k] = matrix[k][q];
    }
  }
  const values = [matrix[0][0] * scale, matrix[1][1] * scale, matrix[2][2] * scale].sort((a, b) => b - a);
  return [values[0], values[1], values[2]];
}

/** Pure tet4 postprocessing after decodeSolidAnalysis/solidResultMatches validation by the caller.
 * Stress is MPa; engineering strain is recomputed from Hooke's law, not copied from solver strain.
 * Capacity evidence must be supplied explicitly and is copied into each element's result. */
export function solidStaticCapacity(result: SolidAnalysisResult, input: SolidAnalysisInput,
  capacityById: StaticCapacityByMaterial): SolidStaticCapacity {
  const empty = (reason: string): SolidStaticCapacity => ({ kind: 'solid-static-capacity', elements: [],
    maximumVonMisesMPa: null, minimumSafetyFactor: null, reason, structuralCertification: false });
  if (input.units !== 'N-mm-MPa' || result.units !== 'N-mm-MPa') return empty('unknown-units');
  if (result.source.documentId !== input.source.documentId || result.source.revision !== input.source.revision
    || result.source.meshKey !== input.source.meshKey || result.elements.length !== input.elements.length) return empty('result-input-mismatch');
  const elements = result.elements.map((row, element): SolidStaticElementCapacity => {
    const materialId = input.elements[element].materialId;
    const material = input.materials.find(candidate => candidate.id === materialId);
    const capacity = sourcedCapacity(capacityById.get(materialId));
    const invalid = (reason: string): SolidStaticElementCapacity => ({ element, integrationPoint: 0, materialId,
      stressMPa: null, principalStressMPa: null, maximumVonMisesMPa: null, strain: null, ...yieldRatio(null, capacity, reason) });
    if (!material || !positive(material.youngMPa) || !Number.isFinite(material.poisson)
      || material.poisson <= -1 || material.poisson >= 0.5) return invalid('invalid-elastic-properties');
    if (!row.stressMPa.every(Number.isFinite)) return invalid('non-finite-stress');
    const [x, y, z, yz, xz, xy] = row.stressMPa;
    const young = material.youngMPa, nu = material.poisson;
    const strain: SolidVector6 = [x / young - nu * (y / young + z / young),
      y / young - nu * (x / young + z / young), z / young - nu * (x / young + y / young),
      2 * (1 + nu) * (yz / young), 2 * (1 + nu) * (xz / young), 2 * (1 + nu) * (xy / young)];
    const principal = principalStresses(row.stressMPa), equivalent = vonMises(row.stressMPa);
    if (![...strain, ...principal, equivalent].every(Number.isFinite)) return invalid('non-finite-stress-or-strain');
    return { element, integrationPoint: 0, materialId, stressMPa: [x, y, z, yz, xz, xy],
      principalStressMPa: principal, maximumVonMisesMPa: equivalent, strain, ...yieldRatio(equivalent, capacity) };
  });
  return { kind: 'solid-static-capacity', elements, ...summarize(elements) };
}
