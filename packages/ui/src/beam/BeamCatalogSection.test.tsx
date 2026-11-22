import { createCatalogItemSource, createStandardPartSource, partKeyOf, PRODUCT_CATALOG_REGISTRY, type StandardPartSource } from '@pointercad/model';
import { Children, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamCatalogSection } from './BeamCatalogSection.js';
import { BeamMemberFields } from './BeamMemberFields.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { readBeamField } from './beamFields.js';
import { createBeamSession, editBeamSession } from './beamSession.js';
import { beamCatalogOccurrences, beamOccurrences } from './beamSource.js';

const familyId = 't-slot-frame-s6';
beforeAll(() => PRODUCT_CATALOG_REGISTRY.ensure([familyId]));
afterEach(resetTestStore);

function catalogItem(key: string) {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(familyId);
  const row = family?.rows.find(candidate => candidate.key === key);
  if (!family || !row) throw new Error(key);
  return { row, source: createCatalogItemSource(family, row) };
}

function select(source: StandardPartSource) {
  const occurrence = { partKey: partKeyOf(source), path: ['frame'], label: source.size };
  const session = editBeamSession(createBeamSession('assembly', 'beam'), { kind: 'select', selected: true, occurrence });
  useAppStore.setState({ beamSession: session });
  return session.members[0].id;
}

function fields(source?: StandardPartSource) {
  const session = requireBeamSession();
  return renderCurrentStore(() => <BeamMemberFields member={session.members[0]} session={session} source={source} />);
}

function clickSection(source: StandardPartSource): void {
  const control = BeamCatalogSection({ member: requireBeamSession().members[0], source, edit: useAppStore.getState().editBeam });
  if (!isValidElement<{ children: ReactNode }>(control)) throw new Error('Missing section control');
  const button = Children.toArray(control.props.children).find(child =>
    isValidElement(child) && child.type === 'button');
  if (!isValidElement<{ onClick: () => void }>(button)) throw new Error('Missing section button');
  button.props.onClick();
}

describe('catalog section in the beam member fields', () => {
  it('offers the supported catalog occurrence for selection and reopening in the standard member panel', () => {
    const fixture = beamUiFixture();
    const frame = { ...fixture.component, id: 'frame', source: catalogItem('s6-20x40').source };
    const asymmetric = { ...frame, id: 'asymmetric', source: catalogItem('s6-20x20-blr').source };
    const miter = { ...frame, id: 'cut', source: { ...frame.source, options: { ...frame.source.options, endMiter: 'x+' } } };
    const components = [fixture.component, frame, asymmetric, miter];
    const document = { ...fixture.source.document, components };
    const placement = fixture.source.resolved.placements.get(fixture.component.id);
    if (!placement) throw new Error('Missing placed member');
    const resolved = { ...fixture.source.resolved, placements: new Map(components.map(item => [item.id, placement])),
      partKeys: new Map(components.map(item => [item.id, partKeyOf(item.source)])) };
    const catalog = beamCatalogOccurrences(document, resolved);
    expect(catalog.get(JSON.stringify([frame.id]))?.source).toEqual(frame.source);
    expect(beamOccurrences(document, resolved, 'standard-members').map(item => item.path)).toEqual([[fixture.component.id], [frame.id]]);
    expect(beamOccurrences(document, resolved).map(item => item.path)).toEqual([[fixture.component.id]]);
  });

  it('shows the button in the section group only for a supported row', () => {
    const { source } = catalogItem('s6-20x40');
    select(source);
    const title = `title="${t('beam.guide.catalogSection')}"`;
    const groups = fields(source).split('</details>').filter(group => group.includes(title));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toContain(`<summary>${t('beam.section')}</summary>`);
    expect(groups[0]).not.toContain(t('beam.catalogSectionManual'));
    expect(fields(catalogItem('s6-20x20-blr').source)).not.toContain(title);
    expect(fields(createStandardPartSource('hexBolt', 'M6', { length: '20' }))).not.toContain(title);
    expect(fields()).not.toContain(title);
  });

  it('copies six editable fields and both references, and requires a new frame confirmation', () => {
    const { row, source } = catalogItem('s6-20x40');
    const id = select(source);
    const edit = useAppStore.getState().editBeam;
    for (const field of ['cx', 'cy', 'principalAngle'] as const) edit({ kind: 'value', id, field, source: '7' });
    for (const property of ['section', 'frame'] as const) edit({ kind: 'source', id, property,
      source: { kind: 'measured', reference: 'Original', condition: 'Prior condition' } });
    edit({ kind: 'confirmed', id, confirmed: true });
    const before = requireBeamSession().members[0];
    expect(before.confirmed).toBe(true);
    clickSection(source);
    const member = requireBeamSession().members[0];
    const evidence = { kind: 'published', reference: `${row.evidence.title} ${row.evidence.locator}`, condition: '' };
    expect(member).toEqual({ ...before, confirmed: false, section: evidence, frame: evidence,
      values: { ...before.values, area: `${row.dims.areaMm2} mm²`, iy: `${row.dims.ixCm4} cm⁴`, iz: `${row.dims.iyCm4} cm⁴`,
        cx: '0', cy: '0', principalAngle: '0' } });
    for (const field of ['torsion', 'shearFactor', 'young', 'shear', 'density'] as const) expect(member.values[field]).toBe('');
    expect(readBeamField('iy', member.values.iy, []).value?.value).toBe(Number(`${row.dims.ixCm4}e4`));
    expect(readBeamField('iz', member.values.iz, []).value?.value).toBe(Number(`${row.dims.iyCm4}e4`));
    expect(fields(source)).toContain(t('beam.catalogSectionManual'));
    edit({ kind: 'value', id, field: 'iy', source: '14 cm⁴' });
    edit({ kind: 'value', id, field: 'torsion', source: '150 mm⁴' });
    expect(requireBeamSession().members[0].values.iy).toBe('14 cm⁴');
    clickSection(source);
    expect(requireBeamSession().members[0].values.torsion).toBe('150 mm⁴');
  });
});
