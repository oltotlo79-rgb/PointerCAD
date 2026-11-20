import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_CONTROLS, withCameraControlPreset } from './cameraControlSettings.js';
import { settingsStorage } from './cameraSettingsPersistence.testSupport.js';
import { loadSettings, saveSettings } from './settings.js';
import { DEFAULT_VIEW_CONTROLS, withViewControlPreset } from './viewControlSettings.js';

/**
 * 視点の操作の雛形の名前を、割り当ての中身の名前に付け直した後(M06-0a。利用者の回答 2026-11-19 21:2x)も、公開済みの v1.0.3 で
 * 保存した設定がそのまま読める事を、v1.0.3 の保存の形の固定の文字で確かめる。
 * - 雛形の id はどこにも保存されない。保存されるのは割当だけ(v1.0.3 の settings.ts は DisplaySettings を JSON にして
 *   'pointercad.settings' に置き、視点の操作は cameraControls の欄の割当だけ)。よって古い id を読む口は要らない。
 * - 下の文字は、v1.0.3(e2cd654d)の既定の設定に、その版の雛形の割当(cameraControlSettings.ts L39-41)を当てて保存した形。
 *   欄の並びも v1.0.3 の DEFAULT_DISPLAY_SETTINGS と同じ。雛形の名前は含まない。
 */
const MIDDLE = '{"input":"middle","alt":false,"shift":false,"ctrl":false,"meta":false}';
const SHIFT_MIDDLE = '{"input":"middle","alt":false,"shift":true,"ctrl":false,"meta":false}';
const CTRL_MIDDLE = '{"input":"middle","alt":false,"shift":false,"ctrl":true,"meta":false}';
const RIGHT = '{"input":"right","alt":false,"shift":false,"ctrl":false,"meta":false}';
const CTRL_RIGHT = '{"input":"right","alt":false,"shift":false,"ctrl":true,"meta":false}';
const WHEEL = '{"input":"wheel","alt":false,"shift":false,"ctrl":false,"meta":false}';
const TUNING = '"wheelSensitivity":1,"dragSensitivity":1,"invertWheel":false,"invertDrag":false}';
const OTHER_FIELDS = ',"tutorialCompleted":false,"shortcutAssignments":{},"numericToolDefaults":{},"autoSaveIntervalMs":300000,'
  + '"theme":"dark","uiScale":100,"trackAngleStep":15,"timelineHintSeen":false,"lengthUnit":"mm",'
  + '"selectionFilter":{"vertex":true,"edge":true,"face":true,"body":true},"inferConstraints":true}';

const PRESETS = ['middleOrbit', 'middlePan', 'rightOrbit'] as const;
const SAVED_BY_V103: Readonly<Record<(typeof PRESETS)[number], string>> = {
  middleOrbit: `{"cameraControls":{"version":1,"orbit":[${MIDDLE}],"pan":[${CTRL_MIDDLE}],"zoom":[${WHEEL},${SHIFT_MIDDLE}],${TUNING}${OTHER_FIELDS}`,
  middlePan: `{"cameraControls":{"version":1,"orbit":[${SHIFT_MIDDLE}],"pan":[${MIDDLE}],"zoom":[${WHEEL}],${TUNING}${OTHER_FIELDS}`,
  rightOrbit: `{"cameraControls":{"version":1,"orbit":[${RIGHT}],"pan":[${MIDDLE},${CTRL_RIGHT}],"zoom":[${WHEEL}],${TUNING}${OTHER_FIELDS}`,
};

describe('視点の操作の雛形の名前を替えた後も、v1.0.3 で保存した設定がそのまま読める(M06-0a)', () => {
  for (const preset of PRESETS) {
    it(`v1.0.3 の形の設定を読むと、雛形 ${preset} を当てた割当と同じになり、書き直しても変わらない`, () => {
      const memory = settingsStorage(SAVED_BY_V103[preset]);
      const loaded = loadSettings(memory.storage);
      expect(loaded.viewControlsRecovered).toBeUndefined();
      expect(loaded.viewControls).toEqual(withViewControlPreset(DEFAULT_VIEW_CONTROLS, preset));
      saveSettings(loaded, memory.storage);
      expect(loadSettings(memory.storage).viewControls).toEqual(loaded.viewControls);
    });
  }

  it('新しい id の雛形の割当は、v1.0.3 で保存した割当(固定の文字)と同じ', () => {
    for (const preset of PRESETS) {
      const stored = JSON.parse(SAVED_BY_V103[preset]) as { readonly cameraControls: unknown };
      expect(withCameraControlPreset(DEFAULT_CAMERA_CONTROLS, preset), preset).toEqual(stored.cameraControls);
    }
  });
});
