import type { DrawingDocument, DrawingView } from '@pointercad/drawing';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { setDrawingCenterMarkVisible } from './centerMarkCommands.js';

export function DrawingCenterMarksPanel({ drawing, view }: { readonly drawing: DrawingDocument; readonly view: DrawingView }): React.JSX.Element | null {
  const resolution = useAppStore((state) => state.drawingResolution), busy = useAppStore((state) => state.drawingBusy);
  if (resolution?.ok !== true) return null;
  const marks = resolution.projection.views.find((item) => item.viewId === view.id)?.centerMarks ?? [];
  if (marks.length === 0) return null;
  const hidden = new Set(view.hiddenCenterMarkIds ?? []);
  return <details className="pcad-drawing-settings" data-help-topic="drawing-views">
    <summary>{t('drawing.centers.individual')}</summary>
    <p>{t('drawing.centers.hint')}</p>
    {marks.map((mark, index) => <label key={mark.id} className="pcad-field">
      <input type="checkbox" checked={!mark.sourceIds.some((id) => hidden.has(id))} disabled={busy || resolution.document !== drawing}
        onChange={(event) => setDrawingCenterMarkVisible(drawing, view.id, mark.id, event.target.checked)} />
      {t('drawing.centers.item').replace('{number}', String(index + 1))}
    </label>)}
  </details>;
}
