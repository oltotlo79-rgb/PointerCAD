import { findStrengthMaterial, STRENGTH_MATERIALS, STRENGTH_SOURCES } from '@pointercad/model';
import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import type { StrengthSource } from '@pointercad/model';
import { useEffect, useRef, useState } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { selectSolidMaterial, solidMaterialCapacityMatches, solidMaterialDraftOf, solidMaterialSourceUrl } from './solidMaterialSelection.js';
import type { SolidMaterialDraft, SolidMaterialIssue } from './solidMaterialSelection.js';

const EVIDENCE = { 'supplier-excerpt': 'solidAnalysis.material.evidence.supplier',
  'manufacturer-reference': 'solidAnalysis.material.evidence.manufacturer', 'measured-reference': 'solidAnalysis.material.evidence.measured',
  'standard-draft': 'solidAnalysis.material.evidence.draft' } as const satisfies Readonly<Record<StrengthSource['evidence'], string>>;
const BASIS = { minimum: 'solidAnalysis.material.basis.minimum', reference: 'solidAnalysis.material.basis.reference' } as const satisfies Readonly<Record<AnalysisMaterialCapacity['basis'], string>>;
const ISSUES = { material: 'solidAnalysis.material.issue.material', thickness: 'solidAnalysis.material.issue.thickness',
  outside: 'strength.error.thickness', source: 'solidAnalysis.material.issue.source' } as const satisfies Readonly<Record<SolidMaterialIssue, string>>;
export interface SolidAnalysisMaterialFieldsProps {
  readonly value: AnalysisMaterialCapacity | null;
  /** Changes for another document/opening, including null → null. */
  readonly selectionKey: string;
  readonly onChange: (capacity: AnalysisMaterialCapacity | null, valid: boolean) => void;
  readonly disabled?: boolean;
}
interface DraftState extends SolidMaterialDraft { readonly base: AnalysisMaterialCapacity | null }

function MaterialFields({ value, onChange, disabled = false }: SolidAnalysisMaterialFieldsProps): React.JSX.Element {
  const [local, setLocal] = useState<DraftState>(() => ({ base: value, ...solidMaterialDraftOf(value) }));
  const composing = useRef(false);
  // Parent acknowledgements retain unfinished text; a different saved value replaces it immediately.
  const draft = local.base === value ? local : { base: value, ...solidMaterialDraftOf(value) };
  const current = useRef<SolidMaterialDraft>(draft);
  current.current = draft;
  const selection = selectSolidMaterial(draft);
  const valid = selection.ok && (selection.capacity === null ? value === null : solidMaterialCapacityMatches(value));
  const notified = useRef<{ readonly value: AnalysisMaterialCapacity | null; readonly valid: boolean } | null>(null);
  const notify = (capacity: AnalysisMaterialCapacity | null, ready: boolean): void => {
    notified.current = { value: capacity, valid: ready }; onChange(capacity, ready);
  };
  useEffect(() => {
    const ready = valid && !composing.current;
    if (notified.current?.value !== value || notified.current.valid !== ready) {
      if (!ready) setLocal({ ...current.current, base: null });
      notified.current = { value, valid: ready }; onChange(ready ? value : null, ready);
    }
  }, [valid, value, onChange]);
  const change = (next: SolidMaterialDraft): void => {
    if (disabled) return;
    const selected = selectSolidMaterial(next);
    const capacity = !disabled && !composing.current && selected.ok ? selected.capacity : null;
    current.current = next;
    setLocal({ ...next, base: capacity });
    notify(capacity, !composing.current && selected.ok);
  };
  const preset = findStrengthMaterial(draft.materialConditionId);
  const source = preset === undefined ? undefined : STRENGTH_SOURCES[preset.yieldStress.sourceId];
  const url = source === undefined ? null : solidMaterialSourceUrl(source);
  const range = preset?.thicknessMm;
  const problem = !selection.ok ? t(ISSUES[selection.issue]) : !valid ? t('solidAnalysis.material.stale') : null;
  return <fieldset disabled={disabled} data-testid="solid-material-fields"
    onCompositionStart={() => { composing.current = true; setLocal({ ...current.current, base: null }); notify(null, false); }}
    onCompositionEnd={() => { composing.current = false; change(current.current); }}
    onKeyDown={event => {
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'Enter' || composing.current || isCompositionKey(event.nativeEvent)) event.stopPropagation();
    }}>
    <legend>{t('strength.material')}</legend>
    <p>{t('solidAnalysis.material.independentElastic')}</p>
    <label>{t('strength.material')}
      <select data-testid="solid-material-condition" value={draft.materialConditionId} title={t('strength.guide.material')}
        onChange={event => { change({ ...draft, materialConditionId: event.target.value }); }}>
        <option value="">{t('solidAnalysis.material.unselected')}</option>
        {STRENGTH_MATERIALS.map(material => <option key={material.id} value={material.id}>
          {`${material.grade} — ${material.condition}${material.thicknessPrinted ? ` (${material.thicknessPrinted} mm)` : ''}`}
        </option>)}
      </select></label>
    <label>{t('strength.productThickness')} (mm)
      <input type="text" inputMode="decimal" data-testid="solid-material-thickness" value={draft.thickness}
        aria-invalid={problem !== null} title={t('strength.productThickness')}
        onChange={event => { change({ ...draft, thickness: event.target.value }); }} /></label>
    {problem === null ? null : <p role="alert">{problem}</p>}
    {preset === undefined || source === undefined ? null : <section aria-label={t('strength.source')}>
      <p>{`${preset.grade} — ${preset.condition}`}</p>
      <p>{range == null ? t('solidAnalysis.material.thicknessUnspecified')
        : `${range.greaterThan} ${range.lowerInclusive ? '≤' : '<'} t ≤ ${range.atMost} mm`}</p>
      <p>{t('strength.materialScope')}</p>
      <p>{t('solidAnalysis.material.temperatureUnspecified')}</p>
      <p>{`${t('strength.field.yieldStress')}: ${preset.yieldStress.mpa} MPa (${t(BASIS[preset.yieldStress.basis])})`}</p>
      <p>{t(EVIDENCE[source.evidence])}</p>
      <p>{source.publisher}</p><p>{source.locator}</p>
      <p>{source.standard}</p><p>{source.standardEdition ?? t('strength.unknownEdition')}</p>
      <p>{`${t('solidAnalysis.material.checkedDate')}: ${source.checkedDate}`}</p>
      <p>{`${t('solidAnalysis.material.sourceDigest')}: ${source.sha256}`}</p>
      {url === null ? null : <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>}
    </section>}
  </fieldset>;
}

/** No submit/run control. The parent owns analysis state and must enforce the validity callback. */
export function SolidAnalysisMaterialFields(props: SolidAnalysisMaterialFieldsProps): React.JSX.Element {
  return <MaterialFields key={props.selectionKey} {...props} />;
}
