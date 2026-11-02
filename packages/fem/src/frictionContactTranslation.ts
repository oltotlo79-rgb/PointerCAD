import { isRecord } from './valueGuards.js';
import type { BeamNodalLoad, Vector3 } from './analysisModel.js';
import type { BeamContactInput } from './contactModel.js';
import { translateBeamContact, type OofemContactPlan } from './contactTranslation.js';

/** Internal candidate only; no public barrel, worker protocol or saved definition registration. */
export interface BeamFrictionContactInput {
  readonly schema: 'pointercad-beam-friction-contact/1';
  readonly geometry: BeamContactInput['geometry'];
  readonly supports: BeamContactInput['supports'];
  readonly contacts: BeamContactInput['contacts'];
  /** Every contact has one explicitly supplied coefficient, including zero. */
  readonly friction: Readonly<Record<string, number>>;
  /** Absolute nodal loads in geometry units, in physical execution order (not load factors). */
  readonly stepLoads: readonly (readonly BeamNodalLoad[])[];
}

export interface FrictionContactTranslation {
  readonly input: BeamFrictionContactInput;
  /** Native assembly geometry; node.load is the first step only. Use loads for solve_friction_steps. */
  readonly plan: OofemContactPlan;
  readonly momentLengthM: number;
  /** Original CAD node ids only, as in translateBeamContact. Refined nodes have no CAD identity. */
  readonly nodeIds: readonly string[];
  readonly friction: Readonly<Record<string, number>>;
  /** Each row contains six N/Nm components per mesh node, including zero-loaded refinement nodes. */
  readonly loads: readonly (readonly number[])[];
}

/** Own finite JSON data only. Do not silently turn holes/non-finite values into JSON null. */
function snapshot(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`friction-shape: ${path}`);
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) throw new Error(`friction-shape: ${path}[${index}]`);
      items.push(snapshot(descriptor.value, `${path}[${index}]`));
    }
    return items;
  }
  if (typeof value === 'object' && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`friction-shape: ${path}`);
      }
      entries.push([key, snapshot(descriptor.value, `${path}.${key}`)]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error(`friction-number-or-shape: ${path}`);
}


function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`friction-shape: ${path}`);
  return value;
}

function topology(plan: OofemContactPlan): string {
  return JSON.stringify({ ...plan, nodes: plan.nodes.map(node => ({
    number: node.number, positionM: node.positionM, restrained: node.restrained,
  })) });
}

/** The shared reader has already validated this stage before refusing zero load. Rebuild its typed
 * snapshot and independently require exactly zero SI nodal sums, with no synthetic reference force. */
function zeroStage(value: unknown, nodeIds: readonly string[], lengthScale: number): BeamNodalLoad[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1024) throw new Error('friction-zero-stage: explicit loads required');
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value
      || [...value].some(character => character.charCodeAt(0) < 32)) throw new Error('friction-zero-stage: invalid identity');
    return value;
  };
  const vector = (value: unknown): Vector3 => {
    if (!Array.isArray(value) || value.length !== 3) throw new Error('friction-zero-stage: invalid vector');
    const components = value.map((item: unknown) => {
      if (typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 1e30) {
        throw new Error('friction-zero-stage: invalid component');
      }
      return item === 0 ? 0 : item;
    });
    return [components[0], components[1], components[2]];
  };
  const ids = new Set<string>();
  const loads = value.map((item: unknown): BeamNodalLoad => {
    const row = record(item, 'zero-stage load');
    const keys = ['id', 'kind', 'nodeId', 'force', 'moment'];
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.kind !== 'nodal') {
      throw new Error('friction-zero-stage: invalid load fields');
    }
    const id = text(row.id), nodeId = text(row.nodeId);
    if (ids.has(id) || !nodeIds.includes(nodeId)) throw new Error('friction-zero-stage: duplicate or unknown identity');
    ids.add(id);
    return { id, kind: 'nodal', nodeId, force: vector(row.force), moment: vector(row.moment) };
  });
  for (const id of nodeIds) {
    const atNode = loads.filter(load => load.nodeId === id);
    for (let axis = 0; axis < 6; axis += 1) {
      const total = atNode.reduce((sum, load) => sum + (axis < 3 ? load.force[axis] : load.moment[axis - 3] * lengthScale), 0);
      if (!Number.isFinite(total) || total !== 0) throw new Error('friction-zero-stage: nonzero nodal sum');
    }
  }
  return loads;
}

/** Same strict contact/beam readers at every step, fixed geometry and explicit loadFactors:[1]. */
export function translateBeamFrictionContact(value: unknown): FrictionContactTranslation {
  const row = record(snapshot(value, '$'), '$');
  const fields = ['schema', 'geometry', 'supports', 'contacts', 'friction', 'stepLoads'];
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) {
    throw new Error('friction-shape: $');
  }
  if (row.schema !== 'pointercad-beam-friction-contact/1') throw new Error('friction-schema: unsupported input');
  if (!Array.isArray(row.stepLoads) || row.stepLoads.length < 1 || row.stepLoads.length > 32) {
    throw new Error('friction-steps: expected 1 to 32 explicit load stages');
  }
  const stepLoads = row.stepLoads;
  const stages = stepLoads.map((referenceLoads: unknown) => {
    try {
      return translateBeamContact({ schema: 'pointercad-beam-contact/1', geometry: row.geometry,
        supports: row.supports, contacts: row.contacts, referenceLoads, loadFactors: [1] });
    } catch (error) {
      if (error instanceof Error && error.message === 'contact-input: buckling-load: zero reference load') return null;
      throw error;
    }
  });
  type ContactTranslation = ReturnType<typeof translateBeamContact>;
  const anchor = stages.find((stage): stage is ContactTranslation => stage !== null);
  if (anchor === undefined) throw new Error('friction-steps: all-zero load paths are not supported');
  const mesh = topology(anchor.plan);
  if (stages.some(stage => stage !== null && (topology(stage.plan) !== mesh || stage.momentLengthM !== anchor.momentLengthM
    || JSON.stringify(stage.nodeIds) !== JSON.stringify(anchor.nodeIds)))) throw new Error('friction-mesh: inconsistent stages');
  const supplied = record(row.friction, 'friction');
  const ids = anchor.input.contacts.map(contact => contact.id);
  if (Object.keys(supplied).length !== ids.length || ids.some(id => !Object.hasOwn(supplied, id))) {
    throw new Error('friction-coefficients: expected exactly the contact ids');
  }
  const coefficients: [string, number][] = [];
  for (const id of ids) {
    const mu = supplied[id];
    if (typeof mu !== 'number' || !Number.isFinite(mu) || mu < 0) throw new Error(`friction-coefficient: ${id}`);
    coefficients.push([id, mu]);
  }
  const friction = Object.fromEntries(coefficients);
  const savedLoads = stages.map((stage, index) => stage?.input.referenceLoads
    ?? zeroStage(stepLoads[index], anchor.nodeIds, anchor.input.geometry.units === 'N-mm' ? 0.001 : 1));
  const plan = stages[0]?.plan ?? { ...anchor.plan,
    nodes: anchor.plan.nodes.map(node => ({ ...node, load: [0, 0, 0, 0, 0, 0] as const })) };
  const input: BeamFrictionContactInput = {
    schema: 'pointercad-beam-friction-contact/1', geometry: anchor.input.geometry, supports: anchor.input.supports,
    contacts: anchor.input.contacts, friction, stepLoads: savedLoads,
  };
  return { input, plan, momentLengthM: anchor.momentLengthM, nodeIds: anchor.nodeIds, friction,
    loads: stages.map(stage => stage === null ? Array.from({ length: 6 * anchor.plan.nodes.length }, () => 0)
      : stage.plan.nodes.flatMap(node => [...node.load])) };
}
