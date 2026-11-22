import { beforeAll, describe, expect, it } from 'vitest';
import { T_SLOT_CATALOG_RECORDS } from '../assembly/catalog/families/frameCatalogRows.js';
import { T_SLOT_OUTLINE_RECORDS } from '../assembly/catalog/families/frameOutlineRows.js';
import { T_SLOT_CATALOG_FAMILIES, type TSlotCatalogRecord } from '../assembly/catalog/families/tSlotFrameCatalog.js';
import { createCatalogRegistry, PRODUCT_CATALOG_REGISTRY } from '../assembly/catalog/registry.js';
import { createCatalogItemSource } from '../assembly/catalog/source.js';
import { beamCadFixture, testComponent, testMember } from './beamInputs.testSupport.js';
import { catalogBeamSection } from './catalogBeamSection.js';
import { standardMembersToBeamAnalysis } from './standardBeamAdapter.js';

const families = Object.values(T_SLOT_CATALOG_FAMILIES);
const registry = createCatalogRegistry(families.map(family => ({ ...family, load: () => Promise.resolve(family) })));
const records = [...T_SLOT_CATALOG_RECORDS, ...T_SLOT_OUTLINE_RECORDS];
beforeAll(() => registry.ensure(families.map(family => family.id)));

function expectedStatus(row: TSlotCatalogRecord) {
  if ([row.areaMm2, row.ixCm4, row.iyCm4].includes(null)) return 'missing-properties';
  // For the recorded faces, only no slots, either opposite pair or all four preserve both mirrors.
  const paired = ['', 'bt', 'lr', 'blrt'].includes([...row.faces].sort().join(''));
  return paired && !row.outline && row.armWidth === undefined && !row.simplifiedKinds?.includes('slotPositionSymmetric')
    ? 'available' : 'unverified-symmetry';
}

describe('published beam sections', () => {
  it.each(families)('matches every printed row and the status counts in $id', family => {
    const printed = records.filter(row => `t-slot-frame-s${row.slot}` === family.id);
    expect(family.rows.map(row => row.key)).toEqual(printed.map(row => row.key));
    const statuses = family.rows.map((row, index) => {
      const record = printed[index];
      const section = catalogBeamSection(createCatalogItemSource(family, row), registry);
      const status = section.ok ? 'available' : section.reason;
      expect(status, row.key).toBe(expectedStatus(record));
      if (section.ok) {
        expect(section).toEqual({ ok: true, areaMm2: record.areaMm2, ixCm4: record.ixCm4, iyCm4: record.iyCm4,
          cx: 0, cy: 0, principalAngle: 0, reference: `${row.evidence.title} ${row.evidence.locator}` });
        // Anonymous document title and figure/table locations only.
        expect(row.evidence.title).toBe('資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)');
        expect(row.evidence.locator).toMatch(/^PDF \d+ 頁 断面の図\(外形・溝・穴・角の丸み\)／PDF \d+ 頁 断面性能の表\(断面積・Ix・Iy・Zx・Zy(?:・単位質量)?\)(?:／PDF \d+ 頁 図の箱\(単位質量\))?$/u);
      }
      return status;
    });
    for (const status of ['available', 'missing-properties', 'unverified-symmetry']) {
      expect(statuses.filter(value => value === status)).toHaveLength(printed.filter(row => expectedStatus(row) === status).length);
    }
  });

  it('checks the width-axis convention for every eligible non-square printed section', () => {
    const rectangles = records.filter(row => expectedStatus(row) === 'available' && row.width !== row.height);
    expect(rectangles.length).toBeGreaterThan(0);
    for (const row of rectangles) {
      if (row.ixCm4 === null || row.iyCm4 === null) throw new Error(row.key);
      expect(Math.sign(row.ixCm4 - row.iyCm4), row.key).toBe(Math.sign(row.height - row.width));
    }
  });

  it('uses the generated length for a square-cut catalog member and refuses stock endpoints on a miter', async () => {
    const family = T_SLOT_CATALOG_FAMILIES.s6;
    await PRODUCT_CATALOG_REGISTRY.ensure([family.id]);
    const row = family.rows.find(candidate => candidate.key === 's6-20x40');
    if (!row) throw new Error('Missing rectangular test section');
    const fixture = beamCadFixture();
    const derive = (options: Readonly<Record<string, string>>) => {
      const component = { ...testComponent(), source: createCatalogItemSource(family, row, options) };
      const member = testMember(component);
      const document = { ...fixture.document, components: [component] };
      const sectionFrame = { ...member.sectionFrame, centroidMm: [0, 0, 0] as const };
      return standardMembersToBeamAnalysis(document, { ...fixture.definition, members: [{ ...member, sectionFrame }] },
        { currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {} });
    };
    const beam = derive({ length: '200+50' });
    if (!beam.ok) throw new Error(beam.issue.message);
    expect(beam.document.nodes.map(node => node.position)).toEqual([[0, 0, 0], [0, 0, 250]]);
    for (const key of ['startMiter', 'endMiter']) {
      expect(derive({ length: '250', [key]: 'x+' })).toMatchObject({ ok: false, issue: { code: 'unsupported-geometry' } });
    }
  });

  it('distinguishes other components, an unresolved row or revision, and omitted printed values', () => {
    const family = T_SLOT_CATALOG_FAMILIES.s8;
    const incomplete = T_SLOT_CATALOG_RECORDS.find(row => row.areaMm2 === null && `t-slot-frame-s${row.slot}` === family.id);
    const row = family.rows.find(candidate => candidate.key === incomplete?.key);
    if (!row) throw new Error('Missing incomplete catalog row');
    const source = createCatalogItemSource(family, row);
    expect(catalogBeamSection({ kind: 'part', partRef: 'plain' }, registry)).toEqual({ ok: false, reason: 'not-catalog-item' });
    expect(catalogBeamSection({ ...source, catalog: 'flatBar' }, registry)).toEqual({ ok: false, reason: 'not-catalog-item' });
    expect(catalogBeamSection({ ...source, options: { ...source.options, item: 'absent' } }, registry))
      .toEqual({ ok: false, reason: 'unresolved-row' });
    expect(catalogBeamSection({ ...source, generatorRevision: 'unknown' }, registry)).toEqual({ ok: false, reason: 'unresolved-row' });
    expect(catalogBeamSection(source, registry)).toEqual({ ok: false, reason: 'missing-properties' });
  });
});
