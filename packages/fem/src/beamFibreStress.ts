import type { ImpactElementEndForces, SectionResultants } from './beamImpactInterior.js';

/**
 * Explicit member-local section outline for elastic longitudinal fibre stress (task185). Lengths in m. The analysis
 * section (BeamSection) holds only A, Iy and Iz, so the outline is a separate typed input and is never derived from A
 * and I. Local axes are the beam frame: x along the member, y and z the principal axes (centroid at the origin).
 * - rectangle: solid, sides parallel to local y (widthYM) and local z (depthZM);
 * - circle: solid, diameterM;
 * - tube: circular hollow, outsideDiameterM and wallThicknessM.
 * Any other profile (angle, channel, H, user outline...) is typed unsupported: its extreme fibre is not unambiguous
 * from this data, so no value is produced for it.
 */
export type BeamFibreSection =
  | { readonly kind: 'rectangle'; readonly widthYM: number; readonly depthZM: number }
  | { readonly kind: 'circle'; readonly diameterM: number }
  | { readonly kind: 'tube'; readonly outsideDiameterM: number; readonly wallThicknessM: number }
  | { readonly kind: 'unsupported'; readonly profile: string };
export interface AnalysedSection { readonly areaM2: number; readonly iyM4: number; readonly izM4: number }

export type FibreSectionCheck =
  | { readonly status: 'supported'; readonly section: Exclude<BeamFibreSection, { kind: 'unsupported' }> }
  | { readonly status: 'unsupported'; readonly profile: string }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'inconsistent'; readonly property: 'area' | 'iy' | 'iz'; readonly outline: number; readonly analysed: number };

function geometric(section: Exclude<BeamFibreSection, { kind: 'unsupported' }>): AnalysedSection {
  if (section.kind === 'rectangle') {
    const b = section.widthYM, h = section.depthZM;
    // Iy is about local y (fibres spread along z), Iz about local z (fibres spread along y).
    return { areaM2: b * h, iyM4: b * h ** 3 / 12, izM4: h * b ** 3 / 12 };
  }
  const outside = section.kind === 'circle' ? section.diameterM : section.outsideDiameterM;
  const inside = section.kind === 'circle' ? 0 : section.outsideDiameterM - 2 * section.wallThicknessM;
  const inertia = Math.PI * (outside ** 4 - inside ** 4) / 64;
  return { areaM2: Math.PI * (outside ** 2 - inside ** 2) / 4, iyM4: inertia, izM4: inertia };
}
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Validates an outline and requires its own A, Iy and Iz to equal the analysed ones within `relative` (default
 * 1e-6), so that the stresses use the same section the solver used. A mismatch is reported, never silently mixed. */
export function checkFibreSection(section: BeamFibreSection, analysed: AnalysedSection, relative = 1e-6): FibreSectionCheck {
  if (section.kind === 'unsupported') return { status: 'unsupported', profile: section.profile };
  const sizes = section.kind === 'rectangle' ? [section.widthYM, section.depthZM]
    : section.kind === 'circle' ? [section.diameterM] : [section.outsideDiameterM, section.wallThicknessM];
  if (!sizes.every(positive)) return { status: 'invalid', reason: 'every dimension must be finite and positive (m)' };
  if (section.kind === 'tube' && !(2 * section.wallThicknessM < section.outsideDiameterM)) {
    return { status: 'invalid', reason: 'the wall must be thinner than the radius' };
  }
  const own = geometric(section);
  for (const [property, outline, value] of [['area', own.areaM2, analysed.areaM2], ['iy', own.iyM4, analysed.iyM4],
    ['iz', own.izM4, analysed.izM4]] as const) {
    if (!(positive(value) && Math.abs(outline - value) <= relative * value)) {
      return { status: 'inconsistent', property, outline, analysed: value };
    }
  }
  return { status: 'supported', section };
}

/** One extreme fibre: the stress in Pa (tension positive) and its local position (y, z) in m. */
export interface FibreExtreme { readonly stressPa: number; readonly yM: number; readonly zM: number }
/** sigma(y, z) = N / A + My z / Iy - Mz y / Iz for the +x-face resultants [N, Vy, Vz, T, My, Mz] (N, N m). */
export function fibreStress(resultants: SectionResultants, analysed: AnalysedSection, yM: number, zM: number): number {
  return resultants[0] / analysed.areaM2 + resultants[4] * zM / analysed.iyM4 - resultants[5] * yM / analysed.izM4;
}
/** The largest (most tensile) and smallest (most compressive) longitudinal fibre stress over the actual boundary of a
 * supported section, with their locations. Shear, torsion, von Mises, contact and plastic effects are not included. */
export function fibreExtremes(resultants: SectionResultants, section: Exclude<BeamFibreSection, { kind: 'unsupported' }>,
  analysed: AnalysedSection): { readonly maximum: FibreExtreme; readonly minimum: FibreExtreme } {
  const points: (readonly [number, number])[] = [];
  if (section.kind === 'rectangle') {
    // A linear field over a convex polygon is extreme at its corners.
    for (const y of [-section.widthYM / 2, section.widthYM / 2]) for (const z of [-section.depthZM / 2, section.depthZM / 2]) points.push([y, z]);
  } else {
    // On a circle of radius R the linear part a z - b y is extreme along +-(-b, a) / |(-b, a)|.
    const radius = (section.kind === 'circle' ? section.diameterM : section.outsideDiameterM) / 2;
    const a = resultants[4] / analysed.iyM4, b = resultants[5] / analysed.izM4;
    const norm = Math.hypot(a, b);
    if (norm === 0) points.push([0, radius]);
    else points.push([-b / norm * radius, a / norm * radius], [b / norm * radius, -a / norm * radius]);
  }
  const values = points.map(([y, z]) => ({ stressPa: fibreStress(resultants, analysed, y, z), yM: y, zM: z }));
  if (!values.every(value => Number.isFinite(value.stressPa))) throw new Error('fibre-stress: non-finite stress');
  let maximum = values[0], minimum = values[0];
  for (const value of values) {
    if (value.stressPa > maximum.stressPa) maximum = value;
    if (value.stressPa < minimum.stressPa) minimum = value;
  }
  return { maximum, minimum };
}

export interface ElementFibreStress {
  readonly element: number;
  readonly memberId: string;
  readonly segment: number;
  readonly end: 'start' | 'end';
  /** Governing emitted samples (first on a tie) for the most tensile and the most compressive fibre. */
  readonly tension: FibreExtreme & { readonly sample: number };
  readonly compression: FibreExtreme & { readonly sample: number };
}
/** Fibre extremes at both ends of every element over the emitted samples only (values between samples are not
 * represented), from the solver's constitutive end forces (impactElementEndForces). */
export function elementFibreStresses(forces: readonly ImpactElementEndForces[],
  section: Exclude<BeamFibreSection, { kind: 'unsupported' }>, analysed: AnalysedSection): ElementFibreStress[] {
  return forces.flatMap(row => (['start', 'end'] as const).map((end): ElementFibreStress => {
    const samples = row[end];
    if (samples.length === 0) throw new Error('fibre-stress: no emitted sample');
    const first = fibreExtremes(samples[0], section, analysed);
    let tension = { ...first.maximum, sample: 0 }, compression = { ...first.minimum, sample: 0 };
    for (let sample = 1; sample < samples.length; sample += 1) {
      const { maximum, minimum } = fibreExtremes(samples[sample], section, analysed);
      if (maximum.stressPa > tension.stressPa) tension = { ...maximum, sample };
      if (minimum.stressPa < compression.stressPa) compression = { ...minimum, sample };
    }
    return { element: row.element, memberId: row.memberId, segment: row.segment, end, tension, compression };
  }));
}

/** An explicitly applicable sourced allowable chosen by the caller (preset id, condition and source), never inferred
 * from E or from a grade name. */
export interface SourcedYield { readonly presetId: string; readonly yieldMPa: number; readonly sourceId: string; readonly condition: string }
export type YieldComparison =
  | { readonly status: 'data-missing'; readonly reason: string }
  | { readonly status: 'nominal-stress-below-yield' | 'nominal-stress-at-or-above-yield';
    readonly peakMPa: number; readonly yieldMPa: number; readonly presetId: string; readonly sourceId: string };
/** Nominal longitudinal fibre stress against a sourced yield value. 'below' is not a safety pass: shear, torsion,
 * combined stress, dynamics beyond the emitted samples, rate effects and contact are not assessed. */
export function compareWithYield(peakAbsolutePa: number, allowable: SourcedYield | null): YieldComparison {
  if (allowable === null) {
    return { status: 'data-missing', reason: 'no sourced yield strength applies to this beam material and condition' };
  }
  if (!(Number.isFinite(allowable.yieldMPa) && allowable.yieldMPa > 0) || !Number.isFinite(peakAbsolutePa)) {
    throw new Error('fibre-stress: invalid yield comparison input');
  }
  const peakMPa = Math.abs(peakAbsolutePa) / 1e6;
  return { status: peakMPa < allowable.yieldMPa ? 'nominal-stress-below-yield' : 'nominal-stress-at-or-above-yield',
    peakMPa, yieldMPa: allowable.yieldMPa, presetId: allowable.presetId, sourceId: allowable.sourceId };
}
