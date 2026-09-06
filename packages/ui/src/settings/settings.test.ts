/**
 * 表示設定の永続化(計画書 docs/plans/P4-スケッチ拡張.md タスク1)。
 *
 * 対応要件: FR-908(表示テーマの切替)、FR-909(表示の拡大率)。検証表(タスク1)どおり、
 * 既定・検証(範囲外は個別に丸めず既定へ戻す)・往復・`localStorage` 無しでも動くことを確かめる。
 */

import { serializeDocument } from '@pointercad/io';
import { createEmptyPartDocument, LENGTH_UNITS } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { TRACK_ANGLE_STEPS } from '../sketch/trackMath.js';
import { ALL_SELECTABLE } from '../solid/selectionFilter.js';
import {
  clampUiScale,
  DEFAULT_DISPLAY_SETTINGS,
  hasLocalStorage,
  LENGTH_UNIT_LABEL_KEYS,
  loadSettings,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  nearestUiScaleStep,
  nextLengthUnit,
  nextThemeIndex,
  saveSettings,
  THEME_IDS,
  UI_SCALE_STEPS,
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
    const settings: DisplaySettings = { ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 130 };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('storage が無いときの保存は何もせず、例外も投げない', () => {
    expect(() => {
      saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 110 }, null);
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
      saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'darkModern', uiScale: 100 }, storage);
    }).not.toThrow();
  });

  it('角度の刻みの既定は 15°(FR-110、§0.12)', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.trackAngleStep).toBe(15);
    expect(TRACK_ANGLE_STEPS).toContain(DEFAULT_DISPLAY_SETTINGS.trackAngleStep);
  });

  it('選んだ角度の刻みを覚え、読み直しても保たれる(端末に保存)', () => {
    const storage = createFakeStorage();
    for (const step of TRACK_ANGLE_STEPS) {
      saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, trackAngleStep: step }, storage);
      expect(loadSettings(storage).trackAngleStep).toBe(step);
    }
  });

  it('一覧に無い角度の刻み(7°)はこの欄だけ既定の 15° へ戻す(NFR-UX-4)', () => {
    const storage = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 120, trackAngleStep: 7 }),
    });
    const loaded = loadSettings(storage);
    expect(loaded.trackAngleStep).toBe(15);
    // テーマと拡大率は壊れていないので、そちらは保存された値のまま残る。
    expect(loaded.theme).toBe('light');
    expect(loaded.uiScale).toBe(120);
  });

  it('角度の刻みが数でない・欄そのものが無いときも既定の 15° にし、他の欄は捨てない', () => {
    // 欄が無いのは P4b より前に保存された値の形。テーマまで既定へ戻すと、
    // 前の版から使っている利用者の好みを失う(前方互換、settings.ts の注釈)。
    const old = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'modern', uiScale: 110 }),
    });
    expect(loadSettings(old)).toEqual({
      ...DEFAULT_DISPLAY_SETTINGS,
      theme: 'modern',
      uiScale: 110,
    });

    const broken = createFakeStorage({
      'pointercad.settings': JSON.stringify({
        theme: 'modern',
        uiScale: 110,
        trackAngleStep: '15',
      }),
    });
    expect(loadSettings(broken).trackAngleStep).toBe(15);
  });

  it('つまみの案内の既読は既定で「まだ見せていない」(FR-507、利用者の決定①、タスク22b)', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.timelineHintSeen).toBe(false);
  });

  it('つまみの案内の既読を覚え、読み直しても保たれる(端末に保存)', () => {
    const storage = createFakeStorage();
    saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, timelineHintSeen: true }, storage);
    expect(loadSettings(storage).timelineHintSeen).toBe(true);
  });

  it('既読の欄が無い・真偽でないときはこの欄だけ既定へ戻し、他の欄は捨てない', () => {
    // 欄が無いのは P4b タスク22b より前に保存された値の形(前方互換、settings.ts の注釈)。
    const old = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 120, trackAngleStep: 30 }),
    });
    const loaded = loadSettings(old);
    expect(loaded.timelineHintSeen).toBe(false);
    expect(loaded.theme).toBe('light');
    expect(loaded.trackAngleStep).toBe(30);

    const broken = createFakeStorage({
      'pointercad.settings': JSON.stringify({
        theme: 'light',
        uiScale: 120,
        timelineHintSeen: 'yes',
      }),
    });
    const brokenLoaded = loadSettings(broken);
    expect(brokenLoaded.timelineHintSeen).toBe(false);
    expect(brokenLoaded.theme).toBe('light');
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

describe('設定パネルの刻みとキー操作(タスク2)', () => {
  it('テーマは 5 種で、既定のダークが先頭にある(FR-908)', () => {
    expect(THEME_IDS).toEqual(['dark', 'light', 'darkModern', 'lightModern', 'modern']);
    expect(THEME_IDS[0]).toBe(DEFAULT_DISPLAY_SETTINGS.theme);
  });

  it('拡大率の段は 90〜150 の中にあり、既定の 100 を含む(FR-909)', () => {
    expect(UI_SCALE_STEPS).toEqual([90, 100, 110, 125, 150]);
    for (const step of UI_SCALE_STEPS) {
      expect(step).toBeGreaterThanOrEqual(MIN_UI_SCALE);
      expect(step).toBeLessThanOrEqual(MAX_UI_SCALE);
    }
    expect(UI_SCALE_STEPS).toContain(DEFAULT_DISPLAY_SETTINGS.uiScale);
  });

  it('段そのものは自分自身へ丸まる', () => {
    for (const step of UI_SCALE_STEPS) {
      expect(nearestUiScaleStep(step)).toBe(step);
    }
  });

  it('段に無い値はいちばん近い段になり、同じ距離なら小さいほうを選ぶ', () => {
    expect(nearestUiScaleStep(104)).toBe(100);
    expect(nearestUiScaleStep(106)).toBe(110);
    // 105 は 100 と 110 のちょうど中間。
    expect(nearestUiScaleStep(105)).toBe(100);
    expect(nearestUiScaleStep(130)).toBe(125);
  });

  it('範囲外や数でない値でも必ず段が 1 つ決まる(空白にならない)', () => {
    expect(nearestUiScaleStep(10)).toBe(90);
    expect(nearestUiScaleStep(1000)).toBe(150);
    expect(nearestUiScaleStep(Number.NaN)).toBe(DEFAULT_DISPLAY_SETTINGS.uiScale);
  });

  it('矢印キーは前後へ動き、端では反対側へ回る', () => {
    expect(nextThemeIndex(0, 'ArrowRight')).toBe(1);
    expect(nextThemeIndex(0, 'ArrowDown')).toBe(1);
    expect(nextThemeIndex(4, 'ArrowRight')).toBe(0);
    expect(nextThemeIndex(0, 'ArrowLeft')).toBe(4);
    expect(nextThemeIndex(2, 'ArrowUp')).toBe(1);
  });

  it('Home / End は先頭と末尾、それ以外のキーでは動かない', () => {
    expect(nextThemeIndex(2, 'Home')).toBe(0);
    expect(nextThemeIndex(2, 'End')).toBe(THEME_IDS.length - 1);
    expect(nextThemeIndex(2, 'Enter')).toBeNull();
    expect(nextThemeIndex(2, 'a')).toBeNull();
    expect(nextThemeIndex(2, 'Escape')).toBeNull();
  });

  it('いまのテーマが分からない(-1)ときは先頭から動き始める', () => {
    expect(nextThemeIndex(-1, 'ArrowRight')).toBe(1);
    expect(nextThemeIndex(-1, 'ArrowLeft')).toBe(THEME_IDS.length - 1);
  });
});

/**
 * 表示の長さの単位(FR-811。計画書 docs/plans/P6-入出力.md タスク3 の検証表)。
 *
 * **内部は mm 固定**(NFR-RE-3)なので、ここで切り替わるのは表示だけである。
 * 検証表の 7 項目(既定 / 壊れた JSON / `localStorage` 無し / 往復 / 知らない単位 /
 * 欄そのものが無い / `.pcad` のバイト列が変わらない)をこの節で固定する。
 */
describe('表示の長さの単位(FR-811、P6 タスク3)', () => {
  it('既定は mm(既存の見た目を変えない)', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.lengthUnit).toBe('mm');
    expect(loadSettings(createFakeStorage()).lengthUnit).toBe('mm');
  });

  it('壊れた JSON では既定の mm になる', () => {
    const storage = createFakeStorage({ 'pointercad.settings': '{not json' });
    expect(loadSettings(storage).lengthUnit).toBe('mm');
  });

  it('localStorage が無い環境でも既定の mm で動く(P4 タスク1 の失敗の再発防止)', () => {
    expect(loadSettings(null).lengthUnit).toBe('mm');
    // 保存できない環境でも例外を外へ出さない(表示は既に切り替わっているので操作は止めない)。
    expect(() => {
      saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, lengthUnit: 'inch' }, null);
    }).not.toThrow();
  });

  it('inch を保存して読み直すと inch のまま(往復、端末に保存)', () => {
    const storage = createFakeStorage();
    saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, lengthUnit: 'inch' }, storage);
    expect(loadSettings(storage).lengthUnit).toBe('inch');
  });

  it('知らない単位・欄そのものが無いときはこの欄だけ既定へ戻し、他の欄は捨てない', () => {
    // 欄が無いのは P6 より前に保存された値の形(前方互換、settings.ts の注釈)。
    const old = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 120, trackAngleStep: 30 }),
    });
    const loaded = loadSettings(old);
    expect(loaded.lengthUnit).toBe('mm');
    expect(loaded.theme).toBe('light');
    expect(loaded.trackAngleStep).toBe(30);

    const broken = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 120, lengthUnit: 'cm' }),
    });
    const brokenLoaded = loadSettings(broken);
    expect(brokenLoaded.lengthUnit).toBe('mm');
    expect(brokenLoaded.theme).toBe('light');

    const notString = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 120, lengthUnit: 25.4 }),
    });
    expect(loadSettings(notString).lengthUnit).toBe('mm');
  });

  it('札を押すと mm と inch が入れ替わり、一覧の単位をすべて通る', () => {
    expect(nextLengthUnit('mm')).toBe('inch');
    expect(nextLengthUnit('inch')).toBe('mm');
    // 何度押しても一覧の外へ出ない(単位が増えても順ぐりに回る)。
    let unit = DEFAULT_DISPLAY_SETTINGS.lengthUnit;
    const seen = new Set<string>();
    for (let step = 0; step < LENGTH_UNITS.length; step += 1) {
      seen.add(unit);
      unit = nextLengthUnit(unit);
    }
    expect(seen.size).toBe(LENGTH_UNITS.length);
    expect(unit).toBe(DEFAULT_DISPLAY_SETTINGS.lengthUnit);
  });

  it('札の文言は単位ごとに ja.json から引ける(NFR-MA-5)', () => {
    for (const unit of LENGTH_UNITS) {
      expect(t(LENGTH_UNIT_LABEL_KEYS[unit]).length).toBeGreaterThan(0);
    }
    // 既存の固定の札とまったく同じ文字を mm 側に置いてある(見た目を変えない)。
    expect(t(LENGTH_UNIT_LABEL_KEYS.mm)).toBe(t('statusBar.unit'));
  });

  it('単位を切り替えても .pcad のバイト列が 1 バイトも変わらない(NFR-RE-3)', () => {
    /*
     * 表示の単位は**端末の設定**であって文書の属性ではない(§0.a-0.1)。
     * 保存時刻だけは呼ぶたびに変わるので、同じ値を渡して時刻の違いを除く
     * (`partFile.ts` の `COMPARISON_SAVED_AT` と同じ手)。
     */
    const document = createEmptyPartDocument();
    const savedAt = '2026-09-06T00:00:00.000Z';
    const storage = createFakeStorage();
    const encoder = new TextEncoder();

    saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, lengthUnit: 'mm' }, storage);
    const before = encoder.encode(serializeDocument(document, { savedAt }));

    saveSettings({ ...loadSettings(storage), lengthUnit: 'inch' }, storage);
    expect(loadSettings(storage).lengthUnit).toBe('inch');
    const after = encoder.encode(serializeDocument(document, { savedAt }));

    expect(after.length).toBe(before.length);
    expect([...after]).toEqual([...before]);
  });
});

describe('選択フィルタ(FR-112、P6 タスク36)', () => {
  it('既定は全部入(P4b までと同じ振る舞い)', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.selectionFilter).toEqual(ALL_SELECTABLE);
    expect(loadSettings(createFakeStorage()).selectionFilter).toEqual(ALL_SELECTABLE);
    expect(loadSettings(null).selectionFilter).toEqual(ALL_SELECTABLE);
  });

  it('端末に保存され、読み直すと同じ入切が戻る(往復)', () => {
    const storage = createFakeStorage();
    const filter = { vertex: false, edge: true, face: true, body: false };
    saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, selectionFilter: filter }, storage);
    expect(loadSettings(storage).selectionFilter).toEqual(filter);
  });

  it('P6 より前に保存された値(欄が無い)でも、テーマと拡大率は生き残る(前方互換)', () => {
    const storage = createFakeStorage({
      'pointercad.settings': JSON.stringify({ theme: 'light', uiScale: 120 }),
    });
    const loaded = loadSettings(storage);
    expect(loaded.theme).toBe('light');
    expect(loaded.uiScale).toBe(120);
    expect(loaded.selectionFilter).toEqual(ALL_SELECTABLE);
  });

  it('壊れている値はこの欄だけ全部入へ戻す(何も選べないまま起動しない)', () => {
    const broken = createFakeStorage({
      'pointercad.settings': JSON.stringify({
        theme: 'light',
        uiScale: 120,
        selectionFilter: { vertex: false, edge: 'no' },
      }),
    });
    const loaded = loadSettings(broken);
    expect(loaded.theme).toBe('light');
    expect(loaded.selectionFilter).toEqual(ALL_SELECTABLE);
  });

  it('余計な欄が混ざっていても 4 欄だけを写す', () => {
    const storage = createFakeStorage({
      'pointercad.settings': JSON.stringify({
        theme: 'dark',
        uiScale: 100,
        selectionFilter: { vertex: true, edge: false, face: true, body: true, sketch: true },
      }),
    });
    expect(Object.keys(loadSettings(storage).selectionFilter).sort()).toEqual([
      'body',
      'edge',
      'face',
      'vertex',
    ]);
  });

  it('入切を変えても .pcad のバイト列は 1 バイトも変わらない(形を変えない、FR-112)', () => {
    const document = createEmptyPartDocument();
    const savedAt = '2026-09-06T00:00:00.000Z';
    const storage = createFakeStorage();
    const encoder = new TextEncoder();

    saveSettings(DEFAULT_DISPLAY_SETTINGS, storage);
    const before = encoder.encode(serializeDocument(document, { savedAt }));

    saveSettings(
      { ...loadSettings(storage), selectionFilter: { vertex: false, edge: false, face: true, body: false } },
      storage,
    );
    const after = encoder.encode(serializeDocument(document, { savedAt }));

    expect([...after]).toEqual([...before]);
  });
});
