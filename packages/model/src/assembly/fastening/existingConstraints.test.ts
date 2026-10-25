import { expressionValueFromNumber as value } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { AssemblyDocument, Joint, Mate, MateTarget } from '../types.js';
import { existingConstraintRejections, type FasteningConstraintContext } from './existingConstraints.js';
import type { BoltedJointPlan } from './types.js';

function target(componentId: string, element: 'xy' | 'z' = 'xy'): MateTarget {
  return { kind: 'origin', componentId, element };
}
function fixture(): AssemblyDocument {
  let document = createAssemblyDocument('existing');
  for (const z of [0, 10, 20]) document = addComponent(document, createComponentFor(document,
    { kind: 'part', partRef: `p${String(z)}` }, { placement: { position: [value(0), value(0), value(z)], rotation: [0, 0, 0, 1] } }));
  return document;
}
function context(document: AssemblyDocument): FasteningConstraintContext {
  return { document, partRevisions: new Map(), partDocument: () => null, resolveFace: () => ({ status: 'missing' }) };
}
function mate(distance: number, second = 'component-1'): Mate {
  return { id: 'mate-1', name: 'distance', kind: 'distance', a: target('component-2'), b: target(second),
    value: value(distance), flipped: second === 'component-3', suppressed: false };
}
const PLAN: BoltedJointPlan = {
  configuration: 'throughBoltWithNut', headSideComponentId: 'component-1', farSideComponentId: 'component-2',
  nominal: 'M8', pitch: 1.25, threadSeries: 'coarse', gripLength: 20, boltLength: 40,
  engagedLength: null, penetration: null, protrusion: 13.2, lengthBasis: 'perDiameterEvidence', lengthVerified: true,
  missingFacts: [], sourceIdentities: {}, operations: [],
  alignment: { movedComponentIds: ['component-2'], delta: { position: [0, 0, -10], rotation: [0, 0, 0, 1] }, placementFingerprints: {} },
};

describe('締結の整列と既存拘束の両立', () => {
  it('distance10を接触0へ変える提案は拒否し、文書と元の拘束を変えない', () => {
    const document = { ...fixture(), mates: [mate(10)] };
    const before = JSON.stringify(document);
    expect(existingConstraintRejections(context(document), PLAN))
      .toEqual([{ code: 'existingConstraintConflict', detail: { constraintId: 'mate-1' } }]);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('接触0と適合する拘束は受理し、抑制した矛盾は除外する', () => {
    expect(existingConstraintRejections(context({ ...fixture(), mates: [mate(0)] }), PLAN)).toEqual([]);
    const alreadyContact = { ...fixture(), components: fixture().components.map((component) => component.id === 'component-2'
      ? { ...component, placement: { ...component.placement, position: [value(0), value(0), value(0)] as const } } : component), mates: [mate(0)] };
    const identity = { ...PLAN, alignment: { ...PLAN.alignment, movedComponentIds: [], delta: { position: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const } } };
    expect(existingConstraintRejections(context(alreadyContact), identity)).toEqual([]);
    expect(existingConstraintRejections(context({ ...fixture(), mates: [{ ...mate(10), suppressed: true }] }), PLAN)).toEqual([]);
  });
  it('外部部品との拘束も確認し、適合なら受理、不適合なら拒否する', () => {
    expect(existingConstraintRejections(context({ ...fixture(), mates: [mate(20, 'component-3')] }), PLAN)).toEqual([]);
    expect(existingConstraintRejections(context({ ...fixture(), mates: [mate(10, 'component-3')] }), PLAN))
      .toMatchObject([{ code: 'existingConstraintConflict' }]);
  });
  it('jointの残す自由度を制限せず、軸のずれだけを拒否する', () => {
    const joint: Joint = { id: 'joint-1', name: 'cylindrical', kind: 'cylindrical',
      a: target('component-1', 'z'), b: target('component-2', 'z'), minValue: null, maxValue: null, suppressed: false };
    const document = { ...fixture(), joints: [joint] };
    expect(existingConstraintRejections(context(document), PLAN)).toEqual([]);
    const sideways = { ...PLAN, alignment: { ...PLAN.alignment,
      delta: { position: [1, 0, -10] as const, rotation: [0, 0, 0, 1] as const } } };
    expect(existingConstraintRejections(context(document), sideways)).toMatchObject([{ code: 'existingConstraintConflict' }]);
  });
  it('現在の部分形状を解決できない拘束を保存指紋から承認しない', () => {
    const a: MateTarget = { kind: 'subShape', componentId: 'component-2', ref: { bodyFeatureId: 'body', index: 0,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } };
    expect(existingConstraintRejections(context({ ...fixture(), mates: [{ ...mate(0), a }] }), PLAN))
      .toMatchObject([{ code: 'existingConstraintUnresolved' }]);
  });
});
