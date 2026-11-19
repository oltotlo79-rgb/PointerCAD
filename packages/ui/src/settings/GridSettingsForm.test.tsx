import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { GridSettingsForm } from './GridSettingsForm.js';

/* 配置の補助 P-C: 設定の一覧の「表示」の節の、方眼の幅と数の form(SnapPauseForm.test.tsx と同じ確かめ方)。 */
beforeEach(resetTestStore);
afterEach(resetTestStore);
const render = (): string => renderCurrentStore(GridSettingsForm);

describe('方眼の幅と数の form', () => {
  it('既定は自動で、幅と数の欄は使えず、適用・戻すは押せない', () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t('settings.grid.title')}"`);
    expect(markup).toContain(`title="${t('settings.grid.modeGuide')}"`);
    expect(markup.match(/<option value="/gu)).toHaveLength(2);
    expect(markup).toContain(`<option value="auto" selected="">${t('settings.grid.mode.auto')}</option>`);
    expect(markup.match(/<input[^>]*disabled=""/gu)).toHaveLength(2);
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""/u);
    expect(markup).toContain('data-settings-draft="false"');
  });

  it('保存した固定の幅と数を出し、欄が使える', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, grid: { mode: 'fixed', stepMm: 200, count: 5 } });
    const markup = render();
    expect(markup).toContain(`<option value="fixed" selected="">${t('settings.grid.mode.fixed')}</option>`);
    expect(markup).toContain('value="200"');
    expect(markup).toContain('value="5"');
    expect(markup.match(/<input[^>]*disabled=""/gu)).toBeNull();
  });
});
