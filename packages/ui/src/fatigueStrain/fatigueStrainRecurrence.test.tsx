import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatigueStrainPanel, fatigueStrainHasOnceHistory } from './FatigueStrainPanel.js';
import { createFatigueStrainSession, currentFatigueStrainResult, editFatigueStrainSession, runFatigueStrainSession,
  type FatigueStrainEdit, type FatigueStrainSession } from './fatigueStrainSession.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/* Manufactured, test-only coefficients typed as a user would (not a material value): b = c = -0.5, sigma_f' = 1000 MPa,
 * E = 200000 MPa, eps_f' = 0.995, so at zero mean stress a cycle of strain amplitude a lives N = 1 / (2 a ** 2) cycles
 * and damages 2 a ** 2 per full cycle, a ** 2 per half cycle (u = 2 ** -8, exact in binary). A one-time record recurs
 * only after its strain has returned to its first value, so its repeated applications are counted closed-loop; the
 * expected lives below are counted by hand from that rule, never read back from the solver. UI text is looked up through the public message API; physical expected lives
 * below remain independently hand-derived. */
const u = 2 ** -8;
const LIFE_BASIS = t('fatigueStrain.lifeBasis');
const RECURRENCE_CLOSURE = t('fatigueStrain.error.recurrenceClosure');
const material = (field: Extract<FatigueStrainEdit, { kind: 'material' }>['field'], value: string): FatigueStrainEdit =>
  ({ kind: 'material', field, value });
const history = (field: Extract<FatigueStrainEdit, { kind: 'history' }>['field'], value: string): FatigueStrainEdit =>
  ({ kind: 'history', index: 0, field, value });
const MATERIAL: readonly FatigueStrainEdit[] = [
  material('materialId', 'manufactured'), material('elasticModulusMpa', '200000'),
  material('fatigueStrengthCoefficientMpa', '1000'), material('fatigueStrengthExponent', '-0.5'),
  material('fatigueDuctilityCoefficient', '0.995'), material('fatigueDuctilityExponent', '-0.5'),
  material('minimumCycles', '1'), material('maximumCycles', '1000000'),
  material('materialReference', 'Test-only manufactured coefficients; not a material value'),
  material('materialCondition', 'Hand-derived example'),
  history('id', 'h1'), history('reference', 'Test-only history'), history('condition', 'Hand-derived example'),
];
const strainOnly = (strain: string, sequence: 'once' | 'repeated-periodic'): readonly FatigueStrainEdit[] => [...MATERIAL,
  { kind: 'historyDerivation', index: 0, value: 'measured' }, history('strain', strain),
  { kind: 'historySequence', index: 0, value: sequence }, history('repeats', '1'), { kind: 'zeroMeanStress', confirmed: true }];
const paired = (samples: string): readonly FatigueStrainEdit[] => [...MATERIAL, { kind: 'historyKind', value: 'paired-stress' },
  { kind: 'historyDerivation', index: 0, value: 'elastic-plastic-analysis' }, history('samples', samples),
  { kind: 'historySequence', index: 0, value: 'once' }, history('repeats', '1')];
const edited = (edits: readonly FatigueStrainEdit[]): FatigueStrainSession =>
  edits.reduce(editFatigueStrainSession, createFatigueStrainSession(useAppStore.getState().activeDocumentId));
const near = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(1e-9 * expected);
};
function render(session: FatigueStrainSession): string {
  useAppStore.setState({ fatigueStrainSession: session });
  return renderToStaticMarkup(<FatigueStrainPanel session={session} />);
}

describe('single-pass damage versus the life of repeated applications', () => {
  it('a one-time 0 -> 2u record: half a cycle per pass (D = u^2), one full cycle per recurrence (32768), with the note', () => {
    const run = runFatigueStrainSession(edited(strainOnly(`0 ${2 * u}`, 'once')), 'owner');
    const result = currentFatigueStrainResult(run);
    expect(run.refusal).toBeNull();
    near(result?.damage, u ** 2);
    // Not 1 / D = 65536: each recurrence adds a full cycle of amplitude u, 2 u^2 of damage.
    near(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : undefined, 32768);
    const html = render(run);
    expect(html).toContain('data-testid="fatigue-strain-life-basis"');
    expect(html).toContain(LIFE_BASIS);
  });

  it('a periodic record keeps life = 1 / D and shows no note', () => {
    const run = runFatigueStrainSession(edited(strainOnly(`${-2 * u} ${2 * u}`, 'repeated-periodic')), 'owner');
    const result = currentFatigueStrainResult(run);
    // One closed cycle of amplitude 2u per period: D = 8 u^2, life 8192.
    near(result?.damage, 8 * u ** 2);
    near(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : undefined, 8192);
    expect(result === null ? null : fatigueStrainHasOnceHistory(result)).toBe(false);
    const html = render(run);
    expect(html).not.toContain('data-testid="fatigue-strain-life-basis"');
    expect(html).not.toContain(LIFE_BASIS);
  });
});

describe('paired one-time record that ends on its first strain', () => {
  it('refuses a wrapped reversal with two stresses, with the precise message, the last-sample path and the typed samples kept', () => {
    // -2u, 2u, -2u: on recurrence the last -2u joins the first, a reversal of every recurring cycle; -300 and -290 MPa.
    const samples = `0 ${-2 * u} -300\n1 ${2 * u} 300\n2 ${-2 * u} -290`;
    const draft = edited(paired(samples));
    const run = runFatigueStrainSession(draft, 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key: 'fatigueStrain.error.recurrenceClosure',
      code: 'strain-stress-history-recurrence-closure', path: 'histories[0].samples[2].stressMpa' }]);
    expect(run.draft).toBe(draft.draft);
    expect(run.draft.histories[0]?.samples).toBe(samples);
    const html = render(run);
    expect(html).toContain(RECURRENCE_CLOSURE);
    expect(html).toContain('histories[0].samples[2].stressMpa');
    expect(html).toMatch(/aria-invalid="true"[^>]*data-fatigue-strain-field="histories\[0\]\.samples"|data-fatigue-strain-field="histories\[0\]\.samples"[^>]*aria-invalid="true"/u);
    expect(html).not.toContain('data-testid="fatigue-strain-result"');
  });

  it('accepts the same stress at the wrap: one full cycle of amplitude 2u at mean 0 per recurrence (8192)', () => {
    const run = runFatigueStrainSession(edited(paired(`0 ${-2 * u} -300\n1 ${2 * u} 300\n2 ${-2 * u} -300`)), 'owner');
    expect(run.refusal).toBeNull();
    const result = currentFatigueStrainResult(run);
    near(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : undefined, 8192);
    expect(render(run)).toContain(LIFE_BASIS);
  });

  it('accepts other end stresses when the wrapped point is not a reversal (0 lies between the valley and the peak)', () => {
    // 0, 2u, -2u, 0 with 10 and 20 MPa at the ends: closed loop 2u, -2u, 2u, so the end stresses are never used and one
    // full cycle of amplitude 2u at mean (300 - 300) / 2 = 0 recurs: life 8192.
    const run = runFatigueStrainSession(edited(paired(`0 0 10\n1 ${2 * u} 300\n2 ${-2 * u} -300\n3 0 20`)), 'owner');
    expect(run.refusal).toBeNull();
    const result = currentFatigueStrainResult(run);
    near(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : undefined, 8192);
  });
});
