import { beamUiFixture } from './beam.testSupport.js';
import type { BeamSession } from './beamSession.js';

export function bucklingUiFixture() {
  const fixture = beamUiFixture();
  const session: BeamSession = { ...fixture.session, analysisType: 'buckling', modeCount: 2, segmentsPerMember: 4,
    members: fixture.session.members.map(member => ({ ...member,
      startRestraints: [true, true, true, true, true, true],
      values: { ...member.values, endFx: '0', endFz: '-1' } })) };
  return { ...fixture, session };
}
