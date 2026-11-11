import type { StandardBeamBucklingDefinition } from './beamInputs.js';
import { beamCadFixture } from './beamInputs.testSupport.js';

export function bucklingCadFixture(): Omit<ReturnType<typeof beamCadFixture>, 'definition'> & {
  readonly definition: StandardBeamBucklingDefinition;
} {
  const fixture = beamCadFixture();
  const old = fixture.definition;
  return {
    document: fixture.document,
    stamp: fixture.stamp,
    definition: {
      schema: 'pointercad-standard-beam/3', id: old.id, revision: old.revision,
      source: old.source, units: old.units, members: old.members,
      materials: old.materials, sections: old.sections,
      buckling: { modeCount: 2, segmentsPerMember: 16 },
      supports: [{ nodeId: 'base', restrained: [true, true, true, true, true, true] }],
      referenceLoads: [{ id: 'compression', kind: 'nodal', nodeId: 'tip',
        force: [0, 0, -10], moment: [0, 0, 0] }],
    },
  };
}
