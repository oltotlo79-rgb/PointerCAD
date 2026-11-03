import { describe, expect, it, vi } from 'vitest';
import type { StandardBeamAdapterContext } from '@pointercad/model';
import type { StandardBeamFrictionDefinition } from '@pointercad/model/beam-analysis';
import { bucklingCadFixture } from '@pointercad/model/testing/analysis-fixtures';
import { prepareCadBeamFrictionContact } from './cadBeamFrictionContact.js';
import { translateBeamFrictionContact } from './frictionContactTranslation.js';

function fixture() {
  const cad = bucklingCadFixture(), old = cad.definition;
  const definition: StandardBeamFrictionDefinition = {
    schema: 'pointercad-standard-beam/7', id: old.id, revision: old.revision, source: old.source,
    units: old.units, members: old.members, materials: old.materials, sections: old.sections,
    supports: old.supports,
    contact: { segmentsPerMember: 1, contacts: [
      { id: 'floor', kind: 'node-plane', nodeId: 'tip', normal: [0, -1, 0], gapMm: 2 },
    ] },
    friction: { floor: 0.3 },
    stepLoads: [
      [{ id: 'force', kind: 'nodal', nodeId: 'tip', force: [2, -10, 0], moment: [1000, -2000, 3000] }],
      [{ id: 'force', kind: 'nodal', nodeId: 'tip', force: [5, -10, 0], moment: [2000, 0, -1000] }],
      [{ id: 'force', kind: 'nodal', nodeId: 'tip', force: [0, 0, 0], moment: [0, 0, 0] }],
      [{ id: 'force', kind: 'nodal', nodeId: 'tip', force: [-5, -10, 0], moment: [-2000, 0, 1000] }],
    ],
    solverOptions: { solver: 'newton', iterationLimit: 64 },
  };
  const context: StandardBeamAdapterContext = { currentSource: cad.stamp, bodies: new Map(), assemblyOptions: {} };
  return { document: cad.document, definition, context };
}

describe('saved friction schema 7 to current CAD input (pure preparation)', () => {
  it('keeps the actual two CAD endpoints, explicit supports, normal, coefficient and all four stages', () => {
    const f = fixture(), before = JSON.stringify({ document: f.document, definition: f.definition });
    const input = prepareCadBeamFrictionContact(f.document, f.definition, f.context);
    expect(input.schema).toBe('pointercad-beam-friction-contact/1');
    // FB 50x6 centroid (25,3), straight generated extrusion local +Z, length 2000 mm.
    expect(input.geometry.nodes).toEqual([
      { id: 'base', position: [25, 3, 0] }, { id: 'tip', position: [25, 3, 2000] },
    ]);
    expect(input.geometry.id).toBe('beam-test'); expect(input.geometry.revision).toBe(1);
    expect(input.geometry.source).toEqual(f.definition.source);
    expect(input.geometry.units).toBe('N-mm');
    expect(input.geometry.modal).toEqual({ modeCount: 1, segmentsPerMember: 1 });
    expect(input.geometry.constraints).toEqual([]); expect(input.geometry.loads).toEqual([]);
    expect(input.supports).toEqual([{ nodeId: 'base', restrained: [true, true, true, true, true, true] }]);
    expect(input.contacts).toEqual([{ id: 'floor', kind: 'node-plane', nodeId: 'tip', normal: [0, -1, 0], gapM: 0.002 }]);
    expect(input.friction).toEqual({ floor: 0.3 });
    expect(input.stepLoads.map(step => step[0].force)).toEqual([[2, -10, 0], [5, -10, 0], [0, 0, 0], [-5, -10, 0]]);
    expect(input.stepLoads.map(step => step[0].id)).toEqual(['force', 'force', 'force', 'force']);
    expect(Object.keys(input).sort()).toEqual(['contacts', 'friction', 'geometry', 'schema', 'stepLoads', 'supports']);
    expect(JSON.stringify({ document: f.document, definition: f.definition })).toBe(before);
  });

  it('keeps N-mm at the adapter boundary and converts moments exactly once in the dedicated translator', () => {
    const f = fixture(), input = prepareCadBeamFrictionContact(f.document, f.definition, f.context);
    expect(input.stepLoads.map(step => step[0].moment)).toEqual([[1000, -2000, 3000], [2000, 0, -1000], [0, 0, 0], [-2000, 0, 1000]]);
    const prepared = translateBeamFrictionContact(input);
    expect(prepared.plan.nodes.map(node => node.positionM)).toEqual([[0.025, 0.003, 0], [0.025, 0.003, 2]]);
    expect(prepared.loads).toEqual([
      [0, 0, 0, 0, 0, 0, 2, -10, 0, 1, -2, 3],
      [0, 0, 0, 0, 0, 0, 5, -10, 0, 2, 0, -1],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, -5, -10, 0, -2, 0, 1],
    ]);
    expect(prepared.plan.contacts).toEqual([{ id: 'floor', kind: 'node-plane', node: 2, normal: [0, -1, 0], gapM: 0.002 }]);
  });

  it('keeps leading and intermediate zero unloading stages and mesh refinement', () => {
    const f = fixture();
    const definition = { ...f.definition, contact: { ...f.definition.contact, segmentsPerMember: 2 },
      stepLoads: [f.definition.stepLoads[2], ...f.definition.stepLoads] };
    const input = prepareCadBeamFrictionContact(f.document, definition, f.context), prepared = translateBeamFrictionContact(input);
    expect(input.geometry.modal).toEqual({ modeCount: 1, segmentsPerMember: 2 });
    expect(input.stepLoads).toHaveLength(5);
    expect(prepared.plan.nodes).toHaveLength(3);
    expect(prepared.loads[0]).toEqual(Array.from({ length: 18 }, () => 0));
    expect(prepared.loads[3]).toEqual(Array.from({ length: 18 }, () => 0));
  });

  it.each([
    { documentId: 'another-document' }, { documentRevision: 8 }, { geometryRevision: 'geometry-13' },
  ])('refuses a saved source mismatch %j', changed => {
    const f = fixture();
    expect(() => prepareCadBeamFrictionContact(f.document, { ...f.definition, source: { ...f.definition.source, ...changed } }, f.context)).toThrow();
  });

  it.each([
    { documentId: 'another-document' }, { documentRevision: 8 }, { geometryRevision: 'geometry-13' },
  ])('refuses a current publication mismatch %j', changed => {
    const f = fixture();
    expect(() => prepareCadBeamFrictionContact(f.document, f.definition,
      { ...f.context, currentSource: { ...f.context.currentSource, ...changed } })).toThrow('stale-source');
  });

  it('refuses foreign document ownership and invalid analysis revision', () => {
    const f = fixture();
    expect(() => prepareCadBeamFrictionContact({ ...f.document, id: 'other' }, f.definition, f.context)).toThrow();
    expect(() => prepareCadBeamFrictionContact(f.document, { ...f.definition, revision: -1 }, f.context)).toThrow();
  });

  it('rejects missing/suppressed occurrence and changed expected part without using saved coordinates', () => {
    const f = fixture(), member = f.definition.members[0];
    for (const changed of [{ ...member, occurrencePath: ['missing'] }, { ...member, expectedPartKey: 'changed' }]) {
      expect(() => prepareCadBeamFrictionContact(f.document, { ...f.definition, members: [changed] }, f.context)).toThrow();
    }
    expect(() => prepareCadBeamFrictionContact({ ...f.document,
      components: f.document.components.map(component => ({ ...component, suppressed: true })) }, f.definition, f.context)).toThrow();
  });

  it('rejects undeclared derived geometry, extra keys and unsupported joint data', () => {
    const f = fixture();
    for (const extra of [{ geometry: {} }, { unexpected: true }, { axialBolts: {} }, { weldLayers: {} },
      { initialStrain: {} }, { results: [] }]) {
      expect(() => prepareCadBeamFrictionContact(f.document, { ...f.definition, ...extra }, f.context)).toThrow();
    }
    expect(() => prepareCadBeamFrictionContact(f.document, { ...f.definition,
      stepLoads: [[{ ...f.definition.stepLoads[0][0], nodeId: 'unknown' }]] }, f.context)).toThrow();
  });

  it('rejects accessors and sparse saved history before invoking a getter', () => {
    const f = fixture(), get = vi.fn(() => f.definition.source);
    const accessor = Object.defineProperty({ ...f.definition }, 'source', { enumerable: true, get });
    expect(() => prepareCadBeamFrictionContact(f.document, accessor, f.context)).toThrow(); expect(get).not.toHaveBeenCalled();
    const sparse = [...f.definition.stepLoads]; Reflect.deleteProperty(sparse, '1');
    expect(() => prepareCadBeamFrictionContact(f.document, { ...f.definition, stepLoads: sparse }, f.context)).toThrow();
  });

  it('refuses a valid schema 5 definition rather than silently choosing its contact/static route', () => {
    const f = fixture(), d = f.definition;
    const oldContact = { schema: 'pointercad-standard-beam/5', id: d.id, revision: d.revision, source: d.source,
      units: d.units, members: d.members, materials: d.materials, sections: d.sections, supports: d.supports,
      referenceLoads: d.stepLoads[0], contact: { ...d.contact, loadFactors: [1] } };
    expect(() => prepareCadBeamFrictionContact(f.document, oldContact, f.context)).toThrow('schema 7 required');
  });

  it('owns every saved load/material/support/contact after preparation and does not retain caller arrays', () => {
    const f = fixture(), input = prepareCadBeamFrictionContact(f.document, f.definition, f.context), before = JSON.stringify(input);
    Object.defineProperty(f.definition.stepLoads[0][0], 'force', { value: [99, 99, 99] });
    Object.defineProperty(f.definition.stepLoads[0][0], 'moment', { value: [99, 99, 99] });
    Object.defineProperty(f.definition.friction, 'floor', { value: 99 });
    Object.defineProperty(f.definition.materials[0], 'youngModulus', { value: 99 });
    Object.defineProperty(f.definition.supports[0], 'restrained', { value: [false, false, false, false, false, false] });
    Object.defineProperty(f.definition.contact.contacts[0], 'gapMm', { value: 99 });
    expect(JSON.stringify(input)).toBe(before);
  });
});
