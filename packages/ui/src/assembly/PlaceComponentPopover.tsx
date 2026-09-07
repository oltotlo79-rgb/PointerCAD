import { useEffect, useRef } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { cancelPlaceComponent, commitPlaceComponent, updatePlaceComponentSource } from './placeComponentActions.js';
import { placementFromSources } from './placeComponent.js';

const FIELDS = [
  ['assembly.place.x', 0],
  ['assembly.place.y', 1],
  ['assembly.place.z', 2],
] as const;

/** 部品を選んだ後、ビューポート内でXYZを式として受け取る非モーダル入力。 */
export function PlaceComponentPopover(): React.JSX.Element | null {
  const placement = useAppStore((state) => state.assemblyPlacement);
  const assembly = useAppStore((state) => state.assembly);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (placement?.kind === 'ready') {
      firstField.current?.focus();
    }
  }, [placement?.requestId, placement?.kind]);

  if (placement === null || assembly === null) return null;
  if (placement.kind === 'choosing') {
    return (
      <div className="pcad-popover" role="status" style={{ left: '16px', top: '16px' }}>
        <div className="pcad-popover__title">{t('assembly.place.choosing')}</div>
      </div>
    );
  }
  const sources = placement.sources;
  const evaluation = placementFromSources(assembly, sources);
  const committing = placement.kind === 'committing';

  const submit = (): void => {
    if (evaluation.ok && !committing) void commitPlaceComponent();
  };

  return (
    <div
      className="pcad-popover"
      role="dialog"
      aria-label={t('assembly.place.title')}
      style={{ left: '16px', top: '16px' }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelPlaceComponent();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      <div className="pcad-popover__title">{t('assembly.place.title')}</div>
      <div className="pcad-popover__fields">
        {FIELDS.map(([labelKey, index]) => {
          const error = evaluation.ok ? null : evaluation.errors[index];
          const value = evaluation.ok ? evaluation.placement.position[index] : null;
          return (
            <label key={labelKey} className={'pcad-field' + (error === null ? '' : ' pcad-field--error')}>
              <span className="pcad-field__label">{t(labelKey)}</span>
              <input
                ref={index === 0 ? firstField : null}
                className="pcad-field__input"
                value={sources[index]}
                disabled={committing}
                aria-invalid={error === null ? undefined : true}
                onChange={(event) => {
                  updatePlaceComponentSource(index, event.currentTarget.value);
                }}
              />
              <span className="pcad-field__unit">{t('assembly.place.unit')}</span>
              <span className="pcad-field__message">
                {error?.message ?? (value === null ? '' : `= ${value.display}`)}
              </span>
            </label>
          );
        })}
      </div>
      <p className="pcad-popover__hint">{t('assembly.place.hint')}</p>
      <div className="pcad-popover__actions">
        <button
          type="button"
          className="pcad-button pcad-button--action"
          aria-disabled={!evaluation.ok || committing}
          title={t('assembly.place.commitTooltip')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {t(committing ? 'assembly.place.committing' : 'assembly.place.commit')}
        </button>
        <button
          type="button"
          className="pcad-button"
          title={t('assembly.place.cancelTooltip')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancelPlaceComponent}
        >
          {t('assembly.place.cancel')}
        </button>
      </div>
    </div>
  );
}
