import { useEffect, useSyncExternalStore } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { getOfflineGateway, type OfflineGateway, type OfflineStatus } from './offlineGateway.js';

const reasons: Readonly<Record<NonNullable<OfflineStatus['reason']>, MessageKey>> = {
  unsupported: 'offline.unsupported', busy: 'offline.busy', download: 'offline.downloadFailed',
  storage: 'offline.storageFailed', registration: 'offline.registrationFailed', missing: 'offline.missing',
  cancelled: 'offline.cancelled',
};
function EnabledOfflineSettings({ gateway }: { readonly gateway: OfflineGateway }): React.JSX.Element {
  const state = useSyncExternalStore(gateway.subscribe, gateway.getSnapshot);
  useEffect(() => { void gateway.refresh(); }, [gateway]);
  const busy = state.phase === 'preparing' || state.phase === 'checking';
  const message = state.reason === undefined ? t(`offline.${state.phase}`) : t(reasons[state.reason]);
  return <section className="pcad-settings__group" aria-label={t('offline.title')} data-help-topic="offline-use">
    <span className="pcad-settings__label" title={t('offline.hint')}>{t('offline.title')}</span>
    <p role="status" aria-live="polite">{message}</p>
    {state.phase === 'preparing' ? <>
      <progress aria-label={t('offline.progress')} max={Math.max(1, state.totalBytes)} value={state.receivedBytes} />
      <span>{t('offline.count').replace('{stored}', String(state.storedFiles)).replace('{total}', String(state.totalFiles))}</span>
    </> : null}
    {state.totalBytes > 0 ? <span>{t('offline.bytes').replace('{received}', (state.receivedBytes / 1_000_000).toFixed(1))
      .replace('{total}', (state.totalBytes / 1_000_000).toFixed(1))}</span> : null}
    <span>{state.availableBytes === undefined ? t('offline.capacityUnknown')
      : t('offline.capacity').replace('{available}', (state.availableBytes / 1_000_000).toFixed(1))}</span>
    <button type="button" className="pcad-button" disabled={busy} title={t('offline.prepareHint')}
      onClick={() => { void gateway.prepare(); }}>{t(state.phase === 'ready' ? 'offline.update' : 'offline.prepare')}</button>
    {state.phase === 'preparing' ? <button type="button" className="pcad-button" title={t('offline.cancelHint')}
      onClick={() => { gateway.cancel(); }}>{t('offline.cancel')}</button> : null}
    <p className="pcad-settings__hint">{t('offline.hint')}</p>
  </section>;
}
export function OfflineSettings(): React.JSX.Element | null {
  const gateway = getOfflineGateway();
  return gateway === undefined ? null : <EnabledOfflineSettings gateway={gateway} />;
}
