import { useState } from 'react';
import { t } from '../i18n/t.js';
import { exportDrawing, type DrawingOutputFormat } from './exportDrawing.js';
import type { DrawingDpi } from './rasterDrawing.js';

const formats = ['pdf', 'svg', 'dxf', 'png', 'jpg'] as const;
export function DrawingExportPopover({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const [format, setFormat] = useState<DrawingOutputFormat>('pdf');
  const [dpi, setDpi] = useState<DrawingDpi>(300);
  const [busy, setBusy] = useState(false);
  const image = format === 'png' || format === 'jpg';
  return <form className="pcad-drawing-input" aria-label={t('drawing.export.title')} onSubmit={(event) => {
    event.preventDefault(); if (busy) return;
    setBusy(true);
    void exportDrawing({ format, dpi }).then((saved) => { setBusy(false); if (saved) onClose(); });
  }}>
    <strong>{t('drawing.export.title')}</strong>
    <label>{t('drawing.export.format')}<select aria-label={t('drawing.export.format')} value={format} disabled={busy} onChange={(event) => {
      const selected = formats.find((item) => item === event.target.value); if (selected !== undefined) setFormat(selected);
    }}>{formats.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
    {image ? <label>{t('drawing.export.dpi')}<select aria-label={t('drawing.export.dpi')} value={dpi} disabled={busy} onChange={(event) => {
      const value = Number(event.target.value); if (value === 150 || value === 300 || value === 600) setDpi(value);
    }}><option value={150}>150 dpi</option><option value={300}>300 dpi</option><option value={600}>600 dpi</option></select></label> : null}
    <p>{t(format === 'dxf' ? 'drawing.export.dxfHint' : image ? 'drawing.export.imageHint' : 'drawing.export.vectorHint')}</p>
    <div><button type="submit" className="pcad-button" disabled={busy}>{t('drawing.export.save')}</button>
      <button type="button" className="pcad-button" disabled={busy} onClick={onClose}>{t('drawing.action.close')}</button></div>
  </form>;
}
