import { catalogStrengthMaterials, STRENGTH_SOURCES, type StandardPartSource } from '@pointercad/model';
import { useState } from 'react';
import { t } from '../i18n/t.js';
import { strengthMaterialLabel } from '../strength/StrengthMaterialFields.js';

export function BeamCatalogMaterial({ source }: { readonly source: StandardPartSource }): React.JSX.Element | null {
  const [id, setId] = useState('');
  const candidates = catalogStrengthMaterials(source);
  if (candidates.length === 0) return null;
  const selected = candidates.find(row => row.id === id);
  const young = selected?.youngModulus;
  const reference = young && STRENGTH_SOURCES[young.sourceId];
  return <>
    <label>{t('beam.catalogMaterial')}<select value={id} onChange={event => setId(event.target.value)} title={t('beam.guide.catalogMaterial')}>
      <option value="">{t('beam.catalogMaterialChoose')}</option>
      {candidates.map(row => <option key={row.id} value={row.id}>{strengthMaterialLabel(row)}</option>)}
    </select></label>
    {selected && <p>{reference && <span>{t('beam.catalogYoungReference')} {reference.label} </span>}
      {t('beam.catalogManualValues')}</p>}
  </>;
}
