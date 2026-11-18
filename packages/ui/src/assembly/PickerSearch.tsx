/**
 * 規格部品の選ぶ窓の頭の検索の欄(K-07a)と、欄が空の時の最近使った物(K-07b)。呼び・種類・規格番号・材質の言葉を空白で区切って入れると、全部を含む行を上から出し、
 * 押すか ↑↓ と Enter で窓をその行へ選び直す(置くのは今までどおり「置く」か Enter)。初めて言葉を入れた時に、まだ読んでいない
 * 族の表を全部読む(窓を開いただけでは読まない。統括の決定 2026-11-17)。
 * 欄が空の時の Enter(置く)と Esc(窓を閉じる)は窓の決まりのまま。言葉がある時の Esc は言葉を消すだけにする。
 * 今の欄の class(pcad-field__input)と label の形は使わず、役割(searchbox・listbox・option)と名前で探せる形にする。
 */
import { PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { useEffect, useId, useState } from 'react';

import { t } from '../i18n/t.js';
import { loadRegisteredCatalogFamilies, type CatalogLoadState } from './catalogFamilyLoading.js';
import { pickerSearchEntries, searchPickerEntries, type PickerJumpTarget, type RecentPart } from './catalogSearch.js';
import { useRecentParts } from './recentStandardParts.js';
import './pickerSearch.css';

interface PickerSearchProps {
  /** 行を選んだ時。窓がその行へ選び直す。 */
  readonly onPick: (target: PickerJumpTarget) => void;
}

/** 読み込みの状態の 1 行(読み込み中と失敗だけ。済みは結果そのものが示す)。 */
function loadMessage(state: CatalogLoadState): React.JSX.Element | null {
  if (state !== 'loading' && state !== 'failed') return null;
  return <p className="pcad-popover__hint" role={state === 'failed' ? 'alert' : 'status'}>
    {t(state === 'failed' ? 'catalog.loading.failed' : 'catalog.loading.inProgress')}</p>;
}

/** 最近使った物の釦(検索の欄が空の時だけ。押すとその物へ選び直し、長さなどの指定も前の値に戻す。K-07b)。 */
function recentButtons(recent: readonly RecentPart[], onPick: (target: PickerJumpTarget) => void): React.JSX.Element | null {
  if (recent.length === 0) return null;
  return <div className="pcad-picker-search__recent" role="group" aria-label={t('assembly.standardPart.recent.label')}>
    <span className="pcad-picker-search__recent-title">{t('assembly.standardPart.recent.label')}</span>
    {recent.map((part) => <button key={part.key} type="button" className="pcad-button pcad-picker-search__result"
      title={t('assembly.standardPart.recent.guide')} onClick={() => { onPick(part.target); }}>
      <span className="pcad-picker-search__label">{part.label}</span>
      {part.detail === '' ? null : <span className="pcad-picker-search__detail">{part.detail}</span>}
    </button>)}
  </div>;
}

export function PickerSearch({ onPick }: PickerSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [load, setLoad] = useState<CatalogLoadState>('none');
  const listId = useId();
  const recent = useRecentParts();
  const searching = query.trim() !== '';
  useEffect(() => {
    if (!searching) return undefined;
    let alive = true;
    void loadRegisteredCatalogFamilies(PRODUCT_CATALOG_REGISTRY, setLoad, () => alive, null);
    return () => { alive = false; };
  }, [searching]);
  // 読み込んだ族の数が変わると並びが作り直される(load の変化で描き直す)。
  const found = searching ? searchPickerEntries(pickerSearchEntries(), query) : { entries: [], more: 0 };
  const current = Math.min(active, Math.max(0, found.entries.length - 1));
  const pick = (index: number): void => {
    const chosen = found.entries[index];
    if (chosen === undefined) return;
    setQuery(''); setActive(0);
    onPick(chosen.target);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || !searching) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = found.entries.length;
      if (count > 0) setActive((current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (event.key === 'Enter') {
      // 言葉がある時の Enter は行を選ぶだけで、置かない(当てはまる行が無い時も置かない)。
      event.preventDefault();
      pick(current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setQuery(''); setActive(0);
    }
  };
  return <div className="pcad-picker-search">
    <input type="search" className="pcad-picker-search__input" value={query} aria-label={t('assembly.standardPart.search.label')}
      placeholder={t('assembly.standardPart.search.placeholder')} title={t('assembly.standardPart.search.guide')}
      aria-controls={searching && found.entries.length > 0 ? listId : undefined} autoComplete="off" spellCheck={false}
      onChange={(event) => { setQuery(event.currentTarget.value); setActive(0); }} onKeyDown={onKeyDown} />
    {searching ? loadMessage(load) : recentButtons(recent, onPick)}
    {!searching ? null : found.entries.length === 0
      ? <p className="pcad-popover__hint" role="status">{t('assembly.standardPart.search.none')}</p>
      : <div id={listId} className="pcad-picker-search__results" role="listbox" aria-label={t('assembly.standardPart.search.results')}>
        {found.entries.map((candidate, index) => <button key={candidate.key} type="button" role="option" aria-selected={index === current}
          className="pcad-button pcad-picker-search__result" title={t('assembly.standardPart.search.pickGuide')}
          // 押しても欄から焦点を奪わない(コマンドの欄の候補と同じ)。
          onMouseDown={(event) => { event.preventDefault(); }} onClick={() => { pick(index); }}>
          <span className="pcad-picker-search__label">{candidate.label}</span>
          {candidate.detail === '' ? null : <span className="pcad-picker-search__detail">{candidate.detail}</span>}
        </button>)}
      </div>}
    {found.more === 0 ? null : <p className="pcad-popover__hint">
      {t('assembly.standardPart.search.more').replace('{count}', String(found.more))}</p>}
  </div>;
}
