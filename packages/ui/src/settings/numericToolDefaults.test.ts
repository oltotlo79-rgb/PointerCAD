import { afterEach, describe, expect, it } from 'vitest';

import {
  chooseNumericInput,
  createNumericInput,
  evaluateNumericInput,
  nextNumericInput,
  NUMERIC_INPUT_STEPS,
  reduceNumericInput,
  type NumericField,
  type NumericInputState,
  type NumericInputStep,
} from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { createConfiguredNumericInput } from './createConfiguredNumericInput.js';
import {
  mergeTemplateToolDefaults,
  numericToolDefaultEntries,
  numericToolDefaultError,
  readNumericToolDefaults,
  templateToolDefaults,
} from './numericToolDefaults.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings, type SettingsStorage } from './settings.js';

function field(state: NumericInputState, key: string): NumericField {
  const result = state.fields.find(candidate => candidate.key === key);
  if (result === undefined) throw new Error(`missing numeric field: ${state.step}/${key}`);
  return result;
}

const originalSettings = useAppStore.getState().displaySettings;
afterEach(() => useAppStore.getState().setDisplaySettings(originalSettings));

describe('道具の数値初期値', () => {
  it('数値欄を持つ全段階を重複なく列挙し、選択肢だけの段に架空の数値を作らない', () => {
    const entries = numericToolDefaultEntries();
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    const choiceOnly = new Set<NumericInputStep>([
      'splineShape', 'mirrorBasis', 'mirrorPlane', 'sweepOptions', 'pointPattern',
      'referenceAxisKind', 'referencePointKind', 'referenceCsAxes',
    ]);
    for (const step of NUMERIC_INPUT_STEPS) {
      const configured = entries.filter(entry => entry.step === step);
      if (choiceOnly.has(step)) {
        expect(createNumericInput('point', step).fields, step).toEqual([]);
        expect(configured, step).toHaveLength(0);
      } else {
        expect(configured.length, step).toBeGreaterThan(0);
      }
    }
    expect(entries.filter(entry => entry.id === 'holeSize/absolute/counterboreDiameter')).toHaveLength(1);
    expect(entries.filter(entry => entry.id === 'surfaceShape/absolute/surfaceDistance')).toHaveLength(1);
  });

  it('保存境界をまとめて検査し、ひな形由来のパラメータ式は失わない', () => {
    expect(readNumericToolDefaults({ 'circleRadius/absolute/radius': '板厚 * 2' })).toEqual({
      'circleRadius/absolute/radius': '板厚 * 2',
    });
    expect(readNumericToolDefaults({ unknown: '10' })).toEqual({});
    expect(readNumericToolDefaults({ 'circleRadius/absolute/radius': '' })).toEqual({});
    expect(readNumericToolDefaults({ 'circleRadius/absolute/radius': '1/0' })).toEqual({});
    expect(readNumericToolDefaults({
      'circleRadius/absolute/radius': '1'.repeat(257),
    })).toEqual({});
    expect(readNumericToolDefaults({
      'circleRadius/absolute/radius': '未定義変数'.repeat(52),
    })).toEqual({});
  });

  it('ほかの表示設定と同じ端末保存を往復し、壊れた数値初期値だけを空へ戻す', () => {
    let raw: string | null = null;
    const storage: SettingsStorage = {
      getItem: () => raw,
      setItem: (_key, value) => { raw = value; },
    };
    saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', numericToolDefaults: {
      'circleRadius/absolute/radius': '板厚 * 2',
    } }, storage);
    expect(loadSettings(storage)).toMatchObject({ theme: 'light', numericToolDefaults: {
      'circleRadius/absolute/radius': '板厚 * 2',
    } });
    if (raw === null) throw new Error('settings were not written');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('saved settings are not an object');
    }
    raw = JSON.stringify({ ...parsed, numericToolDefaults: { unknown: '10' } });
    expect(loadSettings(storage)).toMatchObject({ theme: 'light', numericToolDefaults: {} });
  });

  it('現在のパラメータ、範囲、整数条件で設定値を検査する', () => {
    const byId = new Map(numericToolDefaultEntries().map(entry => [entry.id, entry]));
    const circle = byId.get('circleRadius/absolute/radius');
    const sides = byId.get('polygonShape/absolute/sides');
    if (circle === undefined || sides === undefined) throw new Error('numeric default catalog is incomplete');
    const options = { variables: new Map([['板厚', 3]]) };
    expect(numericToolDefaultError(circle, '板厚 * 2', options)).toBeNull();
    expect(numericToolDefaultError(circle, '0', options)).not.toBeNull();
    expect(numericToolDefaultError(sides, '6.5', options)).not.toBeNull();
  });

  it('ひな形の既存5項目を式のまま往復し、他の端末設定を保つ', () => {
    const sources = {
      'extrudeDistance/absolute/distance': '板厚 * 2',
      'holeSize/absolute/diameter': '板厚 + 1',
      'filletRadius/absolute/radius': '2',
      'chamferSize/absolute/chamferDistance': '3',
      'circleRadius/absolute/radius': '4',
      'point/relative/dx': '9',
    };
    const options = { variables: new Map([['板厚', 5]]) };
    const saved = templateToolDefaults(sources, options);
    expect(saved).toEqual({
      extrudeDistance: '板厚 * 2', holeDiameter: '板厚 + 1', filletRadius: '2',
      chamferDistance: '3', circleRadius: '4',
    });
    if (saved === null) throw new Error('valid tool defaults were rejected');
    expect(mergeTemplateToolDefaults({ 'point/relative/dx': '9' }, saved, options)).toEqual(sources);
    expect(mergeTemplateToolDefaults({}, saved, { variables: new Map() })).toBeNull();
  });

  it('絶対・相対・極座標を分け、クリック値を設定値より優先する', () => {
    const defaults = {
      'point/absolute/x': '1', 'point/relative/dx': '2', 'point/polar/distance': '3',
    };
    const absolute = createNumericInput('point', 'point', 'absolute', { defaultSources: defaults });
    expect(field(absolute, 'x').source).toBe('1');
    expect(field(reduceNumericInput(absolute, { type: 'setMode', mode: 'relative' }), 'dx').source).toBe('2');
    expect(field(reduceNumericInput(absolute, { type: 'setMode', mode: 'polar' }), 'distance').source).toBe('3');
    const clicked = reduceNumericInput(absolute, { type: 'setValues', values: [12.5, -3, 0] });
    expect(clicked.fields.map(item => item.source)).toEqual(['12.5', '-3', '0']);
    expect(clicked.fields.every(item => item.typed === false)).toBe(true);
  });

  it('選択肢で欄を組み直しても入力済み値を保ち、新しく現れた欄だけ設定値を使う', () => {
    const initial = createNumericInput('hole', 'holeSize', 'absolute', { defaultSources: {
      'holeSize/absolute/diameter': '8',
      'holeSize/absolute/counterboreDiameter': '14',
      'holeSize/absolute/counterboreDepth': '4',
    } });
    const edited = reduceNumericInput(initial, { type: 'edit', index: 0, source: '9' });
    const counterbore = chooseNumericInput(edited, 'holeEntry', 'counterbore');
    expect(field(counterbore, 'diameter').source).toBe('9');
    expect(field(counterbore, 'counterboreDiameter').source).toBe('14');
    expect(field(counterbore, 'counterboreDepth').source).toBe('4');
  });

  it('開始時の設定を後続段へ固定し、開始後の設定変更を取り込まない', () => {
    const store = useAppStore.getState();
    store.setDisplaySettings({ ...store.displaySettings, numericToolDefaults: {
      'circleRadius/absolute/radius': '12.5',
    } });
    const center = createConfiguredNumericInput('circle', 'circleCenter');
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings,
      numericToolDefaults: { 'circleRadius/absolute/radius': '99' } });
    const radius = nextNumericInput(center, false);
    if (radius === null) throw new Error('circle center did not open radius stage');
    expect(field(radius, 'radius').source).toBe('12.5');
    expect(Object.isFrozen(radius.defaultSources)).toBe(true);
  });

  it('設定値はmm・度として扱い、画面単位とユーザー入力の換算を混ぜない', () => {
    const length = createNumericInput('circle', 'circleRadius', 'absolute', { defaultSources: {
      'circleRadius/absolute/radius': '25.4',
    } });
    expect(evaluateNumericInput(length, new Map(), { lengthUnit: 'inch' }).results[0]?.value?.value).toBe(25.4);
    const typed = reduceNumericInput(length, { type: 'edit', index: 0, source: '1' });
    expect(evaluateNumericInput(typed, new Map(), { lengthUnit: 'inch' }).results[0]?.value?.value).toBe(25.4);
    expect(evaluateNumericInput(typed, new Map(), { lengthUnit: 'mm' }).results[0]?.value?.value).toBe(1);

    const angle = createNumericInput('revolve', 'revolveAngle', 'absolute', { defaultSources: {
      'revolveAngle/absolute/angle': 'rad(pi/2)',
    } });
    expect(evaluateNumericInput(angle).results[0]?.value?.value).toBe(90);
  });
});
