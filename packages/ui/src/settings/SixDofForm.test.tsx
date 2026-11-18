import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { setSixDofAccess } from './sixDofAccess.js';
import { SixDofForm } from './SixDofForm.js';

/* 設計 B-09 3-5: 操作の割り当ての窓のタブ「3D マウス」。デスクトップ版だけで使え、実機で確かめていない事を出す。 */
afterEach(() => { setSixDofAccess(undefined); vi.restoreAllMocks(); });

describe('3D マウスのタブ', () => {
  it('Web 版(口が無い)は navigator.hid に触らず、読めない事と、実機で確かめていない事だけを出す', () => {
    const hid = vi.fn(() => undefined);
    const navigatorLike: object = typeof globalThis.navigator === 'object' ? globalThis.navigator : {};
    const restore = Object.getOwnPropertyDescriptor(navigatorLike, 'hid');
    Object.defineProperty(navigatorLike, 'hid', { configurable: true, get: hid });
    try {
      const markup = renderToStaticMarkup(<SixDofForm />);
      expect(markup).toContain(t('settings.sixDof.title'));
      expect(markup).toContain(`<p role="note">${t('settings.sixDof.unverified')}</p>`);
      expect(markup).toContain(t('settings.sixDof.unsupported'));
      expect(markup).not.toContain('type="checkbox"');
      expect(markup).not.toContain(t('settings.sixDof.connect'));
      expect(hid).not.toHaveBeenCalled();
    } finally {
      if (restore === undefined) Reflect.deleteProperty(navigatorLike, 'hid');
      else Object.defineProperty(navigatorLike, 'hid', restore);
    }
  });

  it('デスクトップ版は「3D マウスを使う」を出し、本体の答えを読むまでは押せない(実機で確かめていない事も出す)', () => {
    const access = { enable: vi.fn(() => Promise.resolve(true)), disable: vi.fn(() => Promise.resolve(true)),
      enabled: vi.fn(() => Promise.resolve(false)) };
    setSixDofAccess(access);
    const markup = renderToStaticMarkup(<SixDofForm />);
    expect(markup).toContain(`<p role="note">${t('settings.sixDof.unverified')}</p>`);
    expect(markup).toContain(t('settings.sixDof.enable'));
    expect(markup).toContain(`title="${t('settings.sixDof.enableGuide')}"`);
    expect(markup).toMatch(/<input type="checkbox"[^>]*disabled=""/u);
    // 「つなぐ」は、本体の印が入と分かるまで押せない。
    expect(markup).toContain(`<button type="button" class="pcad-button" title="${t('settings.sixDof.connectGuide')}" disabled="">`
      + `${t('settings.sixDof.connect')}</button>`);
    expect(markup).not.toContain(t('settings.sixDof.unsupported'));
    // 描くだけでは本体の口を呼ばない(読むのは描いた後の副作用。入にするのは利用者の操作だけ)。
    expect(access.enable).not.toHaveBeenCalled();
    expect(access.disable).not.toHaveBeenCalled();
  });
});
