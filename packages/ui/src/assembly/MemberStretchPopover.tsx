/**
 * 伸縮(E-13)の窓(モーダルにしない。確定だけが文書を変える)。向き・面の位置・量を入れると、伸び縮みする部材の数と動く部品の数を予告し、
 * 断る時は理由と部品の数(部品の名前の初めの 3 つ)を出す。予告が通るまで確定を押せない。
 */
import { useMemo, useRef } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { useAppStore } from '../store/useAppStore.js';
import { MEMBER_STRETCH_DIRECTIONS, memberStretchReady, type MemberStretchPreview } from './memberStretchDraft.js';

/** 断る理由に添える部品の名前の数。 */
const NAMED_PARTS = 3;

/** 予告の文(通る時は数、断る時は理由と数と名前、入力が読めない時はその理由)。 */
function previewText(preview: MemberStretchPreview | null, names: ReadonlyMap<string, string>): string {
  if (preview === null) return '';
  if (preview.kind === 'issue') return t(`assembly.memberStretch.issue.${preview.issue}`);
  const plan = preview.plan;
  if (plan.ok) {
    return t('assembly.memberStretch.summary').replace('{stretched}', String(plan.stretched.length)).replace('{moved}', String(plan.moved.length));
  }
  const named = plan.componentIds.slice(0, NAMED_PARTS).map((id) => names.get(id) ?? id).join(t('display.listSeparator'));
  return t(`assembly.memberStretch.reason.${plan.reason}`).replace('{count}', String(plan.count)).replace('{names}', named);
}

export function MemberStretchPopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyMemberStretchDraft);
  const preview = useAppStore((state) => state.assemblyMemberStretchPreview);
  const document = useAppStore((state) => state.assembly);
  const names = useMemo(() => new Map(document?.components.map((component): readonly [string, string] => [component.id, component.name]) ?? []),
    [document]);
  const root = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  // 開いた時は最初の欄(向き)へ、閉じた時は開いた元(「組む」のメニューの釦)へ焦点を戻す(C-03)。
  useDialogFocus(() => root.current, draft !== null, { initial: () => first.current });
  if (draft === null) return null;
  const title = t('assembly.memberStretch.title');
  const ready = memberStretchReady(preview);
  const update = useAppStore.getState().updateMemberStretchDraft;
  return (
    <form ref={root} className="pcad-popover pcad-popover--frame-slot" role="dialog" aria-label={title} data-testid="member-stretch"
      onSubmit={(event) => { event.preventDefault(); useAppStore.getState().commitMemberStretch(); }}
      onKeyDown={(event) => {
        // Esc で閉じる(ほかの組立の窓と同じ。字の変換を確定する Esc では閉じない)。
        if (event.key !== 'Escape' || isCompositionKey(event.nativeEvent)) return;
        event.preventDefault(); event.stopPropagation(); useAppStore.getState().cancelMemberStretch();
      }}>
      <strong className="pcad-popover__title">{title}</strong>
      <p role="status">{t('assembly.memberStretch.prompt')}</p>
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.memberStretch.direction')}</span>
          <select ref={first} className="pcad-field__input" value={draft.direction} data-testid="member-stretch-direction"
            title={t('assembly.memberStretch.directionTooltip')}
            onChange={(event) => {
              const picked = MEMBER_STRETCH_DIRECTIONS.find((entry) => entry.direction === event.currentTarget.value);
              if (picked !== undefined) update({ direction: picked.direction });
            }}>
            {MEMBER_STRETCH_DIRECTIONS.map((entry) => (
              <option key={entry.direction} value={entry.direction}>{t(`assembly.memberStretch.directions.${entry.name}`)}</option>))}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.memberStretch.plane')}</span>
          <input className="pcad-field__input" value={draft.plane} data-testid="member-stretch-plane" title={t('assembly.memberStretch.planeTooltip')}
            onChange={(event) => { update({ plane: event.currentTarget.value }); }} />
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.memberStretch.amount')}</span>
          <input className="pcad-field__input" value={draft.amount} data-testid="member-stretch-amount" title={t('assembly.memberStretch.amountTooltip')}
            onChange={(event) => { update({ amount: event.currentTarget.value }); }} />
        </label>
      </div>
      <p role={preview?.kind === 'plan' && !preview.plan.ok ? 'alert' : 'status'} data-testid="member-stretch-preview">
        {previewText(preview, names)}</p>
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button" disabled={!ready} data-testid="member-stretch-commit"
          title={t('assembly.memberStretch.commitTooltip')}>{t('assembly.memberStretch.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.memberStretch.cancelTooltip')}
          onClick={() => { useAppStore.getState().cancelMemberStretch(); }}>
          {t('assembly.memberStretch.cancel')}</button>
      </div>
    </form>
  );
}
