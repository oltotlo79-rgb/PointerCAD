import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import type { AssemblyDocument, PresentationStep } from './types.js';
import type { RigidPlacement } from './placementMath.js';
import type { ResolvedAssembly } from './resolveAssembly.js';
import * as presentation from './presentation.js';

function fixture(): { document: AssemblyDocument; resolved: ResolvedAssembly; placements: ReadonlyMap<string, RigidPlacement>; step: PresentationStep } {
  const step: PresentationStep = { id: 'step-1', name: '離す', start: 0, end: 1,
    body: { kind: 'explode', componentIds: ['a'], direction: { kind: 'world', axis: 'z' }, distance: expressionValueFromNumber(50) } };
  const document: AssemblyDocument = { ...createAssemblyDocument('motion'), components: ['a', 'b'].map((id) => ({ id, name: id,
    source: { kind: 'part', partRef: id }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false })), presentation: [step] };
  const placements = new Map<string, RigidPlacement>([['a', { position: [10, 20, 30], rotation: [0, 0, 0, 1] }], ['b', { position: [0, 0, 0], rotation: [0, 0, 0, 1] }]]);
  const resolved: ResolvedAssembly = { parts: new Map(), placements, partKeys: new Map(), errors: [] };
  return { document, resolved, placements, step };
}

describe('P7-21 presentation time and placements', () => {
  it.each([[0, 1 / 3, 0.5, 1], [1 / 3, 2 / 3, 0.5, 0.5], [2 / 3, 1, 0.5, 0], [0, 1, 0, 0], [0, 1, 1, 1], [0.25, 0.75, 0.5, 0.5]])('progress [%s,%s] at %s is %s', (start, end, t, expected) => {
    expect(presentation.stepProgress({ start, end }, t)).toBeCloseTo(expected, 15);
  });
  it.each([[0, 0], [1, 0], [-1, 1], [0, 2], [NaN, 1], [0, Infinity]])('refuses an invalid interval %s/%s', (start, end) => {
    expect(presentation.stepProgress({ start, end }, 0.5)).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, -0.1, 1.1])('refuses invalid normalized time %s', (t) => {
    expect(presentation.stepProgress({ start: 0, end: 1 }, t)).toBeNull();
  });
  it('canonicalizes signed zero progress', () => { expect(presentation.stepProgress({ start: -0, end: 1 }, -0)).toBe(0); });
  it.each([[0, 30], [0.5, 55], [1, 80]])('adds a 50mm step at t=%s', (t, expectedZ) => {
    const f = fixture(); const result = presentation.explodedPlacements(f.document, f.resolved, f.placements, t);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.placements.get('a')?.position).toEqual([10, 20, expectedZ]);
    expect(result.placements.get('a')?.rotation).toBe(f.placements.get('a')?.rotation);
    expect(result.placements.get('b')).toBe(f.placements.get('b'));
  });
  it('returns the original map at zero with frozen input and no accumulated offset', () => {
    const f = fixture(); Object.freeze(f.document); const before = structuredClone(f.placements);
    const first = presentation.explodedPlacements(f.document, f.resolved, f.placements, 1);
    const zero = presentation.explodedPlacements(f.document, f.resolved, f.placements, 0);
    expect(first.ok).toBe(true); expect(zero).toEqual({ ok: true, placements: f.placements });
    if (zero.ok) expect(zero.placements).toBe(f.placements);
    expect(f.placements).toEqual(before);
  });
  it('adds two overlapping steps in document order', () => {
    const f = fixture(); const doc = { ...f.document, presentation: [f.step, { ...f.step, id: 'step-2' }] };
    const result = presentation.explodedPlacements(doc, f.resolved, f.placements, 1);
    expect(result.ok).toBe(true); if (result.ok) expect(result.placements.get('a')?.position).toEqual([10, 20, 130]);
  });
  it('evaluates the saved expression source rather than a stale cached value', () => {
    const f = fixture(); if (f.step.body.kind !== 'explode') throw new Error('fixture');
    const step = { ...f.step, body: { ...f.step.body, distance: { ...expressionValueFromNumber(999), source: '5*3' } } };
    const result = presentation.explodedPlacements({ ...f.document, presentation: [step] }, f.resolved, f.placements, 1);
    expect(result.ok).toBe(true); if (result.ok) expect(result.placements.get('a')?.position[2]).toBe(45);
  });
  it('refuses a broken expression and preserves every placement atomically', () => {
    const f = fixture(); if (f.step.body.kind !== 'explode') throw new Error('fixture');
    const bad = { ...f.step, id: 'bad', body: { ...f.step.body, distance: { ...expressionValueFromNumber(1), source: 'missing*3' } } };
    expect(presentation.explodedPlacements({ ...f.document, presentation: [f.step, bad] }, f.resolved, f.placements, 1))
      .toEqual({ ok: false, reason: 'invalidExpression', stepId: 'bad' });
    expect(f.placements.get('a')?.position).toEqual([10, 20, 30]);
  });
  it('refuses missing component rather than silently applying a subset', () => {
    const f = fixture(); if (f.step.body.kind !== 'explode') throw new Error('fixture');
    const step = { ...f.step, body: { ...f.step.body, componentIds: ['a', 'gone'] } };
    expect(presentation.explodedPlacements({ ...f.document, presentation: [step] }, f.resolved, f.placements, 1))
      .toEqual({ ok: false, reason: 'missingComponent', stepId: 'step-1' });
  });
  it('adds a serial step, removes it, and preserves the source document', () => {
    const f = fixture();
    const added = presentation.addExplodeStep(f.document, {
      name: '横へ離す', start: 0.5, end: 1,
      body: { kind: 'explode', componentIds: ['b'], direction: { kind: 'world', axis: 'x' },
        distance: expressionValueFromNumber(25) },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.presentation.map((step) => step.id)).toEqual(['step-1', 'step-2']);
    expect(f.document.presentation).toEqual([f.step]);
    expect(presentation.removeStep(added.value, 'step-2')).toEqual(f.document);
    expect(presentation.removeStep(f.document, 'missing')).toBe(f.document);
  });
  it('reorders only an exact permutation of the saved step ids', () => {
    const f = fixture();
    const second = { ...f.step, id: 'step-2', name: '二番' };
    const document = { ...f.document, presentation: [f.step, second] };
    const reordered = presentation.reorderSteps(document, ['step-2', 'step-1']);
    expect(reordered.ok && reordered.value.presentation).toEqual([second, f.step]);
    expect(presentation.reorderSteps(document, ['step-1', 'step-1']))
      .toEqual({ ok: false, reason: 'invalidStep' });
  });
  it('interpolates a revolute joint step into one named drive request', () => {
    const f = fixture();
    const joint = { id: 'joint-1', name: '回転', kind: 'revolute' as const,
      a: { kind: 'origin' as const, componentId: 'a', element: 'z' as const },
      b: { kind: 'origin' as const, componentId: 'b', element: 'z' as const },
      minValue: null, maxValue: null, suppressed: false };
    const step: PresentationStep = { id: 'step-2', name: '回す', start: 0, end: 1,
      body: { kind: 'joint', jointId: joint.id, from: expressionValueFromNumber(350),
        to: expressionValueFromNumber(370), coordinate: 'angle', referenceAngle: 360 } };
    const requests = presentation.presentationJointRequests({ ...f.document, joints: [joint], presentation: [step] }, 0.5);
    expect(requests).toEqual({ ok: true, value: [{ jointId: 'joint-1', coordinate: 'angle',
      value: 360, referenceAngle: 360 }] });
  });
  it('requires a coordinate for cylindrical motion and rejects overlapping drivers', () => {
    const f = fixture();
    const joint = { id: 'joint-1', name: '円筒', kind: 'cylindrical' as const,
      a: { kind: 'origin' as const, componentId: 'a', element: 'z' as const },
      b: { kind: 'origin' as const, componentId: 'b', element: 'z' as const },
      minValue: null, maxValue: null, suppressed: false };
    const step: PresentationStep = { id: 'step-1', name: '動かす', start: 0, end: 0.75,
      body: { kind: 'joint', jointId: joint.id, from: expressionValueFromNumber(0),
        to: expressionValueFromNumber(10) } };
    expect(presentation.presentationJointRequests({ ...f.document, joints: [joint], presentation: [step] }, 0.5))
      .toEqual({ ok: false, reason: 'ambiguousCoordinate', stepId: 'step-1' });
    const angle = { ...step, body: { ...step.body, coordinate: 'angle' as const } };
    const overlap = { ...angle, id: 'step-2', start: 0.5, end: 1 };
    expect(presentation.presentationJointRequests({ ...f.document, joints: [joint],
      presentation: [angle, overlap] }, 0.5))
      .toEqual({ ok: false, reason: 'overlappingDriver', stepId: 'step-2' });
  });
});
