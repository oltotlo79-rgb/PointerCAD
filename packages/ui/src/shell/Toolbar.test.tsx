import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('document mode indicator', () => {
  it.each(['part', 'assembly'] as const)('names %s accessibly without adding an action or a tab stop', kind => {
    if (kind === 'assembly') useAppStore.getState().openAssembly(createAssemblyDocument('Assembly'));
    const before = useAppStore.getState();
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    const html = renderToStaticMarkup(createElement(Toolbar));
    const mode = html.match(/<div class="pcad-toolbar__modes"[^>]*>(.*?)<\/div>/u)?.[0];
    expect(mode).toBeDefined();
    expect(mode).toContain(`aria-label="${t('toolbar.mode.groupLabel')}"`);
    expect(mode).toContain(`aria-label="${t(kind === 'assembly' ? 'assembly.mode' : 'toolbar.mode.modeling')}"`);
    expect(mode).toContain('role="img"');
    expect(mode).toContain('pcad-toolbar__mode-label');
    expect(mode).not.toMatch(/<button|<a |tabindex|aria-pressed|pcad-tab/u);
    expect(useAppStore.getState()).toBe(before);
  });
});
