import { useState } from 'react';
import type { DrawingDocument, DrawingLayer, DrawingLineType } from '@pointercad/drawing';
import { removeDrawingLayer } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingLayer, deleteDrawingLayer, moveDrawingLayer } from './layerCommands.js';

const lineTypes: readonly { readonly kind: DrawingLineType; readonly key: MessageKey }[] = [
  { kind: 'solid', key: 'drawing.layer.solid' }, { kind: 'dashed', key: 'drawing.layer.dashed' },
  { kind: 'chain', key: 'drawing.layer.chain' }, { kind: 'chain2', key: 'drawing.layer.chain2' },
  { kind: 'zigzag', key: 'drawing.layer.zigzag' },
];

function LayerForm({ drawing, layer }: { readonly drawing: DrawingDocument; readonly layer?: DrawingLayer }): React.JSX.Element {
  const [name, setName] = useState(layer?.name ?? '');
  const [visible, setVisible] = useState(layer?.visible ?? true);
  const [printable, setPrintable] = useState(layer?.printable ?? true);
  const [color, setColor] = useState(layer?.color ?? '#000000');
  const [lineType, setLineType] = useState<DrawingLineType>(layer?.lineType ?? 'solid');
  const [width, setWidth] = useState(String(layer?.lineWidth ?? 0.25));
  const [confirming, setConfirming] = useState<DrawingDocument | null>(null);
  const busy = useAppStore((state) => state.drawingBusy);
  const index = drawing.layers.findIndex((entry) => entry.id === layer?.id);
  const deletion = layer === undefined ? null : removeDrawingLayer(drawing, layer.id);
  const close = (): void => useAppStore.getState().setDrawingTool('select');
  return <form className="pcad-drawing-settings" aria-label={t('drawing.property.layer')}
    onKeyDown={(event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (confirming !== null) setConfirming(null); else close();
    }}
    onSubmit={(event) => { event.preventDefault();
      commitDrawingLayer({ name, visible, printable, color, lineType, lineWidth: width.trim() === '' ? NaN : Number(width) }, layer?.id);
    }}>
    <label>{t('drawing.layer.name')}<input className="pcad-field__input" value={name} onChange={(event) => setName(event.target.value)} autoFocus={layer === undefined} /></label>
    <label><input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />{t('drawing.layer.visible')}</label>
    <label><input type="checkbox" checked={printable} onChange={(event) => setPrintable(event.target.checked)} />{t('drawing.layer.printable')}</label>
    <label>{t('drawing.layer.color')}<input className="pcad-field__input" value={color} onChange={(event) => setColor(event.target.value)} /></label>
    <label>{t('drawing.layer.lineType')}<select className="pcad-field__input" value={lineType} onChange={(event) => {
      const choice = lineTypes.find((entry) => entry.kind === event.target.value); if (choice !== undefined) setLineType(choice.kind);
    }}>{lineTypes.map((entry) => <option key={entry.kind} value={entry.kind}>{t(entry.key)}</option>)}</select></label>
    <label>{t('drawing.layer.width')}<input className="pcad-field__input" value={width} inputMode="decimal" onChange={(event) => setWidth(event.target.value)} /></label>
    <div className="pcad-segmented">
      <button type="submit" className="pcad-button" disabled={busy}>{t(layer === undefined ? 'drawing.layer.add' : 'drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={close}>{t('drawing.action.close')}</button>
    </div>
    {layer === undefined ? null : <>
      <div className="pcad-segmented">
        <button type="button" className="pcad-button" disabled={busy || index <= 0} onClick={() => moveDrawingLayer(layer.id, index - 1)}>{t('drawing.layer.moveUp')}</button>
        <button type="button" className="pcad-button" disabled={busy || index >= drawing.layers.length - 1} onClick={() => moveDrawingLayer(layer.id, index + 1)}>{t('drawing.layer.moveDown')}</button>
      </div>
      <button type="button" className="pcad-button" disabled={busy || drawing.layers.length <= 1}
        title={drawing.layers.length <= 1 ? t('drawing.layer.last') : t('drawing.layer.delete')}
        onClick={() => setConfirming(drawing)}>{t('drawing.layer.delete')}</button>
      {confirming !== drawing ? null : <div role="group" aria-label={t('drawing.layer.delete')}>
        <p>{t('drawing.layer.deleteConfirm').replace('{name}', layer.name).replace('{count}', String(deletion?.removedElementCount ?? 0))}</p>
        <button type="button" className="pcad-button" disabled={busy} onClick={() => deleteDrawingLayer(layer.id, confirming)}>{t('drawing.layer.confirmDelete')}</button>
        <button type="button" className="pcad-button" onClick={() => setConfirming(null)}>{t('drawing.action.close')}</button>
      </div>}
    </>}
  </form>;
}

export function DrawingLayerPanel({ allowCreate = false, embedded = false }: { readonly allowCreate?: boolean; readonly embedded?: boolean }): React.JSX.Element | null {
  const drawing = useAppStore((state) => state.drawing);
  const selection = useAppStore((state) => state.drawingSelectedIds);
  const editor = useAppStore((state) => state.drawingEditor);
  if (drawing === null) return null;
  const layer = selection.length === 1 ? drawing.layers.find((entry) => entry.id === selection[0]) : undefined;
  if (layer === undefined && editor?.kind !== 'layer' && !allowCreate) return null;
  return <section className="pcad-section">{embedded ? null : <h3 className="pcad-section__title">{t('drawing.property.layer')}</h3>}
    <LayerForm key={`${drawing.id}:${JSON.stringify(layer ?? null)}`} drawing={drawing} {...(layer === undefined ? {} : { layer })} />
  </section>;
}
