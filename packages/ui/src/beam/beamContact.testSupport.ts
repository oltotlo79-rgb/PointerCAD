import { contactInputSha256, contactPivotLimit, decodeBeamContact, translateBeamContact, type BeamContactAnalysisResult,
  type BeamContactInput } from '@pointercad/fem';
import { bucklingUiFixture } from './beamBuckling.testSupport.js';
import { editBeamSession, type BeamEdit, type BeamSession } from './beamSession.js';

type Vector3 = readonly [number, number, number];

/** The buckling form (start fully restrained, end load -1 N along Z on the 2000 mm member, 4 segments) with one plane
 * contact at the free end: direction +Z, initial gap 0.5 mm, and two independent factors 1 and -1 of the load. */
export function contactUiFixture() {
  const fixture = bucklingUiFixture();
  const member = fixture.session.members[0];
  let session: BeamSession = { ...fixture.session, analysisType: 'contact' };
  const edits: readonly BeamEdit[] = [
    { kind: 'contact-add' },
    { kind: 'contact-node', index: 0, end: 'a', nodeId: member.endNodeId },
    { kind: 'contact-value', index: 0, field: 'normalX', source: '0' },
    { kind: 'contact-value', index: 0, field: 'normalY', source: '0' },
    { kind: 'contact-value', index: 0, field: 'normalZ', source: '1' },
    { kind: 'contact-value', index: 0, field: 'gap', source: '0.5' },
    { kind: 'contact-factor', index: 0, source: '1' },
    { kind: 'contact-factor-add' },
    { kind: 'contact-factor', index: 1, source: '-1' },
  ];
  for (const edit of edits) session = editBeamSession(session, edit);
  return { ...fixture, member, session };
}

/** One returned load state of the protocol fixture: the end node's translation, and the contact's state, reaction
 * and gap as stated by the test (not a numerical oracle). */
export interface ContactStateFixture {
  readonly end: Vector3;
  readonly state: 'open' | 'closed';
  readonly reactionN: number;
  readonly gapM: number;
}

/** Protocol fixture: counts, node numbers, mesh sizes, moment length and pivot limit come from the real translation of
 * the exact request input, and the real decoder binds it to that input and its digest, as the client does. */
export async function contactResultFor(input: BeamContactInput, states: readonly ContactStateFixture[],
  endNodeId: string): Promise<BeamContactAnalysisResult> {
  const { plan, momentLengthM, nodeIds } = translateBeamContact(input);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const zero: Vector3 = [0, 0, 0];
  return decodeBeamContact({
    schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    meshNodes: plan.nodes.length, meshElements: plan.members.length, momentLengthM,
    pivotLimit: contactPivotLimit(plan.contacts.length),
    states: states.map((row, index) => ({ loadFactor: plan.loadFactors[index], pivots: row.state === 'closed' ? 1 : 0,
      nodes: original.map((node, position) => ({ number: node.number,
        displacementM: nodeIds[position] === endNodeId ? row.end : zero, rotationRad: zero })),
      contacts: plan.contacts.map(contact => ({ id: contact.id, state: row.state, normalReactionN: row.reactionN, gapM: row.gapM })),
      forceScaleN: 1, gapScaleM: 1e-3, equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0 })),
  }, input, await contactInputSha256(input));
}
