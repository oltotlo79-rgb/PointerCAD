import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatiguePanel } from './FatiguePanel.js';
import { BASE_EDITS, GOODMAN_OPTION_SCOPE_FRAGMENT, relative, SINGLE_SLOPE_SCOPE_FRAGMENT } from './fatigue.testSupport.js';
import { currentFatigueResultWithPiecewise, fatigueEntryIsSavedWithPiecewise, type FatigueAnyEdit } from './fatiguePiecewiseSession.js';
import { savedFatigueEntry, type FatigueSession } from './fatigueSession.js';

// renderToStaticMarkup reads zustand's server snapshot, which is the store's INITIAL state (zustand 5 useStore passes
// selector(api.getInitialState()) as getServerSnapshot). Without this, the panel's own saved entry and parameters
// would be those of an empty document. Same established pattern as FatiguePanel.test.tsx: render the current store.
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/*
 * SYNTHETIC calibration (task180's analytically specified two-slope curve), not a steel standard, detail category or FAT
 * class: N = 1e5 (400/S)^3 down to 200 MPa, then N = 8e5 (200/S)^5 down to 1e8 cycles. Two fully reversed periodic
 * histories: range 250 twice and range 160 three times, so by hand D = 2/409600 + 3/2441406.25 (both slopes used).
 */
const MANUAL_DAMAGE = 2 / 409600 + 3 / 2441406.25;
const SOURCE = 'synthetic test calibration (not a standard)';
const segment = (index: number, field: 'fromStress' | 'fromCycles' | 'slope', source: string): FatigueAnyEdit =>
  ({ kind: 'piecewise', edit: { kind: 'segment-value', index, field, source } });
const PIECEWISE_EDITS: readonly FatigueAnyEdit[] = [
  { kind: 'stress-definition', value: 'range' }, { kind: 'mean-assumption', value: 'fully-reversed-only' },
  { kind: 'curve-source', field: 'reference', source: SOURCE }, { kind: 'curve-source', field: 'condition', source: 'unit test only' },
  { kind: 'input-mode', value: 'piecewise' },
  { kind: 'piecewise', edit: { kind: 'segment-add' } },
  segment(0, 'fromStress', '400'), segment(0, 'fromCycles', '100000'), segment(0, 'slope', '3'),
  segment(1, 'fromStress', '200'), segment(1, 'fromCycles', '800000'), segment(1, 'slope', '5'),
  { kind: 'piecewise', edit: { kind: 'end-cycles', source: '100000000' } },
  { kind: 'piecewise', edit: { kind: 'end', value: 'cutoff-at-end' } },
  { kind: 'piecewise', edit: { kind: 'applicability', field: 'material', source: 'synthetic' } },
  { kind: 'piecewise', edit: { kind: 'applicability', field: 'detail', source: 'synthetic' } },
  { kind: 'piecewise', edit: { kind: 'applicability', field: 'scope', source: 'unit test only' } },
  { kind: 'history-stress', index: 0, source: '125, -125' }, { kind: 'history-sequence', index: 0, value: 'repeated-periodic' },
  { kind: 'history-repeats', index: 0, source: '2' },
  { kind: 'history-source', index: 0, field: 'reference', source: 'hand-written test history' },
  { kind: 'history-source', index: 0, field: 'condition', source: 'unit test' },
  { kind: 'history-add' },
  { kind: 'history-stress', index: 1, source: '80, -80' }, { kind: 'history-sequence', index: 1, value: 'repeated-periodic' },
  { kind: 'history-repeats', index: 1, source: '3' },
  { kind: 'history-source', index: 1, field: 'reference', source: 'hand-written test history' },
  { kind: 'history-source', index: 1, field: 'condition', source: 'unit test' },
];

function session(): FatigueSession {
  const value = useAppStore.getState().fatigueSession;
  if (value === null) throw new Error('No fatigue session');
  return value;
}
function openAssemblyWithStrength(): void {
  const fixture = bucklingUiFixture();
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}
function enter(edits: readonly FatigueAnyEdit[]): void {
  for (const edit of edits) useAppStore.getState().editFatigue(edit);
}
function parameters(): Parameters<typeof currentFatigueResultWithPiecewise>[1] {
  const state = useAppStore.getState();
  return state.assembly?.parameters ?? state.document.parameters;
}
const html = (value: FatigueSession): string => renderToStaticMarkup(<FatiguePanel session={value} />);

describe('piecewise S-N fatigue through the store and the panel', () => {
  it('calculates the hand Miner sum over both slopes, shows the scope, and clears the result on any edit', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(PIECEWISE_EDITS);
    await useAppStore.getState().runFatigue();
    const result = currentFatigueResultWithPiecewise(session(), parameters());
    if (result === null) throw new Error(`Expected a result: ${session().errorKey ?? ''}`);
    expect(relative(result.damage, MANUAL_DAMAGE)).toBeLessThan(1e-12);
    expect(result.method).toBe('rainflow-three-point-stack/1+miner-linear-piecewise/1');
    const markup = html(session());
    expect(markup).toContain('data-testid="fatigue-piecewise-result"');
    expect(markup).toContain('data-testid="fatigue-piecewise"');
    expect(markup).not.toContain('data-testid="fatigue-correction"');
    // A relevant edit (a calibration row, a shared curve field or a history) discards the derived result.
    for (const edit of [segment(1, 'slope', '5.0'), { kind: 'curve-source', field: 'condition', source: 'other' },
      { kind: 'history-repeats', index: 1, source: '4' }] satisfies FatigueAnyEdit[]) {
      await useAppStore.getState().runFatigue();
      expect(currentFatigueResultWithPiecewise(session(), parameters())).not.toBeNull();
      useAppStore.getState().editFatigue(edit);
      expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
      expect(session().piecewiseAnalyzed).toBeNull();
    }
  });

  it('adds and removes rows and names the exact row or field of a refusal', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(PIECEWISE_EDITS);
    enter([{ kind: 'piecewise', edit: { kind: 'segment-add' } }]);
    expect(session().draft.piecewise?.segments.map(row => row.key)).toEqual(['segment-1', 'segment-2', 'segment-3']);
    expect(html(session())).toContain('data-fatigue-segment="2"');
    enter([{ kind: 'piecewise', edit: { kind: 'segment-remove', index: 2 } }]);
    expect(session().draft.piecewise?.segments).toHaveLength(2);
    enter([segment(1, 'fromStress', '210')]);
    await useAppStore.getState().runFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.piecewiseContinuity', 'piecewise:segment:1']);
    expect(html(session())).toContain('aria-invalid="true"');
    enter([segment(1, 'fromStress', '200'), segment(1, 'slope', '')]);
    await useAppStore.getState().runFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.field', 'piecewise:segment:1:slope']);
    enter([segment(1, 'slope', '5'), { kind: 'piecewise', edit: { kind: 'applicability', field: 'detail', source: ' ' } }]);
    await useAppStore.getState().runFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.piecewiseApplicability', 'piecewise:detail']);
    expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
  });

  it('saves version 5 through Undo, reopens the exact calibration in the panel, and keeps one fatigue configuration', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(PIECEWISE_EDITS);
    useAppStore.getState().saveFatigue();
    expect(session().errorKey).toBeNull();
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    const stored = savedFatigueEntry(assembly);
    // The former find looked only for 'fatigue' and 'fatigue-proportional-tensor' and returned null here.
    if (stored?.kind !== 'fatigue-piecewise') throw new Error('Expected the piecewise configuration');
    expect(stored.definition.schema).toBe('pointercad-fatigue-saved/5');
    expect(stored.definition.input.curve.segments).toEqual([{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 },
      { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }]);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:damage|cycles|life|analyzed|result)"/u);
    const fatigueKinds = (): string[] => (useAppStore.getState().assembly?.beamAnalysisInputs?.analyses ?? [])
      .map(input => input.kind).filter(kind => kind.startsWith('fatigue') && kind !== 'fatigue-strain-life' && kind !== 'fatigue-local-cycle');
    expect(fatigueKinds()).toEqual(['fatigue-piecewise']);
    useAppStore.getState().closeFatigue();
    expect(useAppStore.getState().fatigueSession).toBeNull();
    useAppStore.getState().openFatigue();
    expect(session().draft.inputMode).toBe('piecewise');
    expect(session().piecewiseAnalyzed ?? null).toBeNull();
    expect(session().draft.piecewise?.segments.map(row => [row.fromStress, row.fromCycles, row.slope]))
      .toEqual([['400', '100000', '3'], ['200', '800000', '5']]);
    expect(fatigueEntryIsSavedWithPiecewise(session(), parameters(), stored)).toBe(true);
    expect(html(session())).toContain('data-saved="true"');
    // An edit is changed-since-save in the panel; returning to the saved value is saved again (the same comparator).
    enter([segment(1, 'slope', '6')]);
    expect(html(session())).toContain('data-saved="false"');
    expect(html(session())).toContain(t('fatigue.changedSinceSave'));
    enter([segment(1, 'slope', '5')]);
    expect(html(session())).toContain('data-saved="true"');
    await useAppStore.getState().runFatigue();
    const again = currentFatigueResultWithPiecewise(session(), parameters());
    expect(again === null ? Number.NaN : relative(again.damage, MANUAL_DAMAGE)).toBeLessThan(1e-12);
    // Switching to the single-slope family and saving replaces the piecewise configuration: still exactly one.
    enter([{ kind: 'input-mode', value: 'stress' }, ...BASE_EDITS]);
    useAppStore.getState().saveFatigue();
    expect(session().errorKey).toBeNull();
    expect(fatigueKinds()).toEqual(['fatigue']);
    // Undo removes that save: the exact piecewise configuration is the persisted one again, and reopening shows it saved.
    useAppStore.getState().undo();
    const restored = savedFatigueEntry(useAppStore.getState().assembly ?? useAppStore.getState().document);
    expect(restored?.kind).toBe('fatigue-piecewise');
    expect(fatigueKinds()).toEqual(['fatigue-piecewise']);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(session().draft.inputMode).toBe('piecewise');
    expect(html(session())).toContain('data-saved="true"');
    expect(html(session())).toContain(t('fatigue.saved'));
  });

  it('shows mode-correct scope and curve text in the piecewise mode and restores the single-slope text', () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    expect(session().draft.inputMode).toBe('stress');
    const single = html(session());
    expect(single).toContain(t('fatigue.scope'));
    expect(single).toContain(t('fatigue.curveHelp'));
    expect(single).not.toContain(t('fatigue.scopePiecewise'));
    enter(PIECEWISE_EDITS);
    expect(session().draft.inputMode).toBe('piecewise');
    const piecewise = html(session());
    expect(piecewise).toContain(t('fatigue.scopePiecewise'));
    expect(piecewise).toContain(t('fatigue.curveHelpPiecewise'));
    expect(piecewise).toContain(t('fatigue.piecewise.help'));
    // The user's multi-slope calibration is never described as a single-slope curve or offered a Goodman correction.
    expect(piecewise).not.toContain(t('fatigue.scope'));
    expect(piecewise).not.toContain(t('fatigue.curveHelp'));
    expect(piecewise).not.toContain(SINGLE_SLOPE_SCOPE_FRAGMENT);
    expect(piecewise).not.toContain(GOODMAN_OPTION_SCOPE_FRAGMENT);
    expect(piecewise).not.toContain('data-testid="fatigue-correction"');
    // Switching back through the store's own edit restores the original single-slope text and the correction choice.
    enter([{ kind: 'input-mode', value: 'stress' }]);
    expect(session().draft.inputMode).toBe('stress');
    const back = html(session());
    expect(back).toContain(t('fatigue.scope'));
    expect(back).toContain(t('fatigue.curveHelp'));
    expect(back).not.toContain(t('fatigue.scopePiecewise'));
    expect(back).not.toContain(t('fatigue.curveHelpPiecewise'));
    expect(back).toContain('data-testid="fatigue-correction"');
  });

  it('shows no result for a foreign document, after closing, or before the current input is calculated', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(PIECEWISE_EDITS);
    const owner = session().ownerId;
    // A session that belongs to another document is not calculated (the existing owner guard).
    useAppStore.setState({ fatigueSession: { ...session(), ownerId: `${owner}-other` } });
    await useAppStore.getState().runFatigue();
    expect(session().piecewiseAnalyzed ?? null).toBeNull();
    expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
    useAppStore.setState({ fatigueSession: { ...session(), ownerId: owner } });
    await useAppStore.getState().runFatigue();
    expect(currentFatigueResultWithPiecewise(session(), parameters())).not.toBeNull();
    // Closing discards the result; reopening never restores one (results are derived only).
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
    expect(html(session())).not.toContain('data-testid="fatigue-results"');
  });
});
