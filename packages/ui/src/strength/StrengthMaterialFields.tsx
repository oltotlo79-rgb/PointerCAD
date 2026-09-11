import {
  findStrengthMaterial, STRENGTH_MATERIALS, STRENGTH_SOURCES,
  type Parameter, type StrengthMaterialPreset,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { strengthExpressionField } from './strengthFields.js';
import { StrengthSelect } from './StrengthSelect.js';
import { strengthUsesCustomValues, type StrengthEdit, type StrengthSession } from './strengthSession.js';

export function strengthMaterialLabel(material: StrengthMaterialPreset): string {
  const thickness = material.thicknessMm;
  return `${material.grade} · ${material.condition}${thickness === null ? ''
    : ` · ${String(thickness.greaterThan)} ${thickness.lowerInclusive === true ? '≤' : '<'} t ≤ ${String(thickness.atMost)} mm`}`;
}

export function StrengthMaterialFields({ session, parameters, edit }: {
  readonly session: StrengthSession; readonly parameters: readonly Parameter[]; readonly edit: (edit: StrengthEdit) => void;
}): React.JSX.Element {
  const preset = findStrengthMaterial(session.materialId);
  return <>
    <StrengthSelect labelKey="strength.material" value={session.materialId}
      options={[{ value: '', label: t('strength.customMaterial') }, ...STRENGTH_MATERIALS.map(material => ({ value: material.id, label: strengthMaterialLabel(material) }))]}
      onChange={id => edit({ kind: 'material', id })} />
    {preset === undefined ? null : <>
      <p>{strengthMaterialLabel(preset)}</p>
      {preset.thicknessMm === null ? null : <ExpressionField
        {...strengthExpressionField(session, parameters, 'productThickness', 'length', 'strength.productThickness', session.productThicknessSource)}
        lengthUnit={session.lengthUnit} focused={session.focusedField === 'productThickness'}
        onFocus={() => edit({ kind: 'focus', field: 'productThickness' })}
        onChange={source => edit({ kind: 'product-thickness', source })} />}
      {preset.youngModulus === null || preset.shearModulus === null ? <p>{t('strength.missingElastic')}</p> : null}
      {strengthUsesCustomValues(session) ? <p>{t('strength.customValues')}</p> : null}
      <StrengthMaterialSource material={preset} />
    </>}
  </>;
}

export function StrengthMaterialSource({ material }: { readonly material: StrengthMaterialPreset }): React.JSX.Element {
  const ids = [...new Set([material.yieldStress.sourceId, material.tensileStrength.sourceId,
    material.youngModulus?.sourceId, material.shearModulus?.sourceId])];
  return <details><summary>{t('strength.source')}</summary>
    <p>{t('strength.materialScope')}</p>
    <p>{strengthMaterialLabel(material)}</p>
    <p>σy {material.yieldStress.mpa} MPa · {t(material.yieldStress.basis === 'minimum' ? 'strength.minimum' : 'strength.reference')}</p>
    <p>σt {material.tensileStrength.mpa} MPa · {t(material.tensileStrength.basis === 'minimum' ? 'strength.minimum' : 'strength.reference')}</p>
    {ids.map(id => {
      const source = id === undefined ? undefined : STRENGTH_SOURCES[id];
      return source === undefined ? null : <p key={id}>{source.publisher} · {source.locator}<br />
        {source.standard} · {source.standardEdition ?? t('strength.unknownEdition')}</p>;
    })}
  </details>;
}
