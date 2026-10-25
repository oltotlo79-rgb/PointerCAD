import { decodeContactNumericResult, type BeamContactInput, type BeamContactResult } from './contactModel.js';
import { translateBeamContact } from './contactTranslation.js';

/** The bound contact result; nodeIds[i] is the CAD node of states[k].nodes[i] (original nodes in plan order). */
export interface BeamContactAnalysisResult extends BeamContactResult {
  readonly nodeIds: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Worker JSON -> bound result. Identities, counts and factors come from the plan; the numeric decoder recomputes
 * penetration, tension and complementarity; supported (restrained) components must be exactly zero. */
export function decodeBeamContact(raw: unknown, input: BeamContactInput, inputSha256: string): BeamContactAnalysisResult {
  const { plan, momentLengthM, nodeIds } = translateBeamContact(input);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const numeric = /^[0-9a-f]{64}$/u.test(inputSha256) ? decodeContactNumericResult(raw, { contacts: plan.contacts,
    loadFactors: plan.loadFactors, nodeNumbers: original.map(node => node.number), meshNodes: plan.nodes.length,
    meshElements: plan.members.length, momentLengthM }) : null;
  if (numeric === null) throw new Error('Invalid contact result, identity, count or complementarity');
  for (const state of numeric.states) {
    for (const [index, node] of state.nodes.entries()) {
      const components = [...node.displacementM, ...node.rotationRad];
      if (original[index].restrained.some((fixed, axis) => fixed && components[axis] !== 0)) {
        throw new Error('Contact response violates a prescribed support');
      }
    }
  }
  return { ...numeric, kind: 'oofem-beam-contact-3d', nativeContactSolver: false,
    scope: 'frictionless-unilateral-node-plane-node-pair-small-displacement-static',
    analysisId: input.geometry.id, analysisRevision: input.geometry.revision, source: input.geometry.source,
    inputSha256, structuralCertification: false, nodeIds: [...nodeIds] };
}

export function isBeamContactResult(value: unknown): value is BeamContactAnalysisResult {
  return record(value) && value.kind === 'oofem-beam-contact-3d' && value.nativeContactSolver === false
    && value.structuralCertification === false && value.schema === 'pointercad-oofem-contact-result/1'
    && value.method === 'murty-least-index-lcp-on-native-beam3d-stiffness'
    && value.scope === 'frictionless-unilateral-node-plane-node-pair-small-displacement-static'
    && typeof value.analysisId === 'string' && typeof value.analysisRevision === 'number'
    && Number.isSafeInteger(value.analysisRevision) && value.analysisRevision >= 0
    && record(value.source) && typeof value.source.documentId === 'string'
    && typeof value.inputSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.inputSha256)
    && dense(value.nodeIds) && value.nodeIds.every((id: unknown) => typeof id === 'string')
    && dense(value.states) && value.states.length >= 1 && value.states.length <= 32;
}
/** Holes are refused: every() skips them (same rule as denseArray in transientResults.ts). */
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
}

/** Compare the complete result, ignoring only property insertion order (same rule as transientResults.ts). */
function sameResultStructure(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length
      || Reflect.ownKeys(value).length !== value.length + 1 || Reflect.ownKeys(expected).length !== expected.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !Object.hasOwn(expected, index)
        || !sameResultStructure(value[index], expected[index])) return false;
    }
    return true;
  }
  if (record(value) && record(expected)) {
    const keys = Reflect.ownKeys(value);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key) && sameResultStructure(value[key], expected[key]));
  }
  return value === expected;
}

/** True only for a result decoded from exactly this input and digest; stale or foreign results are rejected. */
export function contactResultMatches(value: unknown, input: BeamContactInput, hash: string): value is BeamContactAnalysisResult {
  if (!isBeamContactResult(value)) return false;
  try {
    const decoded = decodeBeamContact({ schema: value.schema, method: value.method, freeDofs: value.freeDofs,
      meshNodes: value.meshNodes, meshElements: value.meshElements, momentLengthM: value.momentLengthM,
      pivotLimit: value.pivotLimit, states: value.states }, input, hash);
    return sameResultStructure(value, decoded);
  } catch { return false; }
}
