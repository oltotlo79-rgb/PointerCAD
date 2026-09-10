import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingDimensionSeries } from './dimensionSeriesCommands.js';

export function DrawingDimensionSeriesPanel(): React.JSX.Element | null {
  const editor = useAppStore((state) => state.drawingEditor), targets = useAppStore((state) => state.drawingTargets);
  const busy = useAppStore((state) => state.drawingBusy);
  if (editor?.kind !== 'dimension') return null;
  const update = useAppStore.getState().updateDrawingSeriesEditor;
  return <form className="pcad-drawing-settings" aria-label={t('drawing.series.title')} data-help-topic="dimension-series"
    onSubmit={(event) => { event.preventDefault(); void commitDrawingDimensionSeries(); }}>
    <p>{t('drawing.series.pick')}</p>
    <output>{t('drawing.series.count').replace('{count}', String(targets.length))}</output>
    <label>{t('drawing.series.kind')}<select aria-label={t('drawing.series.kind')} value={editor.seriesKind} onChange={(event) => {
      const value = event.target.value;
      if (value === 'chain' || value === 'parallel' || value === 'coordinate' || value === 'progressive') update({ seriesKind: value });
    }}>{(['chain', 'parallel', 'coordinate', 'progressive'] as const).map((kind) => <option key={kind} value={kind}>{t(`drawing.series.${kind}`)}</option>)}</select></label>
    {editor.seriesKind === 'coordinate' ? null : <label>{t('drawing.series.axis')}<select aria-label={t('drawing.series.axis')} value={editor.axis}
      onChange={(event) => { if (event.target.value === 'x' || event.target.value === 'y') update({ axis: event.target.value }); }}>
      <option value="x">{t('drawing.dimension.horizontal')}</option><option value="y">{t('drawing.dimension.vertical')}</option>
    </select></label>}
    {editor.seriesKind === 'chain' ? null : <label>{t('drawing.series.base')}<select aria-label={t('drawing.series.base')} value={editor.baseIndex}
      disabled={targets.length === 0} onChange={(event) => update({ baseIndex: Number(event.target.value) })}>
      {targets.map((_target, index) => <option key={index} value={index}>{t('drawing.series.point').replace('{index}', String(index + 1))}</option>)}
    </select></label>}
    <label>{t('drawing.series.offset')}<input value={editor.offset} inputMode="decimal" onChange={(event) => update({ offset: event.target.value })} /></label>
    <div className="pcad-segmented"><button type="submit" className="pcad-button" disabled={busy || targets.length < 2}>{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={() => useAppStore.getState().setDrawingTool('select')}>{t('drawing.action.close')}</button></div>
  </form>;
}
