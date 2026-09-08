import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/** 分解距離を式で受け取る、ビューポート内の非モーダル入力。 */
export function ExplodePopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyExplodeDraft);
  const error = useAppStore((state) => state.assemblyExplodeError);
  const [source, setSource] = useState('50');
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('z');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft !== null) {
      setSource('50');
      setAxis(draft.direction.kind === 'world' ? draft.direction.axis : 'z');
      input.current?.focus();
    }
  }, [draft]);
  if (draft === null) return null;
  const submit = (): void => {
    const state = useAppStore.getState();
    const count = state.assembly?.presentation.length ?? 0;
    state.commitAssemblyExplode(source,
      t('assembly.explode.defaultName').replace('{count}', String(count + 1)),
      { kind: 'world', axis });
  };
  return (
    <div className="pcad-popover pcad-popover--explode" role="dialog"
      aria-label={t('assembly.explode.title')}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          useAppStore.getState().cancelAssemblyExplode();
        } else if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation(); submit();
        }
      }}>
      <div className="pcad-popover__title">{t('assembly.explode.title')}</div>
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.explode.direction')}</span>
          <select className="pcad-field__input" value={axis}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'x' || value === 'y' || value === 'z') setAxis(value);
            }}>
            <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
          </select>
        </label>
        <label className={'pcad-field' + (error === null ? '' : ' pcad-field--error')}>
          <span className="pcad-field__label">{t('assembly.explode.distance')}</span>
          <input ref={input} className="pcad-field__input" value={source}
            aria-invalid={error === null ? undefined : true}
            onChange={(event) => { setSource(event.currentTarget.value); }} />
          <span className="pcad-field__unit">mm</span>
          <span className="pcad-field__message">
            {error === null ? t('assembly.explode.selectedCount').replace('{count}', String(draft.componentIds.length))
              : t(error === 'invalidExpression' ? 'assembly.explode.invalidExpression' : 'assembly.explode.invalidStep')}
          </span>
        </label>
      </div>
      <p className="pcad-popover__hint">{t('assembly.explode.hint')}</p>
      <div className="pcad-popover__actions">
        <button type="button" className="pcad-button pcad-button--action"
          title={t('assembly.explode.commitTooltip')} onMouseDown={(event) => { event.preventDefault(); }}
          onClick={submit}>{t('assembly.explode.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.explode.cancelTooltip')}
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={() => { useAppStore.getState().cancelAssemblyExplode(); }}>
          {t('assembly.explode.cancel')}
        </button>
      </div>
    </div>
  );
}
