import { useState } from 'react';
import { resolveSheetSeams } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import { formatVolume } from '../solid/solidSummary.js';
import type { SheetMetalToolSession } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { showSheetUnfold } from './sheetUnfoldActions.js';
import { createDrawingFromCurrentPart } from '../drawing/createDrawingCommands.js';
import { exportSheet } from './sheetOutputActions.js';
import './sheetMetal.css';

export function SheetUnfoldPanel({ session }: { readonly session: SheetMetalToolSession }): React.JSX.Element {
  const document = useAppStore((state) => state.document), selection = useAppStore((state) => state.selection);
  const sheets = useAppStore((state) => state.sheetMetalBodies), error = useAppStore((state) => state.sheetMetalError);
  const requested = useAppStore((state) => state.sheetMetalRequestId !== null), computing = useAppStore((state) => state.isComputing);
  const preview = useAppStore((state) => state.sheetMetalPreview);
  const [targetId, setTargetId] = useState(''), [fixedId, setFixedId] = useState('');
  const [seams, setSeams] = useState<readonly string[] | null>(null);
  const targets = document.solids.filter((feature) => sheets.has(feature.id));
  const target = targets.find((item) => item.id === targetId)
    ?? targets.find((item) => selection.some((id) => featureIdOf(id) === item.id)) ?? targets[0];
  const sheet = target === undefined ? undefined : sheets.get(target.id);
  const saved = document.sheetUnfolds.find((item) => item.sourceFeatureId === target?.id);
  const fixed = fixedId || saved?.fixedPanelId || sheet?.panels[0]?.id || '';
  const inputSeams = seams ?? saved?.seamConnectionIds ?? [];
  const mappedSeams = sheet === undefined ? undefined : resolveSheetSeams(sheet, inputSeams);
  const selectedSeams = mappedSeams?.ok === true ? mappedSeams.value : inputSeams;
  const clear = () => useAppStore.getState().clearSheetMetalPreview();
  return <form className="pcad-section pcad-sheet-metal" aria-label={t('sheetMetal.unfold')} data-help-topic="sheet-metal-flat" onSubmit={(event) => {
    event.preventDefault();
    if (target !== undefined) void showSheetUnfold(session, { sourceFeatureId: target.id, fixedPanelId: fixed, seamConnectionIds: selectedSeams });
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().closeSheetMetalTool(); }
  }}>
    <h3>{t('sheetMetal.unfold')}</h3><p>{t('sheetMetal.unfoldHint')}</p>
    {targets.length === 0 ? <p>{t(computing ? 'sheetMetal.waitingForBody' : 'sheetMetal.needBase')}</p> : <>
      <label className="pcad-field"><span>{t('sheetMetal.target')}</span><select value={target?.id ?? ''} onChange={(event) => {
        clear(); setTargetId(event.target.value); setFixedId(''); setSeams(null);
      }}>{targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="pcad-field"><span>{t('sheetMetal.fixedPanel')}</span><select value={fixed} onChange={(event) => { clear(); setFixedId(event.target.value); }}>
        {sheet?.panels.map((panel, index) => <option key={panel.id} value={panel.id}>{t('sheetMetal.panel')} {index + 1}</option>)}
      </select></label>
      <fieldset><legend>{t('sheetMetal.seams')}</legend><p>{t('sheetMetal.seamsHint')}</p>
        {sheet?.bends.map((bend, index) => <label className="pcad-sheet-metal__check" key={bend.id}>
          <input type="checkbox" checked={selectedSeams.includes(bend.id)} onChange={(event) => {
            clear(); setSeams(event.target.checked ? [...selectedSeams, bend.id] : selectedSeams.filter((id) => id !== bend.id));
          }} />{t('sheetMetal.bend')} {index + 1}
        </label>)}
      {mappedSeams?.ok === false ? <p role="alert">{mappedSeams.message} <button type="button" className="pcad-button"
        onClick={() => { clear(); setSeams([]); }}>{t('sheetMetal.removeMissing')}</button></p> : null}
      </fieldset>
    </>}
    {error === null ? null : <p role="alert" className="pcad-field__error">{error}</p>}
    {requested ? <p role="status">{t('sheetMetal.computing')}</p> : preview?.flat === undefined ? null : <p role="status">
      {t('sheetMetal.flatVisible')} {t('sheetMetal.previewVolume').replace('{volume}', formatVolume(preview.volume))}</p>}
    <div className="pcad-sheet-metal__actions"><button className="pcad-button pcad-button--primary" type="submit" disabled={target === undefined || computing || requested}>{t('sheetMetal.showFlat')}</button>
      <button className="pcad-button" type="button" onClick={clear}>{t('sheetMetal.showFolded')}</button></div>
    <button className="pcad-button" type="button" disabled={preview?.flat === undefined || computing || requested}
      title={t('sheetMetal.flatDrawingHint')} onClick={() => { if (preview?.flat !== undefined) void createDrawingFromCurrentPart(undefined, preview); }}>{t('sheetMetal.createFlatDrawing')}</button>
    <fieldset><legend>{t('sheetMetal.output')}</legend><p>{t('sheetMetal.outputHint')}</p>
      <div className="pcad-sheet-metal__actions">{(['flatDxf', 'flatStep', 'foldedStep'] as const).map((format) =>
        <button className="pcad-button" key={format} type="button" disabled={preview?.flat === undefined || computing || requested}
          onClick={() => { if (preview !== null) void exportSheet(preview, format); }}>{t(`sheetMetal.${format}`)}</button>)}</div>
    </fieldset>
    <button className="pcad-button" type="button" onClick={() => useAppStore.getState().closeSheetMetalTool()}>{t('sheetMetal.close')}</button>
  </form>;
}
