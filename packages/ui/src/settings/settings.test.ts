/**
 * 表示設定の永続化(計画書 docs/plans/P4-スケッチ拡張.md タスク1)。
 *
 * 対応要件: FR-908(表示テーマの切替)、FR-909(表示の拡大率)。検証表(タスク1)どおり、
 * 既定・検証(範囲外は個別に丸めず既定へ戻す)・往復・`localStorage` 無しでも動くことを確かめる。
 */

import { describe, expect, it } from 'vitest';

import {
  clampUiScale,
  DEFAULT_DISPLAY_SETTINGS,
  hasLocalStorage,
  loadSettings,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  saveSettings,
  type DisplaySettings,
  type SettingsStorage,
} from './settings.js';

/** `Map` を裏に持つ、検査用の最小限の `localStorage` 相当品。 */
function createFakeStorage(initial: Readonly<Record<string, string>> = {}): SettingsStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('表示設定の永続化(FR-908, FR-909)', () => {
  it('空の storage は既定値を返す', () => {
    expect(loadSettings(createFakeStorage())).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('storage が無い(null)ときも既定値を返す', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('壊れた JSON は既定値を返す', () => {
    const storage = createFakeStorage({ 'pointercad.settings': '{not json' });
    expect(loadSettings(storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('知らないテーマは既定値へ丸ごと戻す(その欄だけを直さない)', () => {
    const storage = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'unknown', uiScale: 120 }),
    });
    expect(loadSettings(storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('範囲外の拡大率は既定値へ丸ごと戻す(個別の丸めは clampUiScale の役目)', () => {
    const storage = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 200 }),
    });
    expect(loadSettings(storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('uiScale が数でなければ既定値へ戻す', () => {
    const storage = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: '120' }),
    });
    expect(loadSettings(storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('保存して読み直すと同じ値になる(往復)', () => {
    const storage = createFakeStorage();
    const settings: DisplaySettings = { theme: 'lightModern', uiScale: 130 };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('storage が無いときの保存は何もせず、例外も投げない', () => {
    expect(() => {
      saveSettings({ theme: 'modern', uiScale: 110 }, null);
    }).not.toThrow();
  });

  it('setItem が例外を投げる環境でも保存は諦めるだけで例外を外へ出さない', () => {
    const storage: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('書き込めません');
      },
    };
    expect(() => {
      saveSettings({ theme: 'darkModern', uiScale: 100 }, storage);
    }).not.toThrow();
  });

  it('getItem が例外を投げる環境では既定値を返す', () => {
    const storage: SettingsStorage = {
      getItem: () => {
        throw new Error('読めません');
      },
      setItem: () => undefined,
    };
    expect(loadSettings(storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('clampUiScale は範囲外を境界値へ丸める', () => {
    expect(clampUiScale(80)).toBe(MIN_UI_SCALE);
    expect(clampUiScale(200)).toBe(MAX_UI_SCALE);
    expect(clampUiScale(120)).toBe(120);
  });

  it('hasLocalStorage は getItem/setItem を持つものだけを使えると判定する', () => {
    expect(hasLocalStorage({ localStorage: createFakeStorage() })).toBe(true);
    expect(hasLocalStorage({})).toBe(false);
    expect(hasLocalStorage({ localStorage: {} })).toBe(false);
  });

  it('localStorage という欄に触れるだけで例外を投げる環境も使えないと判定する', () => {
    const scope = {
      get localStorage(): SettingsStorage {
        throw new Error('アクセスできません');
      },
    };
    expect(hasLocalStorage(scope)).toBe(false);
  });

  it('この実行環境(Node、テスト)には localStorage が無い', () => {
    // Vitest は environment: 'node' で動く(packages/ui/vitest.config.ts)。
    // 既定引数(globalThis)での判定がここでも false になることを確かめる。
    expect(hasLocalStorage()).toBe(false);
    expect(loadSettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });
});
