import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { cancelReplacementPreview, confirmReplacementPreview } from './replaceActions.js';

export function replacementPreviewText(total: number, unmatched: number): string {
  return t('assemblyError.replaceUnmatchedMates')
    .replace('{total}', String(total))
    .replace('{count}', String(unmatched));
}

/** 選び直せない参照があるときだけ出る、その場の確認。背景の操作は塞がない。 */
export function ReplacementPopover(): React.JSX.Element | null {
  const preview = useAppStore((state) => state.assemblyReplacementPreview);
  if (preview === null) return null;
  const plan = preview.prepared.plan;
  return (
    <div
      className="pcad-popover"
      role="dialog"
      aria-label={t('assembly.tool.replacePart')}
      style={{ left: '16px', top: '16px' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelReplacementPreview();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          confirmReplacementPreview();
        }
      }}
    >
      <div className="pcad-popover__title">{t('assembly.tool.replacePart')}</div>
      <p className="pcad-popover__hint">
        {replacementPreviewText(plan.affectedCount, plan.unmatchedCount)}
      </p>
      <div className="pcad-popover__actions">
        <button type="button" className="pcad-button pcad-button--action"
          onClick={confirmReplacementPreview}>{t('assembly.replace.confirm')}</button>
        <button type="button" className="pcad-button"
          onClick={cancelReplacementPreview}>{t('assembly.place.cancel')}</button>
      </div>
    </div>
  );
}
