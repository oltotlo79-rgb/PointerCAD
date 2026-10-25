import { describe, expect, it } from 'vitest';
import { beamCadFixture } from './beamInputs.testSupport.js';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import { type StandardBeamImpactDefinition, type StandardBeamTransientDefinition } from './beamInputs.js';
import { standardMembersToBeamAnalysis } from './standardBeamAdapter.js';

/**
 * Same impact definition as beamImpactInput.test.ts (r134): the buckling CAD member's tip has an initial velocity of
 * -2 m/s along Z and faces a fixed plane whose normal is +Z with a 0.5 mm gap. With that sign convention the tip moves
 * away from the plane (a separating case); only validation, storage and routing are exercised here, not the impact.
 */
function impactFixture() {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamImpactDefinition = {
    schema: 'pointercad-standard-beam/6', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections, supports: old.supports,
    impact: { segmentsPerMember: 8, initialVelocities: [{ nodeId: 'tip', velocityMPerS: [0, 0, -2] }],
      planes: [{ id: 'tip-stop', nodeId: 'tip', normal: [0, 0, 1], gapMm: 0.5 }],
      contactStiffnessNPerM: 1e7, history: { timeStepS: 1e-5, stepCount: 200, outputEvery: 2 } },
  };
  return { fixture, definition };
}

function route(document: ReturnType<typeof bucklingCadFixture>['document'], definition: unknown,
  stamp: ReturnType<typeof bucklingCadFixture>['stamp']) {
  return standardMembersToBeamAnalysis(document, definition, { currentSource: stamp, bodies: new Map(), assemblyOptions: {} });
}

describe('schema 6 impact inputs at the static CAD adapter', () => {
  it('is refused by the static adapter, which never solves an impact as a static load case', () => {
    // Before r143 the adapter refused schemas 3, 4 and 5 by name and returned any other schema as a static definition,
    // so a schema 6 impact would have reached the static solver without loads.
    const { fixture, definition } = impactFixture();
    const result = route(fixture.document, definition, fixture.stamp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('unsupported-analysis');
      expect(result.issue.message).toContain('schema 6');
    }
  });
});

describe('exhaustive static adapter routing over the saved standard-member schemas (r144)', () => {
  it('refuses the schema 4 transient definition with the existing code and message', () => {
    const fixture = bucklingCadFixture();
    const old = fixture.definition;
    const transient: StandardBeamTransientDefinition = {
      schema: 'pointercad-standard-beam/4', id: old.id, revision: old.revision, source: old.source, units: old.units,
      members: old.members, materials: old.materials, sections: old.sections,
      transient: { segmentsPerMember: old.buckling.segmentsPerMember, history: { timeStepS: 1e-4, stepCount: 100,
        outputEvery: 2, damping: 'none', initialConditions: 'zero-at-rest',
        loadFactor: [{ timeS: 0, factor: 0 }, { timeS: 2e-3, factor: 1 }, { timeS: 1e-2, factor: 1 }] } },
      supports: old.supports, referenceLoads: old.referenceLoads,
    };
    const result = route(fixture.document, transient, fixture.stamp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('unsupported-analysis');
      expect(result.issue.message).toBe('Use the explicit transient CAD adapter for schema 4');
    }
  });

  it('still admits schema 1 static and schema 2 modal definitions to the static route', () => {
    const fixture = bucklingCadFixture();
    const linear = { ...beamCadFixture().definition, source: fixture.stamp, id: 'static' };
    const modal = { ...linear, id: 'modal', schema: 'pointercad-standard-beam/2',
      modal: { modeCount: 2, segmentsPerMember: 8 }, loads: [] };
    for (const definition of [linear, modal]) {
      const result = route(fixture.document, definition, fixture.stamp);
      // Routing is what changed: a later geometry/solve refusal is allowed, a schema refusal is not.
      if (!result.ok) expect(['unsupported-analysis', 'unsupported-model'], definition.id).not.toContain(result.issue.code);
    }
  });

  it('refuses an unrecognized schema before any static solve', () => {
    // The strict field reader precedes schema routing: distinguish a valid static shape from an impact shape.
    const staticFixture = beamCadFixture();
    const staticResult = route(staticFixture.document,
      { ...staticFixture.definition, schema: 'pointercad-standard-beam/7' }, staticFixture.stamp);
    expect(staticResult.ok).toBe(false);
    if (!staticResult.ok) {
      expect(staticResult.issue.code).toBe('unsupported-model');
      expect(staticResult.issue.path).toBe('analyses[0].definition');
      expect(staticResult.issue.message).toBe('Expected standard beam schema 1 or 2 in N-mm units');
    }
    const { fixture, definition } = impactFixture();
    const impactResult = route(fixture.document, { ...definition, schema: 'pointercad-standard-beam/7' }, fixture.stamp);
    expect(impactResult.ok).toBe(false);
    if (!impactResult.ok) {
      expect(impactResult.issue.code).toBe('shape');
      expect(impactResult.issue.path).toBe('analyses[0].definition');
      expect(impactResult.issue.message).toBe('Unsupported or missing field');
    }
  });
});
