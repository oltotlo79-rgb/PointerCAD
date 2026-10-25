import { describe, expect, it } from 'vitest';
import { bucklingCadFixture } from '../../model/src/analysis/beamBuckling.testSupport.js';
import { partKeyOf } from '../../model/src/assembly/resolveAssembly.js';
import { standardMembersToBeamBuckling } from './cadBuckling.js';
import { bucklingInputSha256, translateBeamBuckling } from './bucklingTranslation.js';

describe('saved CAD to qualified buckling request', () => {
  it('regenerates actual straight standard geometry and deterministic SI data without deriving supports from CAD fixed', async () => {
    const fixture = bucklingCadFixture();
    const before = JSON.stringify(fixture);
    const context = { currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {} };
    const prepared = standardMembersToBeamBuckling(fixture.document, fixture.definition, context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.issue.message);
    expect(prepared.input.geometry.nodes).toEqual([
      { id: 'base', position: [25, 3, 0] }, { id: 'tip', position: [25, 3, 2000] },
    ]);
    expect(prepared.input.geometry.constraints).toEqual([]);
    expect(prepared.input.geometry.loads).toEqual([]);
    expect(prepared.input.supports).toEqual(fixture.definition.supports);
    const plan = translateBeamBuckling(prepared.input).plan;
    expect(plan.nodes).toHaveLength(17);
    expect(plan.members).toHaveLength(16);
    expect(plan.nodes.find(node => node.id === 'base')?.positionM).toEqual([0.025, 0.003, 0]);
    expect(plan.nodes.find(node => node.id === 'tip')?.positionM).toEqual([0.025, 0.003, 2]);
    expect(plan.nodes.find(node => node.id === 'tip')?.load).toEqual([0, 0, -10, 0, 0, 0]);
    expect(plan.nodes.filter(node => node.restrained.some(Boolean)).map(node => node.id)).toEqual(['base']);
    expect(await bucklingInputSha256(prepared.input)).toBe(await bucklingInputSha256(JSON.parse(JSON.stringify(prepared.input))));
    expect(JSON.stringify(fixture)).toBe(before);
    const unsupported = standardMembersToBeamBuckling(fixture.document, { ...fixture.definition, supports: [] }, context);
    expect(unsupported.ok).toBe(false);
  });

  it('converts supplied N-mm moments to N-m without pretending to certify the prestress', () => {
    const fixture = bucklingCadFixture();
    const prepared = standardMembersToBeamBuckling(fixture.document, { ...fixture.definition,
      referenceLoads: [{ ...fixture.definition.referenceLoads[0], moment: [0, 2000, 0] }] },
    { currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {} });
    if (!prepared.ok) throw new Error(prepared.issue.message);
    expect(translateBeamBuckling(prepared.input).plan.nodes.find(node => node.id === 'tip')?.load)
      .toEqual([0, 0, -10, 0, 2, 0]);
  });

  it('requires a fresh source review on reopen and rejects changed, missing or nonstandard members', () => {
    const fixture = bucklingCadFixture();
    const fresh = { ...fixture.stamp, documentRevision: 8, geometryRevision: 'recomputed-geometry' };
    const context = { currentSource: fresh, bodies: new Map(), assemblyOptions: {} };
    const stale = standardMembersToBeamBuckling(fixture.document, fixture.definition, context);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.issue.code).toBe('stale-source');
    expect(standardMembersToBeamBuckling(fixture.document, { ...fixture.definition, source: fresh }, context).ok).toBe(true);
    const current = { ...context, currentSource: fixture.stamp };
    const missing = { ...fixture.document, components: [] };
    expect(standardMembersToBeamBuckling(missing, fixture.definition, current).ok).toBe(false);
    const changed = { ...fixture.definition, members: fixture.definition.members.map(member => ({ ...member, expectedPartKey: 'changed' })) };
    expect(standardMembersToBeamBuckling(fixture.document, changed, current).ok).toBe(false);
    const component = fixture.document.components[0];
    const nonstandard = { ...component, source: { kind: 'part' as const, partRef: 'curved-part' } };
    const nonstandardDocument = { ...fixture.document, components: [nonstandard] };
    const nonstandardDefinition = { ...fixture.definition, members: fixture.definition.members.map(member => ({
      ...member, expectedPartKey: partKeyOf(nonstandard.source),
    })) };
    const rejected = standardMembersToBeamBuckling(nonstandardDocument, nonstandardDefinition, current);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issue.code).toBe('unsupported-geometry');
  });
});
