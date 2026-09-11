import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { denyBrowserPermissions } from './sessionPermissions.js';

describe('Electronのブラウザー権限を既定拒否する（R11）', () => {
  it('照会・要求・機器・画面共有の四つの口を登録し、許可されたstreamを返さない', () => {
    const session = {
      setPermissionRequestHandler: vi.fn<Session['setPermissionRequestHandler']>(),
      setPermissionCheckHandler: vi.fn<Session['setPermissionCheckHandler']>(),
      setDevicePermissionHandler: vi.fn<Session['setDevicePermissionHandler']>(),
      setDisplayMediaRequestHandler: vi.fn<Session['setDisplayMediaRequestHandler']>(),
    };
    denyBrowserPermissions(session);
    const request = session.setPermissionRequestHandler.mock.calls[0]?.[0];
    const check = session.setPermissionCheckHandler.mock.calls[0]?.[0];
    const device = session.setDevicePermissionHandler.mock.calls[0]?.[0];
    const display = session.setDisplayMediaRequestHandler.mock.calls[0]?.[0];
    if (request == null || check == null || device == null || display == null) throw new Error('権限ハンドラ不足');
    for (const permission of ['media', 'geolocation', 'notifications', 'usb', 'serial', 'unknown']) {
      const callback = vi.fn();
      Reflect.apply(request, undefined, [null, permission, callback, {}]);
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
      expect(Reflect.apply(check, undefined, [null, permission, 'app://pointercad', {}])).toBe(false);
    }
    expect(Reflect.apply(device, undefined, [{ deviceType: 'hid', origin: 'app://pointercad' }])).toBe(false);
    const displayCallback = vi.fn();
    Reflect.apply(display, undefined, [{}, displayCallback]);
    expect(displayCallback).toHaveBeenCalledExactlyOnceWith({});
  });
});
