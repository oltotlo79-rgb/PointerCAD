import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SnapRadiusForm } from './SnapRadiusForm.js';

/* 配置の補助 P-D: 操作の割り当ての窓のタブ「マウスのボタン」の、吸着の幅の form(SnapPauseForm.test.tsx と同じ確かめ方)。 */
beforeEach(resetTestStore);
afterEach(resetTestStore);
const render = (): string => renderCurrentStore(SnapRadiusForm);

describe('吸着の幅の form', () => {
  it('説明つきの 3 つの選択を出し、既定は 中(今までと同じ半径)で、適用・戻すは押せない', () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t('settings.snapRadius.title')}"`);
    expect(markup).toContain(`title="${t('settings.snapRadius.guide')}"`);
    expect(markup.match(/<option value="/gu)).toHaveLength(3);
    expect(markup).toContain(`<option value="medium" selected="">${t('settings.snapRadius.medium')}</option>`);
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""/u);
    expect(markup).toContain('data-settings-draft="false"');
    expect(markup).toContain(t('settings.snapRadius.hint'));
  });

  it('保存した幅を選んだ状態で出す', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, snapRadius: 'large' });
    expect(render()).toContain(`<option value="large" selected="">${t('settings.snapRadius.large')}</option>`);
  });
});
