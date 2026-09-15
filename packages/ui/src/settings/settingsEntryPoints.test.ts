import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, createDrawingDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingToolbar } from '../drawing/DrawingToolbar.js';
import { Toolbar } from '../shell/Toolbar.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('部品・組立・図面から共通の設定へ到達できる', () => {
  it.each(['part', 'assembly', 'drawing'] as const)('%sにも設定の入口を一つだけ出し、文書・保存・履歴を変えない', kind => {
    if (kind === 'assembly') useAppStore.getState().openAssembly(createAssemblyDocument('設定の入口'));
    if (kind === 'drawing') useAppStore.getState().openDrawing(createDrawingDocument('設定の入口', {
      sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
    }));
    const before = useAppStore.getState();
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    let markup: string;
    try { markup = renderToStaticMarkup(createElement(kind === 'drawing' ? DrawingToolbar : Toolbar)); }
    finally { snapshot.mockRestore(); }
    const buttons = markup.match(/<button\b[^>]*>/gu) ?? [];
    const settings = buttons.filter(button => button.includes(`aria-label="${t('toolbar.settings.open')}"`));
    expect(settings).toHaveLength(1);
    expect(settings[0]).toContain('aria-haspopup="true"');
    expect(settings[0]).toContain('aria-expanded="false"');
    expect(settings[0]).not.toContain(' disabled');
    expect(useAppStore.getState()).toBe(before);
  });
});
