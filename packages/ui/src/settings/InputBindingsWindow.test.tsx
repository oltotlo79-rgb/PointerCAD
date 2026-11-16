import ReactHooks, * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { InputBindingsWindow } from './InputBindingsWindow.js';

vi.mock('react', { spy: true });

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/** The window's own tab and closing states (its first two useState calls) are forced; both forms keep their real state. */
function renderWindow(tab: 'view' | 'keys', closing: 'confirm' | 'failed' | null = null): string {
  vi.spyOn(React, 'useState').mockReturnValueOnce([tab, vi.fn()]).mockReturnValueOnce([closing, vi.fn()]);
  vi.spyOn(ReactHooks, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  return renderToStaticMarkup(React.createElement(InputBindingsWindow, { onClose: vi.fn() }));
}
/** The opening tag of one tab panel. */
function panel(markup: string, name: 'view' | 'keys'): string {
  const tag = new RegExp(`<div role="tabpanel" id="[^"]*-panel-${name}"[^>]*>`, 'u').exec(markup)?.[0];
  expect(tag, name).toBeDefined();
  return tag ?? '';
}

describe('操作の割り当ての窓(設計 1-4・§6)', () => {
  it('動かせる非モーダルの窓で、題・閉じるボタン・3 つのタブ(B-08e でマウスのボタンを足した)・開いたまま試せる案内を持つ', () => {
    const markup = renderWindow('view');
    expect(markup).toMatch(/^<dialog open="" class="pcad-input-bindings"/u);
    expect(markup).toContain(t('settings.inputBindings.title'));
    expect(markup).toContain(`title="${t('settings.inputBindings.closeGuide')}"`);
    expect(markup).toContain(`role="tablist" aria-label="${t('settings.inputBindings.tabs')}"`);
    expect(markup.match(/role="tab"/gu)).toHaveLength(3);
    for (const key of ['view', 'keys', 'mouse'] as const) {
      expect(markup).toContain(`>${t(`settings.inputBindings.tab.${key}`)}</button>`);
      expect(markup).toContain(`title="${t(`settings.inputBindings.tab.${key}Guide`)}"`);
    }
    expect(markup).toContain(t('settings.inputBindings.hint'));
    expect(markup).not.toContain(t('settings.inputBindings.draft.message'));
  });

  it('タブを替えても下書きを失わないよう 2 つの form を置いたまま、見えない方を hidden にする', () => {
    const view = renderWindow('view');
    expect(view).toContain(`aria-label="${t('settings.camera.title')}"`);
    expect(view).toContain(`aria-label="${t('settings.shortcuts.title')}"`);
    expect(view).toContain(`aria-label="${t('settings.mouseButtons.title')}"`);
    expect(panel(view, 'view')).not.toContain('hidden');
    expect(panel(view, 'keys')).toContain('hidden=""');
    const keys = renderWindow('keys');
    expect(panel(keys, 'view')).toContain('hidden=""');
    expect(panel(keys, 'keys')).not.toContain('hidden');
    expect(keys).toMatch(/id="[^"]*-tab-keys" aria-controls="[^"]*-panel-keys" aria-selected="true"/u);
    expect(view).toMatch(/id="[^"]*-tab-view" aria-controls="[^"]*-panel-view" aria-selected="true"/u);
  });

  it('閉じる時に下書きがあれば、窓の中に 3 つの選択を出し、適用できなかった時は理由を添える', () => {
    const confirm = renderWindow('view', 'confirm');
    expect(confirm).toContain(t('settings.inputBindings.draft.message'));
    for (const key of ['applyClose', 'discardClose', 'continue'] as const) {
      expect(confirm).toContain(`>${t(`settings.inputBindings.draft.${key}`)}</button>`);
      expect(confirm).toContain(`title="${t(`settings.inputBindings.draft.${key}Guide`)}"`);
    }
    expect(confirm).not.toContain(t('settings.inputBindings.draft.applyFailed'));
    expect(renderWindow('view', 'failed')).toContain(t('settings.inputBindings.draft.applyFailed'));
  });
});
