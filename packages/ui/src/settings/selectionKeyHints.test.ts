import { afterEach, describe, expect, it } from 'vitest';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SelectionModifier } from './selectionModifierSetting.js';

// 選択に足す・外すキーを名前で案内する文の、今(B-08 2-5 の前)の文。既定(今のまま)の時は、この文と 1 文字も変わらない。
const CURRENT_TEXTS: readonly (readonly [MessageKey, string])[] = [
  ['assembly.boltedJoint.unsupported.duplicateHole', '同じ穴を2回選んでいます。重ねて選んだ穴を外してください(Shift を押してもう一度選ぶと外れます)。'],
  ['assembly.boltedJoint.addHolesGuide', '2組目からは、Shift を押しながら穴の内側の面を選んで足します。1組目で合わせた後に同じ軸の上にある穴どうしを、自動で組にします。もう一度選ぶと外します。'],
  ['assembly.frameSlot.pickHole', 'ブラケットの穴の内側の面を選んでください（Shift で足し外し）。フレームに当たる面は、穴ごとに自動で選びます。'],
  ['drawing.advanced.targetHint', '面または3点を使う場合は、用紙上で先に選択してからこの道具を開きます。複数の点はCtrlまたはShiftを押しながら選びます。'],
  ['drawing.dimension.selectHint', '辺や点を選び、Enterで寸法を記入できます。線間距離や二面幅は最初からCtrlまたはShiftを押しながら2つ選びます。'],
  ['sketch.connect.selectTwo', 'Shift または Ctrl を押しながら、点を2つ選んでください。'],
  ['sketch.facePoints.selectThree', 'Shift または Ctrl を押しながら、点を3つ以上選んでください。'],
];

function choose(selectionModifier: SelectionModifier): void {
  useAppStore.setState({ displaySettings: { ...useAppStore.getState().displaySettings, selectionModifier } });
}

afterEach(() => { choose('local'); });

describe('選択に足す・外すキーの案内の文', () => {
  it('既定(今のまま)の時は、7 つの案内がどれも今の文のまま', () => {
    expect(useAppStore.getState().displaySettings.selectionModifier).toBe('local');
    for (const [key, text] of CURRENT_TEXTS) expect(t(key), key).toBe(text);
    choose('local');
    for (const [key, text] of CURRENT_TEXTS) expect(t(key), key).toBe(text);
  });

  it.each([['shift', 'Shift'], ['ctrl', 'Ctrl'], ['shiftOrCtrl', 'Shift または Ctrl']] as const)(
    '%s を選ぶと、7 つの案内が選んだキーの名前(%s)に替わる', (setting, name) => {
      choose(setting);
      for (const [key] of CURRENT_TEXTS) {
        const shown = t(key);
        expect(shown, key).toContain(name);
        expect(shown, key).not.toContain('{keys}');
      }
      expect(t('sketch.connect.selectTwo')).toBe(`${name} を押しながら、点を2つ選んでください。`);
    },
  );

  it('組立の案内(今は Shift だけ)も、Ctrl を選ぶと Ctrl に替わる', () => {
    choose('ctrl');
    expect(t('assembly.frameSlot.pickHole')).toBe('ブラケットの穴の内側の面を選んでください（Ctrl で足し外し）。フレームに当たる面は、穴ごとに自動で選びます。');
    expect(t('assembly.boltedJoint.addHolesGuide')).not.toContain('Shift');
  });

  it('案内でない文は、設定を変えても表の値のまま', () => {
    const before = t('sketch.connect.count');
    choose('ctrl');
    expect(t('sketch.connect.count')).toBe(before);
    expect(t('settings.selectionModifier.title')).toBe('選択に足す・外すキー');
  });
});
