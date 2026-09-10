import { useMemo, useState } from 'react';
import type { DatumDefinition, DatumReference, GdtFeature, GdtFrameSegment, GeometricToleranceFrame, MaterialRequirement } from '@pointercad/drawing';
import { compatibleGdtSizeDimensions, defaultGdtToleranceZone, drawingDimensionContext, GDT_RULES, nextDatumLabel, resolveDrawingDimensions, resolveGdtFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingDatum, commitDrawingGdtFrame, drawingGdtFeature, startDrawingGdt } from './gdtCommands.js';
import { drawingCreationLayer } from './drawingCreationLayer.js';

const featureKinds = ['surface', 'line', 'axis', 'medianPlane'] as const;
const characteristics = ['straightness', 'flatness', 'roundness', 'cylindricity', 'lineProfile', 'surfaceProfile', 'parallelism',
  'perpendicularity', 'angularity', 'position', 'coaxiality', 'symmetry', 'circularRunout', 'totalRunout'] as const;
const initialSegment = (): GdtFrameSegment => ({ characteristic: 'flatness', zone: 'betweenPlanes',
  tolerance: { expression: { source: '0.05', value: 0.05, display: '0.05' }, unit: 'mm' }, material: 'none', datums: [], basicDimensionIds: [] });
const number = (text: string): number => text.trim() === '' ? NaN : Number(text);

function DatumCell({ value, datums, index, onChange }: { readonly value?: DatumReference; readonly datums: readonly DatumDefinition[];
  readonly index: number; readonly onChange: (value: DatumReference | undefined) => void }): React.JSX.Element {
  const members = value === undefined ? [] : value.kind === 'single' ? [value.member] : value.members;
  const change = (memberIndex: 0 | 1, id: string, material: MaterialRequirement): void => {
    const member = { datumId: id, material };
    if (memberIndex === 0 && id === '') { onChange(undefined); return; }
    const first = memberIndex === 0 ? member : members[0], second = memberIndex === 1 ? (id === '' ? undefined : member) : members[1];
    if (first === undefined) return;
    onChange(second === undefined ? { kind: 'single', member: first } : { kind: 'common', members: [first, second] });
  };
  return <fieldset><legend>{t('drawing.gdt.order').replace('{number}', String(index + 1))}</legend>
    {([0, 1] as const).filter((memberIndex) => memberIndex === 0 || members[0] !== undefined).map((memberIndex) => <div key={memberIndex}>
      <label>{t(memberIndex === 0 ? 'drawing.gdt.datum' : 'drawing.gdt.common')}
        <select aria-label={t(memberIndex === 0 ? 'drawing.gdt.datum' : 'drawing.gdt.common')} value={members[memberIndex]?.datumId ?? ''}
          onChange={(event) => change(memberIndex, event.target.value, members[memberIndex]?.material ?? 'none')}>
          <option value="">{t('drawing.gdt.none')}</option>
          {members[memberIndex] !== undefined && !datums.some((datum) => datum.id === members[memberIndex]?.datumId)
            ? <option value={members[memberIndex].datumId}>{t('drawing.gdt.missingDatum')}</option> : null}
          {datums.map((datum) => <option key={datum.id} value={datum.id}>{datum.label}</option>)}
        </select>
      </label>
      {members[memberIndex] === undefined ? null : <label><input type="checkbox" checked={members[memberIndex].material === 'maximum'}
        onChange={(event) => change(memberIndex, members[memberIndex]?.datumId ?? '', event.target.checked ? 'maximum' : 'none')} />{t('drawing.gdt.datumMaximum')}</label>}
    </div>)}
  </fieldset>;
}

export function DrawingGdtPanel({ kind, datum, frame }: { readonly kind: 'datum' | 'gdt'; readonly datum?: DatumDefinition;
  readonly frame?: GeometricToleranceFrame }): React.JSX.Element {
  const document = useAppStore((state) => state.drawing), source = useAppStore((state) => state.drawingSourceResolution);
  const targets = useAppStore((state) => state.drawingTargets), busy = useAppStore((state) => state.drawingBusy);
  const dimensions = useMemo(() => document === null || source === null ? [] : resolveDrawingDimensions(document, drawingDimensionContext(source)), [document, source]);
  const current = datum ?? frame;
  const [featureKind, setFeatureKind] = useState<GdtFeature['kind']>(current?.feature.kind ?? 'surface');
  const [label, setLabel] = useState(datum?.label ?? (document === null ? 'A' : nextDatumLabel(document) ?? ''));
  const [segments, setSegments] = useState<readonly GdtFrameSegment[]>(frame?.segments ?? [initialSegment()]);
  const [height, setHeight] = useState(String(current?.height ?? 3.5));
  const [x, setX] = useState(current === undefined ? '' : String(current.position[0]));
  const [y, setY] = useState(current === undefined ? '' : String(current.position[1]));
  const [sizeId, setSizeId] = useState(current?.sizeDimensionId ?? '');
  const context = source === null ? null : drawingDimensionContext(source);
  const feature = targets.length > 0 ? drawingGdtFeature(featureKind, targets, document ?? undefined, context ?? undefined)
    : current?.feature.kind === featureKind ? current.feature : null;
  const resolved = feature === null || document === null || context === null ? null : resolveGdtFeature(feature, document, context);
  const sizes = feature === null || document === null || context === null ? [] : compatibleGdtSizeDimensions(feature, document, context);
  const effectiveSizeId = sizeId || (sizes.length === 1 ? sizes[0].dimension.id : '');
  const needsSize = featureKind === 'axis' || featureKind === 'medianPlane';
  const change = (index: number, patch: Partial<GdtFrameSegment>): void => setSegments(segments.map((segment, i) => i === index ? { ...segment, ...patch } : segment));
  const close = (): void => useAppStore.getState().setDrawingTool('select');
  return <form className="pcad-drawing-settings" aria-label={t(kind === 'datum' ? 'drawing.gdt.datum' : 'drawing.gdt.title')} data-help-topic="gdt"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}
    onSubmit={(event) => {
      event.preventDefault();
      if (document === null || feature === null || resolved === null) { useAppStore.getState().setDrawingMessage(t('drawing.gdt.pick')); return; }
      const layerId = current?.layerId ?? drawingCreationLayer(document, 'layer-5'); if (layerId === null) return;
      const common = { feature, height: number(height), position: [x.trim() === '' ? resolved.paperPoint[0] + 20 : number(x),
        y.trim() === '' ? resolved.paperPoint[1] + 20 : number(y)] as const, layerId,
        ...(needsSize && effectiveSizeId !== '' ? { sizeDimensionId: effectiveSizeId } : {}), ...(current?.style === undefined ? {} : { style: current.style }) };
      if (kind === 'datum') commitDrawingDatum({ ...common, label }, datum);
      else commitDrawingGdtFrame({ ...common, segments }, frame);
    }}>
    <strong>{t(kind === 'datum' ? 'drawing.gdt.datum' : 'drawing.gdt.title')}</strong>
    <p>{t('drawing.gdt.pick')}</p>
    <fieldset disabled={busy}>
      <label>{t('drawing.gdt.feature')}<select aria-label={t('drawing.gdt.feature')} value={featureKind} onChange={(event) => {
        const next = featureKinds.find((value) => value === event.target.value); if (next !== undefined) { setFeatureKind(next); setSizeId(''); }
      }}>{featureKinds.map((value) => <option key={value} value={value}>{t(`drawing.gdt.feature.${value}`)}</option>)}</select></label>
      {current === undefined ? null : <button type="button" className="pcad-button" onClick={() => startDrawingGdt(kind, current.id)}>{t('drawing.gdt.retarget')}</button>}
      {needsSize ? <><label>{t('drawing.gdt.sizeDimension')}<select aria-label={t('drawing.gdt.sizeDimension')} value={effectiveSizeId} onChange={(event) => setSizeId(event.target.value)}>
        <option value="">{t('drawing.gdt.none')}</option>
        {effectiveSizeId !== '' && !sizes.some((item) => item.dimension.id === effectiveSizeId)
          ? <option value={effectiveSizeId}>{t('drawing.gdt.missingSize')}</option> : null}
        {sizes.map((item) => <option key={item.dimension.id} value={item.dimension.id}>{item.text}</option>)}
      </select></label><p>{t('drawing.gdt.sizeHint')}</p></> : null}
      {kind === 'datum' ? <label>{t('drawing.gdt.label')}<input value={label} maxLength={1} onChange={(event) => setLabel(event.target.value.toUpperCase())} /></label>
        : segments.map((segment, index) => <fieldset key={index}><legend>{t('drawing.gdt.row').replace('{number}', String(index + 1))}</legend>
          <label>{t('drawing.gdt.characteristic')}<select aria-label={t('drawing.gdt.characteristic')} value={segment.characteristic} onChange={(event) => {
            const next = characteristics.find((value) => value === event.target.value);
            if (next !== undefined) change(index, { characteristic: next, zone: defaultGdtToleranceZone(next, resolved?.kind ?? null) });
          }}>{characteristics.map((value) => <option key={value} value={value}>{t(`drawing.gdt.characteristic.${value}`)}</option>)}</select></label>
          <label>{t('drawing.gdt.zone')}<select aria-label={t('drawing.gdt.zone')} value={segment.zone} onChange={(event) => {
            const next = GDT_RULES[segment.characteristic].zones.find((value) => value === event.target.value); if (next !== undefined) change(index, { zone: next });
          }}>{GDT_RULES[segment.characteristic].zones.map((value) => <option key={value} value={value}>{t(`drawing.gdt.zone.${value}`)}</option>)}</select></label>
          <label>{t('drawing.gdt.value')}<input value={segment.tolerance.expression.source} onChange={(event) => change(index,
            { tolerance: { ...segment.tolerance, expression: { source: event.target.value, value: 0, display: event.target.value } } })} /></label>
          <label>{t('drawing.gdt.unit')}<select aria-label={t('drawing.gdt.unit')} value={segment.tolerance.unit} onChange={(event) => change(index,
            { tolerance: { ...segment.tolerance, unit: event.target.value === 'inch' ? 'inch' : 'mm' } })}><option value="mm">mm</option><option value="inch">inch</option></select></label>
          <label><input type="checkbox" checked={segment.material === 'maximum'} onChange={(event) => change(index,
            { material: event.target.checked ? 'maximum' : 'none' })} />{t('drawing.gdt.maximum')}</label>
          {Array.from({ length: Math.min(3, segment.datums.length + 1) }, (_, datumIndex) => <DatumCell key={datumIndex} index={datumIndex}
            value={segment.datums[datumIndex]} datums={document?.datums ?? []} onChange={(value) => {
              const next = [...segment.datums]; if (value === undefined) next.splice(datumIndex, 1); else next[datumIndex] = value;
              change(index, { datums: next });
            }} />)}
          <fieldset><legend>{t('drawing.gdt.basicDimensions')}</legend>{document?.dimensions.filter((item) => item.basic === true).map((item) => <label key={item.id}>
            <input type="checkbox" checked={segment.basicDimensionIds.includes(item.id)} onChange={(event) => change(index, { basicDimensionIds: event.target.checked
              ? [...segment.basicDimensionIds, item.id] : segment.basicDimensionIds.filter((id) => id !== item.id) })} />
            {t(`drawing.dimension.${item.kind === 'thickness' ? 'length' : item.kind}`)} — {dimensions.find((entry) => entry.dimension.id === item.id)?.text ?? '?'}
          </label>)}{segment.basicDimensionIds.filter((id) => !document?.dimensions.some((item) => item.id === id && item.basic === true)).map((id, missingIndex) =>
            <label key={id}><input type="checkbox" checked onChange={() => change(index,
              { basicDimensionIds: segment.basicDimensionIds.filter((entry) => entry !== id) })} />
              {t('drawing.gdt.missingBasic').replace('{number}', String(missingIndex + 1))}</label>)}</fieldset>
          <button type="button" className="pcad-button" disabled={segments.length === 1} onClick={() => setSegments(segments.filter((_, i) => i !== index))}>{t('drawing.gdt.removeRow')}</button>
        </fieldset>)}
      {kind === 'gdt' ? <button type="button" className="pcad-button" disabled={segments.length >= 8} onClick={() => setSegments([...segments, initialSegment()])}>{t('drawing.gdt.addRow')}</button> : null}
      <label>{t('drawing.note.height')}<input value={height} inputMode="decimal" onChange={(event) => setHeight(event.target.value)} /></label>
      <label>{t('drawing.note.x')}<input value={x} inputMode="decimal" placeholder={String((resolved?.paperPoint[0] ?? 0) + 20)} onChange={(event) => setX(event.target.value)} /></label>
      <label>{t('drawing.note.y')}<input value={y} inputMode="decimal" placeholder={String((resolved?.paperPoint[1] ?? 0) + 20)} onChange={(event) => setY(event.target.value)} /></label>
      <button type="submit" className="pcad-button">{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={close}>{t('drawing.action.close')}</button>
    </fieldset>
  </form>;
}
