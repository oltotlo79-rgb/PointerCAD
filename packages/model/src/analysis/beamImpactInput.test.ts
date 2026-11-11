import { describe, expect, it } from 'vitest';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type StandardBeamImpactDefinition } from './beamInputs.js';

/** The buckling CAD member (fixed base -> free tip) moving at -2 m/s along Z towards a fixed plane 0.5 mm below the tip. */
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
const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1',
  analyses: [{ kind: 'standard-members', definition }] });

describe('saved impact inputs (schema 6)', () => {
  it('reads the impact definition back unchanged through the real attachment codec, without results', () => {
    const { fixture, definition } = impactFixture();
    const checked = readBeamAnalysisInputs(attachment(definition), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    expect(checked.value.analyses[0]).toEqual({ kind: 'standard-members', definition });
    const document = withBeamAnalysisInputs(fixture.document, attachment(definition));
    const saved: unknown = JSON.parse(JSON.stringify(document.beamAnalysisInputs));
    const reread = readBeamAnalysisInputs(saved, fixture.document.id);
    expect(reread).toEqual({ ok: true, value: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } });
    expect(JSON.stringify(saved)).not.toMatch(/"(?:samples|contactPeaks|energyJ|referenceLoads|buckling|modal|gapM|directionUnit)"/u);
  });

  it('keeps the earlier schemas readable exactly as before', () => {
    const { fixture } = impactFixture();
    const buckling = fixture.definition;
    const checked = readBeamAnalysisInputs(attachment(buckling), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    expect(checked.value.analyses[0]).toEqual({ kind: 'standard-members', definition: buckling });
    // An impact field on a schema 5 contact definition is refused rather than silently relabelled.
    const { definition } = impactFixture();
    expect(readBeamAnalysisInputs(attachment({ ...definition, schema: 'pointercad-standard-beam/5' }), fixture.document.id))
      .toMatchObject({ ok: false });
  });

  it('refuses malformed, unsupported or out-of-contract impact settings with the exact issue', () => {
    const { fixture, definition } = impactFixture();
    const impact = definition.impact;
    const plane = impact.planes[0];
    const cases: readonly (readonly [unknown, string, string])[] = [
      [{ ...impact, planes: [{ kind: 'node-pair', id: 'pair', nodeIdA: 'tip', nodeIdB: 'base', normal: [0, 0, 1], gapMm: 0 }] },
        'shape', 'analyses[0].definition.impact.planes[0]'],
      [{ ...impact, planes: [] }, 'impact-planes', 'analyses[0].definition.impact.planes'],
      [{ ...impact, planes: [plane, plane] }, 'duplicate-id', 'analyses[0].definition.impact.planes'],
      [{ ...impact, planes: [{ ...plane, nodeId: 'missing' }] }, 'impact-node', 'analyses[0].definition.impact.planes[0].nodeId'],
      [{ ...impact, planes: [{ ...plane, normal: [0, 0, 0] }] }, 'impact-normal', 'analyses[0].definition.impact.planes[0].normal'],
      [{ ...impact, planes: [{ ...plane, gapMm: -1 }] }, 'impact-gap', 'analyses[0].definition.impact.planes[0].gapMm'],
      [{ ...impact, initialVelocities: [{ nodeId: 'tip', velocityMPerS: [0, 0, 0] }] },
        'impact-velocity', 'analyses[0].definition.impact.initialVelocities'],
      [{ ...impact, initialVelocities: [...impact.initialVelocities, ...impact.initialVelocities] },
        'impact-velocity', 'analyses[0].definition.impact.initialVelocities[1]'],
      [{ ...impact, initialVelocities: [{ nodeId: 'tip', velocityMPerS: [0, 0, Number.NaN] }] },
        'number', 'analyses[0].definition.impact.initialVelocities[0].velocityMPerS'],
      [{ ...impact, contactStiffnessNPerM: 0 }, 'impact-stiffness', 'analyses[0].definition.impact.contactStiffnessNPerM'],
      [{ ...impact, history: { ...impact.history, stepCount: 4001 } }, 'impact-history', 'analyses[0].definition.impact.history'],
      [{ ...impact, history: { ...impact.history, outputEvery: 1 } }, 'impact-history', 'analyses[0].definition.impact.history'],
      [{ ...impact, history: { ...impact.history, stepCount: 2.5 } }, 'impact-history', 'analyses[0].definition.impact.history'],
      [{ ...impact, restitution: 0.5 }, 'shape', 'analyses[0].definition.impact'],
    ];
    for (const [value, code, path] of cases) {
      const checked = readBeamAnalysisInputs(attachment({ ...definition, impact: value }), fixture.document.id);
      expect(checked.ok ? null : { code: checked.issue.code, path: checked.issue.path }, JSON.stringify(value)).toEqual({ code, path });
    }
    expect(readBeamAnalysisInputs(attachment({ ...definition, referenceLoads: [] }), fixture.document.id))
      .toMatchObject({ ok: false, issue: { code: 'shape' } });
  });

  it('saves only the history the impact solver can run: interval within the step count, representable step', () => {
    const { fixture, definition } = impactFixture();
    const read = (history: StandardBeamImpactDefinition['impact']['history']) => {
      const checked = readBeamAnalysisInputs(attachment({ ...definition, impact: { ...definition.impact, history } }),
        fixture.document.id);
      return checked.ok ? 'ok' : `${checked.issue.code} ${checked.issue.path}`;
    };
    const refused = 'impact-history analyses[0].definition.impact.history';
    // The solver's readHistory admits outputEvery 1..stepCount (fem beamImpactTranslation.ts count(..., 1, stepCount)):
    // 200 steps with one sample every 200 steps gives samples at 0 and 200 (2 <= 101), the largest admitted interval.
    expect(read({ timeStepS: 1e-5, stepCount: 200, outputEvery: 200 })).toBe('ok');
    expect(read({ timeStepS: 1e-5, stepCount: 1, outputEvery: 1 })).toBe('ok');
    // One step more than the step count: still only 2 samples, so the sample limit alone accepted it, but no run can.
    expect(read({ timeStepS: 1e-5, stepCount: 200, outputEvery: 201 })).toBe(refused);
    expect(read({ timeStepS: 1e-5, stepCount: 1, outputEvery: 2 })).toBe(refused);
    // This finite step is inside the shared numeric domain, but dt^2 underflows to zero:
    // the derived history coefficients are not representable, so the history itself is refused.
    expect(read({ timeStepS: 1e-200, stepCount: 200, outputEvery: 2 })).toBe(refused);
    const numberRefused = 'number analyses[0].definition.impact.history.timeStepS';
    // Saved inputs first pass through the shared finite |value| <= 1e30 reader.
    // 1e200 is outside that domain and is refused at timeStepS before derived-history validation.
    expect(read({ timeStepS: 1e200, stepCount: 200, outputEvery: 2 })).toBe(numberRefused);
    // The inclusive boundary has finite positive derived coefficients; the next IEEE-754 value
    // above 1e30 must instead be refused by the shared numeric reader.
    expect(read({ timeStepS: 1e30, stepCount: 1, outputEvery: 1 })).toBe('ok');
    expect(read({ timeStepS: 1.0000000000000002e30, stepCount: 1, outputEvery: 1 })).toBe(numberRefused);
    // The ordinary saved setting stays readable and unchanged.
    expect(read(definition.impact.history)).toBe('ok');
  });
});
