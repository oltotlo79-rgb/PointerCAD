import type { Session } from 'electron';

import { APP_HOST, APP_SCHEME } from './appProtocol.js';
import { isSixDofDevice, SIX_DOF_DEVICE_IDS, type HidDeviceId } from './sixDofDeviceTable.js';

/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)の読み取りの許可の例外。R11 の全面拒否(sessionPermissions.ts)の上に、
 * HID の照会・機器・選択の 3 つの口だけを、次の全部を満たす時に限って許す形へ差し替える。
 * - 利用者が OS の確かめの窓で認めて、主プロセスの印が入になっている(sixDofGate.ts)。
 * - 求めた画面が app 配信元(`app://pointercad`)。
 * - 機器が HID の規格の「多軸の入力機器」の用途(Generic Desktop 0x01・Multi-axis Controller 0x08)を持ち、かつ
 *   製造元と製品の番号の組が許す表に載る(sixDofDeviceTable.ts)。
 * 要求の口(setPermissionRequestHandler)・画面共有・USB・シリアルは、今までどおり全部断る。
 */

/** app 配信元からの求めか(パスは問わない。開発用のサーバー・OCCT の局所の配信・file:・about:blank は断る)。 */
function fromApp(origin: unknown): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  try {
    const url = new URL(origin);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

/** 主プロセスが持つ印(入にできるのは、利用者が OS の確かめの窓で認めた時だけ)。 */
interface SixDofGateState {
  readonly enabled: () => boolean;
}

/** 選択の候補の 1 つ(機器の名前は製品名なので、窓にも記録にも出さない)。 */
interface HidCandidate {
  readonly deviceId: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly collections: unknown;
}

/** 許す機器が 2 つ以上ある時に、どれを使うかを利用者に選ばせる(番号の 0 始まり。やめたら null)。 */
export type SixDofDeviceChooser = (count: number) => Promise<number | null>;

interface SixDofSession {
  readonly setPermissionCheckHandler: Session['setPermissionCheckHandler'];
  readonly setDevicePermissionHandler: Session['setDevicePermissionHandler'];
  on(event: 'select-hid-device', listener: (event: { preventDefault(): void },
    details: { readonly deviceList: readonly HidCandidate[]; readonly frame: { readonly url: string } | null },
    callback: (deviceId?: string | null) => void) => void): unknown;
}

/** 選択の窓の代わり: 許す機器だけを候補にし、1 つならそれ、2 つ以上なら利用者に選ばせ、0 なら選ばない。 */
async function chooseSixDofDevice(candidates: readonly HidCandidate[], choose: SixDofDeviceChooser,
  ids: readonly HidDeviceId[]): Promise<string> {
  const allowed = candidates.filter((device) => isSixDofDevice(device, ids));
  if (allowed.length <= 1) return allowed[0]?.deviceId ?? '';
  const index = await choose(allowed.length);
  return index === null ? '' : allowed[index]?.deviceId ?? '';
}

/**
 * HID の 3 つの口を、上の条件の時だけ許す形へ差し替える。`denyBrowserPermissions` の後に 1 回だけ呼ぶ
 * (照会・機器の口は差し替わる。どちらも、条件の外は false を返すので、R11 の拒否は保たれる)。
 */
export function allowSixDofDevices(session: SixDofSession, gate: SixDofGateState, choose: SixDofDeviceChooser,
  ids: readonly HidDeviceId[] = SIX_DOF_DEVICE_IDS): void {
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permission === 'hid' && gate.enabled() && fromApp(requestingOrigin));
  session.setDevicePermissionHandler((details) =>
    details.deviceType === 'hid' && gate.enabled() && fromApp(details.origin) && isSixDofDevice(details.device, ids));
  session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (!gate.enabled() || !fromApp(details.frame?.url)) { callback(''); return; }
    // 選んでいる間に印が切になったら、選んだ機器も渡さない。
    void chooseSixDofDevice(details.deviceList, choose, ids)
      .then((deviceId) => { callback(gate.enabled() ? deviceId : ''); }, () => { callback(''); });
  });
}
