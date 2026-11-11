import { describe, expect, it } from 'vitest';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type StandardBeamContactDefinition } from './beamInputs.js';
import { standardMembersToBeamAnalysis } from './standardBeamAdapter.js';

/** One fixed-base member (base -> tip); the tip may touch a fixed plane 0.5 mm below it along -Z (direction +Z),
 * and two independent factors of the existing compressive reference load. */
function contactFixture() {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamContactDefinition = {
    schema: 'pointercad-standard-beam/5', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections,
    contact: { segmentsPerMember: 8,
      contacts: [{ kind: 'node-plane', id: 'tip-stop', nodeId: 'tip', normal: [0, 0, 1], gapMm: 0.5 }],
      loadFactors: [1, -2] },
    supports: old.supports, referenceLoads: old.referenceLoads,
  };
  return { fixture, definition };
}
const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1',
  analyses: [{ kind: 'standard-members', definition }] });

describe('saved contact inputs (schema 5)', () => {
  it('reads the explicit contact definition back unchanged, with the gap kept in mm', () => {
    const { fixture, definition } = contactFixture();
    const checked = readBeamAnalysisInputs(attachment(definition), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    expect(checked.value.analyses[0]).toEqual({ kind: 'standard-members', definition });
    const document = withBeamAnalysisInputs(fixture.document, attachment(definition));
    expect(document.beamAnalysisInputs?.analyses[0]).toEqual({ kind: 'standard-members', definition });
    expect(JSON.stringify(document.beamAnalysisInputs)).not.toMatch(/"(?:gapM|states|nodes|normalReactionN|buckling|modal)"/u);
  });

  it('reads a node pair and a mixed set without inventing or reordering anything', () => {
    const { fixture, definition } = contactFixture();
    const pair: StandardBeamContactDefinition = { ...definition, contact: { ...definition.contact, contacts: [
      ...definition.contact.contacts,
      { kind: 'node-pair', id: 'base-tip', nodeIdA: 'base', nodeIdB: 'tip', normal: [0, 0, 2], gapMm: 0 },
    ] } };
    const checked = readBeamAnalysisInputs(attachment(pair), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    expect(checked.value.analyses[0]).toEqual({ kind: 'standard-members', definition: pair });
  });

  it.each([
    ['no contact', { contacts: [] }, 'contact-count'],
    ['unknown kind', { contacts: [{ kind: 'node-surface', id: 'a', nodeId: 'tip', normal: [0, 0, 1], gapMm: 0 }] }, 'contact-kind'],
    ['absent node', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'elsewhere', normal: [0, 0, 1], gapMm: 0 }] }, 'contact-node'],
    ['zero direction', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'tip', normal: [0, 0, 0], gapMm: 0 }] }, 'contact-normal'],
    ['negative gap', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'tip', normal: [0, 0, 1], gapMm: -0.1 }] }, 'contact-gap'],
    ['gap above 1000 m', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'tip', normal: [0, 0, 1], gapMm: 1e6 + 1 }] }, 'contact-gap'],
    ['NaN gap', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'tip', normal: [0, 0, 1], gapMm: Number.NaN }] }, 'number'],
    ['pair on one node', { contacts: [{ kind: 'node-pair', id: 'a', nodeIdA: 'tip', nodeIdB: 'tip', normal: [0, 0, 1], gapMm: 0 }] }, 'contact-self'],
    ['duplicate id', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'tip', normal: [0, 0, 1], gapMm: 0 },
      { kind: 'node-plane', id: 'a', nodeId: 'base', normal: [0, 0, 1], gapMm: 0 }] }, 'duplicate-id'],
    ['id longer than 64', { contacts: [{ kind: 'node-plane', id: 'x'.repeat(65), nodeId: 'tip', normal: [0, 0, 1], gapMm: 0 }] }, 'text'],
    ['solver gap field', { contacts: [{ kind: 'node-plane', id: 'a', nodeId: 'tip', normal: [0, 0, 1], gapM: 0 }] }, 'shape'],
    ['no load factor', { loadFactors: [] }, 'contact-factors'],
    ['factor above 1e6', { loadFactors: [1e6 + 1] }, 'contact-factors'],
    ['33 load factors', { loadFactors: Array.from({ length: 33 }, () => 1) }, 'size'],
  ] as const)('refuses %s', (_, change, code) => {
    const { fixture, definition } = contactFixture();
    const checked = readBeamAnalysisInputs(attachment({ ...definition, contact: { ...definition.contact, ...change } }),
      fixture.document.id);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issue.code).toBe(code);
  });

  it('refuses 65 contacts and an unloaded structure, and keeps the buckling decoder checks', () => {
    const { fixture, definition } = contactFixture();
    const many = Array.from({ length: 65 }, (_, index) =>
      ({ kind: 'node-plane', id: `c${index}`, nodeId: 'tip', normal: [0, 0, 1], gapMm: index }));
    for (const [value, code] of [
      [{ ...definition, contact: { ...definition.contact, contacts: many } }, 'size'],
      [{ ...definition, referenceLoads: [] }, 'buckling-load'],
      [{ ...definition, supports: [] }, 'buckling-supports'],
      [{ ...definition, contact: { ...definition.contact, segmentsPerMember: 0 } }, 'modal-size'],
      [{ ...definition, contact: { ...definition.contact, segmentsPerMember: 33 } }, 'modal-size'],
      [{ ...definition, buckling: { modeCount: 1, segmentsPerMember: 8 } }, 'shape'],
    ] as const) {
      const checked = readBeamAnalysisInputs(attachment(value), fixture.document.id);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.issue.code).toBe(code);
    }
  });

  it('is refused by the static CAD adapter, which never solves contact as a static load case', () => {
    const { fixture, definition } = contactFixture();
    const result = standardMembersToBeamAnalysis(fixture.document, definition,
      { currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('unsupported-analysis');
  });

  it('refuses sparse contact and factor lists that would save as null, and keeps dense lists with a zero factor', () => {
    const { fixture, definition } = contactFixture();
    const contactWith = (change: Record<string, unknown>) =>
      attachment({ ...definition, contact: { ...definition.contact, ...change } });
    // A hole is skipped by Array.map and .some but serializes as null, so it could never be reopened.
    expect(JSON.stringify(new Array<number>(1))).toBe('[null]');
    const deleted = [1, 2, 3];
    Reflect.deleteProperty(deleted, 1);
    const inherited = new Array<number>(1);
    Object.setPrototypeOf(inherited, [5]);
    const contacts = [...definition.contact.contacts, { ...definition.contact.contacts[0], id: 'second' }];
    Reflect.deleteProperty(contacts, 1);
    for (const [change, path] of [
      [{ loadFactors: new Array<number>(1) }, 'loadFactors[0]'],
      [{ loadFactors: deleted }, 'loadFactors[1]'],
      [{ loadFactors: inherited }, 'loadFactors[0]'],
      [{ contacts }, 'contacts[1]'],
    ] as const) {
      const value = contactWith(change);
      const checked = readBeamAnalysisInputs(value, fixture.document.id);
      expect(checked.ok, path).toBe(false);
      if (!checked.ok) {
        expect(checked.issue.code, path).toBe('contact-sparse');
        expect(checked.issue.path.endsWith(`contact.${path}`), checked.issue.path).toBe(true);
      }
      expect(() => withBeamAnalysisInputs(fixture.document, value), path).toThrow(/contact-sparse/u);
    }
    for (const loadFactors of [[0], [0, 0.5, 1, -1]]) {
      const checked = readBeamAnalysisInputs(contactWith({ loadFactors }), fixture.document.id);
      if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
      expect(checked.value.analyses[0]).toEqual({ kind: 'standard-members',
        definition: { ...definition, contact: { ...definition.contact, loadFactors } } });
    }
  });
});
