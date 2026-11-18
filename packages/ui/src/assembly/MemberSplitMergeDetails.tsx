/**
 * 選ぶ窓の「選んだ部材を分ける・まとめる」(E-11)。ビューか木で選んだ部材 1 本を始点からの距離で 2 本に分け、
 * 同じ線の上で端が接する同じ種類の部材 2 本以上を 1 本にまとめる。どちらも Undo 1 回で戻る(動作は memberSplitMergeActions.ts)。
 */
import { useState, type KeyboardEvent } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { memberSplitMergeMessage, mergeSelectedMembers, splitSelectedMember } from './memberSplitMergeActions.js';

/** 欄の Enter で選ぶ窓の「置く」が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };

export function MemberSplitMergeDetails(): React.JSX.Element {
  const [distance, setDistance] = useState('');
  const [message, setMessage] = useState<ReturnType<typeof memberSplitMergeMessage> | null>(null);
  const selected = useAppStore((state) => state.selection.filter((id) => state.assembly?.components.some((component) => component.id === id))
    .length);
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.memberSplit.title')}</summary>
      <p>{t('catalog.memberSplit.hint').replace('{count}', String(selected))}</p>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.memberSplit.distance')}</span>
        <input title={t('catalog.memberSplit.distanceGuide')} className="pcad-field__input" value={distance} onKeyDown={keepEnter}
          onChange={(event) => { setDistance(event.currentTarget.value); setMessage(null); }} />
        <span className="pcad-field__unit">mm</span>
      </label>
      <button type="button" className="pcad-button pcad-button--action" disabled={selected !== 1 || distance.trim() === ''}
        title={t('catalog.memberSplit.splitGuide')}
        onClick={() => { setMessage(memberSplitMergeMessage(splitSelectedMember(distance.trim()))); }}>
        {t('catalog.memberSplit.splitAction')}</button>
      <button type="button" className="pcad-button pcad-button--action" disabled={selected < 2}
        title={t('catalog.memberSplit.mergeGuide')}
        onClick={() => { setMessage(memberSplitMergeMessage(mergeSelectedMembers())); }}>
        {t('catalog.memberSplit.mergeAction')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
