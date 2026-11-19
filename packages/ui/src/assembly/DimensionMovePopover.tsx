/**
 * 配置の補助 P-A 寸法で動かすの窓(モーダルにしない。確定だけが文書を変える。伸縮の窓 MemberStretchPopover.tsx と同じ形)。
 * 向き・基準・寸法の取り方・寸法を入れると、今の寸法と、動かす量・動く部品の数を予告し、断る時は理由を出す。予告が通るまで確定を押せない。
 * 1 回だけ動かし、拘束は残さない(残す時は距離の合致)。アルミフレーム・鋼材・機械要素のどれを選んでも同じ窓。
 */
import { useMemo, useRef } from 'react';

import { t, type MessageKey } from '../i18n/t.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  DIMENSION_MOVE_AXES, DIMENSION_MOVE_BASES, dimensionMoveReady, dimensionMoveReferences, type DimensionMovePreview,
} from './dimensionMoveDraft.js';

const AXIS_KEYS: Readonly<Record<0 | 1 | 2, MessageKey>> = {
  0: 'assembly.dimensionMove.axis.x', 1: 'assembly.dimensionMove.axis.y', 2: 'assembly.dimensionMove.axis.z',
};

/** 予告の文(今の寸法・動かす量・断る理由・入力の理由)。 */
function previewText(preview: DimensionMovePreview | null): string {
  if (preview === null) return '';
  if (preview.issue !== null) return t(`assembly.dimensionMove.issue.${preview.issue}`);
  const current = t('assembly.dimensionMove.current').replace('{value}', String(preview.current));
  const plan = preview.plan;
  if (plan === null) return current;
  if (!plan.ok) return `${current} ${t(`assembly.dimensionMove.reason.${plan.reason}`).replace('{count}', String(plan.count))}`;
  return `${current} ${t('assembly.dimensionMove.summary').replace('{delta}', String(plan.delta)).replace('{count}', String(plan.movedIds.length))}`;
}

export function DimensionMovePopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyDimensionMoveDraft);
  const preview = useAppStore((state) => state.assemblyDimensionMovePreview);
  const document = useAppStore((state) => state.assembly);
  const root = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  // 開いた時は最初の欄へ、閉じた時は開いた元(「組む」のメニューの釦など)へ焦点を戻す(C-03)。
  useDialogFocus(() => root.current, draft !== null, { initial: () => first.current });
  const references = useMemo(() => document === null || draft === null ? [] : dimensionMoveReferences(document, draft.componentId),
    [document, draft]);
  if (draft === null) return null;
  const title = t('assembly.dimensionMove.title');
  const update = useAppStore.getState().updateDimensionMoveDraft;
  return (
    <form ref={root} className="pcad-popover pcad-popover--frame-slot" role="dialog" aria-label={title} data-testid="dimension-move"
      onSubmit={(event) => { event.preventDefault(); useAppStore.getState().commitDimensionMove(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); useAppStore.getState().cancelDimensionMove(); } }}>
      <strong className="pcad-popover__title">{title}</strong>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.axis')}</span>
        <select ref={first} className="pcad-field__input" title={t('assembly.dimensionMove.axisGuide')} value={String(draft.axis)}
          onChange={(event) => { update({ axis: DIMENSION_MOVE_AXES.find((axis) => String(axis) === event.currentTarget.value) ?? 0 }); }}>
          {DIMENSION_MOVE_AXES.map((axis) => <option key={axis} value={String(axis)}>{t(AXIS_KEYS[axis])}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.reference')}</span>
        <select className="pcad-field__input" title={t('assembly.dimensionMove.referenceGuide')} value={draft.reference}
          onChange={(event) => { update({ reference: event.currentTarget.value }); }}>
          {references.map((item) => <option key={item.value} value={item.value}>
            {item.name ?? t('assembly.dimensionMove.reference.origin')}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.basis')}</span>
        <select className="pcad-field__input" title={t('assembly.dimensionMove.basisGuide')} value={draft.basis}
          onChange={(event) => { update({ basis: DIMENSION_MOVE_BASES.find((basis) => basis === event.currentTarget.value) ?? 'inner' }); }}>
          {DIMENSION_MOVE_BASES.map((basis) => <option key={basis} value={basis}>{t(`assembly.dimensionMove.basis.${basis}`)}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.target')}</span>
        <input className="pcad-field__input" title={t('assembly.dimensionMove.targetGuide')} value={draft.target}
          onChange={(event) => { update({ target: event.currentTarget.value }); }} />
        <span className="pcad-field__unit">mm</span>
      </label>
      <p role="status">{previewText(preview)}</p>
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button pcad-button--action" title={t('assembly.dimensionMove.commitGuide')}
          disabled={!dimensionMoveReady(preview)}>{t('assembly.dimensionMove.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.dimensionMove.cancelGuide')}
          onClick={() => { useAppStore.getState().cancelDimensionMove(); }}>{t('assembly.dimensionMove.cancel')}</button>
      </div>
      <p>{t('assembly.dimensionMove.hint')}</p>
    </form>
  );
}
