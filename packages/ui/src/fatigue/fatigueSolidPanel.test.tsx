import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { StrengthPanel } from '../strength/StrengthPanel.js';
import { StrengthPropertyPanel } from '../strength/StrengthPropertyPanel.js';
import { SolidAnalysisPanel } from '../solidAnalysis/SolidAnalysisPanel.js';
import { FatiguePanel } from './FatiguePanel.js';
import { analyticalSolid } from './fatigueSolid.testSupport.js';
import { BASE_EDITS } from './fatigue.testSupport.js';
import { t } from '../i18n/t.js';

interface Props {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly value?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
}
function rows(panel: 'strength' | 'solid' | 'fatigue'): Props[] {
  const result: Props[] = [];
  function walk(node: ReactNode): void { Children.forEach(node, child => {
    if (isValidElement<Props>(child)) { result.push(child.props); walk(child.props.children); }
  }); }
  function Probe(): null {
    const state = useAppStore.getState();
    if (panel === 'strength' && state.strengthSession !== null) walk(StrengthPanel({ session: state.strengthSession }));
    if (panel === 'solid' && state.solidAnalysisSession !== null) walk(SolidAnalysisPanel({ session: state.solidAnalysisSession }));
    if (panel === 'fatigue' && state.fatigueSession !== null) walk(FatiguePanel({ session: state.fatigueSession }));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result;
}
function row(panel: 'strength' | 'solid' | 'fatigue', id: string): Props {
  const found = rows(panel).find(value => value['data-testid'] === id);
  if (found === undefined) throw new Error(`Missing visible action ${id}`);
  return found;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
  useAppStore.getState().toggleStrength();
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('reachable solid fatigue panel actions (Node, not browser/native acceptance)', () => {
  it('navigates through real strength/solid/fatigue buttons, selects explicitly, calculates actual criterion and returns to retained solid', async () => {
    row('strength', 'solid-analysis-open').onClick?.();
    const source = await analyticalSolid(useAppStore.getState().document.id, useAppStore.getState().completedGeneration);
    const solid = useAppStore.getState().solidAnalysisSession;
    if (solid === null) throw new Error('Actual solid-open action failed');
    // Analytical native boundary fixture only; navigation/session/store actions remain real.
    useAppStore.setState({ solidAnalysisSession: { ...solid, status: 'complete', result: source } });
    row('solid', 'solid-fatigue-open').onClick?.();
    expect(useAppStore.getState().solidAnalysisSession?.result).toBe(source);
    const fatigueHtml = renderToStaticMarkup(<StrengthPropertyPanel />);
    expect(fatigueHtml).toContain('data-testid="fatigue-panel"');
    expect(fatigueHtml).toContain(t('fatigue.solidScope'));
    expect(fatigueHtml).toContain(t('fatigue.tensorFactorsHelp'));
    expect(fatigueHtml).not.toContain(t('fatigue.scope'));
    expect(fatigueHtml).not.toContain(t('fatigue.historiesHelp'));

    expect(useAppStore.getState().fatigueSession?.draft.solid).toBeUndefined();
    row('fatigue', 'fatigue-solid-maximum').onClick?.();
    expect(row('fatigue', 'fatigue-solid-element').value).toBe('1');
    expect(useAppStore.getState().fatigueSession?.solidAnalyzed ?? null).toBeNull();
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    useAppStore.getState().editFatigue({ kind: 'history-stress', index: 0, source: '0,1,0,-1' });
    row('fatigue', 'fatigue-run').onClick?.();
    await vi.waitFor(() => expect(useAppStore.getState().fatigueSession?.solidAnalyzed?.result.damage).toBeGreaterThan(0));
    const html = renderToStaticMarkup(<StrengthPropertyPanel />);
    expect(html).toContain('data-testid="fatigue-solid-provenance"');
    expect(html).toContain('6 MPa');
    for (const component of ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'] as const) expect(html).toContain(t(`fatigue.tensor.${component}`));
    // Independently hide an accepted fatigue result on cancellation, even before the solid attachment clears its outcome.
    useAppStore.setState({ cancelRequestCount: useAppStore.getState().cancelRequestCount + 1 });
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).not.toContain('data-testid="fatigue-solid-provenance"');
    row('fatigue', 'fatigue-close').onClick?.();
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toContain('data-testid="solid-analysis-panel"');
    expect(useAppStore.getState().solidAnalysisSession?.result).toBe(source);
  });
  it('allows clearing and invalid element editing without running the previous selection', async () => {
    row('strength', 'solid-analysis-open').onClick?.();
    const source = await analyticalSolid(useAppStore.getState().document.id, useAppStore.getState().completedGeneration), solid = useAppStore.getState().solidAnalysisSession;
    if (solid === null) throw new Error('No solid session');
    useAppStore.setState({ solidAnalysisSession: { ...solid, status: 'complete', result: source } });
    row('solid', 'solid-fatigue-open').onClick?.();
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    row('fatigue', 'fatigue-solid-maximum').onClick?.();
    for (const value of ['', '0', '2', '1.5', '-1', 'x']) {
      row('fatigue', 'fatigue-solid-element').onChange?.({ target: { value } });
      expect(row('fatigue', 'fatigue-solid-element').value).toBe(value);
      await useAppStore.getState().runFatigue();
      expect(useAppStore.getState().fatigueSession?.solidAnalyzed ?? null).toBeNull();
      expect(useAppStore.getState().fatigueSession?.errorKey).toBe('fatigue.error.solidSelection');
    }
    row('fatigue', 'fatigue-solid-element').onChange?.({ target: { value: '1' } });
    expect(row('fatigue', 'fatigue-solid-element').value).toBe('1');
  });
});
