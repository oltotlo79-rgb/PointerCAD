import type { Annotation, DimensionTarget, SurfaceFinishProcess } from '@pointercad/drawing';
import { useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { addDrawingMachiningNote, addDrawingSurfaceFinish, defaultDrawingAnnotationPosition, editDrawingSourceAnnotation } from './annotationCommands.js';
import { resolveMachiningAnnotation } from './annotationDisplay.js';

export function DrawingAnnotationPopover({ target, annotation, inline = false }: {
  readonly target: DimensionTarget; readonly annotation?: Annotation; readonly inline?: boolean;
}): React.JSX.Element {
  const document = useAppStore((state) => state.drawing);
  const source = useAppStore((state) => state.drawingSourceResolution);
  const library = useAppStore((state) => state.drawingSources);
  const busy = useAppStore((state) => state.drawingBusy);
  const machining = document === null ? null : resolveMachiningAnnotation(document, library, target, annotation?.machiningFeatureId);
  const [kind, setKind] = useState(annotation === undefined ? machining === null ? 'surface' : 'machining' : annotation.kind === 'surfaceFinish' ? 'surface' : 'machining');
  const [process, setProcess] = useState<SurfaceFinishProcess>(annotation?.surfaceFinish?.process ?? 'basic');
  const [parameter, setParameter] = useState<'Ra' | 'Rz'>(annotation?.surfaceFinish?.parameter ?? 'Ra');
  const [value, setValue] = useState(annotation?.surfaceFinish?.value.source ?? '3.2');
  const [height, setHeight] = useState(String(annotation?.height ?? 3.5));
  const [x, setX] = useState(String(annotation?.position[0] ?? 0));
  const [y, setY] = useState(String(annotation?.position[1] ?? 0));
  const number = (text: string): number => text.trim() === '' ? NaN : Number(text);
  const close = (): void => { const state = useAppStore.getState(); state.setDrawingTool('select'); state.selectDrawingIds([]); };
  return <form className={inline ? 'pcad-drawing-settings' : 'pcad-drawing-input'} aria-label={t('drawing.tool.annotation')}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onSubmit={(event) => {
    event.preventDefault();
    if (document === null || source === null) return;
    if (annotation !== undefined) {
      const common = { position: [number(x), number(y)] as const, height: number(height) };
      editDrawingSourceAnnotation(annotation, kind === 'surface' ? { ...common, kind: 'surfaceFinish', process, parameter, value } : { ...common, kind: 'machining' });
      return;
    }
    const position = defaultDrawingAnnotationPosition(target);
    if (position === null) { useAppStore.getState().setDrawingMessage(t('drawing.error.dimensionSourceMissing')); return; }
    if (kind === 'machining') addDrawingMachiningNote(target, position);
    else addDrawingSurfaceFinish({ target, position, process, parameter, value });
  }}>
    <strong>{t('drawing.tool.annotation')}</strong>
    <label>{t('drawing.annotation.kind')}<select aria-label={t('drawing.annotation.kind')} value={kind} disabled={annotation !== undefined} onChange={(event) => setKind(event.target.value)}>
      <option value="surface">{t('drawing.annotation.surface')}</option>
      <option value="machining">{t('drawing.annotation.machining')}</option>
    </select></label>
    {kind === 'machining' ? <output>{machining?.tokens.filter((token) => token.kind === 'text').map((token) => token.text).join(' ') ?? t('drawing.error.machiningSourceMissing')}</output> : <>
      <label>{t('drawing.annotation.process')}<select aria-label={t('drawing.annotation.process')} value={process} onChange={(event) => {
        const next = event.target.value; if (next === 'basic' || next === 'removal' || next === 'noRemoval') setProcess(next);
      }}>
        <option value="basic">{t('drawing.annotation.basic')}</option><option value="removal">{t('drawing.annotation.removal')}</option>
        <option value="noRemoval">{t('drawing.annotation.noRemoval')}</option>
      </select></label>
      <label>{t('drawing.annotation.parameter')}<select aria-label={t('drawing.annotation.parameter')} value={parameter} onChange={(event) => setParameter(event.target.value === 'Rz' ? 'Rz' : 'Ra')}>
        <option value="Ra">Ra</option><option value="Rz">Rz</option>
      </select></label>
      <label>{t('drawing.annotation.roughness')}<input value={value} onChange={(event) => setValue(event.target.value)} autoFocus={annotation === undefined} /></label>
    </>}
    {annotation === undefined ? null : <>
      <label>{t('drawing.note.height')}<input value={height} inputMode="decimal" onChange={(event) => setHeight(event.target.value)} /></label>
      <label>{t('drawing.note.x')}<input value={x} inputMode="decimal" onChange={(event) => setX(event.target.value)} /></label>
      <label>{t('drawing.note.y')}<input value={y} inputMode="decimal" onChange={(event) => setY(event.target.value)} /></label>
    </>}
    <div><button type="submit" className="pcad-button" disabled={busy}>{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={close}>{t('drawing.action.close')}</button></div>
  </form>;
}
