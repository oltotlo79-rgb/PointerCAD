/**
 * 選ぶ窓の「選んだ部材を書き換える」(J-01 包み 8)。ビューか木で選んだ部材(同じ族の部品か、同じ鋼材の製品の部品)の、
 * 呼び(今この窓で選んでいる行。族だけ)と長さを 1 回で替える。合致・ジョイントの選び直しと予告は今の差し替えの道
 * (`memberBulkEditActions.ts`)。保存の形は変えない(部品の保存の欄の値だけが替わる)。
 */
import { useState, type KeyboardEvent } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';
import { memberBulkMessage, startMemberBulkEdit } from './memberBulkEditActions.js';

/** 欄の Enter で選ぶ窓の「置く」が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };

export function MemberBulkEditDetails({ member }: { readonly member: FrameMemberChoice }): React.JSX.Element {
  const [useRow, setUseRow] = useState(false);
  const [length, setLength] = useState('');
  const [message, setMessage] = useState<ReturnType<typeof memberBulkMessage> | null>(null);
  const selected = useAppStore((state) => state.selection.filter((id) => state.assembly?.components.some((component) => component.id === id))
    .length);
  const apply = (): void => {
    const change = { ...(useRow && member.kind === 'catalogItem' ? { itemKey: member.itemKey } : {}),
      ...(length.trim() === '' ? {} : { length: length.trim() }) };
    void startMemberBulkEdit(change).then((outcome) => { setMessage(memberBulkMessage(outcome)); });
  };
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.memberBulk.title')}</summary>
      <p>{t('catalog.memberBulk.hint').replace('{count}', String(selected))}</p>
      {member.kind === 'catalogItem' ? <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.memberBulk.useRow')}</span>
        <input type="checkbox" title={t('catalog.memberBulk.useRowGuide')} checked={useRow}
          onChange={(event) => { setUseRow(event.currentTarget.checked); setMessage(null); }} />
      </label> : null}
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.memberBulk.length')}</span>
        <input title={t('catalog.memberBulk.lengthGuide')} className="pcad-field__input" value={length} onKeyDown={keepEnter}
          onChange={(event) => { setLength(event.currentTarget.value); setMessage(null); }} />
        <span className="pcad-field__unit">mm</span>
      </label>
      <button type="button" className="pcad-button pcad-button--action" disabled={selected === 0}
        title={t('catalog.memberBulk.applyGuide')} onClick={apply}>{t('catalog.memberBulk.apply')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
