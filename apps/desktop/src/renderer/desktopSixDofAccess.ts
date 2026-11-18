import type { SixDofAccess } from '@pointercad/ui';

/**
 * preload の 3D マウス(多軸の入力機器。B-09 3-5)の 3 つの口を、画面が使う `SixDofAccess` の形へ直す。
 * 口が 1 つでも欠けていれば null(画面は「この環境では読めません」を出し、機器に触らない)。
 * 本体の答えは `true` の時だけ真として扱う(形の違う答えは偽)。
 */
const METHODS = ['enableSixDof', 'disableSixDof', 'sixDofEnabled'] as const;

export function createDesktopSixDofAccess(scope: object = globalThis): SixDofAccess | null {
  const api: unknown = Reflect.get(scope, 'pointercadDesktop');
  if (typeof api !== 'object' || api === null || !METHODS.every((name) => typeof Reflect.get(api, name) === 'function')) return null;
  const call = async (name: (typeof METHODS)[number]): Promise<boolean> => {
    const method: unknown = Reflect.get(api, name);
    if (typeof method !== 'function') return false;
    const answer: unknown = await Reflect.apply(method, api, []);
    return answer === true;
  };
  return { enable: () => call('enableSixDof'), disable: () => call('disableSixDof'), enabled: () => call('sixDofEnabled') };
}
