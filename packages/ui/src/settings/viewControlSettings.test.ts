import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_CONTROLS, type CameraBinding, type CameraControlSettings } from './cameraControlSettings.js';
import { loadSettings, saveSettings, type SettingsStorage } from './settings.js';
import {
  currentViewControls, DEFAULT_VIEW_CONTROLS, isViewControlSettings, readStoredViewControls, viewControlProblems, withViewControlPreset,
  type ViewControlOptions, type ViewControlSettings, type ViewTrigger,
} from './viewControlSettings.js';

/*
 * 設計 §4.4 の移行の規則 R1〜R8 と例 1〜4・7・8、§4.5 の問題 7 種、雛形 4 つ。
 * 期待は製品の既定値・移行の関数を使わずに書いた独立の表(v1 の値も同じく手で書く)。
 */
type Modifiers = Partial<Record<'alt' | 'shift' | 'ctrl' | 'meta', boolean>>;
const OFF = { alt: false, shift: false, ctrl: false, meta: false } as const;
const drag = (button: 'left' | 'middle' | 'right', modifiers: Modifiers = {}): ViewTrigger => ({ kind: 'drag', button, ...OFF, ...modifiers });
const wheel = (modifiers: Modifiers = {}): ViewTrigger => ({ kind: 'wheel', ...OFF, ...modifiers });
const v1 = (input: CameraBinding['input'], modifiers: Modifiers = {}): CameraBinding => ({ input, ...OFF, ...modifiers });
const OPTIONS: ViewControlOptions = { orbitSensitivity: 1, panSensitivity: 1, wheelSensitivity: 1, zoomDragSensitivity: 1,
  invertWheel: false, invertZoomDrag: false, invertOrbitX: false, invertOrbitY: false };
/** 例 1 の出力(今の既定の操作と同じ)。 */
const EXPECTED_DEFAULT: ViewControlSettings = { version: 2,
  bindings: { orbit: [drag('middle'), drag('left', { alt: true })], pan: [drag('right'), drag('middle', { shift: true })],
    zoom: [wheel(), wheel({ ctrl: true })] },
  options: OPTIONS };
const V1_DEFAULT: CameraControlSettings = { version: 1, orbit: [v1('middle'), v1('left', { alt: true })],
  pan: [v1('right'), v1('middle', { shift: true })], zoom: [v1('wheel'), v1('wheel', { ctrl: true })],
  wheelSensitivity: 1, dragSensitivity: 1, invertWheel: false, invertDrag: false };
const V1_FUSION: CameraControlSettings = { version: 1, orbit: [v1('middle', { shift: true })], pan: [v1('middle')], zoom: [v1('wheel')],
  wheelSensitivity: 2, dragSensitivity: 0.5, invertWheel: true, invertDrag: false };
const V2_FUSION: ViewControlSettings = { version: 2,
  bindings: { orbit: [drag('middle', { shift: true })], pan: [drag('middle')], zoom: [wheel()] },
  options: { ...OPTIONS, wheelSensitivity: 2, zoomDragSensitivity: 0.5, invertWheel: true } };
const KEY = 'pointercad.settings';

function memory(stored: object | null) {
  const records = new Map<string, string>(stored === null ? [] : [[KEY, JSON.stringify(stored)]]);
  const storage: SettingsStorage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); } };
  return { storage, raw: () => records.get(KEY) ?? null, write: (value: object) => { records.set(KEY, JSON.stringify(value)); } };
}
const core = { theme: 'lightModern', uiScale: 125 } as const;

describe('移行の例(設計 §4.4)', () => {
  it('例1: v1 の既定だけの保存は今の既定と同じ v2 になり、知らせず、v1 はそのまま残る', () => {
    const loaded = loadSettings(memory({ ...core, cameraControls: V1_DEFAULT }).storage);
    expect(loaded.viewControls).toEqual(EXPECTED_DEFAULT);
    expect(loaded.viewControlsRecovered).toBeUndefined();
    expect(loaded.cameraControls).toEqual(V1_DEFAULT);
  });

  it('例2: v1 の Fusion 風と利用者の感度・反転を v2 へ写す(利用者の今の設定を失わない)', () => {
    const loaded = loadSettings(memory({ ...core, cameraControls: V1_FUSION }).storage);
    expect(loaded.viewControls).toEqual(V2_FUSION);
    expect(loaded.viewControlsRecovered).toBeUndefined();
  });

  it('例3: 壊れた v1 は読めない 3 か所だけを捨てて既定へ戻し、v1 で断った 3 つ目の平行移動は残して知らせる', () => {
    const broken = { version: 1, orbit: [v1('middle'), v1('left')],
      pan: [v1('right'), v1('middle', { shift: true }), v1('left', { alt: true, shift: true })],
      zoom: [v1('wheel'), v1('wheel', { ctrl: true })], wheelSensitivity: 50, dragSensitivity: 1, invertWheel: 'yes', invertDrag: false };
    const loaded = loadSettings(memory({ ...core, cameraControls: broken }).storage);
    expect(loaded.viewControls).toEqual({ version: 2,
      bindings: { orbit: [drag('middle')], pan: [drag('right'), drag('middle', { shift: true }), drag('left', { alt: true, shift: true })],
        zoom: [wheel(), wheel({ ctrl: true })] },
      options: OPTIONS });
    expect(loaded.viewControlsRecovered).toBe(3);
    expect(loaded).toMatchObject(core);
  });

  it('例4: 視点の欄が無い古い設定は既定になり、テーマと拡大率はそのままで知らせない', () => {
    const loaded = loadSettings({ getItem: () => '{"theme":"light","uiScale":110}', setItem: () => undefined });
    expect(loaded.viewControls).toEqual(EXPECTED_DEFAULT);
    expect(loaded.viewControlsRecovered).toBeUndefined();
    expect([loaded.theme, loaded.uiScale]).toEqual(['light', 110]);
  });

  it('例7: 読める v2 と v1 が両方ある時は v2 を使い、v1 は読まずに 1 バイトも変えずに書き戻す', () => {
    const custom: ViewControlSettings = { version: 2,
      bindings: { orbit: [drag('right')], pan: [wheel(), drag('middle')], zoom: [wheel({ ctrl: true })] },
      options: { ...OPTIONS, orbitSensitivity: 2.5, panSensitivity: 0.4, invertOrbitY: true } };
    const store = memory({ ...core, cameraControls: V1_FUSION, viewControls: custom });
    const v1Bytes = JSON.stringify(V1_FUSION);
    const loaded = loadSettings(store.storage);
    expect(loaded.viewControls).toEqual(custom);
    expect(loaded.cameraControls).toEqual(V1_FUSION);
    saveSettings({ ...loaded, viewControls: { ...custom, options: { ...custom.options, invertOrbitX: true } } }, store.storage);
    expect(store.raw()).toContain(`"cameraControls":${v1Bytes}`);
    expect(loadSettings(store.storage).viewControls?.options.invertOrbitX).toBe(true);
  });

  it('例8: 新しい版の後に古い版で v1 を直すと、新しい版はその v1 から移し直す', () => {
    const store = memory({ ...core, cameraControls: V1_DEFAULT });
    const first = loadSettings(store.storage);
    saveSettings({ ...first, viewControls: { ...EXPECTED_DEFAULT, options: { ...OPTIONS, orbitSensitivity: 3 } } }, store.storage);
    // The older version keeps only the fields it knows (no viewControls) and writes its own v1 edit.
    const saved: unknown = JSON.parse(store.raw() ?? 'null');
    if (typeof saved !== 'object' || saved === null) throw new Error('Settings record missing');
    expect(saved).toHaveProperty('viewControls');
    const older = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'viewControls'));
    store.write({ ...older, cameraControls: V1_FUSION });
    const back = loadSettings(store.storage);
    expect(back.viewControls).toEqual(V2_FUSION);
    expect(back.viewControlsRecovered).toBeUndefined();
  });
});

describe('読む時の救い出し(R4・R5・R8)', () => {
  it('R4: 壊れた項目だけを捨て、空になった操作はほかで使っていない既定の入力で埋め、捨てた数を返す', () => {
    const result = readStoredViewControls({ viewControls: { version: 2,
      bindings: { orbit: [drag('middle'), { kind: 'gamepad', button: 3 }, drag('left')], pan: [drag('middle')],
        zoom: [wheel(), wheel({ ctrl: true }), wheel({ shift: true }), wheel({ alt: true }), wheel({ meta: true })] },
      options: { ...OPTIONS, orbitSensitivity: 3, panSensitivity: 0, wheelSensitivity: 2, invertZoomDrag: 'no', invertOrbitX: true } } });
    expect(result.settings).toEqual({ version: 2,
      bindings: { orbit: [drag('middle')], pan: [drag('right'), drag('middle', { shift: true })],
        zoom: [wheel(), wheel({ ctrl: true }), wheel({ shift: true }), wheel({ alt: true })] },
      options: { ...OPTIONS, orbitSensitivity: 3, wheelSensitivity: 2, invertOrbitX: true } });
    // gamepad, plain left, the duplicated middle, the fifth wheel, pan speed 0 and the non-boolean inversion.
    expect(result.dropped).toBe(6);
    expect(viewControlProblems(result.settings)).toEqual([]);
  });

  it('R4: v2 の割当と速さの欄が丸ごと読めない時は既定にし、欄ごとに数える', () => {
    expect(readStoredViewControls({ viewControls: { version: 2, bindings: { orbit: [] } } }))
      .toEqual({ settings: EXPECTED_DEFAULT, dropped: 4 });
    expect(readStoredViewControls({ viewControls: { version: 2, bindings: [], options: null } }))
      .toEqual({ settings: EXPECTED_DEFAULT, dropped: 2 });
  });

  it('R1: v2 が無く v1 が丸ごと壊れている時は既定にして知らせる(v1 の欄ごとに数える)', () => {
    expect(readStoredViewControls({ cameraControls: { version: 1, orbit: [] } })).toEqual({ settings: EXPECTED_DEFAULT, dropped: 7 });
    for (const cameraControls of [null, [], 'v1', { ...V1_FUSION, version: 99 }]) {
      expect(readStoredViewControls({ cameraControls })).toEqual({ settings: EXPECTED_DEFAULT, dropped: 1 });
    }
  });

  it('R5: v2 の欄が物でない・未来の版の時は v1 から移し、無ければ既定にして、どちらも知らせる', () => {
    expect(readStoredViewControls({ viewControls: { ...EXPECTED_DEFAULT, version: 3 }, cameraControls: V1_FUSION }))
      .toEqual({ settings: V2_FUSION, dropped: 1 });
    expect(readStoredViewControls({ viewControls: null })).toEqual({ settings: EXPECTED_DEFAULT, dropped: 1 });
    expect(readStoredViewControls({})).toEqual({ settings: EXPECTED_DEFAULT, dropped: 0 });
  });

  it('R8: 後の版の欄は無視し、後の版の入力の種類(キー・タッチ)はその項目だけ捨てて知らせる', () => {
    const later = { version: 2, sixDof: { enabled: true },
      bindings: { orbit: [drag('middle'), { kind: 'keys', keys: 'arrows', ...OFF }], pan: [drag('right'), { kind: 'touch', gesture: 'twoFinger' }],
        zoom: [wheel()] },
      options: { ...OPTIONS, orbitCenter: 'pointer', keyStepDegrees: 15 } };
    expect(readStoredViewControls({ viewControls: later })).toEqual({ settings: { version: 2,
      bindings: { orbit: [drag('middle')], pan: [drag('right')], zoom: [wheel()] }, options: OPTIONS }, dropped: 2 });
  });

  it('読み込みで直した数は保存しない表示だけの値で、壊れた視点の欄はテーマ・単位・選択フィルタを捨てない', () => {
    const filter = { vertex: false, edge: true, face: true, body: false };
    const store = memory({ ...core, lengthUnit: 'inch', selectionFilter: filter, viewControls: { version: 2, bindings: { orbit: [] } } });
    const loaded = loadSettings(store.storage);
    expect(loaded).toMatchObject({ ...core, lengthUnit: 'inch', selectionFilter: filter, viewControls: EXPECTED_DEFAULT, viewControlsRecovered: 4 });
    saveSettings(loaded, store.storage);
    expect(store.raw()).not.toContain('viewControlsRecovered');
    expect(loadSettings(store.storage).viewControlsRecovered).toBeUndefined();
  });
});

describe('既定と雛形', () => {
  it('既定は v1 の既定を移したもので、今の既定の操作と同じ(独立の表と一致)', () => {
    expect(DEFAULT_VIEW_CONTROLS).toEqual(EXPECTED_DEFAULT);
    expect(readStoredViewControls({ cameraControls: DEFAULT_CAMERA_CONTROLS })).toEqual({ settings: EXPECTED_DEFAULT, dropped: 0 });
    expect(viewControlProblems(DEFAULT_VIEW_CONTROLS)).toEqual([]);
  });

  it('4 つの雛形は問題 0 件で、独立の表のとおりの割当になり、速さと反転は残す', () => {
    const tuned: ViewControlSettings = { ...EXPECTED_DEFAULT,
      options: { ...OPTIONS, orbitSensitivity: 2, panSensitivity: 0.5, wheelSensitivity: 3, invertOrbitX: true } };
    const table = {
      pointercad: EXPECTED_DEFAULT.bindings,
      solidworks: { orbit: [drag('middle')], pan: [drag('middle', { ctrl: true })], zoom: [wheel(), drag('middle', { shift: true })] },
      fusion: { orbit: [drag('middle', { shift: true })], pan: [drag('middle')], zoom: [wheel()] },
      onshape: { orbit: [drag('right')], pan: [drag('middle'), drag('right', { ctrl: true })], zoom: [wheel()] },
    } as const;
    for (const preset of ['pointercad', 'solidworks', 'fusion', 'onshape'] as const) {
      const value = withViewControlPreset(tuned, preset);
      expect(viewControlProblems(value), preset).toEqual([]);
      expect(value).toEqual({ ...tuned, bindings: table[preset] });
    }
  });

  it('読む入口は設定が無い・読めない時に既定を返す', () => {
    expect(currentViewControls(undefined)).toBe(DEFAULT_VIEW_CONTROLS);
    expect(currentViewControls({})).toBe(DEFAULT_VIEW_CONTROLS);
    expect(currentViewControls({ viewControls: { ...EXPECTED_DEFAULT, bindings: { ...EXPECTED_DEFAULT.bindings, orbit: [] } } }))
      .toBe(DEFAULT_VIEW_CONTROLS);
    expect(currentViewControls({ viewControls: V2_FUSION })).toBe(V2_FUSION);
  });
});

describe('適用の時の問題(設計 §4.5 の code 7 種)', () => {
  const withBindings = (bindings: Partial<Record<'orbit' | 'pan' | 'zoom', readonly unknown[]>>) =>
    ({ ...EXPECTED_DEFAULT, bindings: { ...EXPECTED_DEFAULT.bindings, ...bindings } });
  it.each([
    { name: 'shape', value: withBindings({ orbit: [drag('middle'), { kind: 'drag', button: 'back', ...OFF }] }),
      expected: [{ code: 'shape', at: 'bindings.orbit.1' }] },
    { name: 'not-allowed', value: withBindings({ zoom: [wheel(), { kind: 'touch', gesture: 'pinch' }] }),
      expected: [{ code: 'not-allowed', action: 'zoom', at: 'bindings.zoom.1' }] },
    { name: 'left-needs-alt', value: withBindings({ orbit: [drag('middle'), drag('left', { shift: true })] }),
      expected: [{ code: 'left-needs-alt', action: 'orbit' }] },
    { name: 'duplicate', value: withBindings({ pan: [drag('right'), drag('middle')] }),
      expected: [{ code: 'duplicate', first: 'orbit', second: 'pan', trigger: drag('middle') }] },
    { name: 'mouse-required', value: withBindings({ zoom: [] }), expected: [{ code: 'mouse-required', action: 'zoom' }] },
    { name: 'too-many', value: withBindings({ zoom: [wheel(), wheel({ ctrl: true }), wheel({ shift: true }), wheel({ alt: true }), wheel({ meta: true })] }),
      expected: [{ code: 'too-many', action: 'zoom' }] },
    { name: 'range', value: { ...EXPECTED_DEFAULT, options: { ...OPTIONS, orbitSensitivity: 0, panSensitivity: Number.NaN } },
      expected: [{ code: 'range', field: 'orbitSensitivity' }, { code: 'range', field: 'panSensitivity' }] },
  ])('$name', ({ value, expected }) => {
    expect(viewControlProblems(value)).toEqual(expected);
    expect(isViewControlSettings(value)).toBe(false);
  });

  it('物でない値・知らない版・反転が真偽でない値は形の問題として断る', () => {
    for (const value of [null, [], { ...EXPECTED_DEFAULT, version: 1 }, { ...EXPECTED_DEFAULT, bindings: null }]) {
      expect(viewControlProblems(value)).toEqual([{ code: 'shape', at: 'viewControls' }]);
    }
    expect(viewControlProblems({ ...EXPECTED_DEFAULT, options: { ...OPTIONS, invertOrbitY: 'yes' } }))
      .toEqual([{ code: 'shape', at: 'options.invertOrbitY' }]);
    for (const speed of [0.09, 10.01, Infinity, -1]) {
      expect(viewControlProblems({ ...EXPECTED_DEFAULT, options: { ...OPTIONS, wheelSensitivity: speed } }))
        .toEqual([{ code: 'range', field: 'wheelSensitivity' }]);
    }
  });

  it('v1 では断ったホイールの回転・平行移動と 4 つまでの割当は v2 では受ける', () => {
    expect(viewControlProblems(withBindings({ orbit: [wheel({ shift: true })], pan: [wheel(), drag('right'), drag('middle', { shift: true }), drag('left', { alt: true })],
      zoom: [wheel({ ctrl: true })] }))).toEqual([]);
  });
});
