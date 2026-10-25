import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint } from '../types.js';
import {
  crossLevelGearDocumentFailure, crossLevelGearTreeFailure, evaluateCrossLevelGearCouplings,
  type CrossLevelGearCouplingDefinition,
} from './crossLevelGearDocument.js';

/*
 * Saved cross-level gear definitions, checked without solving. Hand-written tree: the parent places the middle
 * assembly `mid` twice (A, B) and has a fixed part `ground`; mid has the part `mid-base` and the leaf assembly `leaf`
 * placed as M; leaf has the revolute `child-turn` and the slider `child-slide`. The parent has the revolute `drive` and
 * the slider `lift`. Every expected code below is written from this tree, not read from the implementation.
 */
const PART: ComponentSource = { kind: 'part', partRef: 'part-ref' };
const ZERO = expressionValueFromNumber(0);
function component(id: string, source: ComponentSource = PART): AssemblyComponent {
  return { id, name: id, source, placement: { position: [ZERO, ZERO, ZERO], rotation: [0, 0, 0, 1] },
    fixed: false, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false };
}
function expression(source: string, value: number): ExpressionValue {
  return { ...expressionValueFromNumber(value), source };
}
const sub = (assemblyRef: string): ComponentSource => ({ kind: 'subAssembly', assemblyRef });

const leaf: AssemblyDocument = { ...createAssemblyDocument('leaf'), components: [component('base'), component('arm')],
  joints: [joint('child-turn', 'revolute', 'arm', 'base'), joint('child-slide', 'slider', 'arm', 'base')] };
const mid: AssemblyDocument = { ...createAssemblyDocument('mid'), components: [component('mid-base'), component('M', sub('leaf'))] };
const assemblies = new Map([['leaf', leaf], ['mid', mid]]);

function gear(overrides: Partial<CrossLevelGearCouplingDefinition> = {}): CrossLevelGearCouplingDefinition {
  return { id: 'xg-1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A', 'M'], childJointId: 'child-turn',
    ratio: expression('-2', -2), phaseDeg: expression('0', 0), suppressed: false, ...overrides };
}
function parent(couplings?: readonly CrossLevelGearCouplingDefinition[], extra: Partial<AssemblyDocument> = {}): AssemblyDocument {
  return { ...createAssemblyDocument('parent'),
    components: [component('ground'), component('A', sub('mid')), component('B', sub('mid'))],
    joints: [joint('drive', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'B', 'ground')],
    ...(couplings === undefined ? {} : { crossLevelGearCouplings: couplings }), ...extra };
}
const local = (document: AssemblyDocument) => crossLevelGearDocumentFailure(document)?.code;
const tree = (document: AssemblyDocument, map: ReadonlyMap<string, AssemblyDocument> = assemblies) =>
  crossLevelGearTreeFailure(document, map)?.code;

describe('saved cross-level gear definitions', () => {
  it('accepts legacy documents and repeated placements of one child as separate occurrences', () => {
    expect([local(parent()), tree(parent())]).toEqual([undefined, undefined]);
    expect(evaluateCrossLevelGearCouplings(parent())).toEqual({ ok: true, couplings: [] });
    const document = parent([gear(), gear({ id: 'xg-2', childPath: ['B', 'M'], ratio: expression('ratioB', 0.5), phaseDeg: expression('15', 15) })],
      { parameters: [{ name: 'ratioB', value: expression('0.5', 0.5), unit: 'none', description: '' }] });
    expect([local(document), tree(document)]).toEqual([undefined, undefined]);
    // Expressions are evaluated from their sources (the cached numbers above match, so this is the value 0.5).
    expect(evaluateCrossLevelGearCouplings(document)).toEqual({ ok: true, couplings: [
      { id: 'xg-1', parentJointId: 'drive', child: { path: ['A', 'M'], jointId: 'child-turn' }, ratio: -2, phaseDeg: 0 },
      { id: 'xg-2', parentJointId: 'drive', child: { path: ['B', 'M'], jointId: 'child-turn' }, ratio: 0.5, phaseDeg: 15 },
    ] });
  });

  it('refuses what one document can tell is wrong', () => {
    const sameLevel = { mechanismCouplings: [{ id: 'xg-1', kind: 'gear' as const, jointAId: 'drive', jointBId: 'other',
      ratio: expression('1', 1), phaseDeg: expression('0', 0), referenceAngleA: 0, suppressed: false }] };
    const cases: readonly [AssemblyDocument, string][] = [
      [parent([gear({ id: '' })]), 'invalid-id'],
      [parent([gear()], sameLevel), 'invalid-id'],
      [parent([gear(), gear()]), 'duplicate-coupling'],
      [parent([gear({ ratio: expression('missingName', 2) })]), 'invalid-expression'],
      [parent([gear({ ratio: expression('0', 0) })]), 'invalid-ratio'],
      [parent([gear({ phaseDeg: expression('missingPhase', 0) })]), 'invalid-expression'],
      [parent([gear({ parentJointId: 'none' })]), 'missing-parent-joint'],
      [parent([gear({ parentJointId: 'lift' })]), 'unsupported-parent-joint'],
      [parent([gear({ childPath: [] })]), 'invalid-path'],
      [parent([gear({ childPath: ['A', ''] })]), 'invalid-path'],
      [parent([gear({ childPath: ['X', 'M'] })]), 'missing-component'],
      [parent([gear({ childPath: ['ground'] })]), 'not-subassembly'],
      [parent([gear({ childJointId: '' })]), 'missing-child-joint'],
      [parent([gear(), gear({ id: 'xg-2', childJointId: 'child-turn' })]), 'duplicate-occurrence'],
      [parent([gear({ id: 'xg-2' })], { ...sameLevel, mechanismCouplings: sameLevel.mechanismCouplings.map(c => ({ ...c, id: 'same' })) }),
        'coupled-parent-joint'],
      [parent([gear()], { joints: [{ ...joint('drive', 'revolute', 'A', 'ground'), suppressed: true }] }), 'missing-parent-joint'],
    ];
    for (const [document, code] of cases) expect(local(document)).toBe(code);
  });

  it('keeps suppressed definitions out of the active graph but still checks their references', () => {
    expect(local(parent([gear(), gear({ id: 'xg-2', suppressed: true })]))).toBeUndefined();
    expect(local(parent([gear({ suppressed: true, parentJointId: 'none' })]))).toBe('missing-parent-joint');
    expect(evaluateCrossLevelGearCouplings(parent([gear({ suppressed: true })]))).toEqual({ ok: true, couplings: [] });
  });

  it('refuses paths and child joints that the embedded subassemblies do not have', () => {
    const cyclicLeaf: AssemblyDocument = { ...leaf, components: [...leaf.components, component('C', sub('mid'))] };
    const cases: readonly [AssemblyDocument, ReadonlyMap<string, AssemblyDocument>, string][] = [
      [parent([gear({ childPath: ['A', 'X'] })]), assemblies, 'missing-component'],
      [parent([gear({ childPath: ['A', 'mid-base'] })]), assemblies, 'not-subassembly'],
      [parent([gear()]), new Map([['mid', mid]]), 'missing-subassembly'],
      [parent([gear({ childJointId: 'none' })]), assemblies, 'missing-child-joint'],
      [parent([gear({ childJointId: 'child-slide' })]), assemblies, 'unsupported-child-joint'],
      [parent([gear({ childPath: ['A', 'M', 'C'] })]), new Map([['leaf', cyclicLeaf], ['mid', mid]]), 'cyclic-path'],
    ];
    for (const [document, map, code] of cases) expect(tree(document, map)).toBe(code);
    // The one-level occurrence (A itself) owns no child-turn: mid has no joints.
    expect(tree(parent([gear({ childPath: ['A'] })]))).toBe('missing-child-joint');
  });
});
