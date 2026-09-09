import { FIT_SYMBOLS, type Dimension } from '@pointercad/drawing';
import { useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyDrawingTolerance, type DrawingToleranceInput } from './toleranceCommands.js';

const expressionText = (value: number | { readonly source: string }): string => typeof value === 'number' ? String(value) : value.source;

/** 用紙の上に浮かぶ入力欄。寸法値は参照表示、公差と記号だけを編集する。 */
export function DrawingTolerancePopover({ dimension }: { readonly dimension: Dimension }): React.JSX.Element {
  const [kind, setKind] = useState<DrawingToleranceInput['kind']>(dimension.fit !== undefined ? 'fit' : dimension.tolerance?.kind ?? 'none');
  const [symmetric, setSymmetric] = useState(dimension.tolerance?.kind === 'symmetric' ? expressionText(dimension.tolerance.value) : '0.1');
  const [upper, setUpper] = useState(dimension.tolerance?.kind === 'deviation' ? expressionText(dimension.tolerance.upper) : '0.1');
  const [lower, setLower] = useState(dimension.tolerance?.kind === 'deviation' ? expressionText(dimension.tolerance.lower) : '-0.1');
  const [symbol, setSymbol] = useState(dimension.fit?.symbol ?? 'H7');
  const [showDeviation, setShowDeviation] = useState(dimension.fit?.showDeviation ?? true);
  const busy = useAppStore((state) => state.drawingBusy);
  const resolved = useAppStore((state) => state.drawingResolution);
  const value = resolved?.ok === true ? resolved.dimensions.find((item) => item.dimension.id === dimension.id)?.text : undefined;
  return <form className="pcad-drawing-input" aria-label={t('drawing.tolerance.title')} onSubmit={(event) => {
    event.preventDefault();
    const input: DrawingToleranceInput = kind === 'symmetric' ? { kind, value: symmetric } : kind === 'deviation' ? { kind, upper, lower }
      : kind === 'fit' ? { kind, symbol, showDeviation } : { kind: 'none' };
    applyDrawingTolerance(dimension.id, input);
  }}>
    <strong>{t('drawing.tolerance.title')}</strong>
    <output title={t('drawing.error.dimensionReadOnly')}>{value ?? '…'}</output>
    <label>{t('drawing.tolerance.kind')}
      <select value={kind} onChange={(event) => {
        const value = event.target.value;
        if (value === 'none' || value === 'symmetric' || value === 'deviation' || value === 'fit') setKind(value);
      }}>
        <option value="none">{t('drawing.tolerance.none')}</option>
        <option value="symmetric">{t('drawing.tolerance.symmetric')}</option>
        <option value="deviation">{t('drawing.tolerance.deviation')}</option>
        <option value="fit">{t('drawing.tolerance.fit')}</option>
      </select>
    </label>
    {kind === 'symmetric' ? <label>±<input aria-label={t('drawing.tolerance.symmetric')} value={symmetric} onChange={(event) => setSymmetric(event.target.value)} /></label> : null}
    {kind === 'deviation' ? <>
      <label>{t('drawing.tolerance.upper')}<input value={upper} onChange={(event) => setUpper(event.target.value)} /></label>
      <label>{t('drawing.tolerance.lower')}<input value={lower} onChange={(event) => setLower(event.target.value)} /></label>
    </> : null}
    {kind === 'fit' ? <>
      <label>{t('drawing.tolerance.fit')}<select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
        {FIT_SYMBOLS.map((item) => <option key={`fit:${item}`} value={item}>{item}</option>)}
      </select></label>
      <label><input type="checkbox" checked={showDeviation} onChange={(event) => setShowDeviation(event.target.checked)} />{t('drawing.tolerance.showDeviation')}</label>
    </> : null}
    <div className="pcad-segmented">
      <button type="submit" className="pcad-button" disabled={busy}>{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={() => useAppStore.getState().selectDrawingIds([])}>{t('drawing.action.close')}</button>
    </div>
  </form>;
}
