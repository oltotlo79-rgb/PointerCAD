import type { FatigueTensorComponent } from '@pointercad/fem';
import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamDisplayNumber } from '../beam/BeamResults.js';
import { t, type MessageKey } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatiguePanel } from './FatiguePanel.js';
import { BASE_EDITS, edited, relative } from './fatigue.testSupport.js';
import { createFatigueSession, currentFatigueResult, editFatigueSession, fatigueDraftIsSaved, fatigueSavedInput,
  type FatigueEdit, type FatigueSession } from './fatigueSession.js';

/* Every expected value is derived by hand from the stated method, independently of the core: the stress at each sample is
 * factor x sign x vonMises(reference), with the sign of the principal stress of largest |value| (+1 on an exact tie),
 * counted by rainflow and summed by Miner on BASE_EDITS's test-only curve N = 2e6 x (100 / S)^3 (range, no cut-off). */
const TOLERANCE = 1e-12;

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

type Components = Readonly<Record<FatigueTensorComponent, string>>;
const ZERO: Components = { xx: '0', yy: '0', zz: '0', yz: '0', xz: '0', xy: '0' };
const KEYS: readonly FatigueTensorComponent[] = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
/** BASE_EDITS in the tensor mode. Its stress list "0, 200, 0" stays in the draft and is not used by the tensor mode. */
const tensorEdits = (components: Components, factors: string, extra: readonly FatigueEdit[] = []): readonly FatigueEdit[] => [
  ...BASE_EDITS, { kind: 'input-mode', value: 'proportional-tensor' },
  ...KEYS.map((component): FatigueEdit => ({ kind: 'tensor-component', index: 0, component, source: components[component] })),
  { kind: 'tensor-factors', index: 0, source: factors }, ...extra];
const owner = (): string => useAppStore.getState().activeDocumentId;
function current(): FatigueSession {
  const session = useAppStore.getState().fatigueSession;
  if (session === null) throw new Error('Fatigue session closed');
  return session;
}
/** A draft built by the public edits, then the store's actual Calculate action (actual core, no mocked result). */
async function run(edits: readonly FatigueEdit[]): Promise<FatigueSession> {
  useAppStore.setState({ fatigueSession: edited(edits, owner()) });
  await useAppStore.getState().runFatigue();
  return current();
}
const html = (session: FatigueSession): string => renderToStaticMarkup(<FatiguePanel session={session} />);

describe('proportional tensor fatigue through the store actions and the actual core', () => {
  it('uniaxial 100 MPa with factors 0, 1, 0: equivalent exactly 100 MPa, D = 5e-7, 2e6 repetitions', async () => {
    const session = await run(tensorEdits({ ...ZERO, xx: '100' }, '0, 1, 0'));
    expect([session.errorKey, session.diagnostic]).toEqual([null, null]);
    const result = currentFatigueResult(session, []);
    const conversion = session.analyzed?.tensor?.conversions[0];
    if (result === null || conversion === undefined) throw new Error('Expected a current tensor result');
    // von Mises of diag(100, 0, 0) is sqrt((100^2 + 0 + 100^2) / 2) = 100 and the largest |principal| is +100, so the
    // history is 0, 100, 0 MPa: two half cycles of range 100, each 0.5 x (100 / 100)^3 / 2e6 = 2.5e-7.
    expect(conversion.signedEquivalentReferenceMpa).toBe(100);
    expect(conversion.vonMisesReferenceMpa).toBe(100);
    expect(conversion.signTie).toBe(false);
    expect(session.analyzed?.input.histories[0]?.stressMpa).toEqual([0, 100, 0]);
    expect(result.histories[0]?.cycles.map(cycle => [cycle.count, cycle.rangeMpa])).toEqual([[0.5, 100], [0.5, 100]]);
    expect(relative(result.damage, 5e-7)).toBeLessThan(TOLERANCE);
    expect(result.life.kind).toBe('finite');
    expect(relative(result.life.kind === 'finite' ? result.life.spectrumRepetitions : Number.NaN, 2e6)).toBeLessThan(TOLERANCE);
    const panel = html(session);
    expect(panel).toContain('data-testid="fatigue-tensor-result"');
    expect(panel).toContain('data-sign-tie="false"');
    expect(panel).toContain(`${beamDisplayNumber(100)} MPa`);
    expect(panel).toContain(t('fatigue.tensorNoTie'));
    expect(panel).toContain(t('fatigue.tensorMethod'));
    expect(panel).toContain(t('fatigue.tensorScope'));
  });

  it('pure shear 10 MPa, factors -1, 1 repeated 1000 times: tie disclosed, reversal kept, accepted as fully reversed', async () => {
    const session = await run(tensorEdits({ ...ZERO, xy: '10' }, '-1, 1', [{ kind: 'mean-assumption', value: 'fully-reversed-only' },
      { kind: 'history-sequence', index: 0, value: 'repeated-periodic' }, { kind: 'history-repeats', index: 0, source: '1000' }]));
    const result = currentFatigueResult(session, []);
    const conversion = session.analyzed?.tensor?.conversions[0];
    if (result === null || conversion === undefined) throw new Error(`Expected a tensor result: ${session.errorKey ?? ''}`);
    // Pure shear tau: von Mises sqrt(3) tau; principal stresses +tau, 0, -tau are a tie, so the method's sign is +1.
    // Factors -1, 1 give -sqrt(3) tau, +sqrt(3) tau: per period one closed cycle of range 2 sqrt(3) tau and mean 0,
    // so D = 1000 x (2 sqrt(3) x 10 / 100)^3 / 2e6 and the life is 1 / D.
    const equivalent = Math.sqrt(3) * 10, damage = 1000 * (2 * equivalent / 100) ** 3 / 2e6;
    expect(conversion.signTie).toBe(true);
    expect(conversion.signedEquivalentReferenceMpa).toBeCloseTo(equivalent, 12);
    const signed = conversion.signedEquivalentReferenceMpa;
    expect(session.analyzed?.input.histories[0]?.stressMpa).toEqual([-signed, signed]);
    const cycles = result.histories[0]?.cycles ?? [];
    expect(cycles.map(cycle => [cycle.count, cycle.rangeMpa, cycle.meanMpa])).toEqual([[0.5, 2 * signed, 0], [0.5, 2 * signed, 0]]);
    expect(relative(result.damage, damage)).toBeLessThan(TOLERANCE);
    expect(result.life.kind).toBe('finite');
    expect(relative(result.life.kind === 'finite' ? result.life.spectrumRepetitions : Number.NaN, 1 / damage)).toBeLessThan(TOLERANCE);
    const panel = html(session);
    expect(panel).toContain('data-sign-tie="true"');
    expect(panel).toContain(t('fatigue.tensorTie'));
  });

  it('a refused input keeps the draft; the correction gives a valid analysis; a later edit removes the result', async () => {
    const before = edited(tensorEdits({ ...ZERO, xx: '100', xy: '' }, '0, 1, 0'), owner());
    useAppStore.setState({ fatigueSession: before });
    await useAppStore.getState().runFatigue();
    const refused = current();
    expect([refused.errorKey, refused.focusedField, refused.analyzed]).toEqual(['fatigue.error.tensorComponent', 'tensor:0:xy', null]);
    expect(refused.draft).toBe(before.draft);
    expect(refused.revision).toBe(before.revision);
    expect(html(refused)).toContain(t('fatigue.error.tensorComponent'));
    useAppStore.getState().editFatigue({ kind: 'tensor-component', index: 0, component: 'xy', source: '0' });
    await useAppStore.getState().runFatigue();
    const accepted = current();
    expect(accepted.errorKey).toBeNull();
    expect(currentFatigueResult(accepted, [])).not.toBeNull();
    expect(accepted.analyzed?.tensor?.conversions[0]?.signedEquivalentReferenceMpa).toBe(100);
    expect(editFatigueSession(accepted, { kind: 'focus', field: 'tensor:0:xx' }).analyzed).toBe(accepted.analyzed);
    useAppStore.getState().editFatigue({ kind: 'tensor-factors', index: 0, source: '0, 2, 0' });
    const changed = current();
    expect(changed.analyzed).toBeNull();
    expect(changed.revision).toBe(accepted.revision + 1);
    expect(html(changed)).not.toContain('data-testid="fatigue-results"');
    // A retained stale result cannot become current again, neither for other factors nor for the stress input.
    expect(currentFatigueResult({ ...changed, analyzed: accepted.analyzed }, [])).toBeNull();
    const reference = editFatigueSession(accepted, { kind: 'tensor-component', index: 0, component: 'xx', source: '-100' });
    expect(reference.analyzed).toBeNull();
    expect(currentFatigueResult({ ...reference, analyzed: accepted.analyzed }, [])).toBeNull();
    const back = editFatigueSession(accepted, { kind: 'input-mode', value: 'stress' });
    expect(back.analyzed).toBeNull();
    expect(currentFatigueResult({ ...back, analyzed: accepted.analyzed }, [])).toBeNull();
  });

  type Case = [label: string, components: Components, factors: string, extra: readonly FatigueEdit[], key: MessageKey,
    field: string, point: number | null];
  const CASES: Case[] = [
    ['an empty component (never read as 0)', { ...ZERO, xx: '' }, '0, 1', [], 'fatigue.error.tensorComponent', 'tensor:0:xx', null],
    ['a unit typed in a component', { ...ZERO, yy: '100 MPa' }, '0, 1', [], 'fatigue.error.tensorComponent', 'tensor:0:yy', null],
    ['two numbers in a component', { ...ZERO, zz: '1 2' }, '0, 1', [], 'fatigue.error.tensorComponent', 'tensor:0:zz', null],
    ['a zero reference', ZERO, '0, 1', [], 'fatigue.error.tensorZero', 'tensor:0:xx', null],
    ['a hydrostatic reference', { ...ZERO, xx: '50', yy: '50', zz: '50' }, '0, 1', [], 'fatigue.error.tensorHydrostatic', 'tensor:0:xx', null],
    ['a component beyond 10000 MPa', { ...ZERO, yz: '10001' }, '0, 1', [], 'fatigue.error.tensorBound', 'tensor:0:yz', null],
    ['an unreadable factor', { ...ZERO, xx: '100' }, '0, x', [], 'fatigue.error.tensorFactors', 'tensor:0:factors', 2],
    ['no factor', { ...ZERO, xx: '100' }, ' ', [], 'fatigue.error.tensorFactorsLength', 'tensor:0:factors', null],
    ['factor x equivalent beyond 10000 MPa', { ...ZERO, xx: '100' }, '0, 101', [], 'fatigue.error.tensorBound', 'tensor:0:factors', 2],
    // 0.5 x MIN_VALUE rounds to 0: refused at that factor instead of reporting no damage.
    ['a nonzero factor whose stress rounds to 0', { ...ZERO, xx: '0.5' }, '0, 5e-324', [], 'fatigue.error.tensorUnderflow',
      'tensor:0:factors', 2],
    ['the uniaxial Goodman correction', { ...ZERO, xx: '100' }, '0, 1', [{ kind: 'correction-mode', value: 'goodman' }],
      'fatigue.error.tensorCorrection', 'correction:mode', null],
    ['a nonzero mean under a fully-reversed-only curve', { ...ZERO, xx: '100' }, '0, -1',
      [{ kind: 'mean-assumption', value: 'fully-reversed-only' }], 'fatigue.error.mean', 'tensor:0:factors', null],
  ];
  it.each(CASES)('refuses %s at its own field and keeps the draft', async (_label, components, factors, extra, key, field, point) => {
    const before = edited(tensorEdits(components, factors, extra), owner());
    useAppStore.setState({ fatigueSession: before });
    await useAppStore.getState().runFatigue();
    const refused = current();
    expect([refused.errorKey, refused.focusedField, refused.analyzed]).toEqual([key, field, null]);
    expect(refused.diagnostic).toBe(point === null ? null : t('fatigue.error.point').replace('{point}', String(point)));
    expect(refused.draft).toBe(before.draft);
  });

  it('never turns a tensor draft into a stress configuration (saving it is version 4, fatigueTensorPersistence.test.ts)', async () => {
    const session = await run(tensorEdits({ ...ZERO, xx: '100' }, '0, 1, 0'));
    expect(fatigueSavedInput(session, [], session.ownerId)).toEqual({ ok: false, key: 'fatigue.error.shape', field: 'inputMode',
      diagnostic: null });
    // Even when the hidden stress list equals a saved stress configuration, a tensor draft is never reported as saved.
    const scalar = fatigueSavedInput(edited([...BASE_EDITS, { kind: 'history-stress', index: 0, source: '0, 100, 0' }]), [], owner());
    if (!scalar.ok) throw new Error('Expected a saved stress configuration');
    const sameText = editFatigueSession(session, { kind: 'history-stress', index: 0, source: '0, 100, 0' });
    expect(fatigueDraftIsSaved(sameText, [], scalar.saved)).toBe(false);
    expect(fatigueDraftIsSaved(editFatigueSession(sameText, { kind: 'input-mode', value: 'stress' }), [], scalar.saved)).toBe(true);
  });
});

interface ElementProps {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly onChange?: (event: { readonly target: { readonly value: string; readonly checked: boolean } }) => void;
}
/** The element tree the panel itself returns (same Probe boundary as FatiguePanel.test.tsx), so the reached handlers are
 * the panel's actual handlers. */
function reached(session: FatigueSession): ElementProps[] {
  const found: ElementProps[] = [];
  function walk(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<ElementProps>(child)) return;
      found.push(child.props);
      walk(child.props.children);
    });
  }
  function Probe(): null {
    walk(FatiguePanel({ session }));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return found;
}
function one(found: readonly ElementProps[], testId: string): ElementProps {
  const matches = found.filter(props => props['data-testid'] === testId);
  expect(matches, testId).toHaveLength(1);
  return matches[0] ?? {};
}

describe('FatiguePanel tensor mode', () => {
  it('keeps the stress mode as it was and reaches the actual mode, component and factor handlers', () => {
    expect((html(createFatigueSession(owner())).match(/<option value="" selected="">/gu) ?? []).length).toBe(4);
    const initial = edited(BASE_EDITS, owner());
    useAppStore.setState({ fatigueSession: initial });
    const plain = html(initial);
    expect(plain).toContain('data-testid="fatigue-axial-import"');
    expect(plain).toContain(t('fatigue.historiesHelp'));
    expect(plain).toContain('data-fatigue-field="history:0:stress"');
    expect(plain).not.toContain('data-testid="fatigue-tensor-scope"');
    const mode = one(reached(initial), 'fatigue-input-mode');
    if (mode.onChange === undefined) throw new Error('Missing actual mode handler');
    mode.onChange({ target: { value: 'proportional-tensor', checked: false } });
    const tensor = current();
    expect(tensor.draft.inputMode).toBe('proportional-tensor');
    expect(tensor.revision).toBe(initial.revision + 1);
    const shown = html(tensor);
    expect(shown).toContain('data-testid="fatigue-tensor-scope"');
    expect(shown).toContain(t('fatigue.tensorSaved'));
    expect(shown).toContain(t('fatigue.tensorComponentOrder'));
    for (const key of KEYS) expect(shown).toContain(`data-fatigue-field="tensor:0:${key}"`);
    expect(shown).toContain('data-fatigue-field="tensor:0:factors"');
    expect(shown).not.toContain('data-fatigue-field="history:0:stress"');
    expect(shown).not.toContain('data-testid="fatigue-axial-import"');
    const xx = one(reached(tensor), 'fatigue-tensor-0-xx');
    if (xx.onChange === undefined) throw new Error('Missing actual component handler');
    xx.onChange({ target: { value: '100', checked: false } });
    expect(current().draft.tensors['history-1']?.components.xx).toBe('100');
    const factors = one(reached(current()), 'fatigue-tensor-0-factors');
    if (factors.onChange === undefined) throw new Error('Missing actual factor handler');
    factors.onChange({ target: { value: '0, 1, 0', checked: false } });
    expect(current().draft.tensors['history-1']?.loadFactors).toBe('0, 1, 0');
    expect(current().revision).toBe(tensor.revision + 2);
  });
});
