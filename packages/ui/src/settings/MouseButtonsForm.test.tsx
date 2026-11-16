import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS } from '../commands/commandDefinitions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { MouseButtonsForm } from './MouseButtonsForm.js';
import { loadSettings, saveSettings, type SettingsStorage } from './settings.js';

/* 設計 2-4・B-08e: 操作の割り当ての窓のタブ「マウスのボタン」。既定は割当なし。保存の値は 1 件ずつ読む。 */
beforeEach(resetTestStore);
afterEach(resetTestStore);
const render = (): string => renderCurrentStore(MouseButtonsForm);

describe('マウスのボタンの操作の form', () => {
  it('戻る・進む・中ボタンのダブルクリックの 3 つの選択を、説明つきで、既定は割当なしで出す(適用・戻すは押せない)', () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t('settings.mouseButtons.title')}"`);
    expect(markup.match(/<select\b/gu)).toHaveLength(3);
    for (const key of ['back', 'forward', 'middleDouble'] as const) {
      expect(markup).toContain(`title="${t(`settings.mouseButtons.${key}Guide`)}"`);
    }
    // 各選択に「割当なし」と全ての命令。
    expect(markup.match(/<option value="" selected="">/gu)).toHaveLength(3);
    expect(markup.match(/<option value="/gu)).toHaveLength(3 * (COMMAND_DEFINITIONS.length + 1));
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""/u);
    expect(markup).toContain('data-settings-draft="false"');
    expect(markup).not.toContain('role="status"');
  });

  it('保存した割当を選んだ状態で出し、読めずに外した件数を 1 回だけ知らせる', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, mouseButtonCommands: { back: 'history.undo' }, mouseButtonCommandsRecovered: 2 });
    const markup = render();
    expect(markup).toContain('<option value="history.undo" selected="">');
    expect(markup.match(/<option value="" selected="">/gu)).toHaveLength(2);
    expect(markup).toContain(`<p role="status">${t('settings.mouseButtons.recovered').replace('{count}', '2')}</p>`);
  });

  it('端末への保存と読み込み: 割当は書き戻し、読めなかった件数は保存しない', () => {
    const values = new Map<string, string>();
    const storage: SettingsStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
    const state = useAppStore.getState();
    saveSettings({ ...state.displaySettings, mouseButtonCommands: { forward: 'history.redo' }, mouseButtonCommandsRecovered: 3 }, storage);
    const loaded = loadSettings(storage);
    expect(loaded.mouseButtonCommands).toEqual({ forward: 'history.redo' });
    expect(loaded.mouseButtonCommandsRecovered).toBeUndefined();
  });
});
