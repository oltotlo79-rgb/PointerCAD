import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { isSixDofDevice, SIX_DOF_DEVICE_IDS, type HidDeviceId } from './sixDofDeviceTable.js';
import { allowSixDofDevices, type SixDofDeviceChooser } from './sixDofDevices.js';

/*
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)の許可の例外は、断る場合を先に確かめる。番号は単体のための架空の値で、
 * 実在の機器を指さない。
 */
const IDS: readonly HidDeviceId[] = [{ vendorId: 0x1234, productId: 0x5678 }];
const MULTI_AXIS = [{ usagePage: 0x01, usage: 0x08 }];
const listed = { deviceId: 'listed', name: 'x', vendorId: 0x1234, productId: 0x5678, collections: MULTI_AXIS };
const APP = 'app://pointercad';

function attach(enabled: { value: boolean }, choose = vi.fn<SixDofDeviceChooser>(() => Promise.resolve(0)), ids = IDS) {
  const session = {
    setPermissionCheckHandler: vi.fn<Session['setPermissionCheckHandler']>(),
    setDevicePermissionHandler: vi.fn<Session['setDevicePermissionHandler']>(),
    on: vi.fn<(event: 'select-hid-device', listener: (...args: never[]) => void) => unknown>(),
  };
  allowSixDofDevices(session, { enabled: () => enabled.value }, choose, ids);
  const check = session.setPermissionCheckHandler.mock.calls[0]?.[0];
  const device = session.setDevicePermissionHandler.mock.calls[0]?.[0];
  const select = session.on.mock.calls[0]?.[1];
  if (check == null || device == null || select === undefined) throw new Error('口の登録が足りません');
  expect(session.on.mock.calls[0]?.[0]).toBe('select-hid-device');
  return {
    check: (permission: string, origin: string): unknown => Reflect.apply(check, undefined, [null, permission, origin, {}]),
    device: (details: object): unknown => Reflect.apply(device, undefined, [details]),
    select: async (deviceList: readonly object[], url = `${APP}/index.html`): Promise<{ id: unknown; prevented: boolean }> => {
      const preventDefault = vi.fn();
      const answer = new Promise<unknown>((resolve) => {
        Reflect.apply(select, undefined, [{ preventDefault }, { deviceList, frame: url === '' ? null : { url } }, resolve]);
      });
      const id = await answer;
      return { id, prevented: preventDefault.mock.calls.length === 1 };
    },
    choose,
  };
}

describe('許す表と機器の見分け', () => {
  it('製品の許す表は、2 つの資料で一致した 18 組だけで、重なりが無く、表に無い番号は許さない', () => {
    expect(SIX_DOF_DEVICE_IDS).toHaveLength(18);
    expect(new Set(SIX_DOF_DEVICE_IDS.map((id) => `${String(id.vendorId)}:${String(id.productId)}`)).size).toBe(18);
    expect(SIX_DOF_DEVICE_IDS.every((id) => Number.isInteger(id.vendorId) && Number.isInteger(id.productId)
      && id.vendorId > 0 && id.vendorId <= 0xffff && id.productId > 0 && id.productId <= 0xffff)).toBe(true);
    expect(new Set(SIX_DOF_DEVICE_IDS.map((id) => id.vendorId))).toEqual(new Set([0x046d, 0x256f]));
    // 2 つ目の資料にだけ載り、1 つ目の資料に製品の番号が無かった組は入れない。
    for (const productId of [0xc636, 0xc638, 0xc63a]) {
      expect(SIX_DOF_DEVICE_IDS.some((id) => id.vendorId === 0x256f && id.productId === productId)).toBe(false);
    }
    expect(isSixDofDevice(listed)).toBe(false);
  });

  it('表に載る番号でも、多軸の入力機器の用途が無い機器は許さない', () => {
    const [first] = SIX_DOF_DEVICE_IDS;
    if (first === undefined) throw new Error('表が空です');
    const real = { deviceId: 'real', name: 'x', ...first };
    expect(isSixDofDevice({ ...real, collections: MULTI_AXIS })).toBe(true);
    expect(isSixDofDevice({ ...real, collections: [{ usagePage: 0x01, usage: 0x02 }] })).toBe(false);
    expect(isSixDofDevice({ ...real, collections: undefined })).toBe(false);
  });

  it('番号が表に載っても、多軸の入力機器の用途が無ければ断り、形の違う値も断る', () => {
    expect(isSixDofDevice(listed, IDS)).toBe(true);
    expect(isSixDofDevice({ ...listed, collections: [{ usagePage: 0x01, usage: 0x06 }] }, IDS)).toBe(false);
    expect(isSixDofDevice({ ...listed, collections: [] }, IDS)).toBe(false);
    expect(isSixDofDevice({ ...listed, productId: 0x5679 }, IDS)).toBe(false);
    expect(isSixDofDevice({ ...listed, vendorId: '4660' }, IDS)).toBe(false);
    for (const value of [null, undefined, 'listed', 1, [], { collections: MULTI_AXIS }]) expect(isSixDofDevice(value, IDS)).toBe(false);
  });
});

describe('印が切(既定)の時は、HID の 3 つの口を全部断る', () => {
  it('照会・機器・選択のどれも許さない', async () => {
    const gate = attach({ value: false });
    expect(gate.check('hid', APP)).toBe(false);
    expect(gate.device({ deviceType: 'hid', origin: APP, device: listed })).toBe(false);
    expect(await gate.select([listed])).toEqual({ id: '', prevented: true });
    expect(gate.choose).not.toHaveBeenCalled();
  });
});

describe('印が入でも断る物', () => {
  it('HID 以外の権限・機器の種類(USB・シリアル・カメラなど)は断る', () => {
    const gate = attach({ value: true });
    for (const permission of ['usb', 'serial', 'media', 'geolocation', 'notifications', 'unknown']) {
      expect(gate.check(permission, APP), permission).toBe(false);
    }
    for (const deviceType of ['usb', 'serial']) {
      expect(gate.device({ deviceType, origin: APP, device: listed }), deviceType).toBe(false);
    }
  });

  it('app 配信元でない求め(局所の http・file:・about:blank・空・別の app)は断る', async () => {
    const gate = attach({ value: true });
    for (const origin of ['http://127.0.0.1:43123', 'file:///C:/x', 'about:blank', '', 'app://other', 'https://pointercad']) {
      expect(gate.check('hid', origin), origin).toBe(false);
      expect(gate.device({ deviceType: 'hid', origin, device: listed }), origin).toBe(false);
    }
    expect(await gate.select([listed], 'http://127.0.0.1:43123/')).toEqual({ id: '', prevented: true });
    expect(await gate.select([listed], '')).toEqual({ id: '', prevented: true });
  });

  it('表に無い HID 機器(キーボード・マウス・ゲームパッドの形)は、許可も選択もしない', async () => {
    const gate = attach({ value: true });
    const keyboard = { ...listed, deviceId: 'keyboard', productId: 0x0001, collections: [{ usagePage: 0x01, usage: 0x06 }] };
    const unlisted = { ...listed, deviceId: 'unlisted', productId: 0x0002 };
    expect(gate.device({ deviceType: 'hid', origin: APP, device: keyboard })).toBe(false);
    expect(gate.device({ deviceType: 'hid', origin: APP, device: unlisted })).toBe(false);
    expect(await gate.select([keyboard, unlisted])).toEqual({ id: '', prevented: true });
    expect(await gate.select([keyboard, listed, unlisted])).toEqual({ id: 'listed', prevented: true });
  });

  it('許す機器が 2 つ以上の時は利用者に選ばせ、やめたら選ばない。選ぶ間に印が切になったら渡さない', async () => {
    const enabled = { value: true };
    const second = { ...listed, deviceId: 'second' };
    const gate = attach(enabled, vi.fn<SixDofDeviceChooser>().mockResolvedValueOnce(1).mockResolvedValueOnce(null)
      .mockImplementationOnce(() => { enabled.value = false; return Promise.resolve(0); }));
    expect((await gate.select([listed, second])).id).toBe('second');
    expect((await gate.select([listed, second])).id).toBe('');
    expect((await gate.select([listed, second])).id).toBe('');
    expect(gate.choose).toHaveBeenCalledTimes(3);
  });
});

describe('許す時', () => {
  it('印が入・app 配信元・HID・多軸の用途・表に載る番号の全部がそろった時だけ許す', () => {
    const gate = attach({ value: true });
    expect(gate.check('hid', APP)).toBe(true);
    expect(gate.check('hid', `${APP}/index.html`)).toBe(true);
    expect(gate.device({ deviceType: 'hid', origin: APP, device: listed })).toBe(true);
  });
});
