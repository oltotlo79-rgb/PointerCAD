import { describe, expect, it } from 'vitest';
import { contactPivotLimit, contactPlanContacts, decodeContactNumericResult, validateBeamContacts,
  type BeamContactDefinition, type ContactResultExpectation } from './contactModel.js';

type V = readonly [number, number, number];
const positions = new Map<string, V>([['n1', [1, 0, 0]], ['n2', [2, 0, 0]], ['n3', [3, 0, 0]], ['c1', [2, 0, 0]]]);
const plane = (id: string, nodeId: string, normal: V, gapM: number): BeamContactDefinition =>
  ({ kind: 'node-plane', id, nodeId, normal, gapM });
const pair = (id: string, nodeIdA: string, nodeIdB: string, normal: V, gapM: number): BeamContactDefinition =>
  ({ kind: 'node-pair', id, nodeIdA, nodeIdB, normal, gapM });

describe('contact input validation (same refusals and order as beamContact.validate_contacts)', () => {
  it('normalizes normals and keeps everything else', () => {
    const outcome = validateBeamContacts([plane('floor', 'n2', [0, 0, 2], 1e-3), pair('gap', 'n2', 'n3', [3, 4, 0], 0)],
      [0.5, -1], positions);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.contacts[0]?.normal).toEqual([0, 0, 1]);
    expect(outcome.contacts[1]?.normal).toEqual([0.6, 0.8, 0]);
  });

  it('refuses each invalid case with its code and index', () => {
    const cases: readonly [readonly BeamContactDefinition[], readonly number[], string, number][] = [
      [[], [1], 'contact-count', -1],
      [[plane('', 'n2', [0, 0, 1], 0)], [1], 'contact-id', 0],
      [[plane('a', 'n2', [0, 0, Number.NaN], 0)], [1], 'contact-number', 0],
      [[plane('a', 'n2', [0, 0, 0], 0)], [1], 'contact-normal', 0],
      [[plane('a', 'n2', [0, 0, 1], -1e-6)], [1], 'contact-gap', 0],
      [[plane('a', 'missing', [0, 0, 1], 0)], [1], 'contact-node', 0],
      [[pair('a', 'n2', 'n2', [1, 0, 0], 0)], [1], 'contact-self', 0],
      // F1: n1 -> n2 points +x; a reversed or perpendicular normal is refused.
      [[pair('tie', 'n1', 'n2', [-1, 0, 0], 0.01)], [1], 'contact-orientation', 0],
      [[pair('tie', 'n1', 'n2', [0, 1, 0], 0.01)], [1], 'contact-orientation', 0],
      [[pair('a', 'n2', 'n3', [1, 0, 0], 0), pair('b', 'n3', 'n2', [-2, 0, 0], 1e-3)], [1], 'contact-duplicate', 1],
      [[plane('a', 'n2', [0, 0, 1], 0), plane('b', 'n2', [0, 0, 5], 4e-3)], [1], 'contact-duplicate', 1],
      // F3: opposing stops at one node.
      [[plane('below', 'n2', [0, 0, 1], 0.01), plane('above', 'n2', [0, 0, -1], 0.01)], [1], 'contact-two-sided', 1],
      [[plane('a', 'n2', [0, 0, 1], 0)], [], 'contact-factors', -1],
      [[plane('a', 'n2', [0, 0, 1], 0)], [1, Number.POSITIVE_INFINITY], 'contact-factors', 1],
    ];
    for (const [contacts, factors, code, index] of cases) {
      expect(validateBeamContacts(contacts, factors, positions)).toEqual({ ok: false, code, index });
    }
  });

  it('uses the declared orientation for coincident pair nodes', () => {
    expect(validateBeamContacts([pair('tie', 'n2', 'c1', [-1, 0, 0], 0.01)], [1], positions).ok).toBe(true);
  });

  it('maps CAD nodes to solver nodes or reports a translation defect', () => {
    const outcome = validateBeamContacts([pair('gap', 'n2', 'n3', [1, 0, 0], 2e-3)], [1], positions);
    if (!outcome.ok) throw new Error(outcome.code);
    expect(contactPlanContacts(outcome.contacts, new Map([['n2', 2], ['n3', 3]])))
      .toEqual([{ id: 'gap', kind: 'node-pair', nodeA: 2, nodeB: 3, normal: [1, 0, 0], gapM: 2e-3 }]);
    expect(contactPlanContacts(outcome.contacts, new Map([['n2', 2]]))).toBeNull();
  });
});

/** [0, <hole>, 0]: length 3, index 1 absent. */
function sparseVector(): number[] {
  const vector = new Array<number>(3);
  vector[0] = 0;
  vector[2] = 0;
  return vector;
}

describe('contact result decoder (identities and counts from the request, residuals recomputed)', () => {
  const expected: ContactResultExpectation = {
    contacts: [{ id: 'floor', kind: 'node-plane', node: 2, normal: [0, 0, 1], gapM: 1e-3 }], loadFactors: [1],
    nodeNumbers: [1, 2], meshNodes: 2, meshElements: 1, momentLengthM: 1 };
  const closed = { id: 'floor', state: 'closed', normalReactionN: 300, gapM: 0 };
  const nodes = [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
    { number: 2, displacementM: [0, 0, -1e-3], rotationRad: [0, 0, 0] }];
  const state = (contact: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    loadFactor: 1, pivots: 1, nodes, contacts: [contact], forceScaleN: 500, gapScaleM: 2.5e-3,
    equilibriumResidual: 1e-15, penetration: 0, tension: 0, complementarity: 0, ...overrides });
  const result = (states: readonly unknown[], overrides: Record<string, unknown> = {}) => ({
    schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness', freeDofs: 6,
    meshNodes: 2, meshElements: 1, momentLengthM: 1, pivotLimit: contactPivotLimit(1), states, ...overrides });

  it('decodes a valid closed state and recomputes the measures', () => {
    const decoded = decodeContactNumericResult(result([state(closed)]), expected);
    expect(decoded?.states[0]?.contacts[0]).toEqual(closed);
    expect(decoded?.states[0]?.complementarity).toBe(0);
  });

  it('refuses malformed, mismatched, sparse or inconsistent results even when the reported residuals are 0', () => {
    const bad: readonly unknown[] = [
      null,
      { ...result([state(closed)]), extra: 1 },
      result([state(closed)], { freeDofs: -1 }),
      result([state(closed)], { freeDofs: 13 }),
      result([state(closed)], { meshNodes: 3 }),
      result([state(closed)], { meshElements: -1 }),
      result([state(closed)], { pivotLimit: 999 }),
      result([state(closed)], { momentLengthM: 2 }),
      result([]),
      result([state(closed, { loadFactor: 2 })]),
      result([state(closed, { pivots: -1 })]),
      result([state(closed, { pivots: contactPivotLimit(1) + 1 })]),
      result([state(closed, { gapScaleM: 0 })]),
      result([state(closed, { forceScaleN: 0 })]),
      // Negative closed reaction (pulling) beyond 1e-9 F, with every reported residual 0.
      result([state({ ...closed, normalReactionN: -1 })]),
      // Penetration beyond 1e-9 L reported as closed (gap not zero) and as open.
      result([state({ ...closed, gapM: -1e-6 })]),
      result([state({ ...closed, state: 'open', normalReactionN: 0, gapM: -1e-6 })]),
      // Open contact carrying force (adhesion), closed contact with an open gap.
      result([state({ ...closed, state: 'open', normalReactionN: 1e-3 })]),
      result([state({ ...closed, gapM: 1e-3 })]),
      result([state({ ...closed, id: 'other' })]),
      result([state({ ...closed, state: 'stuck' })]),
      result([state({ ...closed, normalReactionN: Number.POSITIVE_INFINITY })]),
      // Wrong, duplicate, missing or sparse node identities.
      result([state(closed, { nodes: [nodes[0], { ...nodes[1], number: 3 }] })]),
      result([state(closed, { nodes: [nodes[1], nodes[1]] })]),
      result([state(closed, { nodes: [nodes[1]] })]),
      result([state(closed, { nodes: [nodes[0], { ...nodes[1], number: 2.5 }] })]),
      result([state(closed, { nodes: [nodes[0], { ...nodes[1], displacementM: [0, 0] }] })]),
      // Sparse vectors (length 3 with a hole), built without delete: every() skips the hole.
      result([state(closed, { nodes: [nodes[0], { ...nodes[1], displacementM: sparseVector() }] })]),
      result([state(closed, { nodes: [nodes[0], { ...nodes[1], rotationRad: sparseVector() }] })]),
      result([state(closed, { equilibriumResidual: 2e-9 })]),
      result([state(closed, { penetration: Number.NaN })]),
    ];
    for (const raw of bad) expect(decodeContactNumericResult(raw, expected)).toBeNull();
  });
});
