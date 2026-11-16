import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRadialCommandIds } from '../commands/radialCommandItems.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { RadialMenuForm } from './RadialMenuForm.js';
import { loadSettings, saveSettings, type SettingsStorage } from './settings.js';

/* 設計 2-4・B-08f: 操作の割り当ての窓のタブ「放射メニュー」。既定は部品の既定の並び。保存の値は種類ごとに読む。 */
beforeEach(resetTestStore);
afterEach(resetTestStore);
const render = (): string => renderCurrentStore(RadialMenuForm);
const PART_CUSTOM = ['toolbar.sketch.select', 'toolbar.shape.circle', 'toolbar.sketch.line', 'toolbar.shape.rectangle',
  'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'history.redo'] as const;

describe('放射メニューの中身の form', () => {
  it('画面の選択と 8 つの方向の選択を、説明つきで、部品の既定の並びで出す(適用・戻すは押せない)', () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t('settings.radial.title')}"`);
    expect(markup.match(/<select\b/gu)).toHaveLength(9);
    expect(markup).toContain(`title="${t('settings.radial.kindGuide')}"`);
    expect(markup).toContain(`title="${t('settings.radial.slotGuide').replace('{direction}', t('settings.radial.slot.upLeft'))}"`);
    for (const id of defaultRadialCommandIds('part')) expect(markup).toContain(`<option value="${id}" selected="">`);
    // 文脈の差し込みの命令は選べない。
    expect(markup).not.toContain('value="sketch.connectPoints"');
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""/u);
    expect(markup).toContain('data-settings-draft="false"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('role="status"');
  });

  it('保存した並びを選んだ状態で出し、読めずに既定へ戻した画面の数を知らせる', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, radialCommands: { part: PART_CUSTOM }, radialCommandsRecovered: 1 });
    const markup = render();
    expect(markup).toContain('<option value="history.redo" selected="">');
    expect(markup).not.toContain('<option value="history.undo" selected="">');
    expect(markup).toContain(`<p role="status">${t('settings.radial.recovered').replace('{count}', '1')}</p>`);
  });

  it('端末への保存と読み込み: 並びは書き戻し、読めなかった数は保存しない。壊れた種類は既定へ戻して数える', () => {
    const values = new Map<string, string>();
    const storage: SettingsStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
    const state = useAppStore.getState();
    saveSettings({ ...state.displaySettings, radialCommands: { part: PART_CUSTOM }, radialCommandsRecovered: 2 }, storage);
    const loaded = loadSettings(storage);
    expect(loaded.radialCommands).toEqual({ part: PART_CUSTOM });
    expect(loaded.radialCommandsRecovered).toBeUndefined();
    const key = [...values.keys()][0] ?? '';
    const stored: unknown = JSON.parse(values.get(key) ?? '{}');
    const base = typeof stored === 'object' && stored !== null ? stored : {};
    values.set(key, JSON.stringify({ ...base, radialCommands: { part: PART_CUSTOM, drawing: [] } }));
    const broken = loadSettings(storage);
    expect(broken.radialCommands).toEqual({ part: PART_CUSTOM });
    expect(broken.radialCommandsRecovered).toBe(1);
  });
});
