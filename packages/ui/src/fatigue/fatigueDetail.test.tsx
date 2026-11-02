import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { beamDisplayNumber } from '../beam/BeamResults.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatiguePanel } from './FatiguePanel.js';
import { BASE_EDITS, BASE_DAMAGE, relative } from './fatigue.testSupport.js';
import { currentDetailResult } from './fatigueDetailSession.js';
import { currentFatigueResultWithPiecewise, fatigueEntryIsSavedWithPiecewise, type FatigueAnyEdit } from './fatiguePiecewiseSession.js';
import { savedFatigueEntry, type FatigueSession } from './fatigueSession.js';

// Same established pattern as fatiguePiecewise.test.tsx: render the current store (not zustand's server snapshot).
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/*
 * TEST calibrations copied from DNV-RP-C203 (2005, amended 2006) Table 2-1 (air; m = 3 to 1e7 cycles, then m = 5), not
 * product defaults: E (fillet weld throat shear, Table A-8) log a1 = 12.010, F1 (bolt in tension, Table A-2) log a1 = 11.699.
 * Expected lives are hand formulas: weld 2 x 5 mm x 100 mm = 1000 mm2, 0 -> 80 kN is 80 MPa, N = 10^12.010 / 80^3;
 * bolt M20 x 2.5, As = pi/4 (20 - 0.938194 * 2.5)^2, 120 <-> 135 kN 1000 times, life = 10^11.699 / (15000 / As)^3 / 1000.
 */
const stressAt = (logA: number, slope: number, cycles: number): number => (10 ** logA / cycles) ** (1 / slope);
const segment = (index: number, field: 'fromStress' | 'fromCycles' | 'slope', source: string): FatigueAnyEdit =>
  ({ kind: 'piecewise', edit: { kind: 'segment-value', index, field, source } });
const detail = (edit: Extract<FatigueAnyEdit, { readonly kind: 'detail' }>['edit']): FatigueAnyEdit => ({ kind: 'detail', edit });
function calibrationEdits(logA1: number): FatigueAnyEdit[] {
  return [{ kind: 'stress-definition', value: 'range' }, { kind: 'mean-assumption', value: 'mean-independent' },
    { kind: 'curve-source', field: 'reference', source: 'DNV-RP-C203 (2005, amended 2006) Table 2-1, air' },
    { kind: 'curve-source', field: 'condition', source: 'unit test calibration only' },
    { kind: 'piecewise', edit: { kind: 'segment-add' } },
    segment(0, 'fromStress', String(stressAt(logA1, 3, 1e5))), segment(0, 'fromCycles', '100000'), segment(0, 'slope', '3'),
    segment(1, 'fromStress', String(stressAt(logA1, 3, 1e7))), segment(1, 'fromCycles', '10000000'), segment(1, 'slope', '5'),
    { kind: 'piecewise', edit: { kind: 'end-cycles', source: '100000000' } }, { kind: 'piecewise', edit: { kind: 'end', value: 'none' } },
    { kind: 'piecewise', edit: { kind: 'applicability', field: 'material', source: 'structural steel in air' } },
    { kind: 'piecewise', edit: { kind: 'applicability', field: 'detail', source: 'DNV detail category (test)' } },
    { kind: 'piecewise', edit: { kind: 'applicability', field: 'scope', source: 'unit test only' } }];
}
const HISTORY: readonly FatigueAnyEdit[] = [{ kind: 'history-sequence', index: 0, value: 'repeated-periodic' },
  { kind: 'history-source', index: 0, field: 'reference', source: 'hand-written test history' },
  { kind: 'history-source', index: 0, field: 'condition', source: 'unit test' }];
const WELD_EDITS: readonly FatigueAnyEdit[] = [{ kind: 'input-mode', value: 'detail' }, ...calibrationEdits(12.010),
  detail({ kind: 'kind', value: 'weld' }), detail({ kind: 'weld-area', value: 'fillet-throat-area' }),
  detail({ kind: 'weld-concentric', value: true }), detail({ kind: 'value', field: 'weldSize', source: '5' }),
  detail({ kind: 'value', field: 'weldLength', source: '100' }), detail({ kind: 'value', field: 'weldLines', source: '2' }),
  detail({ kind: 'quantity', value: 'weld-group-concentric-shear-force' }), detail({ kind: 'location', source: 'lap joint W1, hand calculation' }),
  detail({ kind: 'curve-stress', value: 'weld-fillet-throat-nominal-shear' }), detail({ kind: 'force', key: 'history-1', source: '0, 80000' }),
  ...HISTORY, { kind: 'history-repeats', index: 0, source: '1' }];
const BOLT_EDITS: readonly FatigueAnyEdit[] = [{ kind: 'input-mode', value: 'detail' }, ...calibrationEdits(11.699),
  detail({ kind: 'kind', value: 'bolt' }), detail({ kind: 'bolt-area', value: 'iso-metric-thread-tensile-stress-area' }),
  detail({ kind: 'value', field: 'boltDiameter', source: '20' }), detail({ kind: 'value', field: 'boltPitch', source: '2.5' }),
  detail({ kind: 'quantity', value: 'bolt-total-axial-force' }), detail({ kind: 'location', source: 'bolt B1, user joint analysis' }),
  detail({ kind: 'curve-stress', value: 'bolt-axial-normal-tensile-stress-area' }),
  detail({ kind: 'force', key: 'history-1', source: '120000, 135000' }), ...HISTORY, { kind: 'history-repeats', index: 0, source: '1000' }];
const WELD_LIFE = 10 ** 12.010 / 80 ** 3;
const BOLT_AREA = (Math.PI / 4) * (20 - 0.938194 * 2.5) ** 2;
const BOLT_LIFE = 10 ** 11.699 / (15_000 / BOLT_AREA) ** 3 / 1000;

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
function finiteLife(): number {
  const result = currentFatigueResultWithPiecewise(session(), parameters());
  if (result === null) throw new Error(`Expected a result: ${session().errorKey ?? ''} ${session().focusedField ?? ''}`);
  if (result.life.kind !== 'finite') throw new Error(result.life.kind);
  return result.life.spectrumRepetitions;
}
const html = (value: FatigueSession): string => renderToStaticMarkup(<FatiguePanel session={value} />);
const fatigueKinds = (): string[] => (useAppStore.getState().assembly?.beamAnalysisInputs?.analyses ?? [])
  .map(input => input.kind).filter(kind => kind.startsWith('fatigue') && kind !== 'fatigue-strain-life' && kind !== 'fatigue-local-cycle');

describe('joint (weld or bolt) fatigue through the store and the panel', () => {
  it('weld: calculates the hand life and shows area, stress definition, location, damage, life and scope', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(WELD_EDITS);
    await useAppStore.getState().runFatigue();
    expect(relative(finiteLife(), WELD_LIFE)).toBeLessThan(1e-9);
    const joint = currentDetailResult(session(), parameters());
    expect(joint?.areaMm2).toBe(1000);
    expect(joint?.codeCompliance).toBe(false);
    const markup = html(session());
    expect(markup).toContain('data-testid="fatigue-detail-result"');
    expect(markup).toContain(`${beamDisplayNumber(1000)} mm²`);
    expect(markup).toContain(t('fatigue.detail.stressWeldThroat'));
    expect(markup).toContain('lap joint W1, hand calculation');
    expect(markup).toContain(t('fatigue.detail.resultScope'));
    expect(markup).toContain(t('fatigue.scopeDetail'));
    expect(markup).toContain('data-testid="fatigue-damage"');
    expect(markup).toContain('data-testid="fatigue-life"');
    expect(markup).toContain('data-fatigue-field="history:0:force"');
    // Nominal stress span of the history, checkable against force / area by hand: 0 / 1000 and 80000 / 1000 MPa.
    expect(markup).toContain('data-fatigue-detail-stress="0" data-min-mpa="0" data-max-mpa="80"');
    // The joint mode offers neither the Goodman correction nor the member axial import (not joint quantities).
    expect(markup).not.toContain('data-testid="fatigue-correction"');
    expect(markup).not.toContain('data-testid="fatigue-axial-import"');
  });

  it('bolt: calculates the hand life on the tensile stress area', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(BOLT_EDITS);
    await useAppStore.getState().runFatigue();
    expect(relative(finiteLife(), BOLT_LIFE)).toBeLessThan(1e-6);
    expect(relative(finiteLife(), 2173.4)).toBeLessThan(1e-4);
    expect(html(session())).toContain(t('fatigue.detail.stressBoltTensile'));
    expect(html(session())).toContain(t('fatigue.detail.boltForceNote'));
  });

  it('refuses a wrong area or definition and an external force, naming the field, without a result', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter([...BOLT_EDITS, detail({ kind: 'bolt-area', value: 'nominal-shank-area' })]);
    await useAppStore.getState().runFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.detailStressMismatch', 'detail:curveStress']);
    expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
    expect(html(session())).toContain(t('fatigue.error.detailStressMismatch'));
    enter([detail({ kind: 'bolt-area', value: 'iso-metric-thread-tensile-stress-area' }),
      detail({ kind: 'quantity', value: 'joint-external-axial-force' })]);
    await useAppStore.getState().runFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.detailLoadDistribution', 'detail:quantity']);
    expect(session().detailAnalyzed ?? null).toBeNull();
  });

  it('clears the joint result on every kind of edit (mode, joint, dimension, history, calibration, source)', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(WELD_EDITS);
    const edits: FatigueAnyEdit[] = [detail({ kind: 'value', field: 'weldLength', source: '100.0' }),
      detail({ kind: 'location', source: 'lap joint W1, recalculated' }), detail({ kind: 'force', key: 'history-1', source: '0, 80000.0' }),
      { kind: 'history-repeats', index: 0, source: '2' }, segment(1, 'slope', '5.0'),
      { kind: 'curve-source', field: 'condition', source: 'other condition' }, detail({ kind: 'weld-concentric', value: true })];
    for (const edit of edits) {
      await useAppStore.getState().runFatigue();
      expect(currentFatigueResultWithPiecewise(session(), parameters())).not.toBeNull();
      enter([edit]);
      expect(session().detailAnalyzed).toBeNull();
      expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
    }
    await useAppStore.getState().runFatigue();
    enter([{ kind: 'input-mode', value: 'piecewise' }]);
    expect(session().detailAnalyzed).toBeNull();
    enter([{ kind: 'input-mode', value: 'detail' }]);
    expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
  });

  it('saves inputs only through Undo/Redo, reopens the joint, and keeps one fatigue configuration', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(WELD_EDITS);
    await useAppStore.getState().runFatigue();
    useAppStore.getState().saveFatigue();
    expect(session().errorKey).toBeNull();
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    const stored = savedFatigueEntry(assembly);
    if (stored?.kind !== 'fatigue-detail') throw new Error('Expected the joint configuration');
    expect(stored.definition.schema).toBe('pointercad-fatigue-saved/6');
    expect(stored.definition.source.documentId).toBe(assembly.id);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:areaMm2|stressHistories|damage|life|analysis|result)"/u);
    expect(fatigueKinds()).toEqual(['fatigue-detail']);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(session().draft.inputMode).toBe('detail');
    expect(session().detailAnalyzed ?? null).toBeNull();
    expect(currentFatigueResultWithPiecewise(session(), parameters())).toBeNull();
    expect(session().draft.detail).toMatchObject({ kind: 'weld', weldArea: 'fillet-throat-area', weldConcentric: true,
      values: { weldSize: '5', weldLength: '100', weldLines: '2' }, forces: { 'history-1': '0, 80000' } });
    expect(fatigueEntryIsSavedWithPiecewise(session(), parameters(), stored)).toBe(true);
    expect(html(session())).toContain('data-saved="true"');
    enter([detail({ kind: 'value', field: 'weldLines', source: '3' })]);
    expect(html(session())).toContain('data-saved="false"');
    enter([detail({ kind: 'value', field: 'weldLines', source: '2' })]);
    expect(html(session())).toContain('data-saved="true"');
    await useAppStore.getState().runFatigue();
    expect(relative(finiteLife(), WELD_LIFE)).toBeLessThan(1e-9);
    // Switching to the single-slope family and saving replaces the joint configuration; Undo restores it, Redo again.
    enter([{ kind: 'input-mode', value: 'stress' }, ...BASE_EDITS]);
    useAppStore.getState().saveFatigue();
    expect(fatigueKinds()).toEqual(['fatigue']);
    useAppStore.getState().undo();
    expect(fatigueKinds()).toEqual(['fatigue-detail']);
    useAppStore.getState().redo();
    expect(fatigueKinds()).toEqual(['fatigue']);
    useAppStore.getState().undo();
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(session().draft.inputMode).toBe('detail');
    expect(html(session())).toContain('data-saved="true"');
  });

  it('keeps the existing modes and gives no joint result to another document', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter(BASE_EDITS);
    await useAppStore.getState().runFatigue();
    const single = currentFatigueResultWithPiecewise(session(), parameters());
    expect(single === null ? Number.NaN : relative(single.damage, BASE_DAMAGE)).toBeLessThan(1e-12);
    const markup = html(session());
    expect(markup).toContain('<option value="detail">');
    expect(markup).toContain('data-testid="fatigue-correction"');
    expect(markup).not.toContain('data-testid="fatigue-detail"');
    enter(WELD_EDITS);
    const owner = session().ownerId;
    useAppStore.setState({ fatigueSession: { ...session(), ownerId: `${owner}-other` } });
    await useAppStore.getState().runFatigue();
    expect(session().detailAnalyzed ?? null).toBeNull();
    useAppStore.setState({ fatigueSession: { ...session(), ownerId: owner } });
    await useAppStore.getState().runFatigue();
    expect(relative(finiteLife(), WELD_LIFE)).toBeLessThan(1e-9);
    // Back to the single-slope family: the earlier stress-mode input is unchanged and calculates as before.
    enter([{ kind: 'input-mode', value: 'stress' }]);
    await useAppStore.getState().runFatigue();
    const again = currentFatigueResultWithPiecewise(session(), parameters());
    expect(again === null ? Number.NaN : relative(again.damage, BASE_DAMAGE)).toBeLessThan(1e-12);
  });

  it('labels every joint control with a title and keeps the force list separate from the stress list', () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    enter([...WELD_EDITS, detail({ kind: 'quantity', value: 'detail-stress' })]);
    const markup = html(session());
    const fieldset = /<fieldset data-testid="fatigue-detail">[\s\S]*?<\/fieldset>/u.exec(markup)?.[0] ?? '';
    expect(fieldset).not.toBe('');
    for (const control of fieldset.match(/<(?:select|input|textarea|button)\b[^>]*>/gu) ?? []) expect(control).toMatch(/\btitle="[^"]+"/u);
    // The detail-stress quantity shows the MPa stress list (empty), never the typed N list.
    expect(markup).toContain('data-fatigue-field="history:0:stress"');
    expect(markup).not.toContain('data-fatigue-field="history:0:force"');
    expect(session().draft.histories[0]?.stress).toBe('');
    expect(session().draft.detail?.forces['history-1']).toBe('0, 80000');
  });
});
