import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidAnalysisPanel } from './SolidAnalysisPanel.js';
import { StrengthPropertyPanel } from '../strength/StrengthPropertyPanel.js';
import { t } from '../i18n/t.js';
interface Props {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly type?: string;
  readonly onClick?: () => void;
  readonly onCompositionStart?: () => void;
  readonly onCompositionEnd?: () => void;
  readonly onSubmit?: (event: { preventDefault(): void }) => void;
  readonly onKeyDown?: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number };
    preventDefault(): void; stopPropagation(): void }) => void;
  readonly checked?: boolean;
  readonly field?: { readonly key: string };
  readonly onChange?: (value: string) => void;
}
function elements(): Props[] {
  const rows: Props[] = [];
  function walk(node: ReactNode): void { Children.forEach(node, child => {
    if (isValidElement<Props>(child)) { rows.push(child.props); walk(child.props.children); }
  }); }
  function Probe(): null {
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    walk(SolidAnalysisPanel({ session })); return null;
  }
  renderToStaticMarkup(<Probe />); return rows;
}
beforeEach(() => {
  resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
});
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore(); });
describe('solid strength panel real handlers (Node, not browser acceptance)', () => {
  it('is reachable in the existing panel and does not run on implicit submit or IME confirmation', () => {
    useAppStore.getState().toggleStrength();
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toContain('solid-analysis-open');
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toContain('solid-analysis-panel');
    const rows = elements(), form = rows[0], run = rows.find(row => row['data-testid'] === 'solid-run');
    expect(run?.type).toBe('button');
    form.onSubmit?.({ preventDefault: vi.fn() }); expect(runner.run).not.toHaveBeenCalled();
    const before = useAppStore.getState().solidAnalysisSession;
    for (const key of ['Enter', 'Escape']) form.onKeyDown?.({ key, nativeEvent: { isComposing: true, keyCode: 229 },
      preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(useAppStore.getState().solidAnalysisSession).toBe(before);
    form.onCompositionStart?.(); run?.onClick?.(); expect(runner.run).not.toHaveBeenCalled();
    form.onCompositionEnd?.(); run?.onClick?.(); expect(runner.run).toHaveBeenCalledOnce();
    rows.find(row => row['data-testid'] === 'solid-fixed')?.onClick?.();
    expect(runner.captureFaces).toHaveBeenCalledWith('fixed');
    form.onKeyDown?.({ key: 'Escape', nativeEvent: { isComposing: false, keyCode: 27 },
      preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(useAppStore.getState().solidAnalysisSession).toBeNull();
  });
  it('shows exactly one load mode, its fields and the signed pressure explanation through the real handlers', () => {
    useAppStore.getState().toggleStrength();
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    const fieldKeys = (): string[] => elements().flatMap(row => row.field ? [row.field.key] : []);
    const radio = (mode: 'traction' | 'pressure'): Props | undefined =>
      elements().find(row => row['data-testid'] === `solid-load-${mode}`);
    expect(radio('traction')?.checked).toBe(true); expect(radio('pressure')?.checked).toBe(false);
    expect(fieldKeys()).toEqual(['young', 'poisson', 'tx', 'ty', 'tz', 'linear', 'angular', 'chord', 'volume']);
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).not.toContain(t('solidAnalysis.pressureHelp'));
    runner.cancel.mockClear();
    radio('pressure')?.onChange?.('pressure');
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(useAppStore.getState().solidAnalysisSession?.loadMode).toBe('pressure');
    expect(radio('pressure')?.checked).toBe(true);
    expect(fieldKeys()).toEqual(['young', 'poisson', 'pressure', 'linear', 'angular', 'chord', 'volume']);
    const markup = renderToStaticMarkup(<StrengthPropertyPanel />);
    for (const key of ['solidAnalysis.loadMode', 'solidAnalysis.loadTraction', 'solidAnalysis.loadPressure',
      'solidAnalysis.pressure', 'solidAnalysis.pressureHelp'] as const) expect(markup).toContain(t(key));
    elements().find(row => row.field?.key === 'pressure')?.onChange?.('-3');
    expect(useAppStore.getState().solidAnalysisSession?.values.pressure).toBe('-3');
    radio('traction')?.onChange?.('traction');
    expect(useAppStore.getState().solidAnalysisSession).toMatchObject({ loadMode: 'traction', values: { pressure: '-3' } });
  });
});
