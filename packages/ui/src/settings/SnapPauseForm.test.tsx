import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SnapPauseForm } from './SnapPauseForm.js';

/* 設計 B-09 3-2: 操作の割り当ての窓のタブ「マウスのボタン」の、吸着を一時止めるキーの form。 */
beforeEach(resetTestStore);
afterEach(resetTestStore);
const render = (): string => renderCurrentStore(SnapPauseForm);

function save(modifier: 'none' | 'shift' | 'ctrl'): void {
  const state = useAppStore.getState();
  state.setDisplaySettings({ ...state.displaySettings, snapPauseModifier: modifier });
}

describe('吸着を一時止めるキーの form', () => {
  it('説明つきの 3 つの選択を出し、既定は なし(今までと同じ動き)で、適用・戻すは押せない', () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t('settings.snapPause.title')}"`);
    expect(markup).toContain(`title="${t('settings.snapPause.guide')}"`);
    expect(markup.match(/<option value="/gu)).toHaveLength(3);
    expect(markup).toContain(`<option value="none" selected="">${t('settings.snapPause.none')}</option>`);
    expect(markup).toContain(`<p role="note">${t('settings.snapPause.noneNote')}</p>`);
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""/u);
    expect(markup).toContain('data-settings-draft="false"');
    expect(markup).toContain(t('settings.snapPause.hint'));
  });

  it('保存したキーを選んだ状態で出し、そのキーが今ほかに何をしているかを選ぶ前に示す', () => {
    save('shift');
    const shift = render();
    expect(shift).toContain(`<option value="shift" selected="">${t('settings.snapPause.shift')}</option>`);
    expect(shift).toContain(`<p role="note">${t('settings.snapPause.shiftNote')}</p>`);
    save('ctrl');
    const ctrl = render();
    expect(ctrl).toContain(`<option value="ctrl" selected="">${t('settings.snapPause.ctrl')}</option>`);
    expect(ctrl).toContain(`<p role="note">${t('settings.snapPause.ctrlNote')}</p>`);
  });
});
