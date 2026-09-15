import { useState } from 'react';
import { containsLengthUnit } from '@pointercad/expression';
import type { WeldLengthValue, WeldSideSpec, WeldSymbol } from '@pointercad/drawing';
import { drawingDimensionContext, resolveGdtFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingCreationLayer } from './drawingCreationLayer.js';
import { commitDrawingWeld, startDrawingWeld } from './weldCommands.js';
import { useDrawingToolDefaults } from './useDrawingToolDefaults.js';

const kinds = ['fillet', 'squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt', 'spot', 'seam'] as const;
const modes = ['arrow', 'opposite', 'both', 'center'] as const;
const contours = ['none', 'flush', 'convex', 'concave'] as const;
const finishes = ['none', 'grind', 'machine', 'chip', 'polish'] as const;
const expr = (source: string) => ({ source, value: 0, display: source });
const lengthValue = (source: string, unit: WeldLengthValue['unit']): WeldLengthValue => ({ expression: expr(source), unit });
const initial = (source: string, side: WeldSideSpec['side'] = 'arrow'): WeldSideSpec => ({ kind: side === 'center' ? 'spot' : 'fillet', side,
  size: { kind: side === 'center' ? 'diameter' : 'leg', value: lengthValue(source, 'mm') }, contour: 'none', finish: 'none' });
const number = (source: string): number => source.trim() === '' ? NaN : Number(source);

function WeldSideEditor({ value, defaultSource, onChange }: { readonly value: WeldSideSpec; readonly defaultSource: string;
  readonly onChange: (value: WeldSideSpec) => void }): React.JSX.Element {
  const unit = value.size?.value.unit ?? value.length?.unit ?? value.pitch?.unit ?? value.rootGap?.unit ?? value.grooveDepth?.unit ?? 'mm';
  const defaultSize = lengthValue(unit === 'inch' && !containsLengthUnit(defaultSource) ? `(${defaultSource})mm` : defaultSource, unit);
  const groove = !['fillet', 'spot', 'seam'].includes(value.kind);
  const inputLength = (key: 'length' | 'pitch' | 'rootGap' | 'grooveDepth'): React.JSX.Element => <label>{t(`drawing.weld.${key}`)}
    <input title={t(`drawing.controlHint.weld.${key}`)} value={value[key]?.expression.source ?? ''} onChange={(event) => onChange({ ...value,
      [key]: event.target.value.trim() === '' ? undefined : lengthValue(event.target.value, unit) })} /></label>;
  return <fieldset><legend>{t(`drawing.weld.side.${value.side}`)}</legend>
    <label title={t('drawing.weld.kind.controlHint')}>{t('drawing.weld.kind')}<select aria-label={t('drawing.weld.kind')} value={value.kind} onChange={(event) => {
      const kind = kinds.find((entry) => entry === event.target.value); if (kind === undefined) return;
      const sizeKind = kind === 'fillet' ? 'leg' : kind === 'spot' ? 'diameter' : kind === 'seam' ? 'width' : undefined;
      onChange({ kind, side: value.side, contour: 'none', finish: 'none',
        ...(sizeKind === undefined ? {} : { size: { kind: sizeKind, value: value.size?.value ?? defaultSize } }) });
    }}>{kinds.filter((kind) => value.side !== 'center' || kind === 'spot' || kind === 'seam').map((kind) =>
        <option key={kind} value={kind}>{t(`drawing.weld.kind.${kind}`)}</option>)}</select></label>
    <label title={t('drawing.weld.unit.controlHint')}>{t('drawing.weld.unit')}<select aria-label={t('drawing.weld.unit')} value={unit} onChange={(event) => {
      const next: WeldLengthValue['unit'] = event.target.value === 'inch' ? 'inch' : 'mm';
      const convert = (length: WeldLengthValue | undefined): WeldLengthValue | undefined => length === undefined ? undefined : { ...length, unit: next };
      onChange({ ...value, size: value.size === undefined ? undefined : { ...value.size, value: { ...value.size.value, unit: next } },
        length: convert(value.length), pitch: convert(value.pitch), rootGap: convert(value.rootGap), grooveDepth: convert(value.grooveDepth) });
    }}><option value="mm">mm</option><option value="inch">inch</option></select></label>
    {value.kind === 'fillet' ? <label title={t('drawing.weld.sizeKind.controlHint')}>{t('drawing.weld.sizeKind')}<select aria-label={t('drawing.weld.sizeKind')} value={value.size?.kind ?? 'leg'}
      onChange={(event) => onChange({ ...value, size: { kind: event.target.value === 'throat' ? 'throat' : 'leg', value: value.size?.value ?? defaultSize } })}>
      <option value="leg">{t('drawing.weld.size.leg')}</option><option value="throat">{t('drawing.weld.size.throat')}</option></select></label> : null}
    <label>{t(groove ? 'drawing.weld.size.penetration' : value.kind === 'spot' ? 'drawing.weld.size.diameter'
      : value.kind === 'seam' ? 'drawing.weld.size.width' : value.size?.kind === 'throat' ? 'drawing.weld.size.throat' : 'drawing.weld.size.leg')}
      <input title={t('drawing.controlHint.weldSize')} value={value.size?.value.expression.source ?? ''} onChange={(event) => onChange({ ...value, size: event.target.value.trim() === '' ? undefined
        : { kind: groove ? 'penetration' : value.kind === 'spot' ? 'diameter' : value.kind === 'seam' ? 'width' : value.size?.kind === 'throat' ? 'throat' : 'leg',
          value: lengthValue(event.target.value, unit) } })} /></label>
    {value.kind === 'spot' ? null : inputLength('length')}
    <label title={t('drawing.weld.count.controlHint')}>{t('drawing.weld.count')}<input value={value.count?.source ?? ''} onChange={(event) => onChange({ ...value,
      count: event.target.value.trim() === '' ? undefined : expr(event.target.value) })} /></label>
    {inputLength('pitch')}
    {groove ? <>{inputLength('rootGap')}{inputLength('grooveDepth')}{value.kind === 'squareButt' ? null : <label>{t('drawing.weld.grooveAngle')}
      <input title={t('drawing.controlHint.weldAngle')} value={value.grooveAngle?.source ?? ''} onChange={(event) => onChange({ ...value,
        grooveAngle: event.target.value.trim() === '' ? undefined : expr(event.target.value) })} /></label>}</> : null}
    {value.side === 'center' ? null : <>
      <label title={t('drawing.weld.contour.controlHint')}>{t('drawing.weld.contour')}<select aria-label={t('drawing.weld.contour')} value={value.contour} onChange={(event) => {
        const contour = contours.find((entry) => entry === event.target.value); if (contour !== undefined) onChange({ ...value, contour, finish: contour === 'none' ? 'none' : value.finish });
      }}>{contours.map((contour) => <option key={contour} value={contour}>{t(`drawing.weld.contour.${contour}`)}</option>)}</select></label>
      <label title={t('drawing.weld.finish.controlHint')}>{t('drawing.weld.finish')}<select aria-label={t('drawing.weld.finish')} value={value.finish} disabled={value.contour === 'none'} onChange={(event) => {
        const finish = finishes.find((entry) => entry === event.target.value); if (finish !== undefined) onChange({ ...value, finish });
      }}>{finishes.map((finish) => <option key={finish} value={finish}>{t(`drawing.weld.finish.${finish}`)}</option>)}</select></label>
    </>}
  </fieldset>;
}

export function DrawingWeldPanel({ symbol }: { readonly symbol?: WeldSymbol }): React.JSX.Element {
  const defaults = useDrawingToolDefaults();
  const document = useAppStore((state) => state.drawing), source = useAppStore((state) => state.drawingSourceResolution);
  const targets = useAppStore((state) => state.drawingTargets), busy = useAppStore((state) => state.drawingBusy);
  const [sides, setSides] = useState<readonly WeldSideSpec[]>(() => symbol?.sides ?? [initial(defaults.source('weldSize'))]);
  const [allAround, setAllAround] = useState(symbol?.allAround ?? false), [fieldWeld, setFieldWeld] = useState(symbol?.fieldWeld ?? false);
  const [tail, setTail] = useState(symbol?.tail ?? ''), [closedTail, setClosedTail] = useState(symbol?.closedTail ?? false);
  const [bend, setBend] = useState(symbol?.arrowBendOffset !== undefined), [bendX, setBendX] = useState(String(symbol?.arrowBendOffset?.[0] ?? -10));
  const [bendY, setBendY] = useState(String(symbol?.arrowBendOffset?.[1] ?? -10));
  const [height, setHeight] = useState(() => symbol === undefined ? defaults.number('weldHeight') : String(symbol.height));
  const [x, setX] = useState(symbol === undefined ? '' : String(symbol.position[0])), [y, setY] = useState(symbol === undefined ? '' : String(symbol.position[1]));
  const target = targets.length > 0 ? targets.length === 1 ? targets[0] : undefined : symbol?.target;
  const resolved = target?.kind !== 'subShape' || target.ref.fingerprint.kind === 'vertex' || document === null || source === null ? null
    : resolveGdtFeature({ kind: target.ref.fingerprint.kind === 'face' ? 'surface' : 'line', target }, document, drawingDimensionContext(source));
  const close = (): void => useAppStore.getState().setDrawingTool('select');
  return <form className="pcad-drawing-settings" aria-label={t('drawing.weld.title')} data-help-topic="welding"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}
    onSubmit={(event) => {
      event.preventDefault();
      if (document === null || target === undefined || resolved === null) { useAppStore.getState().setDrawingMessage(t('drawing.weld.pick')); return; }
      const layerId = symbol?.layerId ?? drawingCreationLayer(document, 'layer-5'); if (layerId === null) return;
      commitDrawingWeld({ system: 'B', target, sides, allAround, fieldWeld, tail, closedTail, layerId, height: number(height),
        position: [x.trim() === '' ? resolved.paperPoint[0] + 20 : number(x), y.trim() === '' ? resolved.paperPoint[1] + 20 : number(y)],
        ...(bend ? { arrowBendOffset: [number(bendX), number(bendY)] as const } : {}), ...(symbol?.style === undefined ? {} : { style: symbol.style }) }, symbol);
    }}>
    <strong>{t('drawing.weld.title')}</strong><p>{t('drawing.weld.pick')}</p><p>{t('drawing.weld.unitsHint')}</p>
    <fieldset disabled={busy}>
      {symbol === undefined ? null : <button title={t('drawing.controlHint.retargetAnnotation')} type="button" className="pcad-button" onClick={() => startDrawingWeld(symbol.id)}>{t('drawing.gdt.retarget')}</button>}
      <label title={t('drawing.weld.side.controlHint')}>{t('drawing.weld.side')}<select aria-label={t('drawing.weld.side')} value={sides.length === 2 ? 'both' : sides[0].side} onChange={(event) => {
        const mode = modes.find((entry) => entry === event.target.value); if (mode === undefined) return;
        setSides((mode === 'both' ? ['arrow', 'opposite'] as const : [mode]).map((side) => sides.find((entry) => entry.side === side) ?? initial(defaults.source('weldSize'), side)));
      }}>{modes.map((mode) => <option key={mode} value={mode}>{t(`drawing.weld.side.${mode}`)}</option>)}</select></label>
      {sides.map((side, index) => <WeldSideEditor key={side.side} value={side} defaultSource={defaults.source('weldSize')}
        onChange={(next) => setSides(sides.map((entry, i) => i === index ? next : entry))} />)}
      <label><input title={t('drawing.controlHint.allAround')} type="checkbox" checked={allAround} onChange={(event) => setAllAround(event.target.checked)} />{t('drawing.weld.allAround')}</label>
      <label><input title={t('drawing.controlHint.fieldWeld')} type="checkbox" checked={fieldWeld} onChange={(event) => setFieldWeld(event.target.checked)} />{t('drawing.weld.fieldWeld')}</label>
      <label title={t('drawing.weld.tail.controlHint')}>{t('drawing.weld.tail')}<textarea value={tail} maxLength={2000} onChange={(event) => setTail(event.target.value)} /></label>
      <label><input title={t('drawing.controlHint.closedTail')} type="checkbox" checked={closedTail} onChange={(event) => setClosedTail(event.target.checked)} />{t('drawing.weld.closedTail')}</label>
      <label><input title={t('drawing.controlHint.bend')} type="checkbox" checked={bend} onChange={(event) => setBend(event.target.checked)} />{t('drawing.weld.bend')}</label>
      {bend ? <><label title={t('drawing.weld.bendX.controlHint')}>{t('drawing.weld.bendX')}<input value={bendX} onChange={(event) => setBendX(event.target.value)} /></label>
        <label title={t('drawing.weld.bendY.controlHint')}>{t('drawing.weld.bendY')}<input value={bendY} onChange={(event) => setBendY(event.target.value)} /></label></> : null}
      <label title={t('drawing.note.height.controlHint')}>{t('drawing.note.height')}<input value={height} inputMode="decimal" onChange={(event) => setHeight(event.target.value)} /></label>
      <label title={t('drawing.controlHint.automaticNoteX')}>{t('drawing.note.x')}<input value={x} inputMode="decimal" onChange={(event) => setX(event.target.value)} /></label>
      <label title={t('drawing.controlHint.automaticNoteY')}>{t('drawing.note.y')}<input value={y} inputMode="decimal" onChange={(event) => setY(event.target.value)} /></label>
      <button title={t('drawing.controlHint.applyAnnotation')} type="submit" className="pcad-button">{t('drawing.action.apply')}</button>
      <button title={t('drawing.controlHint.closeAnnotation')} type="button" className="pcad-button" onClick={close}>{t('drawing.action.close')}</button>
    </fieldset>
  </form>;
}
