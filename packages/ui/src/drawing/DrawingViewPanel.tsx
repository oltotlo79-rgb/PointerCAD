import { useState } from 'react';
import { paperSizeOf, type DrawingDocument, type DrawingView } from '@pointercad/drawing';
import type { NamedView } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { commitDrawingView } from './viewCommands.js';
import { DrawingConstructedViewPanel } from './DrawingConstructedViewPanel.js';
import { DrawingCenterMarksPanel } from './DrawingCenterMarksPanel.js';

export function DrawingViewPanel({ embedded = false }: { readonly embedded?: boolean }): React.JSX.Element | null {
  const drawing = useAppStore((state) => state.drawing);
  const library = useAppStore((state) => state.drawingSources);
  const selection = useAppStore((state) => state.drawingSelectedIds);
  const editor = useAppStore((state) => state.drawingEditor);
  if (drawing === null) return null;
  const cameras = library.sources.find((entry) => entry.metadata.sourceRef === drawing.source.sourceRef)?.document.namedViews ?? [];
  const view = drawing.views.find((entry) => selection.includes(entry.id));
  const cameraId = editor?.kind === 'view' ? editor.cameraId : undefined;
  const constructionKind = view?.construction?.kind ?? (editor?.kind === 'view' ? editor.constructionKind : undefined);
  const form = constructionKind !== undefined ? <DrawingConstructedViewPanel key={JSON.stringify([view, editor])} drawing={drawing} view={view}
    kind={constructionKind} sourceViewId={editor?.kind === 'view' ? editor.sourceViewId : undefined}
    targets={editor?.kind === 'view' ? editor.targets ?? [] : []} />
    : <ViewForm key={`${drawing.id}:${JSON.stringify(view)}:${cameraId ?? ''}`} drawing={drawing} view={view} cameras={cameras} cameraId={cameraId} embedded={embedded} />;
  return <>{form}{view === undefined ? null : <DrawingCenterMarksPanel key={view.id} drawing={drawing} view={view} />}</>;
}

function ViewForm({ drawing, view, cameras, cameraId: initialCameraId, embedded }: {
  readonly drawing: DrawingDocument; readonly view: DrawingView | undefined; readonly cameras: readonly NamedView[];
  readonly cameraId: string | undefined;
  readonly embedded: boolean;
}): React.JSX.Element {
  const paper = paperSizeOf(drawing.sheet.paperSizeId);
  const camera = cameras.find((entry) => entry.id === initialCameraId) ?? cameras[0];
  const [cameraId, setCameraId] = useState(view === undefined ? camera?.id ?? '' : '');
  const [name, setName] = useState(view?.name ?? camera?.name ?? '');
  const [x, setX] = useState(String(view?.position[0] ?? (paper?.width ?? 420) / 2));
  const [y, setY] = useState(String(view?.position[1] ?? (paper?.height ?? 297) / 2));
  const [scale, setScale] = useState(view?.scale == null ? '' : String(view.scale));
  const [hidden, setHidden] = useState(view?.showHidden ?? true);
  const [centers, setCenters] = useState(view?.showCenterLines ?? true);
  const [error, setError] = useState(false);
  const busy = useAppStore((state) => state.drawingBusy);
  return <section className="pcad-section pcad-drawing-settings">
    {embedded ? null : <h3 className="pcad-section__title">{t('drawing.property.view')}</h3>}
    <form onSubmit={(event) => {
      event.preventDefault();
      setError(!commitDrawingView({ cameraId, name, position: [x.trim() === '' ? NaN : Number(x), y.trim() === '' ? NaN : Number(y)],
        scale: scale.trim() === '' ? null : Number(scale), showHidden: hidden, showCenterLines: centers }, view?.id));
    }}>
      <label>{t('drawing.view.camera')}<select className="pcad-field__input" aria-label={t('drawing.view.camera')} value={cameraId} onChange={(event) => {
        setCameraId(event.target.value); const camera = cameras.find((entry) => entry.id === event.target.value);
        if (camera !== undefined) setName(camera.name);
      }}>
        {view === undefined ? null : <option value="">{t('drawing.view.keepDirection')}</option>}
        {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
      </select></label>
      <p>{t('drawing.view.cameraHint')}</p>
      <label>{t('drawing.view.name')}<input className="pcad-field__input" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('drawing.view.x')}<input className="pcad-field__input" value={x} inputMode="decimal" onChange={(event) => setX(event.target.value)} /></label>
      <label>{t('drawing.view.y')}<input className="pcad-field__input" value={y} inputMode="decimal" onChange={(event) => setY(event.target.value)} /></label>
      <label>{t('drawing.view.scale')}<input className="pcad-field__input" value={scale} inputMode="decimal" onChange={(event) => setScale(event.target.value)} /></label>
      <label><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />{t('drawing.view.hidden')}</label>
      <label><input type="checkbox" checked={centers} onChange={(event) => setCenters(event.target.checked)} />{t('drawing.view.centers')}</label>
      {error ? <p role="alert">{t('drawing.view.invalid')}</p> : null}
      <button type="submit" className="pcad-button" disabled={busy || view === undefined && cameras.length === 0}>
        {t(view === undefined ? 'drawing.view.add' : 'drawing.view.apply')}
      </button>
      {view === undefined ? null : <button type="button" className="pcad-button" onClick={() => useAppStore.getState().openDrawingEditor({ kind: 'view' })}>{t('drawing.view.new')}</button>}
    </form>
  </section>;
}
