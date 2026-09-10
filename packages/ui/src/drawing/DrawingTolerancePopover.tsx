import { FIT_SYMBOLS, type Dimension } from '@pointercad/drawing';
import { useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyDrawingTolerance, type DrawingToleranceInput } from './toleranceCommands.js';

const expressionText = (value: number | { readonly source: string }): string => typeof value === 'number' ? String(value) : value.source;

/** 用紙の上に浮かぶ入力欄。寸法値は参照表示、公差と記号だけを編集する。 */
export function DrawingTolerancePopover({ dimension, inline = false }: { readonly dimension: Dimension; readonly inline?: boolean }): React.JSX.Element {
  const [kind, setKind] = useState<DrawingToleranceInput['kind']>(dimension.fit !== undefined ? 'fit' : dimension.tolerance?.kind ?? 'none');
  const [symmetric, setSymmetric] = useState(dimension.tolerance?.kind === 'symmetric' ? expressionText(dimension.tolerance.value) : '0.1');
  const [upper, setUpper] = useState(dimension.tolerance?.kind === 'deviation' ? expressionText(dimension.tolerance.upper) : '0.1');
  const [lower, setLower] = useState(dimension.tolerance?.kind === 'deviation' ? expressionText(dimension.tolerance.lower) : '-0.1');
  const [symbol, setSymbol] = useState(dimension.fit?.symbol ?? 'H7');
  const [showDeviation, setShowDeviation] = useState(dimension.fit?.showDeviation ?? true);
  const [prefix, setPrefix] = useState(dimension.prefix ?? '');
  const [suffix, setSuffix] = useState(dimension.suffix ?? '');
  const [reference, setReference] = useState(dimension.reference);
  const [basic, setBasic] = useState(dimension.basic === true);
  const [offset, setOffset] = useState(String(dimension.placement.commonNormalCoordinate));
  const [automaticText, setAutomaticText] = useState(dimension.placement.textPosition === null);
  const [textX, setTextX] = useState(String(dimension.placement.textPosition?.[0] ?? 0));
  const [textY, setTextY] = useState(String(dimension.placement.textPosition?.[1] ?? 0));
  const busy = useAppStore((state) => state.drawingBusy);
  const drawing = useAppStore((state) => state.drawing);
  const resolved = useAppStore((state) => state.drawingResolution);
  const value = resolved?.ok === true && resolved.document === drawing ? resolved.dimensions.find((item) => item.dimension.id === dimension.id)?.text : undefined;
  const number = (text: string): number => text.trim() === '' ? NaN : Number(text);
  return <form className={inline ? 'pcad-drawing-settings' : 'pcad-drawing-input'} aria-label={t('drawing.tolerance.title')} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().setDrawingTool('select'); }
  }} onSubmit={(event) => {
    event.preventDefault();
    const input: DrawingToleranceInput = kind === 'symmetric' ? { kind, value: symmetric } : kind === 'deviation' ? { kind, upper, lower }
      : kind === 'fit' ? { kind, symbol, showDeviation } : { kind: 'none' };
    applyDrawingTolerance(dimension.id, input, { prefix, suffix, reference, basic, placement: {
      commonNormalCoordinate: number(offset), textPosition: automaticText ? null : [number(textX), number(textY)],
    } }, dimension);
  }}>
    <strong>{t('drawing.tolerance.title')}</strong>
    <output title={t('drawing.error.dimensionReadOnly')}>{value ?? '…'}</output>
    <label>{t('drawing.dimension.prefix')}<input value={prefix} maxLength={100} onChange={(event) => setPrefix(event.target.value)} /></label>
    <label>{t('drawing.dimension.suffix')}<input value={suffix} maxLength={100} onChange={(event) => setSuffix(event.target.value)} /></label>
    <label><input type="checkbox" checked={reference} disabled={basic} onChange={(event) => setReference(event.target.checked)} />{t('drawing.dimension.reference')}</label>
    <label><input type="checkbox" checked={basic} onChange={(event) => {
      setBasic(event.target.checked); if (event.target.checked) { setReference(false); setKind('none'); }
    }} />{t('drawing.dimension.basic')}</label>
    <label>{t('drawing.tolerance.kind')}
      <select value={kind} disabled={basic} onChange={(event) => {
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
    {dimension.kind === 'length' || dimension.kind === 'thickness' || dimension.kind === 'coordinate'
      ? <label>{t('drawing.dimension.offset')}<input value={offset} inputMode="decimal" onChange={(event) => setOffset(event.target.value)} /></label> : null}
    <label><input type="checkbox" checked={automaticText} onChange={(event) => setAutomaticText(event.target.checked)} />{t('drawing.dimension.automaticText')}</label>
    {automaticText ? null : <>
      <label>{t('drawing.dimension.textX')}<input value={textX} inputMode="decimal" onChange={(event) => setTextX(event.target.value)} /></label>
      <label>{t('drawing.dimension.textY')}<input value={textY} inputMode="decimal" onChange={(event) => setTextY(event.target.value)} /></label>
    </>}
    <div className="pcad-segmented">
      <button type="submit" className="pcad-button" disabled={busy}>{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={() => useAppStore.getState().selectDrawingIds([])}>{t('drawing.action.close')}</button>
    </div>
  </form>;
}
