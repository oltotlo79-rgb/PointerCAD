import { findStrengthMaterial, strengthCalculationFields } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { STRENGTH_FIELD_LABELS } from './strengthFields.js';
import { StrengthMaterialSource } from './StrengthMaterialFields.js';
import { strengthResultRows } from './strengthResultView.js';
import type { StrengthSnapshot } from './strengthSession.js';

export function StrengthResults({ snapshot, edited }: { readonly snapshot: StrengthSnapshot; readonly edited: boolean }): React.JSX.Element {
  const preset = findStrengthMaterial(snapshot.materialId);
  const rows = strengthResultRows(snapshot);
  return <section className="pcad-strength__results" aria-label={t('strength.result')}>
    <h4>{t('strength.result')}</h4>
    {edited ? <p role="status">{t('strength.previousResult')}</p> : null}
    <p>{t('strength.snapshot')}</p>
    <p role="status" className={snapshot.value.meetsSpecifiedFactor ? 'pcad-strength__assessment' : 'pcad-strength__assessment pcad-strength__assessment--below'}>
      {t(snapshot.value.meetsSpecifiedFactor ? 'strength.meets' : 'strength.below')}
    </p>
    <p>{t(snapshot.value.criterion === 'von-mises' ? 'strength.misesCriterion' : 'strength.normalCriterion')}</p>
    <dl className="pcad-properties">{rows.map(row => <div key={row.name}>
      <dt className="pcad-properties__key">{row.label}</dt>
      <dd className="pcad-properties__value" data-strength-result={row.name} title={row.exact}>{row.display}</dd>
    </div>)}</dl>
    <details><summary>{t('strength.inputs')}</summary>
      {preset?.thicknessMm == null ? null : <p>{t('strength.productThickness')}: {snapshot.productThicknessSource}</p>}
      {snapshot.materialValuesEdited ? <p>{t('strength.customValues')}</p> : null}
      {strengthCalculationFields(snapshot.value.calculation).map(([name]) => {
        const input = snapshot.value.inputs.get(name);
        return <p key={name}>{t(STRENGTH_FIELD_LABELS[name])}: {input?.source} = {input?.canonical.exact}</p>;
      })}
      {preset === undefined ? <p>{t('strength.customMaterial')}</p> : <StrengthMaterialSource material={preset} />}
      {snapshot.value.calculation.kind === 'bolt' ? <p>{snapshot.threadDesignation} · {t(snapshot.threadSeries === 'coarse' ? 'strength.coarse' : 'strength.fine')} · {t(snapshot.areaMethod === 'table' ? 'strength.table' : 'strength.approximation')}</p> : null}
    </details>
    <details><summary>{t('strength.formulas')}</summary>{rows.map(row => <p key={row.name} className="pcad-strength__formula">
      {row.label}<br />{row.formula}<br />{row.substituted} = {row.exact}
    </p>)}</details>
  </section>;
}
