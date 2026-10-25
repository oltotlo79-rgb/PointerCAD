import type { Parameter } from '@pointercad/model';
import type { BeamFibreSection, BeamImpactInput, BeamImpactResult, BeamImpactSample } from '@pointercad/fem';
import type { StandardBeamFibreOutline } from '@pointercad/model/beam-analysis';
import type { MessageKey } from '../i18n/t.js';
import { readContactField, readTransientField } from './beamFields.js';
import type { ContactDraft } from './beamSession.js';

/**
 * Editable beam impact settings (elastic, frictionless, normal contact against fixed planes only). Fixed planes reuse the
 * existing node-plane contact rows (direction + gap in mm); node-pair rows are reported as unsupported, never dropped.
 * Units are the contract units of BeamImpactInput: velocity m/s, contact stiffness N/m, time s (ms accepted like the
 * transient fields). Text is parsed only here, like beamDefinition.
 */
export interface ImpactVelocityRowDraft {
  readonly nodeId: string;
  readonly velocity: readonly [string, string, string];
}
export interface ImpactDraft {
  readonly velocities: readonly ImpactVelocityRowDraft[];
  readonly contactStiffness: string;
  readonly timeStep: string;
  readonly stepCount: string;
  readonly outputEvery: string;
  /** Optional outline text per beam member id (mm, principal axes of the member's section frame). */
  readonly fibreSections?: Readonly<Record<string, FibreOutlineDraft>>;
}
/** 'none' derives no fibre stress for the member. first = rectangle width along y, circle diameter or tube outside
 * diameter; second = rectangle depth along z or tube wall thickness (unused for a circle). */
export interface FibreOutlineDraft {
  readonly kind: 'none' | 'rectangle' | 'circle' | 'tube';
  readonly first: string;
  readonly second: string;
}
export const emptyImpactDraft = (): ImpactDraft => ({
  velocities: [], contactStiffness: '', timeStep: '', stepCount: '', outputEvery: '1' });

export type ImpactSettings = Pick<BeamImpactInput, 'initialVelocities' | 'contacts' | 'contactStiffnessNPerM' | 'history'>;
export type ImpactDraftCheck = { readonly ok: true; readonly settings: ImpactSettings }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string };

type Read = number | { readonly ok: false; readonly key: MessageKey; readonly field: string };

/** Converts the draft with the same expression, parameter and unit rules as the transient and contact fields. */
export function impactSettingsFromDraft(draft: ImpactDraft, contact: ContactDraft,
  parameters: readonly Parameter[]): ImpactDraftCheck {
  const scalar = (key: string, source: string): Read => {
    const parsed = readContactField('normalX', key, source, parameters);
    return parsed.value ? parsed.value.value : { ok: false, key: 'beam.error.expression', field: key };
  };
  const time = (name: 'timeStep' | 'stepCount' | 'outputEvery', source: string, integer: boolean): Read => {
    const key = `impact:${name}`;
    const parsed = readTransientField(name, key, source, parameters);
    if (!parsed.value) return { ok: false, key: 'beam.error.expression', field: key };
    const value = parsed.value.value;
    return integer && (!Number.isSafeInteger(value) || value < 1) ? { ok: false, key: 'beam.error.range', field: key } : value;
  };

  const initialVelocities: { nodeId: string; velocityMPerS: [number, number, number] }[] = [];
  for (const row of draft.velocities) {
    const components: number[] = [];
    for (const [axis, source] of row.velocity.entries()) {
      const value = scalar(`impact:velocity:${row.nodeId}:${axis}`, source);
      if (typeof value !== 'number') return value;
      components.push(value);
    }
    initialVelocities.push({ nodeId: row.nodeId, velocityMPerS: [components[0], components[1], components[2]] });
  }
  if (!initialVelocities.some(row => row.velocityMPerS.some(component => component !== 0))) {
    return { ok: false, key: 'beam.error.impactVelocity', field: 'impact:velocity' };
  }

  const contacts: { nodeId: string; directionUnit: [number, number, number]; gapM: number }[] = [];
  for (const row of contact.rows) {
    if (row.kind !== 'node-plane') return { ok: false, key: 'beam.error.impactPairUnsupported', field: `contact:${row.id}` };
    const normal: number[] = [];
    for (const [axis, source] of row.normal.entries()) {
      const name = (['normalX', 'normalY', 'normalZ'] as const)[axis];
      const key = `contact:${row.id}:${name}`;
      const parsed = readContactField(name, key, source, parameters);
      if (!parsed.value) return { ok: false, key: 'beam.error.expression', field: key };
      normal.push(parsed.value.value);
    }
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (!(length > 0) || !Number.isFinite(length)) {
      return { ok: false, key: 'beam.error.impactDirection', field: `contact:${row.id}:normalX` };
    }
    const gapKey = `contact:${row.id}:gap`;
    const gap = readContactField('gap', gapKey, row.gap, parameters);
    if (!gap.value) return { ok: false, key: 'beam.error.expression', field: gapKey };
    if (gap.value.value < 0) return { ok: false, key: 'beam.error.contactGap', field: gapKey };
    // Contact gaps are entered in mm like the existing contact analysis; the impact contract stores metres.
    contacts.push({ nodeId: row.nodeIdA, gapM: gap.value.value / 1000,
      directionUnit: [normal[0] / length, normal[1] / length, normal[2] / length] });
  }
  if (contacts.length === 0) return { ok: false, key: 'beam.error.impactContacts', field: 'impact:contacts' };

  const stiffness = scalar('impact:contactStiffness', draft.contactStiffness);
  if (typeof stiffness !== 'number') return stiffness;
  if (!(stiffness > 0)) return { ok: false, key: 'beam.error.range', field: 'impact:contactStiffness' };
  const timeStepS = time('timeStep', draft.timeStep, false);
  if (typeof timeStepS !== 'number') return timeStepS;
  const stepCount = time('stepCount', draft.stepCount, true);
  if (typeof stepCount !== 'number') return stepCount;
  const outputEvery = time('outputEvery', draft.outputEvery, true);
  if (typeof outputEvery !== 'number') return outputEvery;
  // Step and sample limits, support/velocity consistency and rigid modes stay owned by translateBeamImpact.
  return { ok: true, settings: { initialVelocities, contacts, contactStiffnessNPerM: stiffness,
    history: { timeStepS, stepCount, outputEvery } } };
}

/** The geometry and supports come from the existing six-DOF beam preparation; nothing is inferred here. */
export function beamImpactInput(settings: ImpactSettings, geometry: BeamImpactInput['geometry'],
  supports: BeamImpactInput['supports']): BeamImpactInput {
  return { schema: 'pointercad-beam-impact/1', geometry, supports, ...settings };
}

export type FibreOutlineCheck = { readonly ok: true; readonly outlines: ReadonlyMap<string, StandardBeamFibreOutline> }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string };
/** Parses the outline text of the given members with the contact gap field rules (an expression in mm). Sizes must
 * be positive and a tube wall thinner than its radius; members without an outline are simply absent. */
export function fibreOutlinesFromDraft(draft: ImpactDraft, memberIds: readonly string[],
  parameters: readonly Parameter[]): FibreOutlineCheck {
  const outlines = new Map<string, StandardBeamFibreOutline>();
  for (const memberId of memberIds) {
    const rows = draft.fibreSections;
    const row = rows !== undefined && Object.hasOwn(rows, memberId) ? rows[memberId] : undefined;
    if (row === undefined || row.kind === 'none') continue;
    const size = (which: 'first' | 'second', source: string): Read => {
      const key = `impact:fibre:${memberId}:${which}`;
      const parsed = readContactField('gap', key, source, parameters);
      if (!parsed.value) return { ok: false, key: 'beam.error.expression', field: key };
      const mm = parsed.value.value;
      return Number.isFinite(mm) && mm > 0 ? mm : { ok: false, key: 'beam.error.range', field: key };
    };
    const first = size('first', row.first);
    if (typeof first !== 'number') return first;
    if (row.kind === 'circle') { outlines.set(memberId, { kind: 'circle', diameterMm: first }); continue; }
    const second = size('second', row.second);
    if (typeof second !== 'number') return second;
    if (row.kind === 'rectangle') { outlines.set(memberId, { kind: 'rectangle', widthYMm: first, depthZMm: second }); continue; }
    if (!(2 * second < first)) return { ok: false, key: 'beam.error.range', field: `impact:fibre:${memberId}:second` };
    outlines.set(memberId, { kind: 'tube', outsideDiameterMm: first, wallThicknessMm: second });
  }
  return { ok: true, outlines };
}

/** The saved mm outline as the fem kernel's SI outline (m); no other conversion or inference. */
export function fibreSectionInMetres(outline: StandardBeamFibreOutline): BeamFibreSection {
  return outline.kind === 'rectangle' ? { kind: 'rectangle', widthYM: outline.widthYMm / 1000, depthZM: outline.depthZMm / 1000 }
    : outline.kind === 'circle' ? { kind: 'circle', diameterM: outline.diameterMm / 1000 }
    : { kind: 'tube', outsideDiameterM: outline.outsideDiameterMm / 1000, wallThicknessM: outline.wallThicknessMm / 1000 };
}

export interface ImpactContactSummary {
  readonly nodeId: string;
  readonly peakForceN: number;
  readonly peakTimeMs: number;
  readonly totalImpulseNs: number;
  /** Smallest sampled gap (negative = penetration of the compliant contact); null when no sample has this node. */
  readonly minimumGapMm: number | null;
}
function minimumGapMm(result: BeamImpactResult, nodeId: string): number | null {
  const gaps = result.samples.flatMap(sample => sample.contacts.filter(row => row.nodeId === nodeId).map(row => row.gapM));
  return gaps.length === 0 ? null : Math.min(...gaps) * 1000;
}
/**
 * Linearisation warning, not a strength check. The method is linear elastic and small-displacement (BEAM_IMPACT_SCOPE,
 * beamImpactModel.ts 5-11): rotations enter the beam matrices linearised (sin θ ≈ θ, cos θ ≈ 1). 0.1 rad is a chosen
 * warning threshold where (θ − sin θ)/θ ≈ 0.17 % and 1 − cos θ ≈ 0.5 %; it is not taken from a material, yield or strength
 * value. A rotation at or below it only means the linearisation is not obviously violated; yield, rupture, strain-rate
 * and contact adequacy are not assessed by this method in either case.
 */
export const IMPACT_LINEARIZATION_WARNING_ROTATION_RAD = 0.1;

/** Largest sampled nodal rotation (length of the rotation vector, rad); Infinity when a sample is not finite. */
export function maximumImpactRotationRad(samples: readonly BeamImpactSample[]): number {
  let maximum = 0;
  for (const sample of samples) {
    for (const node of sample.nodes) {
      const rotation = Math.hypot(node.rotationRad[0], node.rotationRad[1], node.rotationRad[2]);
      if (!Number.isFinite(rotation)) return Number.POSITIVE_INFINITY;
      maximum = Math.max(maximum, rotation);
    }
  }
  return maximum;
}

/** True beyond the warning threshold and for NaN or Infinity (the threshold itself is not beyond). */
export function impactRotationBeyondLinearization(maximumRotationRad: number): boolean {
  return !(maximumRotationRad <= IMPACT_LINEARIZATION_WARNING_ROTATION_RAD);
}

export interface ImpactSummary {
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly initialEnergyJ: number;
  readonly maximumEnergyBalanceError: number;
  /** Largest sampled nodal rotation (rad), shown for inspection. */
  readonly maximumRotationRad: number;
  /** Beyond the linearisation warning threshold. False is NOT a strength or safety pass. */
  readonly rotationBeyondLinearization: boolean;
  readonly contacts: readonly ImpactContactSummary[];
  /** Always false in this contract; the panel states it instead of hiding it. */
  readonly structuralCertification: false;
}

/** Reads only fields of the accepted BeamImpactResult; displayed lengths/times follow the panel's mm and ms. */
export function summarizeBeamImpact(result: BeamImpactResult): ImpactSummary {
  const last = result.samples.at(-1);
  const rotation = maximumImpactRotationRad(result.samples);
  return {
    durationMs: (last?.timeS ?? 0) * 1000, sampleCount: result.samples.length,
    initialEnergyJ: result.initialEnergyJ, maximumEnergyBalanceError: result.maximumEnergyBalanceError,
    maximumRotationRad: rotation, rotationBeyondLinearization: impactRotationBeyondLinearization(rotation),
    contacts: result.contactPeaks.map(peak => ({
      nodeId: peak.nodeId, peakForceN: peak.intervalForceN, peakTimeMs: peak.timeS * 1000,
      totalImpulseNs: peak.totalImpulseNs,
      minimumGapMm: minimumGapMm(result, peak.nodeId),
    })),
    structuralCertification: result.structuralCertification,
  };
}
