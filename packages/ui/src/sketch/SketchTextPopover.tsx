import { useState } from 'react';
import { toDisplayLength, type Vec3, type WorkPlane } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { clampAnchor } from './NumericInputPopover.js';
import { applySketchText } from './textCommands.js';

/** 同じその場入力の位置決めを使い、文字列を数式として評価しない。 */
export function SketchTextPopover({ origin, plane, anchor }: {
  readonly origin: Vec3;
  readonly plane: WorkPlane;
  readonly anchor: readonly [number, number];
}): React.JSX.Element {
  const unit = useAppStore((state) => state.displaySettings.lengthUnit);
  const [height, setHeight] = useState(() => String(toDisplayLength(10, unit)));
  const [angle, setAngle] = useState('0');
  const [align, setAlign] = useState<'start' | 'middle' | 'end'>('start');
  const [busy, setBusy] = useState(false);
  const text = useAppStore((state) => state.numericInput?.textValue ?? '');
  const error = useAppStore((state) => state.shapeErrorMessage);
  const placement = clampAnchor(anchor, window.innerWidth, window.innerHeight);
  return <form className="pcad-popover" aria-label={t('text.tool')} style={{ position: 'fixed', ...placement }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); useAppStore.getState().setActiveTool('select'); }
    }} onSubmit={(event) => {
      event.preventDefault(); if (busy) return;
      setBusy(true); void applySketchText({ text, heightSource: height, angleSource: angle, align, origin, plane }).then(() => setBusy(false));
    }}>
    <strong>{t('text.tool')}</strong>
    <label className="pcad-field">{t('text.input.text')}<input className="pcad-field__input" value={text} autoFocus disabled={busy} maxLength={1000}
      onChange={(event) => { const state = useAppStore.getState(); if (state.numericInput !== null) state.updateNumericInput({ ...state.numericInput, textValue: event.target.value }); }} /></label>
    <label className="pcad-field">{t('text.input.height')} ({unit})<input className="pcad-field__input" value={height} disabled={busy}
      onChange={(event) => setHeight(event.target.value)} /></label>
    <label className="pcad-field">{t('text.input.angle')}<input className="pcad-field__input" value={angle} disabled={busy}
      onChange={(event) => setAngle(event.target.value)} /></label>
    <label className="pcad-field">{t('text.input.align')}<select aria-label={t('text.input.align')} value={align} disabled={busy} onChange={(event) => {
      const value = event.target.value; if (value === 'start' || value === 'middle' || value === 'end') setAlign(value);
    }}><option value="start">{t('text.input.start')}</option><option value="middle">{t('text.input.middle')}</option><option value="end">{t('text.input.end')}</option></select></label>
    {error === null ? null : <p role="status">{error}</p>}
    <div><button type="submit" className="pcad-button" disabled={busy}>{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={() => useAppStore.getState().setActiveTool('select')}>{t('drawing.action.close')}</button></div>
  </form>;
}
