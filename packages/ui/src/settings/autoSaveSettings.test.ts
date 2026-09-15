import { describe, expect, it } from 'vitest';
import { parseAutoSaveMinutes, readAutoSaveIntervalMs } from './autoSaveSettings.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings } from './settings.js';

describe('自動保存の間隔を既存の端末設定へ保存する', () => {
  it('空欄・小数・非有限・単位つき・範囲外を断り、分の整数だけを受け取る', () => {
    for (const input of ['', ' ', '0', '-1', '61', '1.5', 'NaN', 'Infinity', '1e1', '5分']) expect(parseAutoSaveMinutes(input)).toBeNull();
    expect(parseAutoSaveMinutes(' 1 ')).toBe(1); expect(parseAutoSaveMinutes('60')).toBe(60);
    expect(parseAutoSaveMinutes('05')).toBe(5);
  });
  it('旧設定や壊れた間隔でも既存テーマを残し、自動保存を5分で続ける', () => {
    for (const interval of [undefined, null, false, '', 0, 60_001, 3_600_001, Infinity]) {
      const setting = { ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 125, autoSaveIntervalMs: interval };
      const result = loadSettings({ getItem: () => JSON.stringify(setting), setItem: () => undefined });
      expect(result.theme).toBe('lightModern'); expect(result.uiScale).toBe(125);
      expect(readAutoSaveIntervalMs(result)).toBe(300_000);
    }
  });
  it('保存して再起動しても間隔と既存設定が同じである', () => {
    const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); } };
    const configured = { ...DEFAULT_DISPLAY_SETTINGS, autoSaveIntervalMs: 60_000, uiScale: 125 };
    saveSettings(configured, storage); expect(loadSettings(storage)).toEqual(configured);
    expect(data.size).toBe(1);
  });
});
