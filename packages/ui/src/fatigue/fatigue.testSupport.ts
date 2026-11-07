import { createFatigueSession, editFatigueSession, type FatigueEdit, type FatigueSession } from './fatigueSession.js';

export const TEST_CURVE_SOURCE = 'Test constants only, not a material or code curve';
/** A complete draft entered as a user would: range curve, mean-independent, Sref 100 MPa at Nref 2e6, slope 3, no
 * cut-off, and one history applied once: 0 -> 200 -> 0 MPa. */
export const BASE_EDITS: readonly FatigueEdit[] = [
  { kind: 'stress-definition', value: 'range' }, { kind: 'mean-assumption', value: 'mean-independent' },
  { kind: 'value', field: 'referenceStress', source: '100' }, { kind: 'value', field: 'referenceCycles', source: '2000000' },
  { kind: 'value', field: 'slope', source: '3' }, { kind: 'cutoff-mode', value: 'none' },
  { kind: 'curve-source', field: 'reference', source: TEST_CURVE_SOURCE },
  { kind: 'curve-source', field: 'condition', source: 'unit test' },
  { kind: 'history-stress', index: 0, source: '0, 200, 0' }, { kind: 'history-sequence', index: 0, value: 'once' },
  { kind: 'history-source', index: 0, field: 'reference', source: 'hand-written test history' },
  { kind: 'history-source', index: 0, field: 'condition', source: 'unit test' },
];

export function edited(edits: readonly FatigueEdit[], ownerId = 'fatigue-owner'): FatigueSession {
  let session = createFatigueSession(ownerId);
  for (const edit of edits) session = editFatigueSession(session, edit);
  return session;
}
export function relative(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}
