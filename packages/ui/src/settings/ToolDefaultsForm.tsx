import { useId, useMemo, useState } from 'react';
import { analyzeParameters } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { asksCoordinate, fieldUnitLabelKey } from '../sketch/numericInput.js';
import type { NumericDefaultSources } from '../sketch/numericDefaultSources.js';
import { numericToolDefaultError, toolDefaultEntries, type NumericDefaultEntry } from './numericToolDefaults.js';
import './toolDefaultsSettings.css';

function groupName(entry: NumericDefaultEntry): string {
  return t(entry.titleKey) + (entry.step !== undefined && entry.mode !== undefined && asksCoordinate(entry.step)
    ? ` (${t(`numericInput.mode.${entry.mode}`)})` : '');
}

export function ToolDefaultsForm(): React.JSX.Element {
  const id = useId(), current = useAppStore(state => state.displaySettings.numericToolDefaults);
  const analysis = useAppStore(state => state.parameterAnalysis);
  const nonLengthVariables = useAppStore(state => state.nonLengthVariables);
  const drawing = useAppStore(state => state.drawing);
  const drawingAnalysis = useMemo(() => drawing === null ? null : analyzeParameters(drawing.parameters, []), [drawing]);
  const entries = toolDefaultEntries();
  const groups = [...new Map(entries.map(entry => [entry.group, entry])).values()];
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(groups[0]?.group ?? '');
  const [draft, setDraft] = useState<NumericDefaultSources | null>(null);
  const sources = draft ?? current ?? {};
  const visibleGroups = groups.filter(entry => groupName(entry).includes(query.trim()));
  const group = visibleGroups.some(entry => entry.group === selected) ? selected : visibleGroups[0]?.group;
  const fields = entries.filter(entry => entry.group === group);
  const errors = draft === null ? [] : entries.flatMap(entry => {
    const source = sources[entry.id];
    if (source === undefined || source === current?.[entry.id]) return [];
    const message = numericToolDefaultError(entry, source, drawingAnalysis ?? { variables: analysis.variables,
      exactVariables: analysis.exactVariables, nonLengthVariables });
    return message === null ? [] : [{ entry, message }];
  });
  return <form className="pcad-settings__group pcad-tool-defaults" aria-label={t('settings.toolDefaults.title')} data-help-topic="display-settings"
    onSubmit={event => {
      event.preventDefault(); if (draft === null || errors.length > 0) return;
      const state = useAppStore.getState();
      state.setDisplaySettings({ ...state.displaySettings, numericToolDefaults: { ...draft } }); setDraft(null);
    }}>
    <h3>{t('settings.toolDefaults.title')}</h3>
    <p>{t('settings.toolDefaults.hint')}</p>
    <label htmlFor={`${id}-search`}>{t('settings.toolDefaults.search')}</label>
    <input title={t('settings.toolDefaults.searchGuide')} id={`${id}-search`} className="pcad-field__input" value={query} onChange={event => setQuery(event.currentTarget.value)} />
    <label htmlFor={`${id}-group`}>{t('settings.toolDefaults.group')}</label>
    <select title={t('settings.toolDefaults.groupGuide')} id={`${id}-group`} value={group ?? ''} disabled={visibleGroups.length === 0} onChange={event => setSelected(event.currentTarget.value)}>
      {visibleGroups.map(entry => <option key={entry.group} value={entry.group}>{groupName(entry)}</option>)}
    </select>
    {fields.length === 0 ? <p role="status">{t('settings.toolDefaults.notFound')}</p> : fields.map(entry => {
      const field = entry.fields[0], error = errors.find(item => item.entry.id === entry.id)?.message;
      if (field === undefined) return null;
      const fieldId = `${id}-${entry.id.replaceAll('/', '-')}`;
      return <div key={entry.id} className="pcad-tool-defaults__field">
        <label htmlFor={fieldId}>{t(field.labelKey)} ({t(entry.unitLabelKey ?? fieldUnitLabelKey(field.unit))})</label>
        <input id={fieldId} className="pcad-field__input" type="text" inputMode="text" maxLength={256} autoComplete="off" spellCheck={false}
          value={sources[entry.id] ?? field.defaultSource} title={t(field.tooltipKey)} aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : `${fieldId}-error`}
          onChange={event => setDraft({ ...sources, [entry.id]: event.currentTarget.value })} />
        {error === undefined ? null : <p id={`${fieldId}-error`} role="alert">{error}</p>}
      </div>;
    })}
    {errors.some(error => error.entry.group !== group) ? <p role="alert">{t('settings.toolDefaults.otherErrors')}
      {errors.filter(error => error.entry.group !== group).map(error => <span key={error.entry.id}>{groupName(error.entry)}: {error.message} </span>)}
    </p> : null}
    <div className="pcad-tool-defaults__actions">
      <button type="submit" className="pcad-button" title={t('settings.toolDefaults.applyGuide')} disabled={draft === null || errors.length > 0}>{t('settings.toolDefaults.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.toolDefaults.cancelGuide')} disabled={draft === null} onClick={() => setDraft(null)}>{t('settings.toolDefaults.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.toolDefaults.resetGuide')} onClick={() => setDraft({})}>{t('settings.toolDefaults.reset')}</button>
    </div>
  </form>;
}
