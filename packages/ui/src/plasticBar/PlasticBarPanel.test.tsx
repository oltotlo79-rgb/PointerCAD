import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { PlasticBarPanel } from './PlasticBarPanel.js';
import { BENCHMARK_EDITS, benchmarkResult } from './plasticBar.testSupport.js';
import { createPlasticBarSession, editPlasticBarSession, plasticBarInput, type PlasticBarSession } from './plasticBarSession.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

async function completed(): Promise<PlasticBarSession> {
  let session = createPlasticBarSession('plastic-bar-panel');
  for (const edit of BENCHMARK_EDITS) session = editPlasticBarSession(session, edit);
  const checked = plasticBarInput(session, []);
  if (!checked.ok) throw new Error(`Benchmark input rejected: ${checked.key}`);
  return { ...session, status: 'complete', result: await benchmarkResult(checked.input) };
}
function render(session: PlasticBarSession): string {
  useAppStore.setState({ plasticBarSession: session });
  return renderToStaticMarkup(<PlasticBarPanel session={session} />);
}

describe('PlasticBarPanel', () => {
  it('states the axial, small-strain, displacement-controlled scope and no certification', () => {
    const html = render(createPlasticBarSession('plastic-bar-panel'));
    expect(html).toContain('data-testid="plastic-bar-scope"');
    expect(html).toContain(t('plasticBar.scope'));
    expect(html).toContain(t('plasticBar.notCertified'));
    expect(html).toContain(t('plasticBar.materialHelp'));
    expect(html).not.toContain('data-testid="plastic-bar-results"');
  });

  it('shows the per-step result only for the current document and revision', async () => {
    const session = await completed();
    const html = render(session);
    expect(html).toContain('data-testid="plastic-bar-results"');
    expect(html).toContain('data-yielded="true"');
    expect((html.match(/data-plastic-bar-step="/gu) ?? []).length).toBe(4);
    expect(render({ ...session, revision: session.revision + 1 })).not.toContain('data-testid="plastic-bar-results"');
    expect(render({ ...session, ownerId: 'another-document' })).not.toContain('data-testid="plastic-bar-results"');
  });

  it('an input edit removes the result before anything is rendered', async () => {
    const edited = editPlasticBarSession(await completed(), { kind: 'value', field: 'hardening', source: '0' });
    expect(edited.result).toBeNull();
    expect(edited.status).toBe('editing');
    expect(render(edited)).not.toContain('data-testid="plastic-bar-results"');
  });
});
