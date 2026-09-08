import { useEffect, useRef } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ASSEMBLY_MATE_TOOLS } from '../shell/menus/AssemblyGroup.js';
import { addSelectedOriginTarget, cancelMate, commitMateDraft, handleMateKey, mateDraftCheck, mateFailureText,
  mateKindReadiness, removeDraftTarget, startMate, toggleDraftFlipped, updateMateSource } from './mateActions.js';
import { mateKindNeedsValue } from './mateCommands.js';

export function MatePopover(): React.JSX.Element | null {
  const state = useAppStore();
  const draft = state.assemblyMateDraft;
  const panel = useRef<HTMLDivElement>(null);
  const open = draft !== null;
  const pair = draft?.targets.length === 2;
  const kind = draft?.kind;
  const editingId = draft?.editingMateId;
  useEffect(() => {
    if (open) {
      const input = panel.current?.querySelector<HTMLInputElement>('.pcad-field__input');
      if (input != null) { input.focus(); input.select(); }
      else panel.current?.focus();
    }
  }, [open, pair, kind, editingId]);
  if (draft === null || state.assemblyPlacement !== null) return null;
  const check = mateDraftCheck(state);
  const ready = check?.ok === true;
  const error = draft.issue ?? (draft.targets.length >= 2 ? mateFailureText(check) : null);
  const needsValue = mateKindNeedsValue(draft.kind, draft.targetKinds);
  const componentSelected = state.selection.filter((id) => state.assembly?.components.some((c) => c.id === id && !c.suppressed)).length === 1;
  return (
    <div ref={panel} tabIndex={-1} className="pcad-popover pcad-popover--numeric" role="dialog"
      aria-label={t(draft.editingMateId === null ? 'assembly.mate.title' : 'assembly.mate.edit')}
      style={{ left: 12, top: 12, maxWidth: 'calc(100% - 24px)', maxHeight: 'calc(100% - 24px)', overflow: 'auto' }}
      onKeyDown={(event) => {
        if (handleMateKey(event.key, event.nativeEvent.isComposing)) {
          event.preventDefault(); event.stopPropagation();
        }
      }}>
      <div className="pcad-popover__title">{t(draft.editingMateId === null ? 'assembly.mate.title' : 'assembly.mate.edit')}</div>
      <p className="pcad-popover__hint">
        {t(draft.targets.length === 0 ? 'assembly.mate.pickFirst' : draft.targets.length === 1 ? 'assembly.mate.pickSecond'
          : draft.targets.length === 2 ? 'assembly.mate.ready' : 'assembly.mate.needTwo')}
      </p>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.mate.kind')}</span>
        <select value={draft.kind} onChange={(event) => {
          const item = ASSEMBLY_MATE_TOOLS.find((candidate) => candidate.kind === event.target.value);
          if (item !== undefined) startMate(item.kind);
        }}>
          {ASSEMBLY_MATE_TOOLS.map((item) => {
            const readiness = mateKindReadiness(state, item.kind);
            return <option key={item.kind} value={item.kind} disabled={!readiness.ready}>{t(item.labelKey)}</option>;
          })}
        </select>
      </label>
      <ul>
        {draft.targets.map((target, index) => {
          const component = state.assembly?.components.find((item) => item.id === target.componentId);
          const element = target.kind === 'origin' ? t(`assembly.mate.origin.${target.element}`)
            : t(`selection.kind.${target.ref.fingerprint.kind}`);
          return <li key={target.componentId}>
            {t('assembly.mate.target').replace('{count}', String(index + 1)).replace('{name}', (component?.name ?? target.componentId) + ' / ' + element)}
            <button type="button" className="pcad-button" title={t('assembly.mate.removeTarget')}
              onClick={() => { removeDraftTarget(index); }}>{t('assembly.mate.removeTarget')}</button>
          </li>;
        })}
      </ul>
      <div className="pcad-popover__actions">
        {(['origin', 'x', 'y', 'z', 'xy', 'xz', 'yz'] as const).map((element) => (
          <button key={element} type="button" className="pcad-button" aria-disabled={!componentSelected}
            title={componentSelected ? t(`assembly.mate.origin.${element}`) : t('assembly.mate.selectComponent')}
            onClick={() => { if (componentSelected) addSelectedOriginTarget(element); }}>
            {t(`assembly.mate.origin.${element}`)}
          </button>
        ))}
      </div>
      {needsValue ? (
        <label className="pcad-field">
          <span className="pcad-field__label">{t(draft.kind === 'angle' ? 'assembly.mate.angle' : draft.kind === 'coincident' ? 'assembly.mate.offset' : 'assembly.mate.distance')}</span>
          <input className="pcad-field__input" value={draft.source} aria-invalid={error !== null}
            onChange={(event) => { updateMateSource(event.target.value); }} />
          <span className="pcad-field__unit">{t(draft.kind === 'angle' ? 'numericInput.unit.degree' : 'numericInput.unit.mm')}</span>
        </label>
      ) : null}
      {error === null ? null : <p role="status" className="pcad-field__message pcad-field__message--error">{error}</p>}
      <label className="pcad-checkbox">
        <input type="checkbox" checked={draft.flipped} onChange={() => { toggleDraftFlipped(); }} />
        {t('assembly.mate.flipped')}
      </label>
      <div className="pcad-popover__actions">
        <button type="button" className="pcad-button pcad-button--action" aria-disabled={!ready}
          title={mateFailureText(check) ?? t('assembly.mate.commit')}
          onClick={() => { if (ready) commitMateDraft(); }}>
          {t(draft.editingMateId === null ? 'assembly.mate.commit' : 'assembly.mate.update')}
        </button>
        <button type="button" className="pcad-button" onClick={cancelMate}>{t('assembly.mate.cancel')}</button>
      </div>
    </div>
  );
}
