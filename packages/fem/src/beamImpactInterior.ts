import type { Vector3 } from './analysisModel.js';
import type { BeamImpactInput, BeamImpactSample } from './beamImpactModel.js';
import { translateBeamImpact } from './beamImpactTranslation.js';

/** Six section resultants on the +x face of a section, local axes of the element: N (tension positive), Vy, Vz in N;
 * T, My, Mz in N m as right-hand vectors on local x, y, z. */
export type SectionResultants = readonly [number, number, number, number, number, number];
/** One solver element (segment) of an original CAD member, with the native global 12 x 12 block T^T k T. */
export interface BeamImpactElement {
  readonly element: number;
  readonly memberId: string;
  /** 0-based segment index along the original member, start to end. */
  readonly segment: number;
  readonly solverNodes: readonly [number, number];
  readonly lengthM: number;
  readonly frame: { readonly x: Vector3; readonly y: Vector3; readonly z: Vector3 };
  readonly globalStiffness: readonly (readonly number[])[];
}
export interface BeamImpactMeshNode {
  readonly solverNode: number;
  readonly displacementM: Vector3;
  readonly rotationRad: Vector3;
}
/** Solver-owned mesh response of an impact reply: every mesh node at every emitted sample, and every element block. */
export interface BeamImpactInterior {
  readonly elements: readonly BeamImpactElement[];
  /** One row per emitted sample, each with every mesh node in plan order. */
  readonly mesh: readonly (readonly BeamImpactMeshNode[])[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
}
function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function vector(value: unknown): value is Vector3 {
  return dense(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item));
}
const fail = (message: string): never => { throw new Error(`impact-interior: ${message}`); };
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Rigid-body modes of a two-node element at its own positions: 3 translations and 3 small rotations about the start.
 * Any valid element stiffness maps them to zero force, so a block for other geometry or a corrupted block is refused. */
function rigidModes(a: Vector3, b: Vector3): number[][] {
  const modes: number[][] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const t: Vector3 = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    modes.push([...t, 0, 0, 0, ...t, 0, 0, 0]);
  }
  const arm: Vector3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  for (let axis = 0; axis < 3; axis += 1) {
    const w: Vector3 = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    modes.push([0, 0, 0, ...w, ...cross(w, arm), ...w]);
  }
  return modes;
}
function multiply(matrix: readonly (readonly number[])[], vector12: readonly number[]): number[] {
  return matrix.map(row => row.reduce((sum, value, index) => sum + value * vector12[index], 0));
}

/**
 * Strict decoder of the optional mesh fields of pointercad-oofem-impact-result/1 (beamImpact.py solve_impact_plan with
 * element_stiffness): raw.elements (one block per plan member, plan order) and raw.samples[i].mesh (every plan node,
 * plan order). Called by decodeBeamImpact only when both are present, after the original-node samples are decoded.
 * Checks counts, numbering, finiteness, symmetry, the rigid-body null space at the plan geometry, supports, rest at
 * t = 0 and exact equality of the original-node rows with the decoded `nodes`.
 */
export function decodeImpactInterior(rawElements: unknown, rawMesh: readonly unknown[], input: BeamImpactInput,
  samples: readonly BeamImpactSample[]): BeamImpactInterior {
  const { plan } = translateBeamImpact(input);
  const segments = input.geometry.modal?.segmentsPerMember ?? fail('missing refinement settings');
  if (!dense(rawElements) || rawElements.length !== plan.members.length) return fail('one element block per plan member');
  const elements = rawElements.map((raw, index): BeamImpactElement => {
    const member = plan.members[index];
    if (!record(raw) || !exactKeys(raw, ['number', 'nodes', 'globalStiffness']) || raw.number !== member.number
      || !dense(raw.nodes) || raw.nodes.length !== 2 || raw.nodes[0] !== member.nodes[0] || raw.nodes[1] !== member.nodes[1]) {
      return fail(`element ${index + 1} identity differs from the plan`);
    }
    const matrix = raw.globalStiffness;
    if (!dense(matrix) || matrix.length !== 12 || !matrix.every(row => dense(row) && row.length === 12
      && row.every(item => typeof item === 'number' && Number.isFinite(item)))) {
      return fail(`element ${member.number} block must be a finite 12 x 12 matrix`);
    }
    const block = matrix as number[][];
    const scale = Math.max(...block.map(row => Math.max(...row.map(Math.abs))));
    if (!(scale > 0) || block.some((row, i) => row.some((value, j) => Math.abs(value - block[j][i]) > 1e-9 * scale))) {
      return fail(`element ${member.number} block is zero or not symmetric`);
    }
    const a = plan.nodes[member.nodes[0] - 1].positionM, b = plan.nodes[member.nodes[1] - 1].positionM;
    for (const mode of rigidModes(a, b)) {
      const magnitude = Math.max(...mode.map(Math.abs));
      if (multiply(block, mode).some(force => Math.abs(force) > 1e-8 * scale * magnitude)) {
        fail(`element ${member.number} block does not belong to this element geometry`);
      }
    }
    const original = input.geometry.members[Math.floor(index / segments)];
    return { element: member.number, memberId: original.id, segment: index % segments,
      solverNodes: [member.nodes[0], member.nodes[1]], lengthM: member.frame.lengthM,
      frame: { x: member.frame.x, y: member.frame.y, z: member.frame.z }, globalStiffness: block };
  });
  if (rawMesh.length !== samples.length) fail('one mesh row per sample');
  const mesh = rawMesh.map((rows, sampleIndex): BeamImpactMeshNode[] => {
    if (!dense(rows) || rows.length !== plan.nodes.length) return fail('every mesh node in every sample');
    const sample = samples[sampleIndex];
    return rows.map((row, nodeIndex): BeamImpactMeshNode => {
      const node = plan.nodes[nodeIndex];
      if (!record(row) || !exactKeys(row, ['number', 'displacementM', 'rotationRad']) || row.number !== node.number
        || !vector(row.displacementM) || !vector(row.rotationRad)) return fail(`mesh node ${nodeIndex + 1} is malformed`);
      const state = [...row.displacementM, ...row.rotationRad];
      if (node.restrained.some((fixed, axis) => fixed && state[axis] !== 0)) fail('mesh response violates a support');
      if (sample.step === 0 && state.some(value => value !== 0)) fail('mesh response does not start at rest');
      if (nodeIndex < plan.originalNodeCount) {
        const decoded = sample.nodes[nodeIndex];
        if (decoded.solverNode !== node.number
          || [...decoded.displacementM, ...decoded.rotationRad].some((value, axis) => value !== state[axis])) {
          fail('mesh response differs from the original-node response');
        }
      }
      return { solverNode: node.number, displacementM: [row.displacementM[0], row.displacementM[1], row.displacementM[2]],
        rotationRad: [row.rotationRad[0], row.rotationRad[1], row.rotationRad[2]] };
    });
  });
  return { elements, mesh };
}

export interface ImpactElementEndForces {
  readonly element: number;
  readonly memberId: string;
  readonly segment: number;
  /** Per emitted sample: the resultants at the element start and end sections. */
  readonly start: readonly SectionResultants[];
  readonly end: readonly SectionResultants[];
}
/**
 * Elastic element end forces K_e u_e of the finite-element solution, from the solver's own element blocks and mesh
 * response: f = K_e [u_start, theta_start, u_end, theta_end] (global), rotated to the element frame per 3-block. The
 * section resultants on the +x face are -f at the start and +f at the end. These are the constitutive forces of each
 * element at the emitted samples only (values between samples are not represented); element inertia (M_e a), damping
 * (none) and distributed loads (none) are not included. No stress, yield or certification is derived.
 */
export function impactElementEndForces(interior: BeamImpactInterior): ImpactElementEndForces[] {
  const position = new Map(interior.mesh[0].map((node, index) => [node.solverNode, index]));
  return interior.elements.map(element => {
    const [a, b] = element.solverNodes.map(number => position.get(number) ?? fail('element node missing in the mesh'));
    const local = (f: readonly number[], offset: number): number[] => [element.frame.x, element.frame.y, element.frame.z]
      .map(axis => axis[0] * f[offset] + axis[1] * f[offset + 1] + axis[2] * f[offset + 2]);
    const start: SectionResultants[] = [], end: SectionResultants[] = [];
    for (const rows of interior.mesh) {
      const u = [...rows[a].displacementM, ...rows[a].rotationRad, ...rows[b].displacementM, ...rows[b].rotationRad];
      const f = multiply(element.globalStiffness, u);
      const values = [...local(f, 0), ...local(f, 3), ...local(f, 6), ...local(f, 9)];
      if (!values.every(Number.isFinite)) fail(`element ${element.element} end force is not finite`);
      start.push([-values[0], -values[1], -values[2], -values[3], -values[4], -values[5]]);
      end.push([values[6], values[7], values[8], values[9], values[10], values[11]]);
    }
    return { element: element.element, memberId: element.memberId, segment: element.segment, start, end };
  });
}
