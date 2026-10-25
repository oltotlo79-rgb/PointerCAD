import { useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { MatchViewIcon, ChevronRightIcon } from '../shell/icons.js';
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
  const selectionUnavailable = selectedView === undefined;
  const restoreUnavailable = !ready || selectionUnavailable;
  const unavailableTitle = (label: MessageKey, reason: MessageKey | null): string =>
    reason === null ? t(label) : `${t(label)}: ${t(reason)}`;
  const selectionReason = selectionUnavailable ? 'view.named.chooseRequired' : null;
  const readyReason = ready ? null : 'view.named.unavailable';
  const run = (action: NamedViewAction): void => {
    const result = runNamedViewAction(action);
    setMessage(result.ok ? null : errors[result.reason]);
    if (result.ok && action.kind === 'save') setName('');
  };
  return <details className="pcad-drawing-tools pcad-named-views">
    <summary title={t('view.named.tooltip')} aria-label={t('view.named.title')}>
      <MatchViewIcon /><span className="pcad-named-views__label">{t('view.named.title')}</span><ChevronRightIcon size={10} />
    </summary>
    <div className="pcad-menu__panel" role="group" aria-label={t('view.named.title')}>
      <button type="button" className="pcad-button" data-command-id="toolbar.namedView.quad" aria-pressed={quadEnabled} aria-disabled={!ready}
        title={unavailableTitle(quadEnabled ? 'view.quad.single' : 'view.quad.enable', readyReason)}
        onClick={() => { if (ready) useAppStore.getState().setQuadViewEnabled(!quadEnabled); }}>
        {t(quadEnabled ? 'view.quad.single' : 'view.quad.enable')}
      </button>
      <label>{t('view.named.choose')}<select title={t('controlGuide.namedView.choose')} className="pcad-field__input" aria-label={t('view.named.choose')} value={selectedView?.id ?? ''}
        onChange={(event) => {
          const view = views.find((entry) => entry.id === event.target.value);
          setSelected(view?.id ?? ''); setName(view?.name ?? '');
        }}>
        <option value="">{t('view.named.choose')}</option>
        {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select></label>
      <button type="button" className="pcad-button" data-command-id="toolbar.namedView.restore" aria-disabled={restoreUnavailable}
        title={unavailableTitle('view.named.restore', readyReason ?? selectionReason)}
        onClick={() => { if (!restoreUnavailable) run({ kind: 'restore', id: selected }); }}>{t('view.named.restore')}</button>
      <label>{t('view.named.name')}<input title={t('controlGuide.namedView.name')} className="pcad-field__input" aria-label={t('view.named.name')} value={name} maxLength={120}
        onChange={(event) => setName(event.target.value)} /></label>
      <div className="pcad-segmented">
        <button type="button" className="pcad-button" data-command-id="toolbar.namedView.save" title={unavailableTitle('view.named.save', readyReason)} aria-disabled={!ready}
          onClick={() => { if (ready) run({ kind: 'save', name }); }}>{t('view.named.save')}</button>
        <button type="button" className="pcad-button" data-command-id="toolbar.namedView.rename" title={unavailableTitle('view.named.rename', selectionReason)} aria-disabled={selectionUnavailable}
          onClick={() => { if (!selectionUnavailable) run({ kind: 'rename', id: selected, name }); }}>{t('view.named.rename')}</button>
        <button type="button" className="pcad-button" data-command-id="toolbar.namedView.delete" title={unavailableTitle('view.named.delete', selectionReason)} aria-disabled={selectionUnavailable}
          onClick={() => { if (!selectionUnavailable) run({ kind: 'delete', id: selected }); }}>{t('view.named.delete')}</button>
      </div>
      {message === null ? null : <p role="status">{t(message)}</p>}
    </div>
  </details>;
}
