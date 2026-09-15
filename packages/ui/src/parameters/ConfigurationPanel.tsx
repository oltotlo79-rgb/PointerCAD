import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { type ConfigurationAction, type ConfigurationActionResult } from './configurationActions.js';
import { runMathConfigurationAction } from './mathConfigurationActions.js';

const ERROR_KEYS: Readonly<Record<Extract<ConfigurationActionResult, { readonly ok: false }>['reason'], MessageKey>> = {
  emptyName: 'configuration.error.emptyName', duplicateName: 'configuration.error.duplicateName',
  notFound: 'configuration.error.notFound', unknownParameter: 'configuration.error.unknownParameter',
  missingParameter: 'configuration.error.missingParameter', invalidExpression: 'configuration.error.invalidExpression',
  partRequired: 'configuration.error.partRequired',
};

/** 既存パラメータ区画の先頭に置く。親がdocumentVersionをkeyにして下書きをリセットする。 */
export function ConfigurationPanel(): React.JSX.Element {
  const document = useAppStore((state) => state.document);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  const active = document.activeConfigurationId;
  const run = (action: ConfigurationAction): void => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage(null);
    void runMathConfigurationAction(action, { signal: controller.signal }).then(result => {
      if (pending.current !== controller || controller.signal.aborted) return;
      pending.current = null;
      setBusy(false);
      setMessage(result.ok ? null : t(ERROR_KEYS[result.reason]));
      if (result.ok) setName('');
    });
  };
  return <section aria-label={t('configuration.label')} className="pcad-section">
    <label className="pcad-field">
      <span className="pcad-field__label">{t('configuration.label')}</span>
      <select title={t('controlGuide.configuration.choose')} disabled={busy} className="pcad-field__input" aria-label={t('configuration.label')} value={active ?? ''}
        onChange={(event) => { run({ kind: 'activate', id: event.target.value }); }}>
        {active === null ? <option value="">{t('configuration.none')}</option> : null}
        {document.configurations.map((configuration) => <option key={configuration.id} value={configuration.id}>{configuration.name}</option>)}
      </select>
    </label>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('configuration.name')}</span>
    <input title={t('controlGuide.configuration.name')} disabled={busy} className="pcad-field__input" aria-label={t('configuration.name')} value={name} onChange={(event) => { setName(event.target.value); setMessage(null); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); run({ kind: 'create', name }); } }} />
    </label>
    <div className="pcad-parameter__actions">
      <button type="button" disabled={busy} className="pcad-button" title={t('configuration.createHint')}
        onClick={() => { run({ kind: 'create', name }); }}>{t('configuration.create')}</button>
      <button type="button" className="pcad-button" disabled={busy || active === null} title={t('configuration.renameHint')}
        onClick={() => { if (active !== null) run({ kind: 'rename', id: active, name }); }}>{t('configuration.rename')}</button>
      <button type="button" className="pcad-button" disabled={busy || active === null} title={t('configuration.deleteHint')}
        onClick={() => { if (active !== null) run({ kind: 'delete', id: active }); }}>{t('configuration.delete')}</button>
    </div>
    {busy ? <div role="status">{t('math.calculating')} <button title={t('controlGuide.configuration.stop')} type="button" className="pcad-button" onClick={() => {
      pending.current?.abort(); pending.current = null; setBusy(false); setMessage(null);
    }}>{t('math.cancel')}</button></div> : null}
    {message === null ? null : <p role="alert" className="pcad-panel__error">{message}</p>}
  </section>;
}
