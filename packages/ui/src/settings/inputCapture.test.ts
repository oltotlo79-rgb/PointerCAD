import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { captureViewInput, captureViewKey, captureViewTouch, viewTriggerLabel, type ViewCaptureEvent } from './inputCapture.js';
import { DEFAULT_VIEW_CONTROLS } from './viewControlSettings.js';

/*
 * 設計 1-4・§7.1: 押下・ホイールの出来事 → 視点の入力(左で Alt 無しは断る)。キーの押下(B-08)は captureViewKey が
 * キーの組(矢印・テンキー・＋−)の入力にする(captureViewInput はキーを受けない)。
 */
const event = (type: string, extra: Partial<ViewCaptureEvent> = {}): ViewCaptureEvent =>
  ({ type, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });
const OFF = { alt: false, shift: false, ctrl: false, meta: false };

describe('取り込みの枠の出来事 → 視点の入力', () => {
  it.each([
    [event('pointerdown', { button: 1 }), { kind: 'drag', button: 'middle', ...OFF }],
    [event('pointerdown', { button: 2, shiftKey: true }), { kind: 'drag', button: 'right', ...OFF, shift: true }],
    [event('pointerdown', { button: 0, altKey: true }), { kind: 'drag', button: 'left', ...OFF, alt: true }],
    [event('pointerdown', { button: 1, ctrlKey: true, metaKey: true }), { kind: 'drag', button: 'middle', ...OFF, ctrl: true, meta: true }],
    [event('wheel'), { kind: 'wheel', ...OFF }],
    [event('wheel', { ctrlKey: true }), { kind: 'wheel', ...OFF, ctrl: true }],
  ] as const)('%o を入力にする', (input, trigger) => {
    expect(captureViewInput(input)).toEqual({ status: 'captured', trigger });
  });
  it('左ボタンは Alt が無いと断る(選択と作図に使う)', () => {
    expect(captureViewInput(event('pointerdown', { button: 0 }))).toEqual({ status: 'refused', reason: 'left-needs-alt' });
    expect(captureViewInput(event('pointerdown', { button: 0, shiftKey: true, ctrlKey: true }))).toEqual({ status: 'refused', reason: 'left-needs-alt' });
  });
  it.each([event('pointerdown', { button: 3 }), event('pointerdown', { button: 4 }), event('pointerdown'), event('keydown'), event('pointermove', { button: 1 })])(
    '%o は受けない', input => {
      expect(captureViewInput(input)).toEqual({ status: 'ignored' });
    });
  it('札の表記は修飾キー・入力の順で、設計 §6.5 の表記に従う', () => {
    expect(viewTriggerLabel({ kind: 'drag', button: 'middle', ...OFF, shift: true }))
      .toBe(`${t('settings.camera.shift')}${t('settings.camera.chip.join')}${t('settings.camera.chip.middle')}`);
    expect(viewTriggerLabel({ kind: 'wheel', ...OFF, ctrl: true })).toBe(`${t('settings.camera.ctrl')}＋${t('settings.camera.chip.wheel')}`);
    expect(viewTriggerLabel({ kind: 'drag', button: 'right', ...OFF })).toBe('右ボタン ドラッグ');
    expect(viewTriggerLabel({ kind: 'keys', keys: 'arrows', ...OFF, shift: true }))
      .toBe(`${t('settings.camera.shift')}${t('settings.camera.chip.join')}${t('settings.camera.keys.arrows')}`);
  });
});

describe('取り込みの枠のキー → キーの組の入力(B-08)', () => {
  const key = (code: string, extra: Partial<Record<'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing', boolean>> = {}) =>
    ({ code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...extra });
  it.each([
    ['ArrowLeft', 'orbit', {}, { kind: 'keys', keys: 'arrows', ...OFF }],
    ['ArrowDown', 'pan', { shiftKey: true }, { kind: 'keys', keys: 'arrows', ...OFF, shift: true }],
    ['Numpad8', 'orbit', { ctrlKey: true }, { kind: 'keys', keys: 'numpad', ...OFF, ctrl: true }],
    ['Numpad6', 'pan', {}, { kind: 'keys', keys: 'numpad', ...OFF }],
    ['NumpadAdd', 'zoom', {}, { kind: 'keys', keys: 'plusMinus', ...OFF }],
    ['Minus', 'zoom', { altKey: true }, { kind: 'keys', keys: 'plusMinus', ...OFF, alt: true }],
  ] as const)('%s を %s に取り込む', (code, action, extra, trigger) => {
    expect(captureViewKey(key(code, extra), action)).toEqual({ status: 'captured', trigger });
  });
  it('その操作に使えない組は断る(＋−を回転・平行移動へ、矢印・テンキーを拡大縮小へ)', () => {
    expect(captureViewKey(key('Equal'), 'orbit')).toEqual({ status: 'refused', reason: 'not-for-action' });
    expect(captureViewKey(key('NumpadSubtract'), 'pan')).toEqual({ status: 'refused', reason: 'not-for-action' });
    expect(captureViewKey(key('ArrowUp'), 'zoom')).toEqual({ status: 'refused', reason: 'not-for-action' });
    expect(captureViewKey(key('Numpad2'), 'zoom')).toEqual({ status: 'refused', reason: 'not-for-action' });
  });
  it('組に入らないキーと、変換中の入力は受けない', () => {
    for (const code of ['KeyA', 'Digit1', 'Numpad5', 'Numpad1', 'Enter', 'Tab', 'Space']) {
      expect(captureViewKey(key(code), 'orbit'), code).toEqual({ status: 'ignored' });
    }
    expect(captureViewKey(key('ArrowLeft', { isComposing: true }), 'orbit')).toEqual({ status: 'ignored' });
  });
});

describe('取り込みの枠のタッチの指の操作(B-08h)', () => {
  const touch = (gesture: 'oneFinger' | 'twoFinger' | 'pinch') => ({ kind: 'touch', gesture, ...OFF } as const);
  const base = DEFAULT_VIEW_CONTROLS.bindings;
  it.each([
    ['oneFinger', 'orbit'], ['twoFinger', 'orbit'], ['oneFinger', 'pan'], ['twoFinger', 'pan'], ['pinch', 'zoom'],
  ] as const)('%s を %s に取り込む(マウスの割当はそのまま残す)', (gesture, action) => {
    expect(captureViewTouch(DEFAULT_VIEW_CONTROLS, action, gesture)).toEqual({ status: 'captured', trigger: touch(gesture) });
  });
  it('その操作に使えない指の操作は断る(つまむを回転・平行移動へ、ドラッグを拡大縮小へ)', () => {
    expect(captureViewTouch(DEFAULT_VIEW_CONTROLS, 'orbit', 'pinch')).toEqual({ status: 'refused', reason: 'not-for-action' });
    expect(captureViewTouch(DEFAULT_VIEW_CONTROLS, 'zoom', 'oneFinger')).toEqual({ status: 'refused', reason: 'not-for-action' });
  });
  it('その操作のタッチの割当が 2 つに達していれば足せない(上限はタッチ 2 のまま)', () => {
    const full = { ...DEFAULT_VIEW_CONTROLS, bindings: { ...base, pan: [...base.pan, touch('oneFinger'), touch('twoFinger')] } };
    expect(captureViewTouch(full, 'pan', 'oneFinger')).toEqual({ status: 'refused', reason: 'touch-full' });
    // ほかの操作は数えない。
    expect(captureViewTouch(full, 'orbit', 'oneFinger')).toEqual({ status: 'captured', trigger: touch('oneFinger') });
    const one = { ...DEFAULT_VIEW_CONTROLS, bindings: { ...base, pan: [...base.pan, touch('twoFinger')] } };
    expect(captureViewTouch(one, 'pan', 'oneFinger')).toEqual({ status: 'captured', trigger: touch('oneFinger') });
  });
});
