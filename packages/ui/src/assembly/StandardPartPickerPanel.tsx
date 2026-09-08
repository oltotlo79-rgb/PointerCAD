import type { FastenerDimensionSeries, ThreadSeries } from '@pointercad/model';
import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  commitStandardPartChoice, DEFAULT_STANDARD_PART_PICKER, defaultStandardPartChoice,
  findStandardPartChoice, STANDARD_PART_CATEGORIES, standardPartChoices,
  standardPartUsesDimensionSeries, standardPartUsesThreadSeries, type StandardPartCategory,
} from './standardPartPicker.js';

const CATEGORY_LABELS: Readonly<Record<StandardPartCategory, Parameters<typeof t>[0]>> = {
  hexBolt: 'assembly.standardPart.hexBolt',
  hexNut: 'assembly.standardPart.hexNut',
  plainWasher: 'assembly.standardPart.plainWasher',
  springWasher: 'assembly.standardPart.springWasher',
  socketHeadCapScrew: 'assembly.standardPart.socketHeadCapScrew',
  panHeadScrew: 'assembly.standardPart.panHeadScrew',
  deepGrooveBallBearing: 'assembly.standardPart.deepGrooveBallBearing',
  structuralSection: 'assembly.standardPart.structuralSection',
};

function categoryFrom(value: string): StandardPartCategory | null {
  return STANDARD_PART_CATEGORIES.find((category) => category === value) ?? null;
}

/** Non-modal picker that keeps the last choice so Enter can place repeated parts. */
export function StandardPartPicker(): React.JSX.Element | null {
  const open = useAppStore((state) => state.standardPartPickerOpen);
  const [category, setCategory] = useState(DEFAULT_STANDARD_PART_PICKER.category);
  const [choiceKey, setChoiceKey] = useState(DEFAULT_STANDARD_PART_PICKER.choiceKey);
  const [lengthSource, setLengthSource] = useState(DEFAULT_STANDARD_PART_PICKER.lengthSource);
  const [dimensionSeries, setDimensionSeries] = useState<FastenerDimensionSeries>(
    DEFAULT_STANDARD_PART_PICKER.dimensionSeries,
  );
  const [threadSeries, setThreadSeries] = useState<ThreadSeries>(
    DEFAULT_STANDARD_PART_PICKER.threadSeries,
  );
  const [error, setError] = useState<'unknownChoice' | 'invalidLength' | null>(null);
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);

  if (!open) return null;
  const choices = standardPartChoices(category, dimensionSeries);
  const choice = findStandardPartChoice(category, choiceKey, dimensionSeries)
    ?? defaultStandardPartChoice(category, dimensionSeries);

  const submit = (): void => {
    const result = commitStandardPartChoice(
      category, choice.key, lengthSource, dimensionSeries, threadSeries,
    );
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    if (useAppStore.getState().placeStandardPart(
      category, choice.key, lengthSource, dimensionSeries, threadSeries,
    )) setError(null);
  };

  return (
    <form className="pcad-popover pcad-popover--standard-part" role="dialog"
      aria-label={t('assembly.standardPart.title')}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        useAppStore.getState().closeStandardPartPicker();
      }}>
      <div className="pcad-popover__title">{t('assembly.standardPart.title')}</div>
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.category')}</span>
          <select ref={first} className="pcad-field__input" value={category}
            onChange={(event) => {
              const next = categoryFrom(event.currentTarget.value);
              if (next === null) return;
              setCategory(next);
              setChoiceKey(defaultStandardPartChoice(next, dimensionSeries).key);
              setLengthSource(next === 'structuralSection' ? '1000' : '30');
              setError(null);
            }}>
            {STANDARD_PART_CATEGORIES.map((item) => (
              <option key={item} value={item}>{t(CATEGORY_LABELS[item])}</option>
            ))}
          </select>
        </label>
        {standardPartUsesDimensionSeries(category) ? (
          <label className="pcad-field">
            <span className="pcad-field__label">{t('assembly.standardPart.dimensionSeries')}</span>
            <select className="pcad-field__input" value={dimensionSeries}
              onChange={(event) => {
                const next: FastenerDimensionSeries = event.currentTarget.value === 'main'
                  ? 'main' : 'annexJA';
                setDimensionSeries(next);
                setChoiceKey(defaultStandardPartChoice(category, next).key);
                setError(null);
              }}>
              <option value="annexJA">{t('assembly.standardPart.dimensionSeries.annexJA')}</option>
              <option value="main">{t('assembly.standardPart.dimensionSeries.main')}</option>
            </select>
          </label>
        ) : null}
        {standardPartUsesThreadSeries(category) ? (
          <label className="pcad-field">
            <span className="pcad-field__label">{t('assembly.standardPart.threadSeries')}</span>
            <select className="pcad-field__input" value={threadSeries}
              onChange={(event) => {
                setThreadSeries(event.currentTarget.value === 'fine' ? 'fine' : 'coarse');
                setError(null);
              }}>
              <option value="coarse">{t('assembly.standardPart.threadSeries.coarse')}</option>
              <option value="fine">{t('assembly.standardPart.threadSeries.fine')}</option>
            </select>
          </label>
        ) : null}
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.size')}</span>
          <select className="pcad-field__input" value={choice.key}
            onChange={(event) => { setChoiceKey(event.currentTarget.value); setError(null); }}>
            {choices.map((item) => (
              <option key={item.key} value={item.key}>
                {item.size}{item.verified ? '' : ` ${t('assembly.standardPart.unverifiedShort')}`}
              </option>
            ))}
          </select>
        </label>
        {choice.requiresLength ? (
          <label className={'pcad-field' + (error === 'invalidLength' ? ' pcad-field--error' : '')}>
            <span className="pcad-field__label">{t('assembly.standardPart.length')}</span>
            <input className="pcad-field__input" value={lengthSource}
              aria-invalid={error === 'invalidLength' ? true : undefined}
              onChange={(event) => { setLengthSource(event.currentTarget.value); setError(null); }} />
            <span className="pcad-field__unit">mm</span>
          </label>
        ) : null}
      </div>
      {!choice.verified ? (
        <p className="pcad-popover__hint" role="status">
          {t('assembly.standardPart.unverified').replace('{reason}', choice.note)}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="pcad-field__message" role="alert">
          {t(error === 'invalidLength'
            ? 'assembly.standardPart.invalidLength' : 'assembly.standardPart.unknownChoice')}
        </p>
      )}
      <p className="pcad-popover__hint">{t('assembly.standardPart.hint')}</p>
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button pcad-button--action">
          {t('assembly.standardPart.place')}
        </button>
        <button type="button" className="pcad-button"
          onClick={() => { useAppStore.getState().closeStandardPartPicker(); }}>
          {t('assembly.standardPart.close')}
        </button>
      </div>
    </form>
  );
}
