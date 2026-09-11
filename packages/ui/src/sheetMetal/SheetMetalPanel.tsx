import { useEffect, useMemo, useState } from 'react';
import { createSheetBaseFeature, createSheetFlangeFeature, createSheetBendFeature, createSheetReliefFeature, resolveSheetSeams, availableSheetBoundaryEdges, resolvePart, sheetFlangeProfileEdges, pickSheetBoundary,
  type SheetMetalFeature, type SheetFlangeFeature, type SheetBendFeature, type SheetReliefFeature, type SheetPanelBoundaryRef, type SketchFaceRef } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { formatVolume } from '../solid/solidSummary.js';
import { fieldUnitLabelKey } from '../sketch/numericInput.js';
import type { SheetMetalToolSession } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildSheetCreation } from './sheetCommands.js';
import { applySheetCreation } from './sheetCreationActions.js';
import { SHEET_FIELD_DEFINITIONS, sheetFieldValues, type SheetFieldKey } from './sheetFields.js';
import { sheetInputDocument, sheetInitialProfile, preserveSheetEditValues } from './sheetEditInputs.js';
import { SheetBendSummary } from './SheetBendSummary.js';
import { sheetHelpTopic } from './sheetHelpTopic.js';
import { sheetCheckbox as checkbox, sheetSelect as select } from './sheetFormControls.js';
import './sheetMetal.css';

const faceKey = (ref: SketchFaceRef) => JSON.stringify([ref.sketchId, ref.faceFeatureId]);
const boundaryKey = (ref: SheetPanelBoundaryRef) => JSON.stringify([ref.panelId, ref.boundaryId]);

/** 入力は未確定の下書き。確定時だけ文書へ1操作として適用する。 */
export function SheetMetalPanel({ session }: { readonly session: SheetMetalToolSession }): React.JSX.Element {
  const document = useAppStore((state) => state.document);
  const editing = session.editingFeature, initialProfile = sheetInitialProfile(editing);
  const selection = useAppStore((state) => state.selection);
  const liveSheetBodies = useAppStore((state) => state.sheetMetalBodies);
  const bodies = useAppStore((state) => state.bodies);
  const computing = useAppStore((state) => state.isComputing);
  const requested = useAppStore((state) => state.sheetMetalRequestId !== null);
  const preview = useAppStore((state) => state.sheetMetalPreview);
  const computeError = useAppStore((state) => state.sheetMetalError);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const [profileKey, setProfileKey] = useState(initialProfile === undefined ? '' : faceKey(initialProfile.face));
  const [targetId, setTargetId] = useState(editing !== undefined && editing.kind !== 'sheetBase' ? editing.targetFeatureId : '');
  const [panelId, setPanelId] = useState(editing?.kind === 'sheetBend' ? editing.panelId : '');
  const [lineKey, setLineKey] = useState(editing?.kind === 'sheetBend' ? JSON.stringify([editing.line.sketchId, editing.line.lineFeatureId]) : '');
  const [fixedSide, setFixedSide] = useState<SheetBendFeature['fixedSide']>(editing?.kind === 'sheetBend' ? editing.fixedSide : 'right');
  const [selectedEdges, setSelectedEdges] = useState<readonly string[]>(editing?.kind === 'sheetFlange' ? editing.edges.map(boundaryKey) : []);
  const [reliefEdgeKey, setReliefEdgeKey] = useState(editing?.kind === 'sheetRelief' ? boundaryKey(editing.boundary) : '');
  const [reliefShape, setReliefShape] = useState<SheetReliefFeature['shape']>(editing?.kind === 'sheetRelief' ? editing.shape : 'rectangle');
  const [reliefSeams, setReliefSeams] = useState<readonly string[] | null>(editing?.kind === 'sheetRelief' ? editing.seamConnectionIds ?? [] : null);
  const [holeKeys, setHoleKeys] = useState<readonly string[]>(initialProfile?.holes.map(faceKey) ?? []);
  const [sources, setSources] = useState<Partial<Record<SheetFieldKey, string>>>({});
  const [reversed, setReversed] = useState(editing?.kind === 'sheetBase' && editing.reversed);
  const [basis, setBasis] = useState<SheetFlangeFeature['lengthBasis']>(editing?.kind === 'sheetFlange' ? editing.lengthBasis : 'tangent');
  const [profileMode, setProfileMode] = useState<'rectangle' | 'profile'>(editing?.kind === 'sheetFlange' && editing.profile !== null ? 'profile' : 'rectangle');
  const [baselineId, setBaselineId] = useState(editing?.kind === 'sheetFlange' ? editing.profile?.baselineId ?? '' : '');
  const [overrideRadius, setOverrideRadius] = useState((editing?.kind === 'sheetFlange' || editing?.kind === 'sheetBend') && editing.rule.innerRadius !== null);
  const [overrideK, setOverrideK] = useState((editing?.kind === 'sheetFlange' || editing?.kind === 'sheetBend') && editing.rule.kFactor !== null);
  const [invalidField, setInvalidField] = useState<SheetFieldKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const resolved = useMemo(() => resolvePart(sheetInputDocument(document, editing)), [document, editing]);
  const sheetBodies = editing === undefined ? liveSheetBodies : resolved.sheetMetalBodies;
  const faces = document.sketches.flatMap((sketch) => sketch.features.filter((feature) => feature.kind === 'face')
    .map((feature) => ({ ref: { sketchId: sketch.id, faceFeatureId: feature.id }, name: `${sketch.name} / ${feature.name}` })));
  const profile = profileKey !== '' ? faces.find((item) => faceKey(item.ref) === profileKey)
    : faces.find((item) => selection.some((id) => featureIdOf(id) === item.ref.faceFeatureId)) ?? faces[0];
  const resolvedProfile = resolved.sketches.find((item) => item.sketchId === profile?.ref.sketchId)?.resolved.faces
    .find((item) => item.featureId === profile?.ref.faceFeatureId);
  const profileEdges = resolvedProfile === undefined ? null : sheetFlangeProfileEdges(resolvedProfile);
  const baselines = profileEdges?.ok === true ? profileEdges.value : [];
  const targets = document.solids.filter((feature) => sheetBodies?.has(feature.id) && resolved.liveBodyIds.includes(feature.id));
  const target = targetId !== '' ? targets.find((feature) => feature.id === targetId)
    : targets.find((feature) => selection.some((id) => featureIdOf(id) === feature.id)) ?? targets[0];
  const sheet = target === undefined ? undefined : sheetBodies?.get(target.id);
  const inputSeams = reliefSeams ?? document.sheetUnfolds.find((item) => item.sourceFeatureId === target?.id)?.seamConnectionIds ?? [];
  const mappedSeams = sheet === undefined ? undefined : resolveSheetSeams(sheet, inputSeams);
  const selectedSeams = mappedSeams?.ok === true ? mappedSeams.value : inputSeams;
  const panel = panelId !== '' ? sheet?.panels.find((item) => item.id === panelId) : sheet?.panels[0];
  const lines = document.sketches.flatMap((sketch) => sketch.features.filter((feature) => feature.kind === 'line')
    .map((feature) => ({ key: JSON.stringify([sketch.id, feature.id]), ref: { sketchId: sketch.id, lineFeatureId: feature.id }, name: `${sketch.name} / ${feature.name}` })));
  const line = lineKey !== '' ? lines.find((item) => item.key === lineKey)
    : lines.find((item) => selection.some((id) => featureIdOf(id) === item.ref.lineFeatureId)) ?? lines[0];
  const selectedTargetId = target?.id;
  useEffect(() => {
    if ((session.kind !== 'sheetFlange' && session.kind !== 'sheetRelief') || sheet === undefined) return;
    const body = bodies.find((item) => item.featureId === selectedTargetId);
    if (body === undefined) return;
    const keys: string[] = [];
    for (const id of selection) {
      const parsed = parseSubShapeId(id);
      if (parsed?.kind !== 'edge' || parsed.bodyFeatureId !== selectedTargetId) continue;
      const edge = body.edges.find((item) => item.index === parsed.index);
      if (edge?.curveKind !== 'line') continue;
      const matches = pickSheetBoundary(sheet, edge.start, edge.end);
      if (matches.length === 1) keys.push(boundaryKey(matches[0]));
      else if (matches.length > 1) setMessage(t('sheetMetal.ambiguousEdge'));
    }
    if (keys.length > 0) {
      useAppStore.getState().clearSheetMetalPreview();
      if (session.kind === 'sheetRelief') setReliefEdgeKey(keys[0]);
      else setSelectedEdges((previous) => [...new Set([...previous, ...keys])]);
    }
  }, [selection, sheet, bodies, selectedTargetId, session.kind]);
  const edges = sheet?.panels.flatMap((panel, panelIndex) => {
    const result = availableSheetBoundaryEdges(sheet, panel.id); if (!result.ok) return [];
    return result.value
      .map((edge, index) => ({ ref: { panelId: panel.id, boundaryId: edge.id }, label: `${t('sheetMetal.panel')} ${panelIndex + 1} / ${t('sheetMetal.edge')} ${index + 1}` }));
  }) ?? [];
  const reliefEdge = reliefEdgeKey !== '' ? edges.find((edge) => boundaryKey(edge.ref) === reliefEdgeKey) : edges[0];
  let candidate: SheetMetalFeature | null = null;
  if (session.kind === 'sheetBase' && profile !== undefined) {
    candidate = { ...createSheetBaseFeature(document, profile.ref), reversed,
      holes: faces.filter((item) => holeKeys.includes(faceKey(item.ref)) && faceKey(item.ref) !== faceKey(profile.ref)).map((item) => item.ref) };
  } else if (session.kind === 'sheetBend' && target !== undefined && panel !== undefined && line !== undefined) {
    candidate = { ...createSheetBendFeature(document, target.id, panel.id, line.ref), fixedSide,
      rule: { innerRadius: overrideRadius ? sheet?.rule.innerRadius ?? null : null, kFactor: overrideK ? sheet?.rule.kFactor ?? null : null } };
  } else if (session.kind === 'sheetRelief' && target !== undefined && sheet !== undefined && reliefEdge !== undefined) {
    candidate = { ...createSheetReliefFeature(document, target.id, reliefEdge.ref, sheet.rule), shape: reliefShape, seamConnectionIds: selectedSeams };
  } else if (session.kind === 'sheetFlange' && target !== undefined && (profileMode === 'rectangle' || profile !== undefined)) {
    const initial = createSheetFlangeFeature(document, target.id, edges.filter((edge) => selectedEdges.includes(boundaryKey(edge.ref))).map((edge) => edge.ref));
    candidate = { ...initial, lengthBasis: basis, rule: { innerRadius: overrideRadius ? sheet?.rule.innerRadius ?? null : null,
      kFactor: overrideK ? sheet?.rule.kFactor ?? null : null },
      profile: profileMode === 'rectangle' || profile === undefined ? null : { face: profile.ref, baselineId,
        holes: faces.filter((item) => holeKeys.includes(faceKey(item.ref)) && faceKey(item.ref) !== faceKey(profile.ref)).map((item) => item.ref) } };
  }
  if (candidate !== null) candidate = preserveSheetEditValues(candidate, editing);
  const missingHoles = holeKeys.filter((key) => !faces.some((face) => faceKey(face.ref) === key));
  const missingEdges = selectedEdges.filter((key) => !edges.some((edge) => boundaryKey(edge.ref) === key));
  const missingReferences = (session.kind === 'sheetFlange' && missingEdges.length > 0)
    || ((session.kind === 'sheetBase' || profileMode === 'profile') && missingHoles.length > 0);
  const submit = (commit: boolean) => {
    const state = useAppStore.getState();
    if (state.sheetMetalTool !== session || state.activeDocumentId !== session.documentId || state.document !== session.document
      || state.assembly !== null || state.drawing !== null || state.isComputing || candidate === null || missingReferences) return;
    const result = buildSheetCreation(state.document, candidate, sources, lengthUnit, {
      variables: state.parameterAnalysis.variables, exactVariables: state.parameterAnalysis.exactVariables, nonLengthVariables: state.nonLengthVariables,
    }, editing);
    if (!result.ok) { setMessage(result.message); setInvalidField(result.field ?? null); return; }
    void applySheetCreation(session, result, commit);
  };
  const toggle = (items: readonly string[], key: string, on: boolean) => on ? [...items.filter((item) => item !== key), key] : items.filter((item) => item !== key);
  const profileControls = (label: MessageKey) => <>
    {faces.length === 0 ? <p>{t('sheetMetal.needFace')}</p> : select(label, profile === undefined ? '' : faceKey(profile.ref),
      (value) => { setProfileKey(value); setBaselineId(''); }, faces.map((item) => ({ key: faceKey(item.ref), name: item.name })))}
    <fieldset><legend>{t('sheetMetal.holes')}</legend>{faces.filter((item) => profile === undefined || faceKey(item.ref) !== faceKey(profile.ref))
      .map((item) => checkbox(item.name, holeKeys.includes(faceKey(item.ref)), (on) => setHoleKeys(toggle(holeKeys, faceKey(item.ref), on)), faceKey(item.ref)))}</fieldset>
  </>;
  const titleKey = session.kind === 'sheetBase' ? 'sheetMetal.base' : session.kind === 'sheetBend' ? 'sheetMetal.lineBend' : session.kind === 'sheetRelief' ? 'sheetMetal.relief' : 'sheetMetal.flange';
  const hintKey = session.kind === 'sheetBase' ? 'sheetMetal.baseHint' : session.kind === 'sheetBend' ? 'sheetMetal.lineBendHint' : session.kind === 'sheetRelief' ? 'sheetMetal.reliefHint' : 'sheetMetal.flangeHint';
  return <form className="pcad-section pcad-sheet-metal" aria-label={t(titleKey)} data-help-topic={sheetHelpTopic(session.kind)}
    onSubmit={(event) => { event.preventDefault(); submit(true); }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().closeSheetMetalTool(); }
    }}>
    <h3>{t(titleKey)}{editing === undefined ? '' : ` — ${t('sheetMetal.editing')}`}</h3>
    <p>{t(hintKey)}</p>
    {missingReferences ? <p role="alert">
      {t('sheetMetal.missingReferences')} <button type="button" className="pcad-button" onClick={() => {
        useAppStore.getState().clearSheetMetalPreview(); setSelectedEdges(selectedEdges.filter((key) => !missingEdges.includes(key)));
        setHoleKeys(holeKeys.filter((key) => !missingHoles.includes(key)));
      }}>{t('sheetMetal.removeMissing')}</button></p> : null}
    {session.kind === 'sheetBase' ? <>
      {profileControls('sheetMetal.profile')}
      {checkbox(t('sheetMetal.reverse'), reversed, setReversed, 'reverse')}
    </> : <>
      {targets.length === 0 ? <p>{t(computing ? 'sheetMetal.waitingForBody' : 'sheetMetal.needBase')}</p> : select('sheetMetal.target', target?.id ?? '', (value) => { setTargetId(value); setPanelId(''); setSelectedEdges([]); setReliefEdgeKey(''); setReliefSeams(null); }, targets.map((item) => ({ key: item.id, name: item.name })))}
      {session.kind === 'sheetBend' ? <>
        {select('sheetMetal.panel', panel?.id ?? '', setPanelId, sheet?.panels.map((item, index) => ({ key: item.id, name: `${t('sheetMetal.panel')} ${index + 1}` })) ?? [])}
        {lines.length === 0 ? <p>{t('sheetMetal.needLine')}</p> : select('sheetMetal.bendLine', line?.key ?? '', setLineKey, lines.map((item) => ({ key: item.key, name: item.name })))}
        {select('sheetMetal.fixedSide', fixedSide, (value) => { if (value === 'left' || value === 'right') setFixedSide(value); },
          [{ key: 'right', name: t('sheetMetal.fixedRight') }, { key: 'left', name: t('sheetMetal.fixedLeft') }])}
      </> : session.kind === 'sheetRelief' ? <>
        {select('sheetMetal.reliefEdge', reliefEdge === undefined ? '' : boundaryKey(reliefEdge.ref), setReliefEdgeKey,
          edges.map((edge) => ({ key: boundaryKey(edge.ref), name: edge.label })))}
        {select('sheetMetal.reliefShape', reliefShape, (value) => { if (value === 'rectangle' || value === 'slot') setReliefShape(value); },
          [{ key: 'rectangle', name: t('sheetMetal.rectangle') }, { key: 'slot', name: t('sheetMetal.reliefSlot') }])}
        <fieldset><legend>{t('sheetMetal.seams')}</legend><p>{t('sheetMetal.seamsHint')}</p>
          {sheet?.bends.map((bend, index) => checkbox(`${t('sheetMetal.bend')} ${index + 1}`, selectedSeams.includes(bend.id),
            (on) => setReliefSeams(toggle(selectedSeams, bend.id, on)), bend.id))}
          {mappedSeams?.ok === false ? <p role="alert">{mappedSeams.message} <button type="button" className="pcad-button"
            onClick={() => { useAppStore.getState().clearSheetMetalPreview(); setReliefSeams([]); }}>{t('sheetMetal.removeMissing')}</button></p> : null}
        </fieldset>
      </> : <>
      <fieldset><legend>{t('sheetMetal.edges')}</legend>{edges.map((item) => checkbox(item.label, selectedEdges.includes(boundaryKey(item.ref)),
        (on) => setSelectedEdges(toggle(selectedEdges, boundaryKey(item.ref), on)), boundaryKey(item.ref)))}</fieldset>
      {select('sheetMetal.profileMode', profileMode, (value) => { if (value === 'rectangle' || value === 'profile') setProfileMode(value); },
        [{ key: 'rectangle', name: t('sheetMetal.rectangle') }, { key: 'profile', name: t('sheetMetal.customProfile') }])}
      {profileMode === 'rectangle' ? select('sheetMetal.lengthBasis', basis, (value) => { if (value === 'tangent' || value === 'outer' || value === 'inner') setBasis(value); },
        [{ key: 'tangent', name: t('sheetMetal.basisTangent') }, { key: 'outer', name: t('sheetMetal.basisOuter') }, { key: 'inner', name: t('sheetMetal.basisInner') }]) : <>
        {profileControls('sheetMetal.flangeProfile')}
        {select('sheetMetal.baseline', baselineId, setBaselineId, [{ key: '', name: t('sheetMetal.chooseBaseline') },
          ...baselines.map((edge, index) => ({ key: edge.id, name: `${t('sheetMetal.edge')} ${index + 1}` }))])}
        <p>{t('sheetMetal.baselineHint')}</p>
      </>}
      </>}
      {session.kind === 'sheetRelief' ? null : <>
        {checkbox(t('sheetMetal.overrideRadius'), overrideRadius, setOverrideRadius, 'radius')}
        {checkbox(t('sheetMetal.overrideK'), overrideK, setOverrideK, 'k')}
      </>}
    </>}
    {candidate === null ? null : sheetFieldValues(candidate).map(([key, value]) => {
      const definition = SHEET_FIELD_DEFINITIONS[key];
      return <label className="pcad-field" key={key}><span>{t(definition.labelKey)}</span>
        <input type="text" className={`pcad-field__input${invalidField === key ? ' pcad-field__input--error' : ''}`} aria-invalid={invalidField === key}
          value={sources[key] ?? value.source} title={t(definition.tooltipKey)}
          onChange={(event) => { useAppStore.getState().clearSheetMetalPreview(); setSources({ ...sources, [key]: event.target.value }); setMessage(null); setInvalidField(null); }} />
        <span>{t(fieldUnitLabelKey(definition.unit, lengthUnit))}</span></label>;
    })}
    {candidate === null ? null : <SheetBendSummary feature={candidate} rule={sheet?.rule} sources={sources} lengthUnit={lengthUnit} />}
    {session.kind === 'sheetRelief' ? null : <p>{t('sheetMetal.kFactorHint')}</p>}
    {message === null ? null : <p role="alert" className="pcad-field__error">{message}</p>}
    {computeError === null ? null : <p role="alert" className="pcad-field__error">{computeError}</p>}
    {requested ? <p role="status">{t('sheetMetal.computing')}</p> : preview?.session !== session ? null : <p role="status">
      {t(editing === undefined ? 'sheetMetal.previewHint' : 'sheetMetal.editPreviewHint')} {t(editing === undefined ? 'sheetMetal.previewVolume' : 'sheetMetal.previewTotalVolume').replace('{volume}', formatVolume(preview.volume))}</p>}
    <button className="pcad-button" type="button" disabled={candidate === null || computing || requested} onClick={() => submit(false)}>{t('sheetMetal.preview')}</button>
    <div className="pcad-sheet-metal__actions"><button className="pcad-button pcad-button--primary" type="submit" disabled={candidate === null || computing || requested}>{t(editing === undefined ? 'sheetMetal.create' : 'sheetMetal.applyEdit')}</button>
      <button className="pcad-button" type="button" onClick={() => useAppStore.getState().closeSheetMetalTool()}>{t('sheetMetal.cancel')}</button></div>
  </form>;
}
