import { useId, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { searchNamedEntries, type NameSearchEntry } from './nameSearch.js';
import './documentNameSearch.css';

/** Searching changes no document or selection. Only an explicit result choice selects a target. */
export function DocumentNameSearch({ getEntries, onSelect, helpTopic }: {
  readonly getEntries: () => readonly NameSearchEntry[];
  readonly onSelect: (entry: NameSearchEntry) => void;
  readonly helpTopic: 'feature-tree' | 'assembly';
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null), resultsElement = useRef<HTMLUListElement>(null), id = useId();
  const results = query.trim() === '' ? [] : searchNamedEntries(getEntries(), query);
  return <div className="pcad-name-search" data-help-topic={helpTopic}>
    <label htmlFor={id}>{t('nameSearch.label')}</label>
    <div className="pcad-name-search__input">
      <input id={id} ref={input} type="search" value={query} maxLength={512}
        title={t('nameSearch.hint')} aria-controls={`${id}-results`} autoComplete="off"
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); }
          if (event.key === 'ArrowDown' || event.key === 'Enter') {
            event.preventDefault(); resultsElement.current?.querySelector('button')?.focus();
          }
        }} />
      {query === '' ? null : <button type="button" title={t('nameSearch.clear')} onClick={() => {
        setQuery(''); input.current?.focus();
      }}>{t('nameSearch.clear')}</button>}
    </div>
    {query.trim() === '' ? null : <>
      <p role="status">{results.length === 0 ? t('nameSearch.empty') : `${results.length} ${t('nameSearch.results')}`}</p>
      <ul id={`${id}-results`} ref={resultsElement} aria-label={t('nameSearch.results')} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); input.current?.focus(); }
      }}>{results.map(({ entry, ordinal }) => <li key={entry.key}>
        <button title={t('controlGuide.button.nameSearchResult').replace('{context}', entry.context).replace('{name}', entry.name)} type="button" onClick={() => { onSelect(entry); setQuery(''); input.current?.focus(); }}>
          <span>{ordinal}. {entry.name}</span><small>{entry.context}</small>
          {entry.badges.length === 0 ? null : <small>{entry.badges.map(key => t(key)).join(t('display.listSeparator'))}</small>}
        </button>
      </li>)}</ul>
    </>}
  </div>;
}
