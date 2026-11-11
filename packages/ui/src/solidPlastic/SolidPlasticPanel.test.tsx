import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { StrengthPropertyPanel } from '../strength/StrengthPropertyPanel.js';
import { StrengthPanel } from '../strength/StrengthPanel.js';

/** PROVISIONAL (authored, unexecuted). Static markup of the real panels from the real store. */
const runner = () => ({ run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() });
beforeEach(() => {
  resetTestStore(); useAppStore.setState({ solidPlasticSession: null, solidPlasticRunner: null });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
});
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState({ solidPlasticSession: null, solidPlasticRunner: null }); resetTestStore(); });

describe('solid plasticity panel (authored, unexecuted)', () => {
  it('is reachable from the strength panel of a part and replaces it in the right column', () => {
    useAppStore.getState().toggleStrength();
    const session = useAppStore.getState().strengthSession;
    if (!session) throw new Error('Missing strength session');
    expect(renderToStaticMarkup(<StrengthPanel session={session} />)).toContain('data-testid="solid-plastic-open"');
    useAppStore.setState({ solidPlasticRunner: runner() });
    useAppStore.getState().openSolidPlastic();
    const html = renderToStaticMarkup(<StrengthPropertyPanel />);
    expect(html).toContain('data-testid="solid-plastic-panel"');
    expect(html).not.toContain('data-testid="solid-plastic-open"');
  });

  it('always states the small-strain, contact and large-deformation limits and asks for the material source', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidPlasticRunner: runner() });
    useAppStore.getState().openSolidPlastic();
    const html = renderToStaticMarkup(<StrengthPropertyPanel />);
    expect(html).toContain(t('solidPlastic.assumptions'));
    expect(html).toContain(t('solidPlastic.referenceHelp'));
    expect(html).toContain('data-testid="solid-plastic-reference"');
    expect(html).toContain('data-testid="solid-plastic-history"');
    expect(html).not.toContain('data-testid="solid-plastic-results"');
  });

  it('shows the cancelled state without a result and disables cancel when nothing runs', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidPlasticRunner: runner() });
    useAppStore.getState().openSolidPlastic();
    useAppStore.getState().cancelSolidPlastic();
    const html = renderToStaticMarkup(<StrengthPropertyPanel />);
    expect(html).toContain(t('solidPlastic.cancelled'));
    expect(html).not.toContain('data-testid="solid-plastic-results"');
  });
});
