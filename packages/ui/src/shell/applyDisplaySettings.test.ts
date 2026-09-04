/**
 * ルート要素への表示設定の反映(計画書 docs/plans/P4-スケッチ拡張.md タスク1、§0.a-0.1、0.2)。
 *
 * `document` を持たない検査環境(vitest.config.ts の `environment: 'node'`)でも確かめられるよう、
 * `ThemeRootElement` を満たす最小限の偽物を使う。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DISPLAY_SETTINGS } from '../settings/settings.js';
import { createInitialDocumentState, useAppStore } from '../store/useAppStore.js';
import { applyDisplaySettings, attachDisplaySettings, type ThemeRootElement } from './applyDisplaySettings.js';

/** 呼ばれた `--pcad-scale` の値を覚える、検査用の最小限のルート要素。 */
function createFakeRoot(): ThemeRootElement & { properties: Map<string, string> } {
  const properties = new Map<string, string>();
  return {
    dataset: {},
    style: {
      setProperty: (property, value) => {
        properties.set(property, value);
      },
    },
    properties,
  };
}

beforeEach(() => {
  useAppStore.setState({
    ...createInitialDocumentState(),
    displaySettings: DEFAULT_DISPLAY_SETTINGS,
  });
});

describe('applyDisplaySettings(FR-908, FR-909)', () => {
  it('data-theme 属性を設定する', () => {
    const root = createFakeRoot();
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', uiScale: 100 }, root);
    expect(root.dataset.theme).toBe('light');
  });

  it('--pcad-scale を uiScale/100 の倍率で設定する(90〜150% → 0.9〜1.5)', () => {
    const root = createFakeRoot();
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'dark', uiScale: 130 }, root);
    expect(root.properties.get('--pcad-scale')).toBe('1.3');
  });

  it('拡大率 90 と 150 の境界でも正しい倍率になる', () => {
    const root = createFakeRoot();
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'dark', uiScale: 90 }, root);
    expect(root.properties.get('--pcad-scale')).toBe('0.9');
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'dark', uiScale: 150 }, root);
    expect(root.properties.get('--pcad-scale')).toBe('1.5');
  });

  it('data-ui-scale 属性を uiScale の数のまま設定する(appShell.css の2段の整形が読む、P4 タスク2 仕上げ)', () => {
    const root = createFakeRoot();
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'dark', uiScale: 125 }, root);
    expect(root.dataset.uiScale).toBe('125');
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'dark', uiScale: 150 }, root);
    expect(root.dataset.uiScale).toBe('150');
    applyDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'dark', uiScale: 100 }, root);
    expect(root.dataset.uiScale).toBe('100');
  });
});

describe('attachDisplaySettings(ストアの変化への配線)', () => {
  it('つないだ直後に今の表示設定を反映する', () => {
    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 110 });
    const root = createFakeRoot();

    const detach = attachDisplaySettings(root);

    expect(root.dataset.theme).toBe('modern');
    expect(root.properties.get('--pcad-scale')).toBe('1.1');
    expect(root.dataset.uiScale).toBe('110');
    detach();
  });

  it('setDisplaySettings で変わるたびに反映し直す', () => {
    const root = createFakeRoot();
    const detach = attachDisplaySettings(root);
    expect(root.dataset.theme).toBe(DEFAULT_DISPLAY_SETTINGS.theme);

    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 140 });
    expect(root.dataset.theme).toBe('lightModern');
    expect(root.properties.get('--pcad-scale')).toBe('1.4');
    expect(root.dataset.uiScale).toBe('140');
    detach();
  });

  it('関係ない状態の変化では反映し直さない(同じ参照のときは書き込まない)', () => {
    const root = createFakeRoot();
    const detach = attachDisplaySettings(root);
    root.dataset.theme = undefined;

    useAppStore.getState().setSelection(['point-1']);
    expect(root.dataset.theme).toBeUndefined();
    detach();
  });

  it('戻り値を呼ぶと見張りをやめる', () => {
    const root = createFakeRoot();
    const detach = attachDisplaySettings(root);
    detach();

    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'darkModern', uiScale: 120 });
    // 見張りを外した後の変化は反映されない(直前の値のまま)。
    expect(root.dataset.theme).toBe(DEFAULT_DISPLAY_SETTINGS.theme);
  });
});
