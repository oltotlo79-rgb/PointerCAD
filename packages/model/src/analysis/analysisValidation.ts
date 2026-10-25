import type {
  AnalysisCheck, AnalysisMaterialCapacity, AnalysisSource, BeamAnalysisDocument, BeamCadAssociation, BeamClamp, BeamFrame, BeamMaterial,
  BeamMember, BeamModalSettings, BeamNodalLoad, BeamNode, BeamSection, PropertySource, Vector3,
} from './analysisModel.js';
import { findStrengthMaterial, STRENGTH_SOURCES } from '../measure/strengthMaterials.js';
import { checkStrengthMaterialCondition } from '../measure/strengthMaterialTypes.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(key => !(key in value))) {
    throw new InputIssue('shape', path, 'Unsupported or missing field');
  }
  return value;
}
export class InputIssue extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message);
  }
}
export function text(value: unknown, path: string, limit = 256): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > limit
    || [...value].some(c => c.charCodeAt(0) < 32)) {
    throw new InputIssue('text', path, 'Expected bounded nonempty text');
  }
  return value;
}
export function number(value: unknown, path: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e30
    || (positive && value <= 0)) {
    throw new InputIssue('number', path, 'Expected a finite supported numeric value');
  }
  return value === 0 ? 0 : value;
}
export function revision(value: unknown, path: string): number {
  const result = number(value, path);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new InputIssue('revision', path, 'Expected nonnegative integer revision');
  }
  return result;
}
export function vector(value: unknown, path: string): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new InputIssue('vector', path, 'Expected three components');
  return [number(value[0], path), number(value[1], path), number(value[2], path)];
}
export function list<T>(value: unknown, path: string, maximum: number, read: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new InputIssue('size', path, 'Unsupported collection size');
  return value.map((item, index) => read(item, `${path}[${index}]`));
}
export function propertySource(value: unknown, path: string): PropertySource {
  const row = fields(value, ['kind', 'reference', 'condition'], path);
  if (row.kind !== 'user-supplied' && row.kind !== 'measured' && row.kind !== 'published') {
    throw new InputIssue('provenance', path, 'Unsupported property provenance');
  }
  return {
    kind: row.kind,
    reference: text(row.reference, `${path}.reference`, 2048),
    condition: text(row.condition, `${path}.condition`, 1024),
  };
}
export function readAnalysisSource(value: unknown, path: string): AnalysisSource {
  const source = fields(value, ['documentId', 'documentRevision', 'geometryRevision'], path);
  return {
    documentId: text(source.documentId, `${path}.documentId`),
    documentRevision: revision(source.documentRevision, `${path}.documentRevision`),
    geometryRevision: text(source.geometryRevision, `${path}.geometryRevision`),
  };
}
function readCadAssociation(value: unknown, path: string): BeamCadAssociation {
  const row = fields(value, ['expectedPartKey', 'sectionFrameSource', 'shearCenterModel'], path);
  if (row.shearCenterModel !== 'coincident-with-centroid') {
    throw new InputIssue('section-frame', path, 'Only an explicit coincident shear-centre assumption is supported');
  }
  return {
    expectedPartKey: text(row.expectedPartKey, `${path}.expectedPartKey`, 8192),
    sectionFrameSource: propertySource(row.sectionFrameSource, `${path}.sectionFrameSource`),
    shearCenterModel: row.shearCenterModel,
  };
}
export const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vector3, b: Vector3): Vector3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const scale = (a: Vector3, value: number): Vector3 => [a[0] * value, a[1] * value, a[2] * value];
export const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export function beamFrame(a: Vector3, b: Vector3, hint: Vector3, lengthScale: number): BeamFrame {
  const delta = subtract(b, a);
  const length = Math.hypot(...delta);
  if (!Number.isFinite(length) || length * lengthScale <= 1e-9) {
    throw new InputIssue('zero-length', 'members', 'Beam length must exceed 1 nm');
  }
  const x = scale(delta, 1 / length);
  const hintLength = Math.hypot(...hint);
  if (hintLength === 0 || !Number.isFinite(hintLength)) throw new InputIssue('orientation', 'members', 'Missing local orientation');
  const unitHint = scale(hint, 1 / hintLength);
  const projected = subtract(unitHint, scale(x, dot(x, unitHint)));
  const normal = Math.hypot(...projected);
  if (normal < 1e-8) throw new InputIssue('orientation', 'members', 'Local y hint is parallel to member axis');
  const y = scale(projected, 1 / normal);
  return { x, y, z: cross(x, y), lengthM: length * lengthScale };
}
export function unique<T extends { readonly id: string }>(rows: readonly T[], path: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of rows) {
    if (result.has(item.id)) throw new InputIssue('duplicate-id', path, 'Duplicate id: ' + item.id);
    result.set(item.id, item);
  }
  return result;
}
/** Validate supplied evidence without inventing yield values, conditions or source classifications.
 * This is an input contract only; no safety factor or constitutive law is calculated here. */
export function readAnalysisMaterialCapacity(value: unknown, path = 'capacity'): AnalysisMaterialCapacity {
  if (value === undefined) throw new InputIssue('material-capacity-missing', path, 'Yield evidence is missing');
  if (record(value) && (!Object.hasOwn(value, 'sourceId') || value.sourceId === undefined
    || value.sourceId === null || value.sourceId === '')) {
    throw new InputIssue('material-capacity-source-missing', `${path}.sourceId`, 'An explicit yield source ID is required');
  }
  const names = ['materialConditionId', 'condition', 'thicknessMm', 'yieldMPa', 'sourceId', 'evidence', 'basis'];
  const row = fields(value, names, path);
  if (Reflect.ownKeys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    throw new InputIssue('shape', path, 'Unsupported capacity field');
  }
  const materialConditionId = text(row.materialConditionId, `${path}.materialConditionId`);
  const preset = findStrengthMaterial(materialConditionId);
  const condition = text(row.condition, `${path}.condition`, 1024);
  if (preset === undefined || condition !== preset.condition) {
    throw new InputIssue('material-capacity-condition-mismatch', path, 'Material condition and declared treatment must match the source row');
  }
  const thicknessMm = row.thicknessMm === null ? null : number(row.thicknessMm, `${path}.thicknessMm`, true);
  const thickness = checkStrengthMaterialCondition(preset, thicknessMm);
  if (!thickness.ok) {
    throw new InputIssue(`material-capacity-${thickness.reason}`, `${path}.thicknessMm`, 'Thickness must lie in the stated source interval');
  }
  const sourceId = text(row.sourceId, `${path}.sourceId`);
  const source = Object.hasOwn(STRENGTH_SOURCES, sourceId) ? STRENGTH_SOURCES[sourceId] : undefined;
  if (sourceId !== preset.yieldStress.sourceId || source === undefined || row.evidence !== source.evidence
    || row.basis !== preset.yieldStress.basis) {
    throw new InputIssue('material-capacity-source-mismatch', path, 'Yield source, evidence kind and basis must match the source row');
  }
  const yieldMPa = number(row.yieldMPa, `${path}.yieldMPa`, true);
  if (yieldMPa !== Number(preset.yieldStress.mpa)) {
    throw new InputIssue('material-capacity-value-mismatch', `${path}.yieldMPa`, 'Yield in MPa must match the source row');
  }
  return { materialConditionId, condition, thicknessMm, yieldMPa, sourceId,
    evidence: source.evidence, basis: preset.yieldStress.basis };
}

/** Omit legacy capacity entirely; an explicitly present malformed block is never treated as absent. */
export function readOptionalMaterialCapacity(row: Record<string, unknown>, path: string): Pick<BeamMaterial, 'capacity'> {
  return Object.hasOwn(row, 'capacity') ? { capacity: readAnalysisMaterialCapacity(row.capacity, `${path}.capacity`) } : {};
}

export function readBeamMaterials(value: unknown): BeamMaterial[] {
  return list<BeamMaterial>(value, 'materials', 128, (item, path) => {
    const hasCapacity = record(item) && Object.hasOwn(item, 'capacity');
    const row = fields(item, ['id', 'youngModulus', 'shearModulus', 'densityKgM3', 'source', ...(hasCapacity ? ['capacity'] : [])], path);
    const youngModulus = number(row.youngModulus, `${path}.youngModulus`, true);
    const shearModulus = number(row.shearModulus, `${path}.shearModulus`, true);
    const poisson = youngModulus / (2 * shearModulus) - 1;
    if (!Number.isFinite(poisson) || poisson <= -1 || poisson >= 0.5) {
      throw new InputIssue('isotropy', path, 'E and G must imply -1 < Poisson ratio < 0.5');
    }
    return {
      id: text(row.id, `${path}.id`), youngModulus, shearModulus,
      densityKgM3: number(row.densityKgM3, `${path}.densityKgM3`, true),
      source: propertySource(row.source, `${path}.source`),
      ...readOptionalMaterialCapacity(row, path),
    };
  });
}

export function readBeamSections(value: unknown): BeamSection[] {
  return list<BeamSection>(value, 'sections', 128, (item, path) => {
    const row = fields(item, ['id', 'area', 'iy', 'iz', 'torsionConstant', 'shearFactor', 'source'], path);
    const shearFactor = number(row.shearFactor, `${path}.shearFactor`, true);
    if (shearFactor > 1) {
      throw new InputIssue('shear-factor', path, 'Supported physical shear factor is in (0,1]');
    }
    return {
      id: text(row.id, `${path}.id`), area: number(row.area, `${path}.area`, true),
      iy: number(row.iy, `${path}.iy`, true), iz: number(row.iz, `${path}.iz`, true),
      torsionConstant: number(row.torsionConstant, `${path}.torsionConstant`, true),
      shearFactor, source: propertySource(row.source, `${path}.source`),
    };
  });
}

export function readBeamClamps(value: unknown): BeamClamp[] {
  return list<BeamClamp>(value, 'constraints', 256, (item, path) => {
    const row = fields(item, ['id', 'kind', 'nodeId'], path);
    if (row.kind !== 'fixed') {
      throw new InputIssue('constraint', path, 'Only explicit six-DOF fixed clamps are supported');
    }
    return { id: text(row.id, `${path}.id`), kind: 'fixed', nodeId: text(row.nodeId, `${path}.nodeId`) };
  });
}

export function readBeamLoads(value: unknown): BeamNodalLoad[] {
  return list<BeamNodalLoad>(value, 'loads', 1024, (item, path) => {
    const row = fields(item, ['id', 'kind', 'nodeId', 'force', 'moment'], path);
    if (row.kind !== 'nodal') {
      throw new InputIssue('load', path, 'Only global nodal force/moment loads are supported');
    }
    return {
      id: text(row.id, `${path}.id`), kind: 'nodal', nodeId: text(row.nodeId, `${path}.nodeId`),
      force: vector(row.force, `${path}.force`), moment: vector(row.moment, `${path}.moment`),
    };
  });
}

export function readBeamModalSettings(value: unknown): BeamModalSettings {
  const row = fields(value, ['modeCount', 'segmentsPerMember'], 'modal');
  const modeCount = revision(row.modeCount, 'modal.modeCount');
  const segmentsPerMember = revision(row.segmentsPerMember, 'modal.segmentsPerMember');
  if (modeCount < 1 || modeCount > 24 || segmentsPerMember < 1 || segmentsPerMember > 32) {
    throw new InputIssue('modal-size', 'modal', 'Request 1–24 elastic modes and 1–32 segments per member');
  }
  return { modeCount, segmentsPerMember };
}

export function checkBeamTopology(
  nodes: readonly { readonly id: string }[],
  members: readonly Pick<BeamMember, 'id' | 'occurrencePath' | 'startNodeId' | 'endNodeId' | 'materialId' | 'sectionId'>[],
  materials: readonly BeamMaterial[],
  sections: readonly BeamSection[],
  constraints: readonly BeamClamp[],
  loads: readonly BeamNodalLoad[],
  modal?: BeamModalSettings,
): void {
  const nodeMap = unique(nodes, 'nodes');
  const materialMap = unique(materials, 'materials');
  const sectionMap = unique(sections, 'sections');
  unique(members, 'members');
  unique(constraints, 'constraints');
  unique(loads, 'loads');
  if (nodes.length < 2 || members.length === 0 || (modal === undefined && loads.length === 0)) {
    throw new InputIssue('empty', '$', 'At least two nodes, one member and one load are required');
  }
  if (modal !== undefined) {
    if (loads.length !== 0) {
      throw new InputIssue('modal-load', 'loads', 'Unloaded linear modes require an empty load list; prestress is unsupported');
    }
    const meshNodes = nodes.length + members.length * (modal.segmentsPerMember - 1);
    if (meshNodes > 128) {
      throw new InputIssue('modal-size', 'modal', 'Dense modal route supports at most 128 FE nodes and the available elastic modes');
    }
  }
  const neighbours = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const occurrences = new Set<string>();
  for (const member of members) {
    const a = nodeMap.get(member.startNodeId);
    const b = nodeMap.get(member.endNodeId);
    if (!a || !b || !materialMap.has(member.materialId) || !sectionMap.has(member.sectionId)) {
      throw new InputIssue('missing-reference', 'members', 'Missing node/material/section reference');
    }
    if (a.id === b.id) {
      throw new InputIssue('zero-length', 'members', 'A member must join distinct node ids');
    }
    const key = JSON.stringify(member.occurrencePath);
    if (occurrences.has(key)) {
      throw new InputIssue('duplicate-component', 'members', 'One straight member per explicit occurrence is supported');
    }
    occurrences.add(key);
    neighbours.get(a.id)?.add(b.id);
    neighbours.get(b.id)?.add(a.id);
  }
  const clamped = new Set<string>();
  for (const clamp of constraints) {
    if (!nodeMap.has(clamp.nodeId)) throw new InputIssue('missing-reference', 'constraints', 'Clamp node does not exist');
    if (clamped.has(clamp.nodeId)) throw new InputIssue('duplicate-constraint', 'constraints', 'Node is already fixed');
    clamped.add(clamp.nodeId);
  }
  for (const load of loads) {
    if (!nodeMap.has(load.nodeId)) throw new InputIssue('missing-reference', 'loads', 'Load node does not exist');
  }
  if (clamped.size === nodes.length && (modal === undefined || modal.segmentsPerMember === 1)) {
    throw new InputIssue('no-free-dofs', 'constraints', 'This solver route requires at least one free node');
  }
  const visited = new Set<string>();
  let components = 0;
  for (const node of nodes) {
    if ((neighbours.get(node.id)?.size ?? 0) === 0) {
      throw new InputIssue('isolated-node', 'nodes', 'Every node must belong to a member');
    }
    if (visited.has(node.id)) continue;
    components += 1;
    const pending = [node.id];
    let supported = false;
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      supported ||= clamped.has(id);
      for (const next of neighbours.get(id) ?? []) pending.push(next);
    }
    if (!supported && !(modal !== undefined && constraints.length === 0)) {
      throw new InputIssue('unconstrained-component', 'constraints', 'Every explicitly connected component needs a fixed clamp');
    }
  }
  if (modal !== undefined) {
    const meshNodes = nodes.length + members.length * (modal.segmentsPerMember - 1);
    const elasticDofs = 6 * (meshNodes - clamped.size) - (clamped.size === 0 ? 6 * components : 0);
    if (modal.modeCount > elasticDofs) {
      throw new InputIssue('modal-size', 'modal', 'Requested modes exceed available elastic degrees of freedom');
    }
  }
}

/** Decode into fresh plain values; never keeps caller arrays or accepts executable text. */
export function readBeamAnalysis(value: unknown): AnalysisCheck {
  try {
    const modalSchema = record(value) && value.schema === 'pointercad-beam/2';
    const row = fields(value, [
      'schema', 'id', 'revision', 'source', 'units', 'nodes', 'members',
      'materials', 'sections', 'constraints', 'loads', ...(modalSchema ? ['modal'] : []),
    ], '$');
    if ((row.schema !== 'pointercad-beam/1' && row.schema !== 'pointercad-beam/2') || (row.units !== 'N-m' && row.units !== 'N-mm')) {
      throw new InputIssue('unsupported-model', '$', 'Expected beam schema 1 or 2 and N-m or N-mm units');
    }
    const source = readAnalysisSource(row.source, 'source');
    const nodes = list<BeamNode>(row.nodes, 'nodes', 256, (item, path) => {
      const node = fields(item, ['id', 'position'], path);
      return { id: text(node.id, `${path}.id`), position: vector(node.position, `${path}.position`) };
    });
    const materials = readBeamMaterials(row.materials);
    const sections = readBeamSections(row.sections);
    const members = list<BeamMember>(row.members, 'members', 512, (item, path) => {
      const hasCadSource = record(item) && Object.hasOwn(item, 'cadSource');
      const member = fields(item, [
        'id', 'componentId', 'occurrencePath', 'startNodeId', 'endNodeId', 'materialId', 'sectionId', 'localYHint',
        ...(hasCadSource ? ['cadSource'] : []),
      ], path);
      const occurrencePath = list<string>(member.occurrencePath, `${path}.occurrencePath`, 32, text);
      if (occurrencePath.length === 0) {
        throw new InputIssue('occurrence', path, 'Explicit component occurrence path required');
      }
      const componentId = text(member.componentId, `${path}.componentId`);
      if (occurrencePath[occurrencePath.length - 1] !== componentId) {
        throw new InputIssue('occurrence', path, 'Last occurrence id must identify the component');
      }
      return {
        id: text(member.id, `${path}.id`), componentId, occurrencePath,
        startNodeId: text(member.startNodeId, `${path}.startNodeId`),
        endNodeId: text(member.endNodeId, `${path}.endNodeId`),
        materialId: text(member.materialId, `${path}.materialId`),
        sectionId: text(member.sectionId, `${path}.sectionId`),
        localYHint: vector(member.localYHint, `${path}.localYHint`),
        ...(hasCadSource ? { cadSource: readCadAssociation(member.cadSource, `${path}.cadSource`) } : {}),
      };
    });
    const constraints = readBeamClamps(row.constraints);
    const loads = readBeamLoads(row.loads);
    const modal = modalSchema ? readBeamModalSettings(row.modal) : undefined;
    const document: BeamAnalysisDocument = {
      schema: row.schema, id: text(row.id, 'id'), revision: revision(row.revision, 'revision'),
      source, units: row.units, nodes, members, materials, sections, constraints, loads,
      ...(modal === undefined ? {} : { modal }),
    };
    checkBeamTopology(nodes, members, materials, sections, constraints, loads, modal);
    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    for (const member of members) {
      const a = nodeMap.get(member.startNodeId);
      const b = nodeMap.get(member.endNodeId);
      if (a && b) beamFrame(a.position, b.position, member.localYHint, row.units === 'N-mm' ? 0.001 : 1);
    }
    return { ok: true, document };
  } catch (error) {
    if (error instanceof InputIssue) {
      return { ok: false, issue: { code: error.code, path: error.path, message: error.message } };
    }
    return { ok: false, issue: { code: 'invalid-input', path: '$', message: 'Analysis input could not be decoded' } };
  }
}
/** Deterministic for a given document, independent of caller object-key order. */
export function serializeBeamAnalysis(value: unknown): string {
  const checked = readBeamAnalysis(value);
  if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}`);
  return JSON.stringify(checked.document);
}
