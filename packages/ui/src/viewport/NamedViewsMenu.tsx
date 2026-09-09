import { useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { runNamedViewAction, type NamedViewAction, type NamedViewActionResult } from './namedViewActions.js';

const errors: Readonly<Record<Extract<NamedViewActionResult, { readonly ok: false }>['reason'], MessageKey>> = {
  emptyName: 'view.named.emptyName', duplicateName: 'view.named.duplicateName', invalidCamera: 'view.named.invalidCamera',
  notFound: 'view.named.notFound', unavailable: 'view.named.unavailable',
};

export function NamedViewsMenu(): React.JSX.Element {
  const documentId = useAppStore((state) => state.activeDocumentId);
  return <NamedViewsForm key={documentId} />;
}

function NamedViewsForm(): React.JSX.Element {
  const views = useAppStore((state) => (state.assembly ?? state.document).namedViews);
  const ready = useAppStore((state) => state.viewCameraController !== null);
  const quadEnabled = useAppStore((state) => state.quadCamera !== null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState<MessageKey | null>(null);
  const selectedView = views.find((view) => view.id === selected);
  const run = (action: NamedViewAction): void => {
    const result = runNamedViewAction(action);
    setMessage(result.ok ? null : errors[result.reason]);
    if (result.ok && action.kind === 'save') setName('');
  };
  return <details className="pcad-drawing-tools">
    <summary title={t('view.named.tooltip')}>{t('view.named.title')}</summary>
    <div className="pcad-menu__panel" role="group" aria-label={t('view.named.title')}>
      <button type="button" className="pcad-button" aria-pressed={quadEnabled} disabled={!ready}
        onClick={() => useAppStore.getState().setQuadViewEnabled(!quadEnabled)}>
        {t(quadEnabled ? 'view.quad.single' : 'view.quad.enable')}
      </button>
      <label>{t('view.named.choose')}<select className="pcad-field__input" aria-label={t('view.named.choose')} value={selectedView?.id ?? ''}
        onChange={(event) => {
          const view = views.find((entry) => entry.id === event.target.value);
          setSelected(view?.id ?? ''); setName(view?.name ?? '');
        }}>
        <option value="">{t('view.named.choose')}</option>
        {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select></label>
      <button type="button" className="pcad-button" disabled={!ready || selectedView === undefined}
        onClick={() => run({ kind: 'restore', id: selected })}>{t('view.named.restore')}</button>
      <label>{t('view.named.name')}<input className="pcad-field__input" aria-label={t('view.named.name')} value={name} maxLength={120}
        onChange={(event) => setName(event.target.value)} /></label>
      <div className="pcad-segmented">
        <button type="button" className="pcad-button" disabled={!ready} onClick={() => run({ kind: 'save', name })}>{t('view.named.save')}</button>
        <button type="button" className="pcad-button" disabled={selectedView === undefined} onClick={() => run({ kind: 'rename', id: selected, name })}>{t('view.named.rename')}</button>
        <button type="button" className="pcad-button" disabled={selectedView === undefined} onClick={() => run({ kind: 'delete', id: selected })}>{t('view.named.delete')}</button>
      </div>
      {message === null ? null : <p role="status">{t(message)}</p>}
    </div>
  </details>;
}
