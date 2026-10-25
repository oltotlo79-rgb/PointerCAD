import type {
  AnalysisIssue, AnalysisSource, BeamAnalysisDocument, BeamClamp, BeamMaterial,
  BeamModalSettings, BeamNodalLoad, BeamSection, PropertySource, Vector3,
} from './analysisModel.js';
import {
  checkBeamTopology, fields, InputIssue, list, number, propertySource,
  readAnalysisSource, readBeamAnalysis, readBeamClamps, readBeamLoads, readBeamMaterials,
  readBeamModalSettings, readBeamSections, revision, text, unique, vector,
} from './analysisValidation.js';
import { readCadAxialBoltInputs, type CadAxialBoltInputs } from './axialBoltInput.js';
import { readCadWeldLayerInputs, type CadWeldLayerInputs } from './weldLayerInput.js';
import { readCadJointInitialStrain, type CadJointInitialStrain } from './jointInitialStrainInput.js';
import { readBeamTransientHistory, type BeamTransientHistory } from './beamTransientHistory.js';
import { readPlasticBarSavedInput, type PlasticBarSavedInput } from './plasticBarInput.js';
import { readFatigueSavedInput, type FatigueSavedInput } from './fatigueInput.js';
import { readFatigueTensorSavedInput, type FatigueTensorSavedInput } from './fatigueTensorInput.js';
import { readFatigueSolidSavedInput, type FatigueSolidSavedInput } from './fatigueSolidInput.js';
import { readFatiguePiecewiseSavedInput, type FatiguePiecewiseSavedInput } from './fatiguePiecewiseInput.js';
import { readFatigueStrainSavedConfiguration, type FatigueStrainSavedConfiguration } from './fatigueStrainInput.js';
import { readFatigueLocalCycleSavedInput, type FatigueLocalCycleSavedInput } from './fatigueLocalCycleInput.js';
import { readSolidCadSavedInput, type SolidCadSavedInput } from './solidCadInput.js';
import { readSolidPlasticCadSavedInput, type SolidPlasticCadSavedInput } from './solidPlasticCadInput.js';
import { readSolidModalCadSavedInput, type SolidModalCadSavedInput } from './solidModalCadInput.js';
import { readSolidBucklingCadSavedInput, type SolidBucklingCadSavedInput } from './solidBucklingCadInput.js';
import { readStandardBeamImpactSettings, type StandardBeamImpactSettings } from './beamImpactInput.js';

export type { StandardBeamFibreOutline, StandardBeamFibreSection, StandardBeamImpactPlane, StandardBeamImpactSettings,
  StandardBeamImpactVelocity } from './beamImpactInput.js';

/** Explicit user interpretation of the simplified CAD section, in its local XY plane. */
export interface BeamSectionFrameInput {
  readonly centroidMm: Vector3;
  /** Centroidal principal y axis, before the occurrence's world rotation. */
  readonly principalY: Vector3;
  readonly confirmed: true;
  /** This beam route cannot represent an offset shear centre or warping. */
  readonly shearCenterModel: 'coincident-with-centroid';
  readonly source: PropertySource;
}

export interface StandardBeamMemberInput {
  readonly id: string;
  readonly occurrencePath: readonly string[];
  /** Canonical partKeyOf(source), including size, options and generator revisions. */
  readonly expectedPartKey: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly materialId: string;
  readonly sectionId: string;
  readonly sectionFrame: BeamSectionFrameInput;
}

export interface StandardBeamDefinition {
  readonly schema: 'pointercad-standard-beam/1' | 'pointercad-standard-beam/2';
  readonly modal?: BeamModalSettings;
  readonly id: string;
  readonly revision: number;
  readonly source: AnalysisSource;
  readonly units: 'N-mm';
  readonly members: readonly StandardBeamMemberInput[];
  readonly materials: readonly BeamMaterial[];
  readonly sections: readonly BeamSection[];
  readonly constraints: readonly BeamClamp[];
  readonly loads: readonly BeamNodalLoad[];
}

/** Explicit global translations X/Y/Z and rotations X/Y/Z; never inferred from CAD mates. */
export type BeamBucklingRestraints = readonly [boolean, boolean, boolean, boolean, boolean, boolean];

export interface BeamBucklingSupportInput {
  readonly nodeId: string;
  readonly restrained: BeamBucklingRestraints;
}

export interface StandardBeamBucklingDefinition
  extends Omit<StandardBeamDefinition, 'schema' | 'modal' | 'constraints' | 'loads'> {
  readonly schema: 'pointercad-standard-beam/3';
  readonly buckling: BeamModalSettings;
  readonly supports: readonly BeamBucklingSupportInput[];
  readonly referenceLoads: readonly BeamNodalLoad[];
}

/** Saved transient inputs: the buckling route's explicit six-DOF supports and reference loads, mesh refinement
 * and an explicit load-factor/damping history. Results, nonzero initial states and world geometry are never stored. */
export interface StandardBeamTransientDefinition
  extends Omit<StandardBeamBucklingDefinition, 'schema' | 'buckling'> {
  readonly schema: 'pointercad-standard-beam/4';
  readonly transient: { readonly segmentsPerMember: number; readonly history: BeamTransientHistory };
}

/** One frictionless one-sided contact on node translations: a node against a fixed rigid plane at the declared gap
 * from its unloaded position, or two explicitly paired nodes. The normal is a global direction (normalized when solved; for a pair it
 * points from A towards B) and the declared initial gap is in mm, never derived from CAD surfaces. */
export type StandardBeamContactInput =
  | { readonly kind: 'node-plane'; readonly id: string; readonly nodeId: string; readonly normal: Vector3; readonly gapMm: number }
  | { readonly kind: 'node-pair'; readonly id: string; readonly nodeIdA: string; readonly nodeIdB: string;
      readonly normal: Vector3; readonly gapMm: number };

/** Saved contact inputs: the buckling route's explicit six-DOF supports and reference loads, mesh refinement, the
 * contacts and independent load factors (each solved from the unloaded state). Results and world geometry are never
 * stored; orientation and duplicate checks need the current CAD positions and run when the analysis is prepared. */
export interface StandardBeamContactDefinition
  extends Omit<StandardBeamBucklingDefinition, 'schema' | 'buckling'> {
  readonly schema: 'pointercad-standard-beam/5';
  /** Optional explicit bilateral axial shanks; absence preserves the contact-only model. */
  readonly axialBolts?: CadAxialBoltInputs;
  /** Effective elastic throat layers; both present requires the simultaneous joint-contact execution route. */
  readonly weldLayers?: CadWeldLayerInputs;
  /** Explicit stress-free shank shortening; only the simultaneous joint route consumes this input. */
  readonly initialStrain?: CadJointInitialStrain;
  readonly contact: {
    readonly segmentsPerMember: number;
    readonly contacts: readonly StandardBeamContactInput[];
    readonly loadFactors: readonly number[];
  };
}

/** Saved impact inputs (schema 6): the explicit six-DOF supports of the buckling route, mesh refinement and the
 * elastic frictionless fixed-plane impact settings. There is no external load and no result is ever stored. */
export interface StandardBeamImpactDefinition
  extends Omit<StandardBeamBucklingDefinition, 'schema' | 'buckling' | 'referenceLoads'> {
  readonly schema: 'pointercad-standard-beam/6';
  readonly impact: StandardBeamImpactSettings;
}

/** Same bounds as the contact solver input: 64 contacts, 32 factors, gap up to 1000 m, |factor| up to 1e6. */
const STANDARD_BEAM_MAX_CONTACTS = 64;
const STANDARD_BEAM_MAX_CONTACT_FACTORS = 32;
const STANDARD_BEAM_MAX_CONTACT_GAP_MM = 1e6;
const MAX_CONTACT_FACTOR = 1e6;

export type StandardBeamAnyDefinition = StandardBeamDefinition | StandardBeamBucklingDefinition
  | StandardBeamTransientDefinition | StandardBeamContactDefinition | StandardBeamImpactDefinition;

export type BeamAnalysisInput =
  | { readonly kind: 'manual'; readonly document: BeamAnalysisDocument }
  | { readonly kind: 'standard-members'; readonly definition: StandardBeamAnyDefinition }
  /** Saved elasto-plastic bar inputs (at most one per document); never a result. */
  | { readonly kind: 'plastic-bar'; readonly definition: PlasticBarSavedInput }
  /** Saved fatigue inputs (at most one per document): the user's S-N curve and stress histories; never a result. */
  | { readonly kind: 'fatigue'; readonly definition: FatigueSavedInput }
  /** Saved proportional-tensor fatigue input (version 4): the same single fatigue configuration of the document, given as
   * reference stress tensors and signed load factors; never a result. */
  | { readonly kind: 'fatigue-proportional-tensor'; readonly definition: FatigueTensorSavedInput }
  | { readonly kind: 'fatigue-solid-proportional'; readonly definition: FatigueSolidSavedInput }
  /** Saved piecewise S-N fatigue input (version 5): the same single fatigue configuration with a sourced multi-slope
   * user calibration; never a result. */
  | { readonly kind: 'fatigue-piecewise'; readonly definition: FatiguePiecewiseSavedInput }
  /** Saved strain-life fatigue inputs (at most one per document): user coefficients and local total strains; never a result. */
  | { readonly kind: 'fatigue-strain-life'; readonly definition: FatigueStrainSavedConfiguration }
  /** Saved Morrow/SWT local-cycle fatigue input (at most one per document): user coefficients and one local cycle; never a result. */
  | { readonly kind: 'fatigue-local-cycle'; readonly definition: FatigueLocalCycleSavedInput }
  | { readonly kind: 'solid-cad'; readonly definition: SolidCadSavedInput }
  | { readonly kind: 'solid-plastic-cad'; readonly definition: SolidPlasticCadSavedInput }
  /** Saved free-vibration input (at most one per document); never a mode, a shape or a display choice. */
  | { readonly kind: 'solid-modal-cad'; readonly definition: SolidModalCadSavedInput }
  /** Saved linear prestress buckling input (at most one per document): count and static reference; never a factor. */
  | { readonly kind: 'solid-buckling-cad'; readonly definition: SolidBucklingCadSavedInput };

/** Optional persisted inputs. Derived CAD positions and all result arrays are excluded. */
export interface BeamAnalysisInputs {
  readonly schema: 'pointercad-beam-inputs/1';
  readonly analyses: readonly BeamAnalysisInput[];
}

export type BeamInputsCheck =
  | { readonly ok: true; readonly value: BeamAnalysisInputs }
  | { readonly ok: false; readonly issue: AnalysisIssue };

function readSectionFrame(value: unknown, path: string): BeamSectionFrameInput {
  const row = fields(value, ['centroidMm', 'principalY', 'confirmed', 'shearCenterModel', 'source'], path);
  const centroidMm = vector(row.centroidMm, `${path}.centroidMm`);
  const principalY = vector(row.principalY, `${path}.principalY`);
  const magnitude = Math.hypot(...principalY);
  if (row.confirmed !== true || row.shearCenterModel !== 'coincident-with-centroid') {
    throw new InputIssue('section-confirmation', path, 'Explicit section and shear-centre assumptions are required');
  }
  if (centroidMm[2] !== 0 || principalY[2] !== 0 || Math.abs(magnitude - 1) > 1e-10) {
    throw new InputIssue('section-frame', path, 'Centroid and unit principal y must lie in the generated local XY plane');
  }
  return {
    centroidMm, principalY, confirmed: true, shearCenterModel: row.shearCenterModel,
    source: propertySource(row.source, `${path}.source`),
  };
}

function readStandardMember(value: unknown, path: string): StandardBeamMemberInput {
  const row = fields(value, [
    'id', 'occurrencePath', 'expectedPartKey', 'startNodeId', 'endNodeId',
    'materialId', 'sectionId', 'sectionFrame',
  ], path);
  const occurrencePath = list(row.occurrencePath, `${path}.occurrencePath`, 32, text);
  if (occurrencePath.length === 0) {
    throw new InputIssue('occurrence', path, 'A full occurrence path is required');
  }
  return {
    id: text(row.id, `${path}.id`), occurrencePath,
    expectedPartKey: text(row.expectedPartKey, `${path}.expectedPartKey`, 8192),
    startNodeId: text(row.startNodeId, `${path}.startNodeId`),
    endNodeId: text(row.endNodeId, `${path}.endNodeId`),
    materialId: text(row.materialId, `${path}.materialId`),
    sectionId: text(row.sectionId, `${path}.sectionId`),
    sectionFrame: readSectionFrame(row.sectionFrame, `${path}.sectionFrame`),
  };
}

function readStandardDefinition(value: unknown, path: string): StandardBeamDefinition {
  const modalSchema = value !== null && typeof value === 'object'
    && 'schema' in value && value.schema === 'pointercad-standard-beam/2';
  const row = fields(value, [
    'schema', 'id', 'revision', 'source', 'units', 'members',
    'materials', 'sections', 'constraints', 'loads', ...(modalSchema ? ['modal'] : []),
  ], path);
  if ((row.schema !== 'pointercad-standard-beam/1' && row.schema !== 'pointercad-standard-beam/2') || row.units !== 'N-mm') {
    throw new InputIssue('unsupported-model', path, 'Expected standard beam schema 1 or 2 in N-mm units');
  }
  const members = list(row.members, `${path}.members`, 512, readStandardMember);
  const materials = readBeamMaterials(row.materials);
  const sections = readBeamSections(row.sections);
  const constraints = readBeamClamps(row.constraints);
  const loads = readBeamLoads(row.loads);
  const modal = modalSchema ? readBeamModalSettings(row.modal) : undefined;
  const nodeIds = new Set(members.flatMap(member => [member.startNodeId, member.endNodeId]));
  if (nodeIds.size > 256) {
    throw new InputIssue('size', path, 'This beam route supports at most 256 nodes');
  }
  // Topology is checked without inventing or persisting any world coordinates.
  checkBeamTopology([...nodeIds].map(id => ({ id })), members, materials, sections, constraints, loads, modal);
  return {
    schema: row.schema, id: text(row.id, `${path}.id`), revision: revision(row.revision, `${path}.revision`),
    source: readAnalysisSource(row.source, `${path}.source`), units: row.units,
    members, materials, sections, constraints, loads, ...(modal === undefined ? {} : { modal }),
  };
}

/** Explicit six-DOF supports shared by schemas 3 to 6, with the unchanged buckling rules and issue paths. */
function readSixDofSupports(value: unknown, path: string, nodeIds: ReadonlySet<string>): BeamBucklingSupportInput[] {
  const supportIds = new Set<string>();
  const supports = list<BeamBucklingSupportInput>(value, `${path}.supports`, 128, (item, itemPath) => {
    const support = fields(item, ['nodeId', 'restrained'], itemPath);
    const nodeId = text(support.nodeId, `${itemPath}.nodeId`);
    const mask = support.restrained;
    if (!nodeIds.has(nodeId) || supportIds.has(nodeId) || !Array.isArray(mask) || mask.length !== 6
      || !mask.every((entry: unknown) => typeof entry === 'boolean') || !mask.some(Boolean)) {
      throw new InputIssue('buckling-supports', itemPath, 'Expected a unique existing node and six explicit boolean restraints');
    }
    supportIds.add(nodeId);
    return { nodeId, restrained: [mask[0] === true, mask[1] === true, mask[2] === true,
      mask[3] === true, mask[4] === true, mask[5] === true] };
  });
  if (supports.length === 0) throw new InputIssue('buckling-supports', path, 'Explicit supports are required');
  return supports;
}

function readBucklingDefinition(value: unknown, path: string): StandardBeamBucklingDefinition {
  const row = fields(value, [
    'schema', 'id', 'revision', 'source', 'units', 'members', 'materials', 'sections',
    'buckling', 'supports', 'referenceLoads',
  ], path);
  // Reuse the unchanged strict CAD/material/section/topology decoder. This temporary
  // unloaded and unrestrained modal geometry is never stored in the CAD document.
  const geometry = readStandardDefinition({
    schema: 'pointercad-standard-beam/2', id: row.id, revision: row.revision,
    source: row.source, units: row.units, members: row.members,
    materials: row.materials, sections: row.sections, modal: row.buckling,
    constraints: [], loads: [],
  }, path);
  if (geometry.modal === undefined) throw new InputIssue('buckling-settings', path, 'Missing buckling settings');
  const nodeIds = new Set(geometry.members.flatMap(member => [member.startNodeId, member.endNodeId]));
  const supports = readSixDofSupports(row.supports, path, nodeIds);
  const referenceLoads = readBeamLoads(row.referenceLoads);
  unique(referenceLoads, `${path}.referenceLoads`);
  const sums = new Map<string, number[]>();
  for (const load of referenceLoads) {
    if (!nodeIds.has(load.nodeId)) throw new InputIssue('buckling-load', path, 'Reference load node is absent');
    const sum = sums.get(load.nodeId) ?? [0, 0, 0, 0, 0, 0];
    for (let axis = 0; axis < 6; axis += 1) {
      sum[axis] += axis < 3 ? load.force[axis] : load.moment[axis - 3] * 0.001;
    }
    sums.set(load.nodeId, sum);
  }
  if ([...sums.values()].some(sum => sum.some(component => !Number.isFinite(component) || Math.abs(component) > 1e30))) {
    throw new InputIssue('buckling-load', path, 'Combined SI reference load is outside the supported finite range');
  }
  if (![...sums.values()].some(sum => sum.some(component => component !== 0))) {
    throw new InputIssue('buckling-load', path, 'A nonzero combined reference load is required');
  }
  // Load direction and prestress stability need the current world geometry and
  // native static state. Do not guess them from local CAD axes in a saved input.
  return {
    schema: 'pointercad-standard-beam/3', id: geometry.id, revision: geometry.revision,
    source: geometry.source, units: geometry.units, members: geometry.members,
    materials: geometry.materials, sections: geometry.sections,
    buckling: geometry.modal, supports, referenceLoads,
  };
}

function readTransientDefinition(value: unknown, path: string): StandardBeamTransientDefinition {
  const row = fields(value, [
    'schema', 'id', 'revision', 'source', 'units', 'members', 'materials', 'sections',
    'transient', 'supports', 'referenceLoads',
  ], path);
  if (row.schema !== 'pointercad-standard-beam/4') {
    throw new InputIssue('unsupported-model', path, 'Expected standard beam transient schema 4');
  }
  const settings = fields(row.transient, ['segmentsPerMember', 'history'], `${path}.transient`);
  // Structure, supports and nonzero reference loads reuse the unchanged strict buckling decoder; its mode
  // count 1 is only the required placeholder of the shared mesh settings and is not stored.
  const structure = readBucklingDefinition({
    schema: 'pointercad-standard-beam/3', id: row.id, revision: row.revision, source: row.source,
    units: row.units, members: row.members, materials: row.materials, sections: row.sections,
    buckling: { modeCount: 1, segmentsPerMember: settings.segmentsPerMember },
    supports: row.supports, referenceLoads: row.referenceLoads,
  }, path);
  const history = readBeamTransientHistory(settings.history, `${path}.transient.history`);
  return {
    schema: 'pointercad-standard-beam/4', id: structure.id, revision: structure.revision,
    source: structure.source, units: structure.units, members: structure.members,
    materials: structure.materials, sections: structure.sections,
    transient: { segmentsPerMember: structure.buckling.segmentsPerMember, history },
    supports: structure.supports, referenceLoads: structure.referenceLoads,
  };
}

/** list() reads with Array.map and the factor bound uses .some; both skip holes, so a sparse saved list such as
 * [,] would be accepted and then save as [null]. Like beamTransientHistory, every index must be an own element and
 * nothing else may be present (oversized lists are left to list(), which refuses them by size without walking). */
function denseList(value: unknown, path: string, maximum: number): void {
  if (!Array.isArray(value) || value.length > maximum) return;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new InputIssue('contact-sparse', `${path}[${index}]`, 'Expected a list without holes');
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    throw new InputIssue('contact-sparse', path, 'Expected a plain list without extra properties');
  }
}

function readContactRow(value: unknown, path: string, nodeIds: ReadonlySet<string>): StandardBeamContactInput {
  const pair = value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'node-pair';
  const row = fields(value, pair ? ['kind', 'id', 'nodeIdA', 'nodeIdB', 'normal', 'gapMm']
    : ['kind', 'id', 'nodeId', 'normal', 'gapMm'], path);
  if (!pair && row.kind !== 'node-plane') throw new InputIssue('contact-kind', path, 'Expected node-plane or node-pair');
  const id = text(row.id, `${path}.id`, 64);
  const normal = vector(row.normal, `${path}.normal`);
  if (!(Math.hypot(...normal) > 1e-12)) throw new InputIssue('contact-normal', `${path}.normal`, 'Expected a nonzero direction');
  const gapMm = number(row.gapMm, `${path}.gapMm`);
  if (gapMm < 0 || gapMm > STANDARD_BEAM_MAX_CONTACT_GAP_MM) {
    throw new InputIssue('contact-gap', `${path}.gapMm`, 'Expected a nonnegative initial gap of at most 1000 m');
  }
  const node = (name: string): string => {
    const nodeId = text(row[name], `${path}.${name}`);
    if (!nodeIds.has(nodeId)) throw new InputIssue('contact-node', `${path}.${name}`, 'Contact node is absent');
    return nodeId;
  };
  if (!pair) return { kind: 'node-plane', id, nodeId: node('nodeId'), normal, gapMm };
  const nodeIdA = node('nodeIdA'), nodeIdB = node('nodeIdB');
  if (nodeIdA === nodeIdB) throw new InputIssue('contact-self', path, 'A contact pair needs two different nodes');
  return { kind: 'node-pair', id, nodeIdA, nodeIdB, normal, gapMm };
}

function readContactDefinition(value: unknown, path: string): StandardBeamContactDefinition {
  const hasBolts = value !== null && typeof value === 'object' && Object.hasOwn(value, 'axialBolts');
  const hasWelds = value !== null && typeof value === 'object' && Object.hasOwn(value, 'weldLayers');
  const hasInitialStrain = value !== null && typeof value === 'object' && Object.hasOwn(value, 'initialStrain');
  const row = fields(value, [
    'schema', 'id', 'revision', 'source', 'units', 'members', 'materials', 'sections',
    'contact', 'supports', 'referenceLoads', ...(hasBolts ? ['axialBolts'] : []), ...(hasWelds ? ['weldLayers'] : []),
    ...(hasInitialStrain ? ['initialStrain'] : []),
  ], path);
  if (row.schema !== 'pointercad-standard-beam/5') {
    throw new InputIssue('unsupported-model', path, 'Expected standard beam contact schema 5');
  }
  const settings = fields(row.contact, ['segmentsPerMember', 'contacts', 'loadFactors'], `${path}.contact`);
  // Same reuse as schema 4: the unchanged strict buckling decoder checks structure, supports and the nonzero
  // reference load; its mode count 1 is only the placeholder of the shared mesh settings and is not stored.
  const structure = readBucklingDefinition({
    schema: 'pointercad-standard-beam/3', id: row.id, revision: row.revision, source: row.source,
    units: row.units, members: row.members, materials: row.materials, sections: row.sections,
    buckling: { modeCount: 1, segmentsPerMember: settings.segmentsPerMember },
    supports: row.supports, referenceLoads: row.referenceLoads,
  }, path);
  const nodeIds = new Set(structure.members.flatMap(member => [member.startNodeId, member.endNodeId]));
  denseList(settings.contacts, `${path}.contact.contacts`, STANDARD_BEAM_MAX_CONTACTS);
  const contacts = list(settings.contacts, `${path}.contact.contacts`, STANDARD_BEAM_MAX_CONTACTS,
    (item, itemPath) => readContactRow(item, itemPath, nodeIds));
  if (contacts.length === 0) throw new InputIssue('contact-count', `${path}.contact.contacts`, 'At least one contact is required');
  unique(contacts, `${path}.contact.contacts`);
  denseList(settings.loadFactors, `${path}.contact.loadFactors`, STANDARD_BEAM_MAX_CONTACT_FACTORS);
  const loadFactors = list(settings.loadFactors, `${path}.contact.loadFactors`, STANDARD_BEAM_MAX_CONTACT_FACTORS, number);
  if (loadFactors.length === 0 || loadFactors.some(factor => Math.abs(factor) > MAX_CONTACT_FACTOR)) {
    throw new InputIssue('contact-factors', `${path}.contact.loadFactors`, 'Expected 1 to 32 load factors of magnitude at most 1e6');
  }
  const axialBolts = hasBolts ? readCadAxialBoltInputs(row.axialBolts) : undefined;
  if (axialBolts !== undefined) {
    if (axialBolts.analysisId !== structure.id || axialBolts.analysisRevision !== structure.revision
      || axialBolts.source.documentId !== structure.source.documentId
      || axialBolts.source.documentRevision !== structure.source.documentRevision
      || axialBolts.source.geometryRevision !== structure.source.geometryRevision) {
      throw new InputIssue('bolt-stale', `${path}.axialBolts`, 'Bolt association belongs to another analysis or source');
    }
    for (const bolt of axialBolts.bolts) {
      for (const end of [bolt.first, bolt.second]) {
        const member = structure.members.find(candidate => candidate.id === end.memberId);
        if (member === undefined || ![member.startNodeId, member.endNodeId].includes(end.nodeId)) {
          throw new InputIssue('bolt-owner', `${path}.axialBolts`, 'Bolt endpoint does not belong to the declared member');
        }
      }
    }
  }
  const weldLayers = hasWelds ? readCadWeldLayerInputs(row.weldLayers) : undefined;
  if (weldLayers !== undefined) {
    if (weldLayers.analysisId !== structure.id || weldLayers.analysisRevision !== structure.revision
      || weldLayers.source.documentId !== structure.source.documentId
      || weldLayers.source.documentRevision !== structure.source.documentRevision
      || weldLayers.source.geometryRevision !== structure.source.geometryRevision) {
      throw new InputIssue('weld-stale', `${path}.weldLayers`, 'Weld association belongs to another analysis or source');
    }
    for (const weld of weldLayers.welds) for (const end of [weld.first, weld.second]) {
      const member = structure.members.find(candidate => candidate.id === end.memberId);
      if (member === undefined || ![member.startNodeId, member.endNodeId].includes(end.nodeId)) {
        throw new InputIssue('weld-owner', `${path}.weldLayers`, 'Weld endpoint does not belong to the declared member');
      }
    }
  }
  if (hasInitialStrain && (axialBolts === undefined || weldLayers === undefined)) {
    throw new InputIssue('initial-strain-joint', `${path}.initialStrain`, 'Initial strain requires the simultaneous shank and weld route');
  }
  const initialStrain = hasInitialStrain ? readCadJointInitialStrain(row.initialStrain, axialBolts?.bolts.map(bolt => bolt.id) ?? []) : undefined;
  return {
    ...(axialBolts === undefined ? {} : { axialBolts }), ...(weldLayers === undefined ? {} : { weldLayers }),
    ...(initialStrain === undefined ? {} : { initialStrain }),
    schema: 'pointercad-standard-beam/5', id: structure.id, revision: structure.revision,
    source: structure.source, units: structure.units, members: structure.members,
    materials: structure.materials, sections: structure.sections,
    contact: { segmentsPerMember: structure.buckling.segmentsPerMember, contacts, loadFactors },
    supports: structure.supports, referenceLoads: structure.referenceLoads,
  };
}

function readImpactDefinition(value: unknown, path: string): StandardBeamImpactDefinition {
  const row = fields(value, [
    'schema', 'id', 'revision', 'source', 'units', 'members', 'materials', 'sections', 'impact', 'supports',
  ], path);
  if (row.schema !== 'pointercad-standard-beam/6') {
    throw new InputIssue('unsupported-model', path, 'Expected standard beam impact schema 6');
  }
  const impact = row.impact;
  const segmentsPerMember = impact !== null && typeof impact === 'object' && 'segmentsPerMember' in impact
    ? impact.segmentsPerMember : undefined;
  // Same strict structure decoder and unloaded mesh placeholder as schema 3; the mode count 1 is not stored and an
  // impact analysis has no reference load.
  const geometry = readStandardDefinition({
    schema: 'pointercad-standard-beam/2', id: row.id, revision: row.revision,
    source: row.source, units: row.units, members: row.members,
    materials: row.materials, sections: row.sections, modal: { modeCount: 1, segmentsPerMember },
    constraints: [], loads: [],
  }, path);
  if (geometry.modal === undefined) throw new InputIssue('impact-settings', path, 'Missing impact mesh settings');
  const nodeIds = new Set(geometry.members.flatMap(member => [member.startNodeId, member.endNodeId]));
  const supports = readSixDofSupports(row.supports, path, nodeIds);
  return {
    schema: 'pointercad-standard-beam/6', id: geometry.id, revision: geometry.revision,
    source: geometry.source, units: geometry.units, members: geometry.members,
    materials: geometry.materials, sections: geometry.sections, supports,
    impact: readStandardBeamImpactSettings(impact, `${path}.impact`, geometry.modal.segmentsPerMember, nodeIds, supports,
      new Set(geometry.sections.map(section => section.id))),
  };
}

function readInput(value: unknown, path: string): BeamAnalysisInput {
  if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'manual') {
    const row = fields(value, ['kind', 'document'], path);
    const checked = readBeamAnalysis(row.document);
    if (!checked.ok) {
      throw new InputIssue(checked.issue.code, `${path}.document.${checked.issue.path}`, checked.issue.message);
    }
    return { kind: 'manual', document: checked.document };
  }
  const row = fields(value, ['kind', 'definition'], path);
  if (row.kind === 'solid-cad') {
    return { kind: 'solid-cad', definition: readSolidCadSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'solid-plastic-cad') {
    return { kind: 'solid-plastic-cad', definition: readSolidPlasticCadSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'solid-modal-cad') {
    return { kind: 'solid-modal-cad', definition: readSolidModalCadSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'solid-buckling-cad') {
    return { kind: 'solid-buckling-cad', definition: readSolidBucklingCadSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'plastic-bar') {
    return { kind: 'plastic-bar', definition: readPlasticBarSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'fatigue') {
    return { kind: 'fatigue', definition: readFatigueSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'fatigue-solid-proportional') {
    return { kind: 'fatigue-solid-proportional', definition: readFatigueSolidSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'fatigue-proportional-tensor') {
    return { kind: 'fatigue-proportional-tensor', definition: readFatigueTensorSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'fatigue-piecewise') {
    return { kind: 'fatigue-piecewise', definition: readFatiguePiecewiseSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'fatigue-strain-life') {
    return { kind: 'fatigue-strain-life', definition: readFatigueStrainSavedConfiguration(row.definition, `${path}.definition`) };
  }
  if (row.kind === 'fatigue-local-cycle') {
    return { kind: 'fatigue-local-cycle', definition: readFatigueLocalCycleSavedInput(row.definition, `${path}.definition`) };
  }
  if (row.kind !== 'standard-members') {
    throw new InputIssue('unsupported-model', path, 'Unknown analysis input kind');
  }
  const definition = row.definition;
  const schema = definition !== null && typeof definition === 'object' && 'schema' in definition
    ? definition.schema : null;
  return { kind: 'standard-members', definition: schema === 'pointercad-standard-beam/6'
    ? readImpactDefinition(definition, `${path}.definition`)
    : schema === 'pointercad-standard-beam/5'
    ? readContactDefinition(definition, `${path}.definition`)
    : schema === 'pointercad-standard-beam/4'
      ? readTransientDefinition(definition, `${path}.definition`)
      : schema === 'pointercad-standard-beam/3'
        ? readBucklingDefinition(definition, `${path}.definition`)
        : readStandardDefinition(definition, `${path}.definition`) };
}

export function readBeamAnalysisInputs(value: unknown, ownerId: string): BeamInputsCheck {
  try {
    const row = fields(value, ['schema', 'analyses'], '$');
    if (row.schema !== 'pointercad-beam-inputs/1') {
      throw new InputIssue('unsupported-schema', 'schema', 'Unknown analysis input attachment version');
    }
    const analyses = list(row.analyses, 'analyses', 32, readInput);
    if (analyses.filter(input => input.kind === 'solid-cad').length > 1) {
      throw new InputIssue('duplicate-id', 'analyses', 'At most one solid CAD configuration per document');
    }
    if (analyses.filter(input => input.kind === 'solid-plastic-cad').length > 1) {
      throw new InputIssue('duplicate-id', 'analyses', 'At most one solid plasticity configuration per document');
    }
    if (analyses.filter(input => input.kind === 'solid-modal-cad').length > 1) {
      throw new InputIssue('duplicate-id', 'analyses', 'At most one solid modal configuration per document');
    }
    if (analyses.filter(input => input.kind === 'solid-buckling-cad').length > 1) {
      throw new InputIssue('duplicate-id', 'analyses', 'At most one solid buckling configuration per document');
    }
    const documents = analyses.map(input => input.kind === 'manual' ? input.document : input.definition);
    unique(documents, 'analyses');
    if (analyses.filter(input => input.kind === 'plastic-bar').length > 1) {
      throw new InputIssue('duplicate-id', 'analyses', 'At most one plastic-bar configuration per document');
    }
    if (analyses.filter(input => input.kind === 'fatigue' || input.kind === 'fatigue-proportional-tensor' || input.kind === 'fatigue-solid-proportional' || input.kind === 'fatigue-piecewise').length > 1) {
      throw new InputIssue('duplicate-id', 'analyses', 'At most one fatigue configuration per document');
    }
    for (const document of documents) {
      if (document.source.documentId !== ownerId) {
        throw new InputIssue('wrong-document', 'source.documentId', 'Analysis belongs to a different document');
      }
    }
    return { ok: true, value: { schema: row.schema, analyses } };
  } catch (error) {
    if (error instanceof InputIssue) {
      return { ok: false, issue: { code: error.code, path: error.path, message: error.message } };
    }
    return { ok: false, issue: { code: 'invalid-input', path: '$', message: 'Analysis inputs could not be decoded' } };
  }
}

/** An immutable document edit suitable for the existing Undo snapshot stack. */
export function withBeamAnalysisInputs<T extends { readonly id: string; readonly beamAnalysisInputs?: BeamAnalysisInputs }>(
  document: T,
  value: unknown,
): T {
  const checked = readBeamAnalysisInputs(value, document.id);
  if (!checked.ok) {
    throw new Error(`${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}`);
  }
  return { ...document, beamAnalysisInputs: checked.value };
}
