import { analyzeFatigue, analyzeFatigueWithMeanStressCorrection } from '@pointercad/fem';
import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatiguePanel } from './FatiguePanel.js';
import { BASE_EDITS, edited } from './fatigue.testSupport.js';
import { createFatigueSession, editFatigueSession, fatigueCorrection, fatigueInput,
  type FatigueEdit, type FatigueSession } from './fatigueSession.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function analyzed(edits: readonly FatigueEdit[]): FatigueSession {
  const session = edited(edits);
  const checked = fatigueInput(session, []);
  if (!checked.ok) throw new Error(`Draft refused: ${checked.key}`);
  const analysis = analyzeFatigue(checked.input);
  if (!analysis.ok) throw new Error(`Analysis refused: ${analysis.code}`);
  return { ...session, analyzed: { input: checked.input, result: analysis.result } };
}
function render(session: FatigueSession): string {
  useAppStore.setState({ fatigueSession: session });
  return renderToStaticMarkup(<FatiguePanel session={session} />);
}

describe('FatiguePanel', () => {
  it('states the scope, no certification and that the curve is the user\'s own, with every choice unselected', () => {
    const html = render(createFatigueSession('fatigue-owner'));
    expect(html).toContain(t('fatigue.scope'));
    expect(html).toContain(t('fatigue.notCertified'));
    expect(html).toContain(t('fatigue.curveHelp'));
    // Four explicit choices (stress definition, mean assumption, cut-off, history use), none preselected.
    expect((html.match(/<option value="" selected="">/gu) ?? []).length).toBe(4);
    expect(html).not.toContain('data-testid="fatigue-results"');
    expect(html).toContain('data-saved="false"');
  });

  it('shows damage and the typed life only for the exact analyzed input', () => {
    const session = analyzed(BASE_EDITS);
    const html = render(session);
    expect(html).toContain('data-testid="fatigue-results"');
    expect(html).toContain('data-life="finite"');
    expect(html).toContain(t('fatigue.lifeFinite'));
    expect(html).toContain(`${t('fatigue.damage')}: 0.000004`);
    const changed = editFatigueSession(session, { kind: 'value', field: 'slope', source: '4' });
    expect(render(changed)).not.toContain('data-testid="fatigue-results"');
  });

  it('never shows a damaging underflow as zero damage, and states when no cycle damages', () => {
    const underflow = render(analyzed([...BASE_EDITS, { kind: 'value', field: 'referenceStress', source: '10000' },
      { kind: 'value', field: 'referenceCycles', source: '1' }, { kind: 'value', field: 'slope', source: '20' },
      { kind: 'history-stress', index: 0, source: '0, 1e-300, 0' }]));
    expect(underflow).toContain('data-life="not-representable"');
    expect(underflow).toContain(t('fatigue.damageUnderflow'));
    expect(underflow).toContain(t('fatigue.historyDamageZero'));
    expect(underflow).not.toContain(`${t('fatigue.damage')}: 0<`);
    const none = render(analyzed([...BASE_EDITS, { kind: 'cutoff-mode', value: 'value' },
      { kind: 'value', field: 'cutoff', source: '250' }]));
    expect(none).toContain('data-life="no-damaging-cycle"');
    expect(none).toContain(t('fatigue.lifeNoDamage'));
    expect(none).toContain(`${t('fatigue.damage')}: 0<`);
  });

  it('shows the cut-off value and repeat count fields only when chosen', () => {
    expect(render(edited(BASE_EDITS))).not.toContain('data-fatigue-field="cutoff"');
    expect(render(edited([...BASE_EDITS, { kind: 'cutoff-mode', value: 'value' }]))).toContain('data-fatigue-field="cutoff"');
    expect(render(edited([...BASE_EDITS, { kind: 'history-sequence', index: 0, value: 'repeated-periodic' }])))
      .toContain('data-fatigue-field="history:0:repeats"');
  });
});

interface ElementProps {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { readonly target: { readonly value: string; readonly checked: boolean } }) => void;
  readonly onBlurCapture?: (event: { readonly target: EventTarget }) => void;
  readonly ref?: { current: { contains(node: unknown): boolean } | null };
}
/** The element tree the panel itself returns, rendered through a Probe component (same boundary as the contact focus
 * regression), so the reached form and Calculate props are the panel's actual handlers. */
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

describe('FatiguePanel same-field focus after a refused calculation', () => {
  it('keeps blur view-only and refocuses only the same refused, still connected field through Calculate', () => {
    const owner = useAppStore.getState().activeDocumentId;
    const invalid = edited([...BASE_EDITS, { kind: 'value', field: 'slope', source: '0' }, { kind: 'focus', field: 'slope' }], owner);
    useAppStore.setState({ fatigueSession: invalid });
    // Typed adapter only: this does not claim physical DOM/pointer delivery.
    class FieldElement extends EventTarget {
      readonly classList = { contains: (name: string): boolean => name === 'pcad-field__input' };
      isConnected = true;
      readonly focus = vi.fn();
    }
    vi.stubGlobal('HTMLElement', FieldElement);
    const input = new FieldElement();
    try {
      const found = reached(invalid);
      const form = one(found, 'fatigue-panel'), calculate = one(found, 'fatigue-run');
      if (form.onBlurCapture === undefined || form.ref === undefined || calculate.onClick === undefined) {
        throw new Error('Missing reached focus adapter');
      }
      form.ref.current = { contains: node => node === input };
      const beforeBlur = useAppStore.getState();
      form.onBlurCapture({ target: input });
      expect(useAppStore.getState()).toBe(beforeBlur);
      calculate.onClick();
      const refused = useAppStore.getState().fatigueSession;
      expect([refused?.errorKey, refused?.focusedField, refused?.analyzed]).toEqual(['fatigue.error.field', 'slope', null]);
      expect(input.focus).toHaveBeenCalledOnce();
      const beforeRepeat = useAppStore.getState();
      form.onBlurCapture({ target: input });
      expect(useAppStore.getState()).toBe(beforeRepeat);
      calculate.onClick();
      expect(input.focus).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().fatigueSession?.draft).toBe(invalid.draft);
      expect(useAppStore.getState().fatigueSession?.revision).toBe(invalid.revision);
      // A disconnected input is not focused.
      input.isConnected = false;
      form.onBlurCapture({ target: input });
      calculate.onClick();
      expect(input.focus).toHaveBeenCalledTimes(2);
      // Leaving another field: the refusal moves the focus to slope, which the ExpressionField effect handles.
      input.isConnected = true;
      useAppStore.setState({ fatigueSession: { ...invalid, focusedField: 'referenceStress' } });
      form.onBlurCapture({ target: input });
      calculate.onClick();
      expect(useAppStore.getState().fatigueSession?.focusedField).toBe('slope');
      expect(input.focus).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('FatiguePanel explicit Goodman selection', () => {
  it('reaches the actual selection and applicability handlers without default strengths or a default assertion', () => {
    const initial = edited(BASE_EDITS);
    useAppStore.setState({ fatigueSession: initial });
    expect(render(initial)).not.toContain('data-fatigue-field="correction:ultimateTensileStrengthMpa"');
    const mode = one(reached(initial), 'fatigue-correction-mode');
    if (mode.onChange === undefined) throw new Error('Missing actual mode handler');
    mode.onChange({ target: { value: 'goodman', checked: false } });
    const opted = useAppStore.getState().fatigueSession;
    if (opted === null) throw new Error('Session closed');
    expect(opted.draft.correction.mode).toBe('goodman');
    expect(Object.values(opted.draft.correction.values)).toEqual(['', '', '']);
    expect(opted.draft.correction.elasticSymmetricYield).toBe(false);
    const html = render(opted);
    expect(html).toContain(t('fatigue.correctionHelp'));
    expect(html).toContain(t('fatigue.ultimateTensileStrength'));
    expect(html).toContain(t('fatigue.yieldStrength'));
    expect(html).toContain(t('fatigue.minimumCycles'));
    expect(html).toContain('data-fatigue-field="correction:reference"');
    expect(html).toContain('data-fatigue-field="correction:condition"');
    const applicability = one(reached(opted), 'fatigue-correction-applicability');
    if (applicability.onChange === undefined) throw new Error('Missing actual applicability handler');
    applicability.onChange({ target: { value: '', checked: true } });
    expect(useAppStore.getState().fatigueSession?.draft.correction.elasticSymmetricYield).toBe(true);
    const current = useAppStore.getState().fatigueSession;
    if (current === null) throw new Error('Session closed');
    const disable = one(reached(current), 'fatigue-correction-mode');
    if (disable.onChange === undefined) throw new Error('Missing actual mode handler');
    disable.onChange({ target: { value: 'none', checked: false } });
    expect(useAppStore.getState().fatigueSession?.draft.correction.mode).toBe('none');
  });

  it('renders the actual corrected result and its strength/source provenance, and hides it after a source edit', () => {
    const session = edited([...BASE_EDITS,
      { kind: 'stress-definition', value: 'amplitude' }, { kind: 'mean-assumption', value: 'fully-reversed-only' },
      { kind: 'value', field: 'referenceCycles', source: '1000000' }, { kind: 'value', field: 'slope', source: '2' },
      { kind: 'history-stress', index: 0, source: '150, 250' },
      { kind: 'history-sequence', index: 0, value: 'repeated-periodic' }, { kind: 'history-repeats', index: 0, source: '1' },
      { kind: 'correction-mode', value: 'goodman' }, { kind: 'correction-applicability', value: true },
      { kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: '400' },
      { kind: 'correction-value', field: 'yieldStrengthMpa', source: '300' },
      { kind: 'correction-value', field: 'minimumCycles', source: '1001' },
      { kind: 'correction-source', field: 'reference', source: 'panel synthetic strength source' },
      { kind: 'correction-source', field: 'condition', source: 'elastic, symmetric test only' },
    ]);
    const built = fatigueInput(session, []), correction = fatigueCorrection(session, []);
    if (!built.ok || !correction.ok || correction.correction === null) throw new Error('Invalid test input');
    const computed = analyzeFatigueWithMeanStressCorrection(built.input, correction.correction);
    if (!computed.ok) throw new Error(computed.code);
    expect(Math.abs(computed.result.damage / 1e-6 - 1)).toBeLessThan(1e-12);
    const accepted: FatigueSession = { ...session, analyzed: { input: built.input,
      result: computed.result, correction: correction.correction } };
    const html = render(accepted);
    expect(html).toContain('data-testid="fatigue-correction-result"');
    expect(html).toContain('data-method="goodman-tension-only/1"');
    expect(html).toContain(`${t('fatigue.damage')}: 0.000001`);
    expect(html).toContain(`${t('fatigue.ultimateTensileStrength')}: 400 MPa`);
    expect(html).toContain(`${t('fatigue.yieldStrength')}: 300 MPa`);
    expect(html).toContain(`${t('fatigue.minimumCycles')}: 1001`);
    expect(html).toContain('panel synthetic strength source');
    expect(html).toContain('elastic, symmetric test only');
    const changed = editFatigueSession(accepted, { kind: 'correction-source', field: 'reference', source: 'other source' });
    expect(render(changed)).not.toContain('data-testid="fatigue-results"');
  });
});