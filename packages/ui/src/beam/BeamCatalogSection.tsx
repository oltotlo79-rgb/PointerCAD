import { catalogBeamSection, type StandardPartSource } from '@pointercad/model';
import type { PropertySource } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import type { BeamFieldName } from './beamFields.js';
import type { BeamEdit, BeamMemberDraft } from './beamSession.js';

export function BeamCatalogSection({ member, source, edit }: {
  readonly member: BeamMemberDraft; readonly source: StandardPartSource; readonly edit: (edit: BeamEdit) => void;
}): React.JSX.Element | null {
  const section = catalogBeamSection(source);
  if (!section.ok) return null;
  const applied = member.section.kind === 'published' && member.section.reference === section.reference;
  const apply = (): void => {
    const value = (field: BeamFieldName, source: string): void => edit({ kind: 'value', id: member.id, field, source });
    value('area', `${section.areaMm2} mm²`);
    // At zero angle beam y follows local +X (the table's Ix) and beam z follows local +Y.
    value('iy', `${section.ixCm4} cm⁴`);
    value('iz', `${section.iyCm4} cm⁴`);
    value('cx', String(section.cx));
    value('cy', String(section.cy));
    value('principalAngle', String(section.principalAngle));
    const evidence: PropertySource = { kind: 'published', reference: section.reference, condition: '' };
    edit({ kind: 'source', id: member.id, property: 'section', source: evidence });
    edit({ kind: 'source', id: member.id, property: 'frame', source: evidence });
  };
  return <>
    <button type="button" className="pcad-button" onClick={apply} title={t('beam.guide.catalogSection')}>{t('beam.catalogSection')}</button>
    {applied && <p>{t('beam.catalogSectionManual')}</p>}
  </>;
}
