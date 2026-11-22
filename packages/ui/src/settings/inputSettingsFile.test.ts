import { describe, expect, it } from 'vitest';
import { INPUT_SETTINGS_FILE_BYTES } from '../file/fileContracts.js';
import {
  canUndoInputSettings, decodeInputSettingsFile, encodeInputSettingsFile, inputSettingsValuesOf, planInputSettingsImport,
  type InputSettingsReading,
} from './inputSettingsFile.js';
import { DEFAULT_DISPLAY_SETTINGS, type DisplaySettings } from './settings.js';
import { DEFAULT_VIEW_CONTROLS, sameViewControls, type ViewControlSettings, type ViewTrigger } from './viewControlSettings.js';

/* 設計 B-09 3-1: 操作の割り当ての設定ファイル。全体を断る場合・1 件ずつ捨てる場合・置き換えと元に戻す。 */
const encoder = new TextEncoder();
const bytesOf = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const FILE = { format: 'pointercad-input-settings', version: 1 } as const;
const lineOnL = { key: 'l', primary: false, shift: false, alt: false };
const PART_CUSTOM = ['toolbar.sketch.select', 'toolbar.shape.circle', 'toolbar.sketch.line', 'toolbar.shape.rectangle',
  'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'history.redo'] as const;
const numpadOrbit: ViewTrigger = { kind: 'keys', keys: 'numpad', alt: false, shift: false, ctrl: false, meta: false };
/** テンキーの回転。NumLock の入った数字は選択の種類の既定のキー(1〜4)とも同じ押し方になる。 */
const WITH_NUMPAD_ORBIT: ViewControlSettings = {
  ...DEFAULT_VIEW_CONTROLS, bindings: { ...DEFAULT_VIEW_CONTROLS.bindings, orbit: [...DEFAULT_VIEW_CONTROLS.bindings.orbit, numpadOrbit] },
};
const CUSTOM: DisplaySettings = {
  ...DEFAULT_DISPLAY_SETTINGS,
  viewControls: { ...DEFAULT_VIEW_CONTROLS, options: { ...DEFAULT_VIEW_CONTROLS.options, orbitSensitivity: 2 } },
  shortcutAssignments: { 'toolbar.sketch.line': [lineOnL] },
  mouseButtonCommands: { back: 'history.undo' },
  radialCommands: { part: PART_CUSTOM },
  snapPauseModifier: 'ctrl',
  selectionModifier: 'shift',
};

function decoded(bytes: Uint8Array): InputSettingsReading {
  const result = decodeInputSettingsFile(bytes);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}
const refusalOf = (bytes: Uint8Array): string | null => {
  const result = decodeInputSettingsFile(bytes);
  return result.ok ? null : result.reason;
};

describe('書き出しと読み込みの往復', () => {
  it('適用済みの 6 つの欄を印と版つきの JSON に書き、読み戻すと同じ割り当てになる', () => {
    const bytes = encodeInputSettingsFile(CUSTOM);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ ...FILE, inputAssignments: { version: 2, keys: { 'toolbar.sketch.line': [lineOnL] } } });
    const reading = decoded(bytes);
    for (const section of ['view', 'keys', 'mouse', 'radial', 'snap', 'selection'] as const) {
      expect(reading.sections[section], section).toEqual({ state: 'read', dropped: 0 });
    }
    expect(reading.unknownFields).toBe(0);
    const view = reading.values.viewControls, written = CUSTOM.viewControls;
    expect(view !== undefined && written !== undefined && sameViewControls(view, written)).toBe(true);
    expect(view?.options.orbitSensitivity).toBe(2);
    expect(reading.values.shortcutAssignments).toEqual({ 'toolbar.sketch.line': [lineOnL] });
    expect(reading.values.mouseButtonCommands).toEqual({ back: 'history.undo' });
    expect(reading.values.radialCommands).toEqual({ part: PART_CUSTOM });
    expect(reading.values.snapPauseModifier).toBe('ctrl');
    expect(JSON.parse(text)).toMatchObject({ version: 1, selectionModifier: 'shift' });
    expect(planInputSettingsImport(DEFAULT_DISPLAY_SETTINGS, reading).next.selectionModifier).toBe('shift');
  });
});

describe('ファイル全体を断る(今の割り当ては変えない)', () => {
  it('大きすぎる・文字として読めない・JSON でない', () => {
    expect(refusalOf(new Uint8Array(INPUT_SETTINGS_FILE_BYTES + 1))).toBe('tooLarge');
    expect(refusalOf(Uint8Array.of(0xff, 0xfe, 0x00))).toBe('notJson');
    expect(refusalOf(encoder.encode('{"format":'))).toBe('notJson');
  });

  it('印が無い・違う、物でない', () => {
    expect(refusalOf(bytesOf(null))).toBe('notSettings');
    expect(refusalOf(bytesOf([FILE]))).toBe('notSettings');
    expect(refusalOf(bytesOf({ ...FILE, format: 'pointercad-script' }))).toBe('notSettings');
    expect(refusalOf(bytesOf({ version: 1, mouseButtonCommands: { back: 'history.undo' } }))).toBe('notSettings');
  });

  it('未来の版は壊れた版と分けて断る', () => {
    expect(refusalOf(bytesOf({ ...FILE, version: 2, mouseButtonCommands: { back: 'history.undo' } }))).toBe('futureVersion');
    for (const version of ['1', 0, 1.5, null]) {
      expect(refusalOf(bytesOf({ ...FILE, version, mouseButtonCommands: { back: 'history.undo' } })), String(version)).toBe('badVersion');
    }
  });

  it('読める欄が 1 つも無い', () => {
    expect(refusalOf(bytesOf(FILE))).toBe('nothingReadable');
    expect(refusalOf(bytesOf({ ...FILE, viewControls: 'x', inputAssignments: { version: 3, keys: {} }, mouseButtonCommands: [], radialCommands: 1,
      snapPauseModifier: 'alt' }))).toBe('nothingReadable');
  });
});

describe('欄の中は 1 件ずつ確かめる', () => {
  it('知らない命令・入力・種類はその 1 件だけ捨てて数え、形の違う欄はその欄だけ読まない', () => {
    const reading = decoded(bytesOf({
      ...FILE,
      viewControls: 'not an object',
      inputAssignments: { version: 2, keys: { 'toolbar.sketch.line': [lineOnL], 'no.such.command': [lineOnL] } },
      mouseButtonCommands: { back: 'history.undo', sideways: 'history.redo', forward: 'no.such.command' },
      radialCommands: { part: PART_CUSTOM, unknownKind: PART_CUSTOM },
      snapPauseModifier: 'alt',
      script: 'alert(1)',
    }));
    expect(reading.sections).toEqual({
      view: { state: 'unreadable', dropped: 0 }, keys: { state: 'read', dropped: 1 },
      mouse: { state: 'read', dropped: 2 }, radial: { state: 'read', dropped: 1 }, snap: { state: 'unreadable', dropped: 0 },
      selection: { state: 'absent', dropped: 0 },
    });
    expect(reading.values.viewControls).toBeUndefined();
    expect(reading.values.snapPauseModifier).toBeUndefined();
    expect(reading.values.shortcutAssignments).toEqual({ 'toolbar.sketch.line': [lineOnL] });
    expect(reading.values.mouseButtonCommands).toEqual({ back: 'history.undo' });
    expect(reading.values.radialCommands).toEqual({ part: PART_CUSTOM });
    expect(reading.unknownFields).toBe(1);
  });

  it('__proto__ の鍵は知らない欄・知らない入力として捨て、物の原型を変えない', () => {
    const reading = decoded(encoder.encode(
      '{"format":"pointercad-input-settings","version":1,"__proto__":{"polluted":true},"mouseButtonCommands":{"__proto__":"history.undo","back":"history.undo"}}'));
    expect(reading.unknownFields).toBe(1);
    expect(reading.sections.mouse).toEqual({ state: 'read', dropped: 1 });
    expect(reading.values.mouseButtonCommands).toEqual({ back: 'history.undo' });
    expect(Object.getPrototypeOf(reading.values.mouseButtonCommands)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

describe('置き換えの計画と元に戻す', () => {
  it.each([[{}, 'absent'], [{ selectionModifier: 'future' }, 'unreadable']] as const)(
    '選択キーの欄が無い旧ファイルと知らない値は、吸着の幅と同じく今の値のまま (%j)', (field, state) => {
      const reading = decoded(bytesOf({ ...FILE, snapRadius: 'large', ...field }));
      expect(reading.values.selectionModifier).toBeUndefined();
      expect(reading.sections.selection).toEqual({ state, dropped: 0 });
      expect(reading.unknownFields).toBe(0);
      const plan = planInputSettingsImport(CUSTOM, reading);
      expect(plan.blocked).toBe(false);
      expect(plan.next).toMatchObject({ selectionModifier: 'shift', snapPauseModifier: 'ctrl', snapRadius: 'large' });
    },
  );

  it('選択キーだけの版1ファイルも読み込める', () => {
    const reading = decoded(bytesOf({ ...FILE, selectionModifier: 'ctrl' }));
    expect(reading.sections.selection).toEqual({ state: 'read', dropped: 0 });
    expect(planInputSettingsImport(CUSTOM, reading).next.selectionModifier).toBe('ctrl');
  });

  it('ファイルに無い欄は今の値のまま(同じ物)で、置き換えた欄だけ起動の時のお知らせを消す', () => {
    const current: DisplaySettings = { ...CUSTOM, viewControlsRecovered: 1, mouseButtonCommandsRecovered: 2 };
    const reading = decoded(bytesOf({ ...FILE, mouseButtonCommands: { forward: 'history.redo' } }));
    expect(reading.sections.view).toEqual({ state: 'absent', dropped: 0 });
    const plan = planInputSettingsImport(current, reading);
    expect(plan.blocked).toBe(false);
    expect(plan.viewKeysDropped).toBe(0);
    expect(plan.next.viewControls).toBe(current.viewControls);
    expect(plan.next.shortcutAssignments).toBe(current.shortcutAssignments);
    expect(plan.next.radialCommands).toBe(current.radialCommands);
    expect(plan.next.snapPauseModifier).toBe('ctrl');
    expect(plan.next.selectionModifier).toBe('shift');
    expect(plan.next.mouseButtonCommands).toEqual({ forward: 'history.redo' });
    expect(plan.next.mouseButtonCommandsRecovered).toBeUndefined();
    expect(plan.next.viewControlsRecovered).toBe(1);
    expect(plan.next.theme).toBe(current.theme);
  });

  it('ファイルの視点のキーが命令のキーと重なればその視点のキーだけ外し、今の視点のキーと重なる時は置き換えない', () => {
    const reading = decoded(bytesOf({ ...FILE, viewControls: WITH_NUMPAD_ORBIT }));
    expect(reading.sections.view).toEqual({ state: 'read', dropped: 0 });
    const plan = planInputSettingsImport(DEFAULT_DISPLAY_SETTINGS, reading);
    expect(plan.viewKeysDropped).toBe(1);
    expect(plan.blocked).toBe(false);
    expect(plan.next.viewControls?.bindings.orbit).toEqual(DEFAULT_VIEW_CONTROLS.bindings.orbit);
    const mouseOnly = decoded(bytesOf({ ...FILE, mouseButtonCommands: { back: 'history.undo' } }));
    expect(planInputSettingsImport({ ...DEFAULT_DISPLAY_SETTINGS, viewControls: WITH_NUMPAD_ORBIT }, mouseOnly).blocked).toBe(true);
  });

  it('置き換えた 6 つの欄が変わっていない間だけ元に戻せ、戻すと置き換える前の同じ物になる', () => {
    const plan = planInputSettingsImport(CUSTOM, decoded(bytesOf({ ...FILE, mouseButtonCommands: { back: 'history.redo' } })));
    const written = inputSettingsValuesOf(plan.next);
    expect(canUndoInputSettings(plan.next, written)).toBe(true);
    expect(canUndoInputSettings({ ...plan.next, theme: 'light' }, written)).toBe(true);
    expect(canUndoInputSettings({ ...plan.next, radialCommands: {} }, written)).toBe(false);
    expect(canUndoInputSettings({ ...plan.next, snapPauseModifier: 'shift' }, written)).toBe(false);
    expect(canUndoInputSettings({ ...plan.next, selectionModifier: 'ctrl' }, written)).toBe(false);
    const undone: DisplaySettings = { ...plan.next, ...inputSettingsValuesOf(CUSTOM) };
    expect(undone.mouseButtonCommands).toBe(CUSTOM.mouseButtonCommands);
    expect(undone.selectionModifier).toBe('shift');
    expect(undone.viewControls).toBe(CUSTOM.viewControls);
  });
});
