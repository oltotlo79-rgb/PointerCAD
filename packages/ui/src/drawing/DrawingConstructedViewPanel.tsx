import { useState } from 'react';
import type { DimensionTarget, DrawingDocument, DrawingView, DrawingViewConstruction } from '@pointercad/drawing';
import { useAppStore } from '../store/useAppStore.js';
import { t, type MessageKey } from '../i18n/t.js';
import { commitConstructedDrawingView } from './constructedViewCommands.js';
import { initialConstructedViewFields, parseConstructedViewDraft, type ConstructedViewChoices, type ConstructedViewFields } from './constructedViewDraft.js';

export const CONSTRUCTED_VIEW_LABELS = { section: 'drawing.tool.sectionView', detail: 'drawing.tool.detailView', auxiliary: 'drawing.tool.auxiliaryView',
  partial: 'drawing.tool.partialView', broken: 'drawing.tool.brokenView' } as const satisfies Record<DrawingViewConstruction['kind'], MessageKey>;

export function DrawingConstructedViewPanel({ drawing, view, kind, sourceViewId: sourceId, targets }: {
  readonly drawing: DrawingDocument; readonly view?: DrawingView; readonly kind: DrawingViewConstruction['kind'];
  readonly sourceViewId?: string; readonly targets: readonly DimensionTarget[];
}): React.JSX.Element {
  const definition = view?.construction;
  const plane = definition !== undefined && 'plane' in definition ? definition.plane : undefined;
  const [fields, setFields] = useState(() => ({ ...initialConstructedViewFields(view, t(CONSTRUCTED_VIEW_LABELS[kind])),
    ...(view === undefined && kind === 'detail' ? { scale: '2' } : {}) }));
  const [hidden, setHidden] = useState(view?.showHidden ?? true);
  const [centers, setCenters] = useState(view?.showCenterLines ?? true);
  const [choices, setChoices] = useState<ConstructedViewChoices>({ kind,
    sourceViewId: definition !== undefined && 'sourceViewId' in definition ? definition.sourceViewId
      : plane?.kind === 'viewLine' ? plane.sourceViewId : sourceId ?? drawing.views.find((item) => item.id !== view?.id)?.id ?? '',
    planeKind: plane?.kind ?? (targets.length === 3 ? 'threePoints' : targets.length === 1 && targets[0].kind === 'subShape'
      && targets[0].ref.fingerprint.kind === 'face' ? 'face' : 'workPlane'),
    workPlane: plane?.kind === 'workPlane' ? plane.planeId : 'xy',
    mode: definition?.kind === 'section' ? definition.mode : 'full', keepSide: definition?.kind === 'section' ? definition.keepSide : 'positive',
    reversed: definition?.kind === 'section' && definition.reversed,
    regionKind: definition?.kind === 'partial' ? definition.region.kind : 'circle', axis: definition?.kind === 'broken' ? definition.axis : 'u' });
  const [error, setError] = useState(false);
  const busy = useAppStore((state) => state.drawingBusy);
  const input = (key: keyof ConstructedViewFields, label: MessageKey) => <label key={key}>{t(label)}
    <input className="pcad-field__input" aria-label={t(label)} value={fields[key]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></label>;
  function select<K extends keyof ConstructedViewChoices>(key: K, label: MessageKey,
    options: readonly { readonly value: ConstructedViewChoices[K]; readonly label: string }[]): React.JSX.Element {
    return <label>{t(label)}<select className="pcad-field__input" aria-label={t(label)} value={String(choices[key])} onChange={(event) => {
      const option = options.find((item) => String(item.value) === event.target.value);
      if (option !== undefined) {
        setChoices({ ...choices, [key]: option.value });
        if (key === 'mode' && view === undefined) setFields({ ...fields, boundary: option.value === 'half' ? '-15,0\n15,0'
          : option.value === 'stepped' ? '-15,0\n0,0\n0,5\n15,5' : '-10,-10\n10,-10\n10,10\n-10,10' });
      }
    }}>{options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select></label>;
  }
  const showPlane = kind === 'section' || kind === 'auxiliary';
  const showBoundary = kind === 'partial' && choices.regionKind === 'polygon'
    || kind === 'section' && choices.mode !== 'full' && choices.mode !== 'revolved';
  return <form className="pcad-drawing-settings" onSubmit={(event) => {
    event.preventDefault();
    const draft = parseConstructedViewDraft(drawing, fields, choices, targets, definition);
    setError(draft === null || !commitConstructedDrawingView(drawing, { ...draft, name: fields.name,
      showHidden: hidden, showCenterLines: centers }, view));
  }} onKeyDown={(event) => { if (event.key === 'Escape') { useAppStore.getState().selectDrawingIds([]); event.stopPropagation(); } }}>
    <p>{t(CONSTRUCTED_VIEW_LABELS[kind])}</p>
    <p className="pcad-drawing-property-hint">{t('drawing.advanced.hint')}</p>
    {input('name', 'drawing.view.name')}
    {select('sourceViewId', 'drawing.advanced.source', drawing.views.filter((item) => item.id !== view?.id).map((item) => ({ value: item.id, label: item.name })))}
    {input('x', 'drawing.view.x')}{input('y', 'drawing.view.y')}{input('scale', 'drawing.view.scale')}
    <label><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />{t('drawing.view.hidden')}</label>
    <label><input type="checkbox" checked={centers} onChange={(event) => setCenters(event.target.checked)} />{t('drawing.view.centers')}</label>
    {showPlane ? <>
      {select('planeKind', 'drawing.advanced.plane', [
        { value: 'workPlane', label: t('drawing.advanced.workPlane') }, { value: 'face', label: t('drawing.advanced.face') },
        { value: 'threePoints', label: t('drawing.advanced.threePoints') }, { value: 'viewLine', label: t('drawing.advanced.viewLine') },
      ])}
      {choices.planeKind === 'workPlane' ? select('workPlane', 'drawing.advanced.workPlane', [
        { value: 'xy', label: 'XY' }, { value: 'xz', label: 'XZ' }, { value: 'yz', label: 'YZ' },
      ]) : null}
      {choices.planeKind === 'workPlane' || choices.planeKind === 'face' ? input('offset', 'drawing.advanced.offset') : null}
      {choices.planeKind === 'face' || choices.planeKind === 'threePoints' ? <p>{t('drawing.advanced.targetHint')}</p> : null}
      {choices.planeKind === 'viewLine' ? <>{input('lineX1', 'drawing.advanced.lineX1')}{input('lineY1', 'drawing.advanced.lineY1')}
        {input('lineX2', 'drawing.advanced.lineX2')}{input('lineY2', 'drawing.advanced.lineY2')}</> : null}
    </> : null}
    {kind === 'section' ? <>
      {select('mode', 'drawing.advanced.sectionMode', [
        { value: 'full', label: t('drawing.advanced.full') }, { value: 'half', label: t('drawing.advanced.half') },
        { value: 'local', label: t('drawing.advanced.local') }, { value: 'revolved', label: t('drawing.advanced.revolved') },
        { value: 'stepped', label: t('drawing.advanced.stepped') },
      ])}
      {select('keepSide', 'drawing.advanced.keepSide', [{ value: 'positive', label: t('drawing.advanced.positive') }, { value: 'negative', label: t('drawing.advanced.negative') }])}
      <label><input type="checkbox" checked={choices.reversed} onChange={(event) => setChoices({ ...choices, reversed: event.target.checked })} />{t('drawing.advanced.reversed')}</label>
      {input('label', 'drawing.advanced.label')}
    </> : null}
    {kind === 'partial' ? select('regionKind', 'drawing.advanced.region', [{ value: 'circle', label: t('drawing.advanced.circle') }, { value: 'polygon', label: t('drawing.advanced.polygon') }]) : null}
    {kind === 'detail' || kind === 'partial' && choices.regionKind === 'circle' ? <>
      {input('centerX', 'drawing.advanced.centerX')}{input('centerY', 'drawing.advanced.centerY')}{input('radius', 'drawing.advanced.radius')}
      {kind === 'detail' ? input('label', 'drawing.advanced.label') : null}
    </> : null}
    {kind === 'broken' ? <>
      {select('axis', 'drawing.advanced.axis', [{ value: 'u', label: t('drawing.advanced.horizontal') }, { value: 'v', label: t('drawing.advanced.vertical') }])}
      {input('from', 'drawing.advanced.from')}{input('to', 'drawing.advanced.to')}{input('gap', 'drawing.advanced.gap')}
    </> : null}
    {showBoundary ? <><label>{t('drawing.advanced.boundary')}<textarea className="pcad-field__input" aria-label={t('drawing.advanced.boundary')}
      rows={4} value={fields.boundary} onChange={(event) => setFields({ ...fields, boundary: event.target.value })} /></label>
      <p>{t(kind === 'section' && choices.mode === 'half' ? 'drawing.advanced.halfHint'
        : kind === 'section' && choices.mode === 'stepped' ? 'drawing.advanced.steppedHint' : 'drawing.advanced.boundaryHint')}</p></> : null}
    {error ? <p role="alert">{t('drawing.advanced.invalid')}</p> : null}
    <button className="pcad-button" type="submit" disabled={busy}>{t(view === undefined ? 'drawing.view.add' : 'drawing.view.apply')}</button>
    <button className="pcad-button" type="button" onClick={() => useAppStore.getState().selectDrawingIds([])}>{t('drawing.advanced.cancel')}</button>
  </form>;
}
