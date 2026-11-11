import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidModalSection } from './SolidModalSection.js';
import { initialSolidModalState } from './solidModalState.js';

const runner = () => ({ run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn(), runModal: vi.fn(), cancelModal: vi.fn() });

/**
 * Server rendering normally reads the store's initial snapshot (zustand passes getInitialState as getServerSnapshot),
 * not the state the test just wrote. Same deliberate current-snapshot pattern as ParameterPanel.test.ts: only the
 * snapshot source is replaced for this one render; the real store, selectors and actions are used unchanged.
 */
function markup(node: ReactElement): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(node); } finally { snapshot.mockRestore(); }
}

beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidModal: initialSolidModalState() }); });
afterEach(() => { useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidModal: initialSolidModalState() }); resetTestStore(); });

describe('SolidModalSection', () => {
  it('renders labelled physical inputs and refuses to run without a valid density', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidAnalysisRunner: runner() });
    useAppStore.getState().openSolidAnalysis();
    const empty = markup(<SolidModalSection />);
    expect(empty).toContain(t('solidAnalysis.modalDensity'));
    expect(empty).toContain(t('solidAnalysis.modalCount'));
    expect(empty).toMatch(/<label>[^<]*<input type="text" inputmode="decimal" data-testid="solid-modal-density"/i);
    expect(empty).toContain(t('solidAnalysis.modalInputInvalid'));
    expect(empty).toMatch(/data-testid="solid-modal-run" disabled=""/);
    expect(empty).toContain(t('solidAnalysis.modalEmpty'));
    useAppStore.getState().editSolidModalInput('density', '7850');
    const ready = markup(<SolidModalSection />);
    expect(ready).not.toContain(t('solidAnalysis.modalInputInvalid'));
    expect(ready).not.toMatch(/data-testid="solid-modal-run" disabled=""/);
  });

  it('cannot run without a runner that supports the modal analysis', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() } });
    useAppStore.getState().openSolidAnalysis();
    useAppStore.getState().editSolidModalInput('density', '7850');
    expect(markup(<SolidModalSection />)).toMatch(/data-testid="solid-modal-run" disabled=""/);
  });

  it('shows a failed solve as an alert and offers no mode', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidAnalysisRunner: runner() });
    useAppStore.getState().openSolidAnalysis();
    const id = useAppStore.getState().startSolidModal();
    useAppStore.getState().receiveSolidModal(id, { kind: 'failed', message: 'solid-modal-mechanism: free body' });
    const rendered = markup(<SolidModalSection />);
    expect(rendered).toContain('solid-modal-mechanism: free body');
    expect(rendered).toContain(t('solidAnalysis.modalFailed'));
    expect(rendered).not.toContain('solid-modal-mode-');
  });
});
