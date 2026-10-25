import type { Vector3 } from './analysisModel.js';
import type { BeamBucklingInput, BucklingRestraints } from './bucklingModel.js';
import { modalFixture } from './modal.testSupport.js';

/** Slenderness chosen analytically before any runtime observation:
 * P_E/(kGA) < 7e-8 for both pinned branches, so 1e-4 Euler comparison
 * resolves mesh error without confusing finite-shear physics with Euler.
 */
export function bucklingFixture(options: {
  readonly pinned?: boolean; readonly segments?: number; readonly loadScale?: number;
  readonly stiffnessScale?: number; readonly lengthScale?: number;
  readonly millimetres?: boolean; readonly rotated?: boolean;
} = {}): BeamBucklingInput {
  const unit = options.millimetres ? 1000 : 1;
  const length = options.lengthScale ?? 1;
  const base = modalFixture({ free: true, modes: 2, segments: options.segments ?? 16,
    millimetres: options.millimetres, stiffnessScale: options.stiffnessScale });
  const force: Vector3 = options.rotated ? [0, -(options.loadScale ?? 1), 0] : [-(options.loadScale ?? 1), 0, 0];
  const localYHint: Vector3 = options.rotated ? [0, 0, 1] : [0, 1, 0];
  const start: BucklingRestraints = options.pinned
    ? options.rotated ? [true, true, true, false, true, false] : [true, true, true, true, false, false]
    : [true, true, true, true, true, true];
  const end: BucklingRestraints = options.rotated
    ? [true, false, true, false, false, false] : [false, true, true, false, false, false];
  return {
    schema: 'pointercad-beam-buckling/1',
    geometry: { ...base, nodes: [{ id: 'node-0', position: [0, 0, 0] },
      { id: 'node-1', position: options.rotated ? [0, length * unit, 0] : [length * unit, 0, 0] }],
    members: base.members.map(member => ({ ...member, localYHint })),
    sections: base.sections.map(section => ({ ...section, iy: 1e-12 * unit ** 4,
      iz: 2e-12 * unit ** 4, torsionConstant: 1.5e-12 * unit ** 4 })) },
    supports: [{ nodeId: 'node-0', restrained: start }, ...(options.pinned ? [{ nodeId: 'node-1', restrained: end }] : [])],
    referenceLoads: [{ id: 'reference', kind: 'nodal', nodeId: 'node-1', force, moment: [0, 0, 0] }],
  };
}

export function eulerReference(options: Parameters<typeof bucklingFixture>[0] = {}): readonly [number, number] {
  const base = Math.PI ** 2 * 210e9 * (options.stiffnessScale ?? 1) * 1e-12
    / ((options.lengthScale ?? 1) ** 2 * (options.loadScale ?? 1) * (options.pinned ? 1 : 4));
  return [base, base * 2];
}
