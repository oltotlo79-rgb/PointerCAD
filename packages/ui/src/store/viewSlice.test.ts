/** 表示設定・断面表示。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  createEmptyPartDocument,
  FREE_WORK_PLANE_ID,
} from '@pointercad/model';
import {
  expressionValueFromNumber,
} from '@pointercad/expression';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  DEFAULT_DISPLAY_SETTINGS,
} from '../settings/settings.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('表示設定(FR-908、FR-909、計画書 P4 タスク1、§0.a-0.1〜0.3)', () => {
  it('起動時の表示設定は既定(ダーク・100%)', () => {
    expect(useAppStore.getState().displaySettings).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('setDisplaySettings で表示設定を丸ごと差し替えられる', () => {
    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', uiScale: 120 });
    expect(useAppStore.getState().displaySettings).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', uiScale: 120 });

    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 90 });
    expect(useAppStore.getState().displaySettings).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 90 });
  });

  it('localStorage が無い実行環境(このテスト環境)でも例外を投げずに保存を試みる', () => {
    // Vitest は environment: 'node' で動く(localStorage が無い)。saveSettings が黙って
    // 諦めることを settings.test.ts で確かめているので、ここでは setDisplaySettings 経由でも
    // 例外が外へ漏れないことだけを確かめる(NFR-RE-1)。
    expect(() => {
      useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'darkModern', uiScale: 140 });
    }).not.toThrow();
  });

  it('resetDocument(新規)では表示設定を戻さない(部品ではなく端末の好みのため)', () => {
    useAppStore.getState().setDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 150 });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().displaySettings).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 150 });
  });
});

describe('ビューの断面表示(FR-111、P6 タスク35)', () => {
  it('起動直後は切ってある(平面を 1 枚も持たない)', () => {
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('入れると今の作図面で切り、オフセット 0・表向きから始まる(§0.42)', () => {
    useAppStore.getState().setWorkPlane('xz');
    useAppStore.getState().toggleSectionView();
    const section = useAppStore.getState().sectionView;
    expect(section).not.toBeNull();
    expect(section?.plane).toEqual({
      kind: 'workPlane',
      planeId: 'xz',
      offset: expressionValueFromNumber(0),
    });
    expect(section?.offsetMm).toBe(0);
    expect(section?.flipped).toBe(false);
  });

  it('基準の 3 面でない作図面のときは XY から始める(解けない面で切らない)', () => {
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    useAppStore.getState().toggleSectionView();
    expect(useAppStore.getState().sectionView?.plane).toEqual({
      kind: 'workPlane',
      planeId: 'xy',
      offset: expressionValueFromNumber(0),
    });
  });

  it('もう一度押すと切れる(元の見た目に戻る)', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().toggleSectionView();
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('つまみ(オフセット)を動かしても文書は 1 バイトも変わらず、再計算も走らない', () => {
    const before = useAppStore.getState().document;
    const version = useAppStore.getState().documentVersion;
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().setSectionOffset(12.5);
    useAppStore.getState().flipSectionView();
    const state = useAppStore.getState();
    expect(state.sectionView?.offsetMm).toBe(12.5);
    expect(state.sectionView?.flipped).toBe(true);
    // 文書(形の正本)も、そこから導く控えも触っていない → 再計算は起きない。
    expect(state.document).toBe(before);
    expect(state.documentVersion).toBe(version);
    expect(state.isComputing).toBe(false);
  });

  it('数にならないオフセットは据え置く(0 除算や NaN を描画へ持ち込まない)', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().setSectionOffset(5);
    useAppStore.getState().setSectionOffset(Number.NaN);
    useAppStore.getState().setSectionOffset(Number.POSITIVE_INFINITY);
    expect(useAppStore.getState().sectionView?.offsetMm).toBe(5);
  });

  it('同じ値を入れ直しても札を作り直さない(描き直しを呼ばない、NFR-PF-1)', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().setSectionOffset(3);
    const first = useAppStore.getState().sectionView;
    useAppStore.getState().setSectionOffset(3);
    expect(useAppStore.getState().sectionView).toBe(first);
  });

  it('切ってあるあいだはオフセットも裏返しも効かない(null のまま)', () => {
    useAppStore.getState().setSectionOffset(9);
    useAppStore.getState().flipSectionView();
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('丸ごと差し替えられる(面を選び直す道はここを通る)', () => {
    useAppStore.getState().setSectionView({
      plane: { kind: 'workPlane', planeId: 'yz', offset: expressionValueFromNumber(0) },
      offsetMm: -4,
      flipped: true,
    });
    expect(useAppStore.getState().sectionView?.offsetMm).toBe(-4);
    useAppStore.getState().setSectionView(null);
    expect(useAppStore.getState().sectionView).toBeNull();
  });

  it('新規(文書の作り直し)では持ち越さない', () => {
    useAppStore.getState().toggleSectionView();
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().sectionView).toBeNull();
  });
});
