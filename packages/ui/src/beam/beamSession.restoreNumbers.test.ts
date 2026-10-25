import { expressionValueFromNumber } from '@pointercad/expression';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type StandardBeamDefinition,
  type StandardBeamTransientDefinition } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { bucklingCadFixture } from '../../../model/src/analysis/beamBuckling.testSupport.js';
import { readBeamField, readTransientField, type BeamFieldName } from './beamFields.js';
import { restoreBeamSession } from './beamSession.js';

/** Saved through the real model writer/reader (withBeamAnalysisInputs), exactly what a reopened document holds. */
function savedStandard(definition: StandardBeamDefinition, documentId: string): StandardBeamDefinition {
  const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'standard-members', definition }] }, documentId);
  if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}`);
  const saved = checked.value.analyses[0];
  if (saved?.kind !== 'standard-members' || (saved.definition.schema !== 'pointercad-standard-beam/1'
    && saved.definition.schema !== 'pointercad-standard-beam/2')) {
    throw new Error('Expected a saved schema 1 or 2 definition');
  }
  return saved.definition;
}

describe('restoreBeamSession keeps every saved number readable and binary-identical', () => {
  // Small, large, fractional and signed values; none is a short decimal or all fit String() without exponents.
  const young = 208000 + 1 / 3, area = 300 + 1 / 7, cx = 1e-7, cy = -2.5e-8;
  const force = [1e-7, -1e22, 1 / 3] as const, moment = [2.5e-8, -0.1, -1e21] as const;

  it('restores member, section, frame and load fields as plain decimals that evaluate to the saved double', () => {
    const fixture = beamCadFixture();
    const original = fixture.definition;
    const tip = original.loads[0]?.nodeId ?? 'tip';
    const definition = savedStandard({ ...original,
      materials: original.materials.map(row => ({ ...row, youngModulus: young })),
      sections: original.sections.map(row => ({ ...row, area })),
      members: original.members.map(member => ({ ...member, sectionFrame: { ...member.sectionFrame, centroidMm: [cx, cy, 0] } })),
      loads: original.loads.map(load => ({ ...load, force: [...force], moment: [...moment] })),
    }, fixture.document.id);
    const restored = restoreBeamSession('owner', definition, []);
    const member = restored.members[0];
    if (member === undefined) throw new Error('No restored member');
    const end = definition.members[0]?.startNodeId === tip ? 'start' : 'end';
    const expected: readonly (readonly [BeamFieldName, number])[] = [
      ['young', young], ['area', area], ['cx', cx], ['cy', cy],
      [`${end}Fx`, force[0]], [`${end}Fy`, force[1]], [`${end}Fz`, force[2]],
      [`${end}Mx`, moment[0]], [`${end}My`, moment[1]], [`${end}Mz`, moment[2]],
    ];
    for (const [name, value] of expected) {
      const source = member.values[name];
      expect(source, name).not.toMatch(/e/iu);
      const read = readBeamField(name, source, []);
      expect(read.value?.value, `${name} = ${source}`).toBe(value);
    }
    // Counterexample of the replaced String(value): exponent text is not in the expression grammar.
    expect(String(cx)).toBe('1e-7');
    expect(readBeamField('cx', String(cx), []).value).toBeNull();
  });

  it('restores transient sample times and factors without the 12-digit rounding of the replaced formatter', () => {
    const fixture = bucklingCadFixture();
    const old = fixture.definition;
    const definition: StandardBeamTransientDefinition = {
      schema: 'pointercad-standard-beam/4', id: old.id, revision: old.revision, source: old.source, units: old.units,
      members: old.members, materials: old.materials, sections: old.sections,
      transient: { segmentsPerMember: 8, history: { timeStepS: 0.0005, stepCount: 40, outputEvery: 4,
        loadFactor: [{ timeS: 0, factor: 0 }, { timeS: 0.005, factor: 1 / 3 }, { timeS: 0.02, factor: -2 / 3 }],
        damping: 'none', initialConditions: 'zero-at-rest' } },
      supports: old.supports, referenceLoads: old.referenceLoads,
    };
    const document = withBeamAnalysisInputs(fixture.document,
      { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] });
    const saved = document.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/4') {
      throw new Error('Expected saved schema 4 inputs');
    }
    const restored = restoreBeamSession('owner', saved.definition, []);
    expect(readTransientField('timeStep', 'transient:timeStep', restored.transient.timeStep, []).value?.value).toBe(0.0005);
    saved.definition.transient.history.loadFactor.forEach((row, index) => {
      const sample = restored.transient.samples[index];
      expect(readTransientField('sampleTime', `t${index}`, sample?.time ?? '', []).value?.value).toBe(row.timeS);
      expect(readTransientField('sampleFactor', `f${index}`, sample?.factor ?? '', []).value?.value).toBe(row.factor);
    });
    // Counterexample of the replaced expressionValueFromNumber: 1/3 came back as a different double.
    expect(expressionValueFromNumber(1 / 3).value).not.toBe(1 / 3);
    expect(restored.transient.stepCount).toBe('40');
  });
});
