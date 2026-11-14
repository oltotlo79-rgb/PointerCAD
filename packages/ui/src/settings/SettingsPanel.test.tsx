import ReactHooks, * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { SettingsPanel } from './SettingsPanel.js';

vi.mock('react', { spy: true });

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/** The panel's own open state (its first useState) is forced; every form inside keeps its real state. */
function renderPanel(closing: 'confirm' | 'failed' | null = null): string {
  const state = vi.spyOn(React, 'useState').mockReturnValueOnce([true, vi.fn()]);
  if (closing !== null) state.mockReturnValueOnce([closing, vi.fn()]);
  vi.spyOn(ReactHooks, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  return renderToStaticMarkup(React.createElement(SettingsPanel));
}
const SECTIONS = ['display', 'controls', 'autoSave', 'toolDefaults', 'other'] as const;
function section(markup: string, key: typeof SECTIONS[number]): string {
  const start = markup.indexOf(`<summary class="pcad-settings__section-title">${t(`toolbar.settings.section.${key}`)}</summary>`);
  expect(start, key).toBeGreaterThanOrEqual(0);
  return markup.slice(start, markup.indexOf('</details>', start));
}

describe('設定の窓の題・見出し・入口(報告の指摘 7、統括の決定 2)', () => {
  it('題は「設定」で、入口の説明は中身の節を名指しする', () => {
    expect(t('settings.title')).toBe('設定');
    const markup = renderPanel();
    expect(markup).toContain(`<span class="pcad-settings__title">${t('settings.title')}</span>`);
    expect(markup).toContain(`aria-label="${t('settings.title')}"`);
    for (const word of ['表示', '視点の操作', 'キーの割り当て', '自動保存', '道具の初期値']) {
      expect(t('toolbar.settings.openTooltip')).toContain(word);
    }
  });

  it('中身を 5 つの畳める見出しに分け、最初は全て開いている', () => {
    const markup = renderPanel();
    expect([...markup.matchAll(/<summary class="pcad-settings__section-title">([^<]*)<\/summary>/gu)].map(match => match[1]))
      .toEqual(SECTIONS.map(key => t(`toolbar.settings.section.${key}`)));
    expect(markup.match(/<details class="pcad-settings__section" open="">/gu)).toHaveLength(SECTIONS.length);
  });

  it('視点の操作とキーの割り当ては「操作の割り当て」の 1 つの見出しの下にまとまる', () => {
    const markup = renderPanel();
    const controls = section(markup, 'controls');
    expect(controls).toContain(`aria-label="${t('settings.camera.title')}"`);
    expect(controls).toContain(`aria-label="${t('settings.shortcuts.title')}"`);
    expect(section(markup, 'display')).toContain(`aria-label="${t('settings.theme.label')}"`);
    expect(section(markup, 'autoSave')).toContain(`aria-label="${t('settings.autoSave.title')}"`);
    expect(section(markup, 'toolDefaults')).toContain(`aria-label="${t('settings.toolDefaults.title')}"`);
    expect(section(markup, 'other')).toContain(t('tutorial.start'));
  });

  it('下書きがある時の確かめは窓の中に 3 つの選択を出し、適用できなかった時は理由を添える', () => {
    const confirm = renderPanel('confirm');
    expect(confirm).toContain(t('toolbar.settings.draft.message'));
    for (const key of ['applyClose', 'discardClose', 'continue'] as const) {
      expect(confirm).toContain(`>${t(`toolbar.settings.draft.${key}`)}</button>`);
    }
    expect(confirm).not.toContain(t('toolbar.settings.draft.applyFailed'));
    expect(renderPanel('failed')).toContain(t('toolbar.settings.draft.applyFailed'));
    expect(renderPanel()).not.toContain(t('toolbar.settings.draft.message'));
  });
});
