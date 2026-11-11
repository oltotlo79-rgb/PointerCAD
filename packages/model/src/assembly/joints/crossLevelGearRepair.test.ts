import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint } from '../types.js';
import { crossLevelGearTreeFailure, pruneCrossLevelGears, type CrossLevelGearCouplingDefinition } from './crossLevelGearDocument.js';

/*
 * Edits that break saved cross-level gears. Hand-written tree: the parent places the child assembly `child` twice
 * (A, B) and owns the revolutes `drive` and `spin`; the child owns the revolute `child-turn`. x1 couples drive to
 * A/child-turn, x2 couples spin to B/child-turn. Each case edits the parent or the child the way a user edit would and
 * states, from the tree, which gear must be kept, suspended (kept but inactive) or removed.
 */
const ZERO = expressionValueFromNumber(0);
const PART: ComponentSource = { kind: 'part', partRef: 'part-ref' };
const sub = (assemblyRef: string): ComponentSource => ({ kind: 'subAssembly', assemblyRef });
function component(id: string, source: ComponentSource = PART): AssemblyComponent {
  return { id, name: id, source, placement: { position: [ZERO, ZERO, ZERO], rotation: [0, 0, 0, 1] },
    fixed: false, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [component('base'), component('arm')],
  joints: [joint('child-turn', 'revolute', 'arm', 'base')] };
const assemblies = new Map([['child', child]]);
const x1: CrossLevelGearCouplingDefinition = { id: 'x1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A'],
  childJointId: 'child-turn', ratio: expression('-2', -2), phaseDeg: expression('0', 0), suppressed: false };
const x2: CrossLevelGearCouplingDefinition = { ...x1, id: 'x2', parentJointId: 'spin', childPath: ['B'] };
const parent: AssemblyDocument = { ...createAssemblyDocument('parent'),
  components: [component('ground'), component('A', sub('child')), component('B', sub('child'))],
  joints: [joint('drive', 'revolute', 'A', 'ground'), joint('spin', 'revolute', 'B', 'ground')],
  crossLevelGearCouplings: [x1, x2] };

describe('an edit keeps saved cross-level gears readable', () => {
  it('returns the same document when nothing is broken, and documents without gears untouched', () => {
    expect(pruneCrossLevelGears(parent, assemblies)).toEqual({ document: parent, repairs: [] });
    expect(pruneCrossLevelGears(parent, assemblies).document).toBe(parent);
    const legacy: AssemblyDocument = { ...createAssemblyDocument('legacy'), components: parent.components, joints: parent.joints };
    expect(pruneCrossLevelGears(legacy, assemblies).document).toBe(legacy);
  });

  it('removes only the gear whose placement was deleted and keeps the sibling placement gear', () => {
    const edited: AssemblyDocument = { ...parent, components: parent.components.filter(c => c.id !== 'B'),
      joints: parent.joints.filter(j => j.id !== 'spin') };
    const result = pruneCrossLevelGears(edited, assemblies);
    expect(result.repairs).toEqual([{ couplingId: 'x2', code: 'missing-parent-joint', action: 'removed' }]);
    expect(result.document.crossLevelGearCouplings).toEqual([x1]);
    expect(crossLevelGearTreeFailure(result.document, assemblies)).toBeNull();
    // The placement alone (joint kept) is the missing reference.
    const placementOnly = pruneCrossLevelGears({ ...parent, components: parent.components.filter(c => c.id !== 'B') }, assemblies);
    expect(placementOnly.repairs).toEqual([{ couplingId: 'x2', code: 'missing-component', action: 'removed' }]);
  });

  it('suspends a gear whose parent joint was suppressed, keeping its definition', () => {
    const edited: AssemblyDocument = { ...parent, joints: parent.joints.map(j => j.id === 'drive' ? { ...j, suppressed: true } : j) };
    const result = pruneCrossLevelGears(edited, assemblies);
    expect(result.repairs).toEqual([{ couplingId: 'x1', code: 'missing-parent-joint', action: 'suspended' }]);
    expect(result.document.crossLevelGearCouplings).toEqual([{ ...x1, suppressed: true }, x2]);
    expect(crossLevelGearTreeFailure(result.document, assemblies)).toBeNull();
  });

  it('removes gears whose joint changed kind or whose child joint left the subassembly, for both placements', () => {
    const slider = pruneCrossLevelGears({ ...parent, joints: parent.joints.map(j => j.id === 'drive' ? { ...j, kind: 'slider' as const } : j) },
      assemblies);
    expect(slider.repairs).toEqual([{ couplingId: 'x1', code: 'unsupported-parent-joint', action: 'removed' }]);
    // Editing the shared child removes its joint for A and B at once: both gears go, each reported.
    const emptied = new Map([['child', { ...child, joints: [] }]]);
    const result = pruneCrossLevelGears(parent, emptied);
    expect(result.repairs).toEqual([
      { couplingId: 'x1', code: 'missing-child-joint', action: 'removed' },
      { couplingId: 'x2', code: 'missing-child-joint', action: 'removed' },
    ]);
    expect(result.document.crossLevelGearCouplings).toEqual([]);
  });

  it('suspends a gear whose parent joined a same-level gear, and removes one whose expression broke', () => {
    const geared = pruneCrossLevelGears({ ...parent, mechanismCouplings: [{ id: 'same', kind: 'gear', jointAId: 'drive', jointBId: 'spin',
      ratio: expression('1', 1), phaseDeg: expression('0', 0), referenceAngleA: 0, suppressed: false }] }, assemblies);
    expect(geared.repairs).toEqual([
      { couplingId: 'x1', code: 'coupled-parent-joint', action: 'suspended' },
      { couplingId: 'x2', code: 'coupled-parent-joint', action: 'suspended' },
    ]);
    const broken = pruneCrossLevelGears({ ...parent, crossLevelGearCouplings: [{ ...x1, ratio: expression('removedParameter', -2) }, x2] },
      assemblies);
    expect(broken.repairs).toEqual([{ couplingId: 'x1', code: 'invalid-expression', action: 'removed' }]);
    expect(broken.document.crossLevelGearCouplings).toEqual([x2]);
  });
});
