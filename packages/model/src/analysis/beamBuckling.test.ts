import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from './index.js';
import { beamCadFixture } from './beamInputs.testSupport.js';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import { standardMembersToBeamAnalysis } from './standardBeamAdapter.js';

describe('strict saved CAD buckling inputs', () => {
  it('keeps the three definition versions distinct and preserves old inputs exactly', () => {
    const fixture = bucklingCadFixture();
    const linear = beamCadFixture().definition;
    const staticInput = { ...linear, source: fixture.stamp, id: 'static' };
    const modalInput = { ...staticInput, id: 'modal', schema: 'pointercad-standard-beam/2',
      modal: { modeCount: 2, segmentsPerMember: 8 }, loads: [] };
    const value = { schema: 'pointercad-beam-inputs/1', analyses: [staticInput, modalInput, fixture.definition]
      .map(definition => ({ kind: 'standard-members', definition })) };
    const checked = readBeamAnalysisInputs(value, fixture.document.id);
    expect(checked).toEqual({ ok: true, value });
    expect(fixture.document.beamAnalysisInputs).toBeUndefined();
    const edited = withBeamAnalysisInputs(fixture.document, value);
    expect(edited.beamAnalysisInputs).toEqual(value);
    expect(edited).not.toBe(fixture.document);
    const wrongRoute = standardMembersToBeamAnalysis(fixture.document, fixture.definition,
      { currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {} });
    expect(wrongRoute.ok).toBe(false);
    if (!wrongRoute.ok) expect(wrongRoute.issue.code).toBe('unsupported-analysis');
  });

  const invalid: readonly [string, (definition: ReturnType<typeof bucklingCadFixture>['definition']) => unknown][] = [
    ['unknown version', definition => ({ ...definition, schema: 'pointercad-standard-beam/4' })],
    ['results injection', definition => ({ ...definition, results: [] })],
    ['coordinates injection', definition => ({ ...definition, nodes: [] })],
    ['modal reinterpretation', definition => ({ ...definition, modal: definition.buckling })],
    ['unknown setting', definition => ({ ...definition, buckling: { ...definition.buckling, solver: 'other' } })],
    ['no supports', definition => ({ ...definition, supports: [] })],
    ['all free', definition => ({ ...definition, supports: [{ nodeId: 'base', restrained: [false, false, false, false, false, false] }] })],
    ['nonboolean mask', definition => ({ ...definition, supports: [{ nodeId: 'base', restrained: [1, true, true, true, true, true] }] })],
    ['wrong mask size', definition => ({ ...definition, supports: [{ nodeId: 'base', restrained: [true] }] })],
    ['duplicate supports', definition => ({ ...definition, supports: [...definition.supports, ...definition.supports] })],
    ['missing support node', definition => ({ ...definition, supports: [{ ...definition.supports[0], nodeId: 'absent' }] })],
    ['no reference load', definition => ({ ...definition, referenceLoads: [] })],
    ['zero reference load', definition => ({ ...definition, referenceLoads: [{ ...definition.referenceLoads[0], force: [0, 0, 0] }] })],
    ['cancelled reference loads', definition => ({ ...definition, referenceLoads: [...definition.referenceLoads,
      { ...definition.referenceLoads[0], id: 'opposite', force: [0, 0, 10] }] })],
    ['duplicate loads', definition => ({ ...definition, referenceLoads: [...definition.referenceLoads, ...definition.referenceLoads] })],
    ['missing load node', definition => ({ ...definition, referenceLoads: [{ ...definition.referenceLoads[0], nodeId: 'absent' }] })],
    ['nonfinite force', definition => ({ ...definition, referenceLoads: [{ ...definition.referenceLoads[0], force: [Infinity, 0, 0] }] })],
    ['combined force out of range', definition => ({ ...definition, referenceLoads: [0, 1].map(index => ({
      ...definition.referenceLoads[0], id: `force-${index}`, force: [1e30, 0, 0],
    })) })],
    ['foreign document', definition => ({ ...definition, source: { ...definition.source, documentId: 'other' } })],
  ];
  it.each(invalid)('rejects %s without dropping fields', (label, change) => {
    const fixture = bucklingCadFixture();
    const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: change(fixture.definition) },
    ] }, fixture.document.id);
    expect(checked.ok, label).toBe(false);
  });

  it('preserves explicit transverse forces and moments for geometry-dependent native admissibility', () => {
    const fixture = bucklingCadFixture();
    const definition = { ...fixture.definition, referenceLoads: [{ ...fixture.definition.referenceLoads[0],
      force: [10, 0, 0], moment: [0, 2000, 0] }] };
    const value = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] };
    expect(readBeamAnalysisInputs(value, fixture.document.id)).toEqual({ ok: true, value });
  });

  it('checks the final combined force, matching the qualified translator rather than rejecting a finite partial sum', () => {
    const fixture = bucklingCadFixture();
    const definition = { ...fixture.definition, referenceLoads: [1e30, 1e30, -1e30].map((force, index) => ({
      ...fixture.definition.referenceLoads[0], id: `force-${index}`, force: [force, 0, 0],
    })) };
    const value = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] };
    expect(readBeamAnalysisInputs(value, fixture.document.id)).toEqual({ ok: true, value });
  });
});
