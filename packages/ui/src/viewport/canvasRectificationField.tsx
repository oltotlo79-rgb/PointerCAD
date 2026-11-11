import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useAppStore } from '../store/useAppStore.js';

/** 四隅は元画像上で左上→右上→右下→左下。確定まで文書と履歴を変えない。 */
export function CanvasRectificationField(): React.JSX.Element | null {
  const picking = useAppStore(state => state.canvasRectification);
  const message = useAppStore(state => state.canvasMessage);
  const apply = useAppStore(state => state.applyCanvasRectification);
  const cancel = useAppStore(state => state.cancelCanvasRectification);
  if (picking === null) return null;
  const prompt = picking.points.length === 0 ? t('canvas.rectifyPickTopLeft')
    : picking.points.length === 1 ? t('canvas.rectifyPickTopRight')
    : picking.points.length === 2 ? t('canvas.rectifyPickBottomRight')
    : picking.points.length === 3 ? t('canvas.rectifyPickBottomLeft') : '';
  return <div className="pcad-popover pcad-canvas-rectification">
    <DraggableWindowTitle className="pcad-popover__title">{t('canvas.rectifyTitle')}</DraggableWindowTitle>
    <p className={message === null ? 'pcad-field__message' : 'pcad-field__message pcad-field__message--error'}
      role="status">{message ?? prompt}</p>
    <div className="pcad-popover__actions">
      <button type="button" className="pcad-button" disabled={picking.points.length !== 4}
        title={t('canvas.rectifyApplyTooltip')}
        onClick={() => { apply(); }}>{t('canvas.rectifyApply')}</button>
      <button type="button" className="pcad-button" title={t('canvas.rectifyCancelTooltip')} onClick={() => { cancel(); }}>
        {t('canvas.rectifyCancel')}
      </button>
    </div>
  </div>;
}
