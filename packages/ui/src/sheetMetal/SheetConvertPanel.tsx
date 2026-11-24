/** 立体を板金へ変える(M-08)。選んだ平らな面を基準に内半径と K 係数を入れ、計算部で板金として読めた時だけ確定する。 */
import { useState } from 'react';
import { defaultSheetMetalRule, type SheetConvertFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { pendingFieldVariables } from '../shell/propertyFieldUnits.js';
import { formatVolume } from '../solid/solidSummary.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import { fieldUnitLabelKey } from '../sketch/numericInput.js';
import type { SheetMetalToolSession } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { applySheetCreation } from './sheetCreationActions.js';
import { selectedConvertFace, sheetConvertCandidate, type SheetConvertFace } from './sheetConvertDraft.js';
import { evaluateSheetDraft, sheetSourceLengthUnit } from './sheetDraft.js';
import { SHEET_FIELD_DEFINITIONS, sheetFieldValues, type SheetFieldKey } from './sheetFields.js';
import { sheetHelpTopic } from './sheetHelpTopic.js';
import { SHEET_DEFAULT_KEYS } from './sheetMetalDefaultSources.js';
import './sheetMetal.css';

function initialRule(editing: SheetConvertFeature | undefined): SheetConvertFeature['rule'] {
  if (editing !== undefined) return editing.rule;
  const rule = defaultSheetMetalRule();
  return { innerRadius: rule.innerRadius, kFactor: rule.kFactor };
}

export function SheetConvertPanel({ session }: { readonly session: SheetMetalToolSession }): React.JSX.Element {
  const editing = session.editingFeature?.kind === 'sheetConvert' ? session.editingFeature : undefined;
  const document = useAppStore((state) => state.document);
  const selection = useAppStore((state) => state.selection);
  const bodies = useAppStore((state) => state.bodies);
  const computing = useAppStore((state) => state.isComputing);
  const requested = useAppStore((state) => state.sheetMetalRequestId !== null);
  const preview = useAppStore((state) => state.sheetMetalPreview);
  const computeError = useAppStore((state) => state.sheetMetalError);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const [sources, setSources] = useState<Partial<Record<SheetFieldKey, string>>>(() => ({ ...(session.defaultSources ?? {}) }));
  const [millimetreSourceKeys, setMillimetreSourceKeys] = useState<ReadonlySet<SheetFieldKey>>(() => new Set(SHEET_DEFAULT_KEYS));
  const [invalidField, setInvalidField] = useState<SheetFieldKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const picked = selectedConvertFace(selection, bodies, editing?.id);
  // 編集の時は元の立体が消費されていて面を選べないので、選び直さなければ保存した基準の面を使う。
  const face: Extract<SheetConvertFace, { ok: true }> | null = picked.ok ? picked
    : editing === undefined ? null : { ok: true, sourceFeatureId: editing.sourceFeatureId, face: editing.referenceFace };
  const draft = face === null ? null : sheetConvertCandidate(document, face, initialRule(editing), editing).feature;
  const sourceName = face === null ? '' : document.solids.find((feature) => feature.id === face.sourceFeatureId)?.name ?? face.sourceFeatureId;
  const submit = (commit: boolean) => {
    const state = useAppStore.getState();
    if (state.sheetMetalTool !== session || state.activeDocumentId !== session.documentId || state.document !== session.document
      || state.assembly !== null || state.drawing !== null || state.isComputing || face === null || draft === null) return;
    const options = { variables: state.parameterAnalysis.variables, exactVariables: state.parameterAnalysis.exactVariables,
      nonLengthVariables: state.nonLengthVariables, pendingVariables: pendingFieldVariables(state) };
    const evaluated = evaluateSheetDraft(draft, sources, lengthUnit, options, millimetreSourceKeys);
    if (!evaluated.ok) { setMessage(evaluated.message); setInvalidField(evaluated.field ?? null); return; }
    if (evaluated.feature.kind !== 'sheetConvert') return;
    void applySheetCreation(session, sheetConvertCandidate(state.document, face, evaluated.feature.rule, editing), commit);
  };
  return <form className="pcad-section pcad-sheet-metal" aria-label={t('sheetMetal.convert')} data-help-topic={sheetHelpTopic(session.kind)}
    onSubmit={(event) => { event.preventDefault(); submit(true); }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().closeSheetMetalTool(); }
    }}>
    <h3>{t('sheetMetal.convert')}{editing === undefined ? '' : ` — ${t('sheetMetal.editing')}`}</h3>
    <p>{t('sheetMetal.convertHint')}</p>
    <p role="status">{face === null ? t(picked.ok ? 'sheetMetal.convertNeedFace' : picked.messageKey)
      : t('sheetMetal.convertSource').replace('{name}', sourceName)}</p>
    {draft === null ? null : sheetFieldValues(draft).map(([key, value]) => {
      const definition = SHEET_FIELD_DEFINITIONS[key];
      return <label className="pcad-field" key={key}><span>{t(definition.labelKey)}</span>
        <input type="text" className={`pcad-field__input${invalidField === key ? ' pcad-field__input--error' : ''}`} aria-invalid={invalidField === key}
          value={sources[key] ?? value.source} title={t(definition.tooltipKey)}
          onChange={(event) => { useAppStore.getState().clearSheetMetalPreview(); setSources({ ...sources, [key]: event.target.value });
            setMillimetreSourceKeys(previous => new Set([...previous].filter(item => item !== key)));
            setMessage(null); setInvalidField(null); }} />
        <span>{t(fieldUnitLabelKey(definition.unit, sheetSourceLengthUnit(key, lengthUnit, millimetreSourceKeys)))}</span></label>;
    })}
    <p>{t('sheetMetal.convertRadiusHint')}</p>
    <p>{t('sheetMetal.kFactorHint')}</p>
    {message === null ? null : <p role="alert" className="pcad-field__error">{message}</p>}
    {computeError === null ? null : <p role="alert" className="pcad-field__error">{computeError}</p>}
    {requested ? <p role="status">{t('sheetMetal.computing')}</p> : preview?.session !== session ? null : <p role="status" title={formatVolume(preview.volume)}>
      {t('sheetMetal.previewHint')} {t('sheetMetal.previewVolume').replace('{volume}', formatVolume(preview.volume, 'mm', (value) => displayNumber(value).text))}</p>}
    <button className="pcad-button" type="button" title={t('sheetMetal.guide.preview')} disabled={draft === null || computing || requested} onClick={() => submit(false)}>{t('sheetMetal.preview')}</button>
    <div className="pcad-sheet-metal__actions"><button className="pcad-button pcad-button--primary" type="submit" title={t('sheetMetal.guide.commit')} disabled={draft === null || computing || requested}>{t(editing === undefined ? 'sheetMetal.create' : 'sheetMetal.applyEdit')}</button>
      <button className="pcad-button" type="button" title={t('sheetMetal.guide.cancel')} onClick={() => useAppStore.getState().closeSheetMetalTool()}>{t('sheetMetal.cancel')}</button></div>
  </form>;
}
