import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { buildSteelStockList, STEEL_EVIDENCE, steelSectionCatalogs,
  type FastenerDimensionSeries, type ThreadSeries,
  type SteelProduct, type SteelSectionCatalog } from '@pointercad/model';
import { useEffect, useRef, useState } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { SteelBendEditForm, SteelBendFields } from './SteelBendFields.js';
import { beginSteelBendPlacement, buildSteelBendChoice, DEFAULT_STEEL_BEND_SOURCES,
  selectedSteelBendEditTarget, type SteelBendEditTarget, type SteelBendSources } from './steelBendPicker.js';
import { useAppStore } from '../store/useAppStore.js';
import { exportSteelStockCsv, steelStockIssueText } from './steelStockCsvExport.js';
import { placeEditableSteelBend, placeEditableSteelPart, type EditableSteelPlacementOutcome } from './steelEditablePart.js';
import {
  commitStandardPartChoice, DEFAULT_STANDARD_PART_PICKER, defaultStandardPartChoice,
  findStandardPartChoice, STANDARD_PART_CATEGORIES, standardPartChoices,
  standardPartUsesDimensionSeries, standardPartUsesThreadSeries, structuralPartChoices,
  STRUCTURAL_MATERIAL_CHOICES, type StructuralMaterialChoice, type StandardPartCategory,
  steelPartDimensionGroups, steelPartChoiceAtDimension,
} from './standardPartPicker.js';

const CATEGORY_LABELS: Readonly<Record<StandardPartCategory, Parameters<typeof t>[0]>> = {
  hexBolt: 'assembly.standardPart.hexBolt',
  hexNut: 'assembly.standardPart.hexNut',
  plainWasher: 'assembly.standardPart.plainWasher',
  springWasher: 'assembly.standardPart.springWasher',
  socketHeadCapScrew: 'assembly.standardPart.socketHeadCapScrew',
  panHeadScrew: 'assembly.standardPart.panHeadScrew',
  deepGrooveBallBearing: 'assembly.standardPart.deepGrooveBallBearing',
  structuralSection: 'assembly.standardPart.structuralSection',
};

const STEEL_SHAPE_LABELS: Readonly<Record<SteelSectionCatalog, Parameters<typeof t>[0]>> = {
  flatBar: 'assembly.steel.flatBar', roundBar: 'assembly.steel.roundBar',
  steelPipe: 'assembly.steel.steelPipe', equalAngle: 'assembly.steel.equalAngle',
  channel: 'assembly.steel.channel', hBeam: 'assembly.steel.hBeam',
};
const STEEL_CONDITION_LABELS = {
  'hotRolled-heatTreatmentUnspecified': 'assembly.steel.hotRolled',
  'brightBar-heatTreatmentUnspecified': 'assembly.steel.brightBar',
  'blackPipe-plainEnds': 'assembly.steel.blackPipe',
  'whitePipe-zincCoated': 'assembly.steel.whitePipe',
} as const;
type EditableMessage = Exclude<EditableSteelPlacementOutcome, 'placing' | 'invalidLength' | 'unknownChoice'>;
const EDITABLE_MESSAGES: Readonly<Record<EditableMessage, Parameters<typeof t>[0]>> = {
  busy: 'assembly.steel.editable.busy', cancelled: 'assembly.steel.editable.cancelled',
  failed: 'assembly.steel.editable.failed', notSteelStock: 'assembly.steel.editable.notSteelStock',
  unavailable: 'assembly.steel.editable.unavailable',
};

function categoryFrom(value: string): StandardPartCategory | null {
  return STANDARD_PART_CATEGORIES.find((category) => category === value) ?? null;
}

const STANDARD_VERIFICATION_LABELS = {
  draft: 'assembly.steel.standardDraft', 'final-standard': 'assembly.steel.standardFinal',
  unverified: 'assembly.steel.standardUnverified',
} as const;

/** Display-only ledger notes; producer editions and saved product standard strings stay separate. */
export function SteelStandardEditionNote({ standardEdition }: {
  readonly standardEdition: SteelProduct['standardEdition'];
}): React.JSX.Element {
  return <>{(['material', 'dimensions'] as const).map((kind) => {
    const standard = standardEdition[kind];
    return <p key={kind}>
      {t(kind === 'material' ? 'assembly.steel.materialStandardEdition' : 'assembly.steel.dimensionStandardEdition')}
      {' '}{standard.number}:{standard.edition || t('assembly.steel.standardUnverified')}
      {' / '}{t(STANDARD_VERIFICATION_LABELS[standard.verification])}
      <br /><span>{standard.verificationNote}</span>
    </p>;
  })}</>;
}

/** Non-modal picker that keeps the last choice so Enter can place repeated parts. */
export function StandardPartPicker(): React.JSX.Element | null {
  const open = useAppStore((state) => state.standardPartPickerOpen);
  const assembly = useAppStore((state) => state.assembly);
  const library = useAppStore((state) => state.assemblyLibrary);
  const selection = useAppStore((state) => state.selection);
  const [category, setCategory] = useState(DEFAULT_STANDARD_PART_PICKER.category);
  const [choiceKey, setChoiceKey] = useState(DEFAULT_STANDARD_PART_PICKER.choiceKey);
  const [lengthSource, setLengthSource] = useState(DEFAULT_STANDARD_PART_PICKER.lengthSource);
  const [dimensionSeries, setDimensionSeries] = useState<FastenerDimensionSeries>(
    DEFAULT_STANDARD_PART_PICKER.dimensionSeries,
  );
  const [threadSeries, setThreadSeries] = useState<ThreadSeries>(
    DEFAULT_STANDARD_PART_PICKER.threadSeries,
  );
  const [bendEnabled, setBendEnabled] = useState(false);
  const [bendSources, setBendSources] = useState<SteelBendSources>(DEFAULT_STEEL_BEND_SOURCES);
  const [bendPlacementError, setBendPlacementError] = useState(false);
  const [editable, setEditable] = useState(false);
  const [editableMessage, setEditableMessage] = useState<EditableMessage | null>(null);
  const [steelMaterial, setSteelMaterial] = useState<StructuralMaterialChoice>('SS400');
  const [steelShape, setSteelShape] = useState<SteelSectionCatalog>('flatBar');
  const [error, setError] = useState<'unknownChoice' | 'invalidLength' | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  const composing = useRef(false);
  const compositionKey = useRef(false);
  const pendingCsv = useRef<AbortController | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState('');
  const [csvStatus, setCsvStatus] = useState('');
  const [stockOpen, setStockOpen] = useState(false);
  const [bendEdit, setBendEdit] = useState<SteelBendEditTarget | null>(null);

  useEffect(() => {
    composing.current = false;
    compositionKey.current = false;
    if (open) first.current?.focus();
    else setBendEdit(null);
  }, [open]);
  useEffect(() => () => {
    const pending = pendingCsv.current;
    pendingCsv.current = null;
    pending?.abort();
  }, []);
  useEffect(() => {
    if (!open || category !== 'structuralSection') pendingCsv.current?.abort();
    setCsvError('');
    setCsvStatus('');
  }, [open, category, assembly, library]);

  if (!open) return null;
  if (bendEdit !== null) return <SteelBendEditForm target={bendEdit} onClose={() => {
    setBendEdit(null); useAppStore.getState().closeStandardPartPicker();
  }} />;
  const selectedBend = selectedSteelBendEditTarget({ ...useAppStore.getState(), assembly, assemblyLibrary: library, selection });
  const isSteel = category === 'structuralSection';
  const stock = isSteel && stockOpen && assembly !== null
    ? buildSteelStockList(assembly, library.assemblies, library.parts) : null;
  const shapes = steelMaterial === 'unspecified' ? [] : steelSectionCatalogs(steelMaterial);
  const activeShape = shapes.includes(steelShape) ? steelShape : shapes[0];
  const choices = isSteel ? structuralPartChoices(steelMaterial, activeShape)
    : standardPartChoices(category, dimensionSeries);
  const choice = choices.find((candidate) => candidate.key === choiceKey)
    ?? (isSteel ? choices[0] : findStandardPartChoice(category, choiceKey, dimensionSeries)
      ?? defaultStandardPartChoice(category, dimensionSeries));
  const steel = choice?.steelProduct;
  if (choice === undefined) return null;
  const dimensionGroups = isSteel ? steelPartDimensionGroups(choices) : null;
  const dimensionGroup = dimensionGroups?.groups.find((group) => group.choices.some((item) => item.key === choice.key));
  const sizeField = <label className="pcad-field">
    <span className="pcad-field__label">{t('assembly.standardPart.size')}</span>
    <select title={t('assembly.guide.standardSize')} className="pcad-field__input" value={choice.key}
      onChange={(event) => {
        if (choices.some((item) => item.key === event.currentTarget.value)) {
          setChoiceKey(event.currentTarget.value); setError(null);
        }
      }}>
      {choices.map((item) => (
        <option key={item.key} value={item.key}>
          {item.size}{item.verified ? '' : ` ${t('assembly.standardPart.unverifiedShort')}`}
        </option>
      ))}
    </select>
    {steel?.catalog !== 'steelPipe' ? null : <span className="pcad-popover__hint">
      {t('assembly.steel.pipeDimensions')
        .replace('{diameter}', String(steel.dimensions?.outsideDiameter))
        .replace('{thickness}', String(steel.dimensions?.wallThickness))}
    </span>}
  </label>;

  const bending = isSteel && steel !== undefined && bendEnabled;
  const bend = bending ? buildSteelBendChoice(steel, bendSources) : null;
  // A new editable part file from the same source as 置く; existing placements are never converted.
  const editing = isSteel && steel !== undefined && editable && !bending;
  const submit = (): void => {
    if (bending) {
      if (bend?.ok !== true) return;
      if (!editable) { setBendPlacementError(!beginSteelBendPlacement(bend)); return; }
      setEditableMessage(null);
      void placeEditableSteelBend(bend).then((outcome) => { if (outcome !== 'placing') setEditableMessage(outcome); });
      return;
    }
    if (editing) {
      setEditableMessage(null);
      void placeEditableSteelPart(choice.key, lengthSource).then((outcome) => {
        if (outcome === 'invalidLength' || outcome === 'unknownChoice') setError(outcome);
        else if (outcome !== 'placing') setEditableMessage(outcome);
      });
      return;
    }
    const result = commitStandardPartChoice(
      category, choice.key, lengthSource, dimensionSeries, threadSeries,
    );
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    if (useAppStore.getState().placeStandardPart(
      category, choice.key, lengthSource, dimensionSeries, threadSeries,
    )) setError(null);
  };

  return (
    <form className="pcad-popover pcad-popover--standard-part" role="dialog"
      aria-label={t('assembly.standardPart.title')}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onPointerDownCapture={() => { compositionKey.current = false; }}
      onSubmit={(event) => {
        event.preventDefault();
        // The confirming Enter may submit after compositionend; only a new key/pointer clears it.
        if (!composing.current && !compositionKey.current) submit();
      }}
      onKeyDown={(event) => {
        compositionKey.current = composing.current || isCompositionKey(event.nativeEvent);
        if (compositionKey.current || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        useAppStore.getState().closeStandardPartPicker();
      }}>
      <DraggableWindowTitle className="pcad-popover__title">{t('assembly.standardPart.title')}</DraggableWindowTitle>
      {selectedBend === null ? null : <button type="button" className="pcad-button"
        title={t('assembly.steel.bend.reedit.entryGuide')} onClick={() => { setBendEdit(selectedBend); }}>
        {t('assembly.steel.bend.reedit.entry')}</button>}
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.category')}</span>
          <select title={t('assembly.guide.standardCategory')} ref={first} className="pcad-field__input" value={category}
            onChange={(event) => {
              const next = categoryFrom(event.currentTarget.value);
              if (next === null) return;
              setCategory(next);
              setChoiceKey(defaultStandardPartChoice(next, dimensionSeries).key);
              setLengthSource(next === 'structuralSection' ? '1000' : '30');
              setError(null);
            }}>
            {STANDARD_PART_CATEGORIES.map((item) => (
              <option key={item} value={item}>{t(CATEGORY_LABELS[item])}</option>
            ))}
          </select>
        </label>
        {isSteel ? <>
          <label className="pcad-field">
            <span className="pcad-field__label">{t('assembly.steel.material')}</span>
            <select className="pcad-field__input" title={t('assembly.steel.materialGuide')} value={steelMaterial}
              onChange={(event) => {
                const next = STRUCTURAL_MATERIAL_CHOICES.find((item) => item === event.currentTarget.value);
                if (next === undefined) return;
                const shape = next === 'unspecified' ? undefined : steelSectionCatalogs(next)[0];
                setSteelMaterial(next);
                if (shape !== undefined) setSteelShape(shape);
                setChoiceKey(structuralPartChoices(next, shape)[0].key);
                setError(null);
              }}>
              {STRUCTURAL_MATERIAL_CHOICES.map((item) => <option key={item} value={item}>
                {item === 'unspecified' ? t('assembly.steel.unspecified') : item}
              </option>)}
            </select>
          </label>
          {steelMaterial === 'unspecified' ? null : <label className="pcad-field">
            <span className="pcad-field__label">{t('assembly.steel.shape')}</span>
            <select className="pcad-field__input" title={t('assembly.steel.shapeGuide')} value={activeShape}
              onChange={(event) => {
                const next = shapes.find((item) => item === event.currentTarget.value);
                if (next === undefined) return;
                setSteelShape(next);
                setChoiceKey(structuralPartChoices(steelMaterial, next)[0].key);
                setError(null);
              }}>
              {shapes.map((item) => <option key={item} value={item}>{t(STEEL_SHAPE_LABELS[item])}</option>)}
            </select>
          </label>}
        </> : null}
        {standardPartUsesDimensionSeries(category) ? (
          <label className="pcad-field">
            <span className="pcad-field__label">{t('assembly.standardPart.dimensionSeries')}</span>
            <select title={t('assembly.guide.standardDimensions')} className="pcad-field__input" value={dimensionSeries}
              onChange={(event) => {
                const next: FastenerDimensionSeries = event.currentTarget.value === 'main'
                  ? 'main' : 'annexJA';
                setDimensionSeries(next);
                setChoiceKey(defaultStandardPartChoice(category, next).key);
                setError(null);
              }}>
              <option value="annexJA">{t('assembly.standardPart.dimensionSeries.annexJA')}</option>
              <option value="main">{t('assembly.standardPart.dimensionSeries.main')}</option>
            </select>
          </label>
        ) : null}
        {standardPartUsesThreadSeries(category) ? (
          <label className="pcad-field">
            <span className="pcad-field__label">{t('assembly.standardPart.threadSeries')}</span>
            <select title={t('assembly.guide.standardThread')} className="pcad-field__input" value={threadSeries}
              onChange={(event) => {
                setThreadSeries(event.currentTarget.value === 'fine' ? 'fine' : 'coarse');
                setError(null);
              }}>
              <option value="coarse">{t('assembly.standardPart.threadSeries.coarse')}</option>
              <option value="fine">{t('assembly.standardPart.threadSeries.fine')}</option>
            </select>
          </label>
        ) : null}
        {dimensionGroups === null || dimensionGroup === undefined ? sizeField : <>
          <label className="pcad-field">
            <span className="pcad-field__label">{t(dimensionGroups.dimension === 'thickness'
              ? 'assembly.steel.selectThickness' : 'assembly.steel.selectDiameter')}</span>
            <select className="pcad-field__input" value={String(dimensionGroup.value)}
              title={t(dimensionGroups.dimension === 'thickness'
                ? 'assembly.steel.selectThicknessGuide' : 'assembly.steel.selectDiameterGuide')}
              onChange={(event) => {
                const next = steelPartChoiceAtDimension(choices, choice.key, event.currentTarget.value);
                if (next === undefined) return;
                setChoiceKey(next.key); setError(null);
              }}>
              {dimensionGroups.groups.map((group) => <option key={group.value} value={String(group.value)}>
                {group.value} mm
              </option>)}
            </select>
          </label>
          <label className="pcad-field">
            <span className="pcad-field__label">{t(dimensionGroups.dimension === 'thickness'
              ? 'assembly.steel.selectWidth' : 'assembly.standardPart.size')}</span>
            <select className="pcad-field__input" value={choice.key} title={t('assembly.steel.selectWidthGuide')}
              onChange={(event) => {
                if (!dimensionGroup.choices.some((item) => item.key === event.currentTarget.value)) return;
                setChoiceKey(event.currentTarget.value); setError(null);
              }}>
              {dimensionGroup.choices.map((item) => <option key={item.key} value={item.key}>
                {dimensionGroups.dimension === 'thickness' ? `${item.steelProduct?.dimensions?.width} mm` : item.size}
                {item.steelProduct !== undefined && dimensionGroup.choices.some((other) => other.key !== item.key
                  && other.size === item.size) ? ` / ${t(STEEL_CONDITION_LABELS[item.steelProduct.condition])}` : ''}
              </option>)}
            </select>
          </label>
          <details className="pcad-popover__hint">
            <summary>{t('assembly.steel.allSizes')}</summary>
            {sizeField}
          </details>
        </>}
        {steel === undefined ? null : <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.steel.bend.enable')}</span>
          <input type="checkbox" checked={bendEnabled} title={t('assembly.steel.bend.enableGuide')}
            onChange={(event) => { setBendEnabled(event.currentTarget.checked); setBendPlacementError(false); }} />
        </label>}
        {steel === undefined ? null : <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.steel.editable.enable')}</span>
          <input type="checkbox" checked={editable} title={t('assembly.steel.editable.enableGuide')}
            onChange={(event) => { setEditable(event.currentTarget.checked); setEditableMessage(null); }} />
        </label>}
        {bending ? <SteelBendFields sources={bendSources} result={bend}
          onChange={(next) => { setBendSources(next); setBendPlacementError(false); }} /> : null}
        {choice.requiresLength && !bending ? (
          <label className={'pcad-field' + (error === 'invalidLength' ? ' pcad-field--error' : '')}>
            <span className="pcad-field__label">{t('assembly.standardPart.length')}</span>
            <input title={t('assembly.guide.standardLength')} className="pcad-field__input" value={lengthSource}
              aria-invalid={error === 'invalidLength' ? true : undefined}
              onChange={(event) => { setLengthSource(event.currentTarget.value); setError(null); }} />
            <span className="pcad-field__unit">mm</span>
          </label>
        ) : null}
      </div>
      {isSteel && steelMaterial === 'unspecified' ? <p className="pcad-popover__hint" role="status">
        {t('assembly.steel.unspecifiedHint')}
      </p> : null}
      {steel === undefined ? null : (
        <div className="pcad-popover__hint" role="status">
          <p>{steel.materialStandard} / {steel.evidence === 'flat' && steel.materialGrade === 'SS400'
            ? t('assembly.steel.producerFlatDimensions') : steel.productStandard}</p>
          <SteelStandardEditionNote standardEdition={steel.standardEdition} />
          <p>{t(STEEL_CONDITION_LABELS[steel.condition])}</p>
          <p>{t(steel.geometry === 'simplifiedSection'
            ? 'assembly.steel.simplified' : steel.geometry === 'profileSection'
              ? 'assembly.steel.profile' : 'assembly.steel.nominal')}</p>
          <p>{t('assembly.steel.lengthBounds')}</p>
          <p>{t('assembly.steel.catalogLengths')} {steel.standardLengthsMm.length === 0
            ? t('assembly.steel.unknownLength') : `${steel.standardLengthsMm.join(' / ')} mm`}</p>
          <a href={STEEL_EVIDENCE[steel.evidence].url} target="_blank" rel="noreferrer"
            title={STEEL_EVIDENCE[steel.evidence].locator}>{STEEL_EVIDENCE[steel.evidence].title}</a>
          {steel.materialEvidence === undefined ? null : <p>
            <a href={STEEL_EVIDENCE[steel.materialEvidence].url} target="_blank" rel="noreferrer"
              title={STEEL_EVIDENCE[steel.materialEvidence].locator}>{t('assembly.steel.gradeSource')}</a>
          </p>}
          {steel.profileEvidence === undefined ? null : <p>
            <a href={steel.profileEvidence.url} target="_blank" rel="noreferrer"
              title={steel.profileEvidence.locator}>{t('assembly.steel.profileSource')}</a>
          </p>}
          <p>{t('assembly.steel.referenceOnly')}</p>
        </div>
      )}
      {!isSteel || assembly === null ? null : (
        <details className="pcad-popover__hint" open={stockOpen}
          onToggle={(event) => { setStockOpen(event.currentTarget.open); }}>
          <summary>{t('assembly.steel.stockList')}</summary>
          {stock === null ? null : <>
          <p>{t('assembly.steel.stockScope')}</p>
          {stock.issues.length === 0 ? null : <p role="status">{t('assembly.steel.stockPartial')}</p>}
          {stock.rows.length === 0 ? <p>{t('assembly.steel.stockEmpty')}</p> : (
            <div className="pcad-bom__scroll"><table className="pcad-bom__table">
              <thead><tr>
                <th scope="col">{t('assembly.steel.material')}</th>
                <th scope="col">{t('assembly.standardPart.size')}</th>
                <th scope="col">{t('assembly.steel.stockLength')} (mm)</th>
                <th scope="col">{t('assembly.steel.finishedLength')} (mm)</th>
                <th scope="col">{t('assembly.steel.quantity')}</th>
                <th scope="col">{t('assembly.steel.totalLength')} (mm)</th>
                <th scope="col">{t('assembly.steel.csv.catalogRevision')}</th>
                <th scope="col">{t('assembly.steel.csv.generatorRevision')}</th>
              </tr></thead>
              <tbody>{stock.rows.map((row) => <tr key={row.key}>
                <td>{row.product.materialGrade}</td><td>{row.product.size}</td>
                <td>{row.lengthMm}</td><td>{row.finishedLengthMm ?? t('assembly.steel.finishedUnknown')}</td><td>{row.quantity}</td><td>{row.totalLengthMm}</td>
                <td>{row.catalogRevision}</td><td>{row.generatorRevision}</td>
              </tr>)}</tbody>
              <tfoot><tr>
                <th scope="row" colSpan={4}>{t('assembly.steel.stockTotal')}</th>
                <td>{stock.totalQuantity}</td><td colSpan={3}>{stock.totalLengthMm}</td>
              </tr></tfoot>
            </table></div>
          )}
          {stock.issues.length === 0 ? null : <ul>
            {stock.issues.map((issue, index) => <li key={index}>
              {issue.occurrenceNames.join(' › ')}: {steelStockIssueText(issue)}
            </li>)}
          </ul>}
          <button type="button" className="pcad-button" disabled={csvBusy}
            title={t('assembly.steel.csv.exportGuide')} onClick={() => {
              if (assembly !== null) void exportSteelStockCsv({ pending: pendingCsv, assembly, library,
                busy: setCsvBusy, error: setCsvError, status: setCsvStatus });
            }}>{t('assembly.steel.csv.export')}</button>
          {csvBusy ? <p role="status">{t('assembly.steel.csv.busy')}
            <button type="button" className="pcad-button" title={t('assembly.steel.csv.cancelGuide')}
              onClick={() => pendingCsv.current?.abort()}>{t('assembly.steel.csv.cancel')}</button>
          </p> : null}
          {csvError === '' ? null : <p role="alert">{csvError}</p>}
          {csvStatus === '' ? null : <p role="status">{csvStatus}</p>}
          </>}
        </details>
      )}
      {!choice.verified ? (
        <p className="pcad-popover__hint" role="status">
          {t('assembly.standardPart.unverified').replace('{reason}', choice.note)}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="pcad-field__message" role="alert">
          {t(error === 'invalidLength'
            ? (steel === undefined ? 'assembly.standardPart.invalidLength' : 'assembly.steel.invalidLength')
            : 'assembly.standardPart.unknownChoice')}
        </p>
      )}
      {bendPlacementError && bending ? <p role="alert">{t('assembly.steel.bend.unavailable')}</p> : null}
      {editing || (bending && editable) ? <p className="pcad-popover__hint">{t('assembly.steel.editable.hint')}</p> : null}
      {(editing || (bending && editable)) && editableMessage !== null ? <p role={editableMessage === 'cancelled' ? 'status' : 'alert'}>
        {t(EDITABLE_MESSAGES[editableMessage])}</p> : null}
      <p className="pcad-popover__hint">{t('assembly.standardPart.hint')}</p>
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button pcad-button--action"
          disabled={bending && bend?.ok !== true}
          title={t(bending ? 'assembly.steel.bend.enableGuide'
            : editing ? 'assembly.steel.editable.enableGuide' : 'assembly.guide.standardPlace')}>
          {t(bending ? 'assembly.steel.bend.place'
            : editing ? 'assembly.steel.editable.place' : 'assembly.standardPart.place')}
        </button>
        <button type="button" className="pcad-button" title={t('assembly.guide.standardCancel')}
          onClick={() => { useAppStore.getState().closeStandardPartPicker(); }}>
          {t('assembly.standardPart.close')}
        </button>
      </div>
    </form>
  );
}
