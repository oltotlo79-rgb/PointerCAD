import type { StrengthMaterialPreset } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { solidMaterialYoung } from './solidMaterialSelection.js';

/** Catalogue preview only; it never certifies the independently editable analysis inputs. */
export function SolidAnalysisMaterialValues({ preset, young }: {
  readonly preset: StrengthMaterialPreset; readonly young: string | undefined;
}): React.JSX.Element {
  const elastic = solidMaterialYoung(preset);
  return <div data-testid="solid-material-values">
    {elastic !== null && young !== undefined && young !== elastic.mpa
      ? <p data-testid="solid-material-young-edited">{t('solidAnalysis.material.youngDifferent')}</p> : null}
    <details data-testid="solid-material-values-details">
    <summary data-testid="solid-material-values-toggle" onKeyDown={event => {
      if (event.key === 'Enter') event.stopPropagation();
    }}>{t('solidAnalysis.material.tableSummary')}</summary>
    <table>
      <caption>{t('solidAnalysis.material.tableCaption')}</caption>
      <thead><tr><th scope="col">{t('solidAnalysis.material.property')}</th>
        <th scope="col">{t('solidAnalysis.material.tableValue')}</th></tr></thead>
      <tbody>
        <tr><th scope="row">{t('solidAnalysis.young')}</th><td>{elastic === null
          ? t('solidAnalysis.material.noYoung') : `${elastic.mpa} MPa (${t(elastic.basis === 'reference'
            ? 'solidAnalysis.material.basis.reference' : 'solidAnalysis.material.basis.minimum')})`}</td></tr>
        <tr><th scope="row">{t('solidAnalysis.yieldValue')}</th><td>{`${preset.yieldStress.mpa} MPa (${t(preset.yieldStress.basis === 'reference'
          ? 'solidAnalysis.material.basis.reference' : 'solidAnalysis.material.basis.minimum')})`}</td></tr>
      </tbody>
    </table>
    <p>{t('solidAnalysis.material.manualValues')}</p>
    {elastic === null ? null : <details data-testid="solid-material-young-source">
      <summary data-testid="solid-material-young-source-toggle" onKeyDown={event => {
        if (event.key === 'Enter') event.stopPropagation();
      }}>{t('solidAnalysis.material.youngSource')}</summary>
      <p>{elastic.source.publisher}</p><p>{elastic.source.locator}</p>
      <p>{elastic.source.standard ?? t('solidAnalysis.material.standardUnspecified')}</p>
      <p>{elastic.source.standardEdition ?? t('strength.unknownEdition')}</p>
      <p>{`${t('solidAnalysis.material.checkedDate')}: ${elastic.source.checkedDate}`}</p>
      <p>{`${t('solidAnalysis.material.sourceDigest')}: ${elastic.source.sha256}`}</p>
      <a href={elastic.source.url} target="_blank" rel="noopener noreferrer">{elastic.source.url}</a>
    </details>}
    </details>
  </div>;
}
