import { useState } from 'react';
import type { Balloon } from '@pointercad/drawing';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginDrawingTableDrag, deleteDrawingTables, finishDrawingTableDrag } from './tableCommands.js';

export function DrawingBalloonPanel({ balloon }: { readonly balloon: Balloon }): React.JSX.Element {
  const [x, setX] = useState(String(balloon.position[0]));
  const [y, setY] = useState(String(balloon.position[1]));
  const source = useAppStore((state) => state.drawingSourceResolution);
  const busy = useAppStore((state) => state.drawingBusy);
  const row = source?.bomRows?.find((item) => item.componentIds.some((id) => balloon.componentIds.includes(id)));
  return <form className="pcad-drawing-settings" aria-label={t('drawing.table.balloon')} data-help-topic="drawing-bom"
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().setDrawingTool('select'); }
    }}
    onSubmit={(event) => {
      event.preventDefault();
      const position = [x.trim() === '' ? NaN : Number(x), y.trim() === '' ? NaN : Number(y)] as const;
      if (!position.every(Number.isFinite)) { useAppStore.getState().setDrawingMessage(t('drawing.error.positionInvalid')); return; }
      const drag = beginDrawingTableDrag(balloon.id, balloon.position);
      if (drag !== null) finishDrawingTableDrag(drag, position);
    }}>
    <output>{t('drawing.table.balloon')} {row?.number ?? '—'} {row?.name ?? ''}</output>
    <label>{t('drawing.table.positionX')}<input className="pcad-field__input" value={x} inputMode="decimal" onChange={(event) => setX(event.target.value)} /></label>
    <label>{t('drawing.table.positionY')}<input className="pcad-field__input" value={y} inputMode="decimal" onChange={(event) => setY(event.target.value)} /></label>
    <button type="submit" className="pcad-button" disabled={busy}>{t('drawing.action.apply')}</button>
    <button type="button" className="pcad-button" disabled={busy} onClick={deleteDrawingTables}>{t('drawing.table.delete')}</button>
    <button type="button" className="pcad-button" onClick={() => useAppStore.getState().setDrawingTool('select')}>{t('drawing.action.close')}</button>
  </form>;
}
