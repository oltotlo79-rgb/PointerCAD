import { useEffect, useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { hidOf, requestSixDofDevice } from '../viewport/sixDofInput.js';
import { getSixDofAccess, notifySixDofChange, type SixDofAccess } from './sixDofAccess.js';

/**
 * 操作の割り当ての窓のタブ「3D マウス」(設計 B-09 3-5)。デスクトップ版だけで使える。
 * 「3D マウスを使う」を入にすると、本体が OS の確かめの窓を出し、許可された時だけ多軸の入力機器を読めるようにする。
 * 実機で確かめていない事を、利用者に見える 1 文で出す。Web 版(口が無い)は機器に一切触らず、読めない事だけを出す。
 */
export function SixDofForm(): React.JSX.Element {
  const id = useId();
  const access = getSixDofAccess();
  return <section className="pcad-settings__group pcad-camera-settings" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t('settings.sixDof.title')}</h3>
    <p role="note">{t('settings.sixDof.unverified')}</p>
    {access === undefined ? <p>{t('settings.sixDof.unsupported')}</p> : <SixDofSwitch access={access} />}
  </section>;
}

function SixDofSwitch({ access }: { readonly access: SixDofAccess }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  useEffect(() => {
    let live = true;
    access.enabled().then((value) => { if (live) setEnabled(value); }, () => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, [access]);
  const change = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (next) await access.enable(); else await access.disable();
      const now = await access.enabled();
      setEnabled(now);
      setMessage(next && !now ? 'settings.sixDof.notAllowed' : null);
      notifySixDofChange();
    } catch {
      setMessage('settings.sixDof.failed');
    } finally {
      setBusy(false);
    }
  };
  // 「つなぐ」: 多軸の入力機器の用途だけを候補にして、機器の選択の窓を出す(本体が許す表と用途で、もう一度確かめる)。
  const connect = async (): Promise<void> => {
    const hid = hidOf(globalThis.navigator);
    if (hid === undefined) { setMessage('settings.sixDof.unsupported'); return; }
    setBusy(true);
    try {
      setMessage(await requestSixDofDevice(hid) ? 'settings.sixDof.connected' : 'settings.sixDof.notConnected');
      notifySixDofChange();
    } catch {
      setMessage('settings.sixDof.notConnected');
    } finally {
      setBusy(false);
    }
  };
  return <>
    <label>
      <input type="checkbox" checked={enabled === true} disabled={enabled === null || busy} title={t('settings.sixDof.enableGuide')}
        onChange={(event) => { void change(event.currentTarget.checked); }} />
      {t('settings.sixDof.enable')}
    </label>
    <button type="button" className="pcad-button" title={t('settings.sixDof.connectGuide')} disabled={enabled !== true || busy}
      onClick={() => { void connect(); }}>{t('settings.sixDof.connect')}</button>
    {message === null ? null : <p role="status">{t(message)}</p>}
  </>;
}
