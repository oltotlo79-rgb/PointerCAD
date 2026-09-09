import type { DimensionTarget, SurfaceFinishProcess } from '@pointercad/drawing';
import { useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { addDrawingMachiningNote, addDrawingSurfaceFinish, defaultDrawingAnnotationPosition } from './annotationCommands.js';
import { resolveMachiningAnnotation } from './annotationDisplay.js';

export function DrawingAnnotationPopover({ target }: { readonly target: DimensionTarget }): React.JSX.Element {
  const document = useAppStore((state) => state.drawing);
  const source = useAppStore((state) => state.drawingSourceResolution);
  const library = useAppStore((state) => state.drawingSources);
  const machining = document === null ? null : resolveMachiningAnnotation(document, library, target);
  const [kind, setKind] = useState(machining === null ? 'surface' : 'machining');
  const [process, setProcess] = useState<SurfaceFinishProcess>('basic');
  const [parameter, setParameter] = useState<'Ra' | 'Rz'>('Ra');
  const [value, setValue] = useState('3.2');
  return <form className="pcad-drawing-input" aria-label={t('drawing.tool.annotation')} onSubmit={(event) => {
    event.preventDefault();
    if (document === null || source === null) return;
    const position = defaultDrawingAnnotationPosition(target);
    if (position === null) { useAppStore.getState().setDrawingMessage(t('drawing.error.dimensionSourceMissing')); return; }
    if (kind === 'machining') addDrawingMachiningNote(target, position);
    else addDrawingSurfaceFinish({ target, position, process, parameter, value });
  }}>
    <strong>{t('drawing.tool.annotation')}</strong>
    <label>{t('drawing.annotation.kind')}<select value={kind} onChange={(event) => setKind(event.target.value)}>
      <option value="surface">{t('drawing.annotation.surface')}</option>
      <option value="machining">{t('drawing.annotation.machining')}</option>
    </select></label>
    {kind === 'machining' ? <output>{machining?.tokens.filter((token) => token.kind === 'text').map((token) => token.text).join(' ') ?? t('drawing.error.machiningSourceMissing')}</output> : <>
      <label>{t('drawing.annotation.process')}<select value={process} onChange={(event) => {
        const next = event.target.value; if (next === 'basic' || next === 'removal' || next === 'noRemoval') setProcess(next);
      }}>
        <option value="basic">{t('drawing.annotation.basic')}</option><option value="removal">{t('drawing.annotation.removal')}</option>
        <option value="noRemoval">{t('drawing.annotation.noRemoval')}</option>
      </select></label>
      <label>{t('drawing.annotation.parameter')}<select value={parameter} onChange={(event) => setParameter(event.target.value === 'Rz' ? 'Rz' : 'Ra')}>
        <option value="Ra">Ra</option><option value="Rz">Rz</option>
      </select></label>
      <label>{t('drawing.annotation.roughness')}<input value={value} onChange={(event) => setValue(event.target.value)} autoFocus /></label>
    </>}
    <div><button type="submit" className="pcad-button">{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={() => useAppStore.getState().setDrawingTool('select')}>{t('drawing.action.close')}</button></div>
  </form>;
}
