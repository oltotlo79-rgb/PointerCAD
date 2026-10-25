import type { Vector3 } from './analysisModel.js';
import { fields, InputIssue, list, number, text, unique, vector } from './analysisValidation.js';

/** Same bounds as the beam impact solver input (fem beamImpactModel): 4000 steps, 101 output samples, 64 planes. */
export const STANDARD_BEAM_IMPACT_MAX_STEPS = 4000;
export const STANDARD_BEAM_IMPACT_MAX_SAMPLES = 101;
export const STANDARD_BEAM_IMPACT_MAX_PLANES = 64;
const MAX_GAP_MM = 1e6;

/** A fixed rigid plane facing one original node: global direction (normalized when solved) and initial gap in mm,
 * as in the saved contact analysis. Node pairs, friction and restitution are not part of this saved model. */
export interface StandardBeamImpactPlane {
  readonly id: string;
  readonly nodeId: string;
  readonly normal: Vector3;
  readonly gapMm: number;
}
export interface StandardBeamImpactVelocity {
  readonly nodeId: string;
  readonly velocityMPerS: Vector3;
}
/** Explicit member-local section outline for the nominal longitudinal fibre stress, in mm on the principal axes of the
 * member's section frame (y = principalY, z = x cross y). Only result post-processing reads it: the solver keeps using
 * the saved A, Iy, Iz and J, and the outline is never derived from them. Other profiles are not representable here. */
export type StandardBeamFibreOutline =
  | { readonly kind: 'rectangle'; readonly widthYMm: number; readonly depthZMm: number }
  | { readonly kind: 'circle'; readonly diameterMm: number }
  | { readonly kind: 'tube'; readonly outsideDiameterMm: number; readonly wallThicknessMm: number };
export interface StandardBeamFibreSection {
  readonly sectionId: string;
  readonly outline: StandardBeamFibreOutline;
}
export const STANDARD_BEAM_MAX_FIBRE_SECTIONS = 128;
const MAX_OUTLINE_MM = 1e6;

/** Saved elastic frictionless fixed-plane impact settings; results, energies and samples are never stored. */
export interface StandardBeamImpactSettings {
  readonly segmentsPerMember: number;
  readonly initialVelocities: readonly StandardBeamImpactVelocity[];
  readonly planes: readonly StandardBeamImpactPlane[];
  readonly contactStiffnessNPerM: number;
  readonly history: { readonly timeStepS: number; readonly stepCount: number; readonly outputEvery: number };
  /** Optional outlines, at most one per saved section id; absent means no fibre stress is derived. */
  readonly fibreSections?: readonly StandardBeamFibreSection[];
}

type Restraints = readonly [boolean, boolean, boolean, boolean, boolean, boolean];

/** Strict reader after the shared structure/support decoding; segmentsPerMember is already checked by the caller. */
export function readStandardBeamImpactSettings(value: unknown, path: string, segmentsPerMember: number,
  nodeIds: ReadonlySet<string>, supports: readonly { readonly nodeId: string; readonly restrained: Restraints }[],
  sectionIds?: ReadonlySet<string>): StandardBeamImpactSettings {
  const withOutlines = value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'fibreSections');
  const row = fields(value, withOutlines
    ? ['segmentsPerMember', 'initialVelocities', 'planes', 'contactStiffnessNPerM', 'history', 'fibreSections']
    : ['segmentsPerMember', 'initialVelocities', 'planes', 'contactStiffnessNPerM', 'history'], path);
  const restraint = new Map(supports.map(support => [support.nodeId, support.restrained]));
  const node = (raw: unknown, at: string): string => {
    const nodeId = text(raw, at);
    if (!nodeIds.has(nodeId)) throw new InputIssue('impact-node', at, 'Impact node is absent');
    return nodeId;
  };
  const sparse = (raw: unknown, at: string, maximum: number): void => {
    if (!Array.isArray(raw) || raw.length > maximum) return;
    for (let index = 0; index < raw.length; index += 1) {
      if (!Object.hasOwn(raw, index)) throw new InputIssue('impact-sparse', `${at}[${index}]`, 'Expected a list without holes');
    }
    if (Reflect.ownKeys(raw).length !== raw.length + 1) {
      throw new InputIssue('impact-sparse', at, 'Expected a plain list without extra properties');
    }
  };

  sparse(row.initialVelocities, `${path}.initialVelocities`, 128);
  const seen = new Set<string>();
  const initialVelocities = list<StandardBeamImpactVelocity>(row.initialVelocities, `${path}.initialVelocities`, 128,
    (item, itemPath) => {
      const entry = fields(item, ['nodeId', 'velocityMPerS'], itemPath);
      const nodeId = node(entry.nodeId, `${itemPath}.nodeId`);
      if (seen.has(nodeId)) throw new InputIssue('impact-velocity', itemPath, 'Each node has at most one initial velocity');
      seen.add(nodeId);
      const velocityMPerS = vector(entry.velocityMPerS, `${itemPath}.velocityMPerS`);
      const restrained = restraint.get(nodeId);
      if (restrained !== undefined && [0, 1, 2].some(axis => restrained[axis] && velocityMPerS[axis] !== 0)) {
        throw new InputIssue('impact-velocity', itemPath, 'A restrained translation cannot start moving');
      }
      return { nodeId, velocityMPerS };
    });
  if (!initialVelocities.some(entry => entry.velocityMPerS.some(component => component !== 0))) {
    throw new InputIssue('impact-velocity', `${path}.initialVelocities`, 'A nonzero initial velocity is required');
  }

  sparse(row.planes, `${path}.planes`, STANDARD_BEAM_IMPACT_MAX_PLANES);
  const planes = list<StandardBeamImpactPlane>(row.planes, `${path}.planes`, STANDARD_BEAM_IMPACT_MAX_PLANES,
    (item, itemPath) => {
      // Only the fixed-plane form exists; a saved node-pair or any extra field is refused, never reinterpreted.
      const entry = fields(item, ['id', 'nodeId', 'normal', 'gapMm'], itemPath);
      const id = text(entry.id, `${itemPath}.id`, 64);
      const nodeId = node(entry.nodeId, `${itemPath}.nodeId`);
      const normal = vector(entry.normal, `${itemPath}.normal`);
      const length = Math.hypot(...normal);
      if (!(length > 1e-12) || !Number.isFinite(length)) {
        throw new InputIssue('impact-normal', `${itemPath}.normal`, 'Expected a nonzero finite direction');
      }
      const restrained = restraint.get(nodeId);
      if (restrained !== undefined && [0, 1, 2].every(axis => restrained[axis] || normal[axis] === 0)) {
        throw new InputIssue('impact-normal', `${itemPath}.normal`, 'The plane direction only acts on restrained translations');
      }
      const gapMm = number(entry.gapMm, `${itemPath}.gapMm`);
      if (gapMm < 0 || gapMm > MAX_GAP_MM) throw new InputIssue('impact-gap', `${itemPath}.gapMm`, 'Expected a gap from 0 to 1000 m');
      return { id, nodeId, normal, gapMm };
    });
  if (planes.length === 0) throw new InputIssue('impact-planes', `${path}.planes`, 'At least one fixed plane is required');
  unique(planes, `${path}.planes`);

  const contactStiffnessNPerM = number(row.contactStiffnessNPerM, `${path}.contactStiffnessNPerM`);
  if (!(contactStiffnessNPerM > 0)) {
    throw new InputIssue('impact-stiffness', `${path}.contactStiffnessNPerM`, 'Expected a positive stiffness in N/m');
  }
  const history = fields(row.history, ['timeStepS', 'stepCount', 'outputEvery'], `${path}.history`);
  const timeStepS = number(history.timeStepS, `${path}.history.timeStepS`);
  const stepCount = number(history.stepCount, `${path}.history.stepCount`);
  const outputEvery = number(history.outputEvery, `${path}.history.outputEvery`);
  // The solver's readHistory (fem beamImpactTranslation.ts) admits an output interval of 1 to stepCount only and the
  // step coefficients dt^2, 4/dt^2, 4/dt, dt/2 and the duration dt * stepCount only when finite and positive; a saved
  // setting outside either could never be run, so it is refused here with the same bounds instead of at Run.
  const derived = [timeStepS * timeStepS, 4 / (timeStepS * timeStepS), 4 / timeStepS, timeStepS / 2, timeStepS * stepCount];
  if (!(timeStepS > 0) || !Number.isSafeInteger(stepCount) || stepCount < 1 || stepCount > STANDARD_BEAM_IMPACT_MAX_STEPS
    || !Number.isSafeInteger(outputEvery) || outputEvery < 1 || outputEvery > stepCount
    || Math.ceil(stepCount / outputEvery) + 1 > STANDARD_BEAM_IMPACT_MAX_SAMPLES
    || !derived.every(item => Number.isFinite(item) && item > 0)) {
    throw new InputIssue('impact-history', `${path}.history`,
      'Expected a representable positive time step, 1 to 4000 steps, an output interval of 1 to the step count and at most 101 output samples');
  }
  if (row.segmentsPerMember !== segmentsPerMember) {
    throw new InputIssue('impact-settings', `${path}.segmentsPerMember`, 'Mesh refinement does not match the structure');
  }
  const settings = { segmentsPerMember, initialVelocities, planes, contactStiffnessNPerM, history: { timeStepS, stepCount, outputEvery } };
  if (!withOutlines) return settings;
  sparse(row.fibreSections, `${path}.fibreSections`, STANDARD_BEAM_MAX_FIBRE_SECTIONS);
  const outlineSections = new Set<string>();
  const fibreSections = list<StandardBeamFibreSection>(row.fibreSections, `${path}.fibreSections`, STANDARD_BEAM_MAX_FIBRE_SECTIONS,
    (item, itemPath) => {
      const entry = fields(item, ['sectionId', 'outline'], itemPath);
      const sectionId = text(entry.sectionId, `${itemPath}.sectionId`, 128);
      if (sectionIds !== undefined && !sectionIds.has(sectionId)) {
        throw new InputIssue('impact-fibre-section', `${itemPath}.sectionId`, 'The outline names a section that is not saved');
      }
      if (outlineSections.has(sectionId)) throw new InputIssue('impact-fibre-section', itemPath, 'Each section has at most one outline');
      outlineSections.add(sectionId);
      const raw = entry.outline;
      const kind = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'kind')
        ? (raw as { readonly kind: unknown }).kind : undefined;
      const size = (field: unknown, at: string): number => {
        const mm = number(field, at);
        if (!(mm > 0) || mm > MAX_OUTLINE_MM) throw new InputIssue('impact-fibre-outline', at, 'Expected a positive size up to 1000 m in mm');
        return mm;
      };
      const at = `${itemPath}.outline`;
      if (kind === 'rectangle') {
        const shape = fields(raw, ['kind', 'widthYMm', 'depthZMm'], at);
        return { sectionId, outline: { kind, widthYMm: size(shape.widthYMm, `${at}.widthYMm`), depthZMm: size(shape.depthZMm, `${at}.depthZMm`) } };
      }
      if (kind === 'circle') {
        const shape = fields(raw, ['kind', 'diameterMm'], at);
        return { sectionId, outline: { kind, diameterMm: size(shape.diameterMm, `${at}.diameterMm`) } };
      }
      if (kind === 'tube') {
        const shape = fields(raw, ['kind', 'outsideDiameterMm', 'wallThicknessMm'], at);
        const outsideDiameterMm = size(shape.outsideDiameterMm, `${at}.outsideDiameterMm`);
        const wallThicknessMm = size(shape.wallThicknessMm, `${at}.wallThicknessMm`);
        if (!(2 * wallThicknessMm < outsideDiameterMm)) {
          throw new InputIssue('impact-fibre-outline', `${at}.wallThicknessMm`, 'The wall must be thinner than the radius');
        }
        return { sectionId, outline: { kind, outsideDiameterMm, wallThicknessMm } };
      }
      throw new InputIssue('impact-fibre-outline', `${at}.kind`, 'Only rectangle, circle and tube outlines are supported');
    });
  if (fibreSections.length === 0) {
    throw new InputIssue('impact-fibre-section', `${path}.fibreSections`, 'Omit fibreSections instead of saving an empty list');
  }
  return { ...settings, fibreSections };
}
