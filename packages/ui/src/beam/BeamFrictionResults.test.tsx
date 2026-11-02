import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BeamFrictionContactInput, FrictionContactResult } from '@pointercad/fem';
import { modalFixture } from '../../../fem/src/modal.testSupport.js';
import { t } from '../i18n/t.js';
import { BeamFrictionResults } from './BeamFrictionResults.js';

/** Hand-authored display data: N10, mu .3, tangential demand 2/5/0/-5 gives -2/-3/0/+3.
 * The separate 2 mm gap/1 mm slip/0.003 J cells exercise units only, not equilibrium or native certification. */
function result(): FrictionContactResult {
  const geometry = modalFixture({ free: true, modes: 1, segments: 1 });
  const input: BeamFrictionContactInput = { schema: 'pointercad-beam-friction-contact/1', geometry,
    supports: [], contacts: [{ id: 'plane', kind: 'node-plane', nodeId: 'node-1', normal: [0, 1, 0], gapM: 0 }],
    friction: { plane: .3 }, stepLoads: [[2, -10], [5, -10], [0, 0], [-5, -10]].map(([x, y]) => [
      { id: 'load', kind: 'nodal', nodeId: 'node-1', force: [x, y, 0], moment: [0, 0, 0] }]) };
  return { kind: 'pointercad-internal-friction-contact-candidate', solver: 'newton', iterationLimit: 64, freeDofs: 3,
    analysisId: geometry.id, analysisRevision: geometry.revision, source: geometry.source, inputSha256: 'a'.repeat(64),
    input, nodeIds: ['node-1'], states: [0, 1, 2, 3].map((step): FrictionContactResult['states'][number] => ({ step, iterations: 1,
      forceScaleN: 10, gapScaleM: 1, equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0,
      frictionConeExcess: 0, slipLawResidual: 0,
      nodes: [{ number: 2, displacementM: [.001, -.002, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'plane', state: step === 0 ? 'stick' : step === 2 ? 'open' : 'slip', frictionCoefficient: .3,
        normalReactionN: [10, 10, 0, 10][step], gapM: .002, frictionForceN: [[-2, -3, 0, 3][step], 0, 0],
        slipIncrementM: [.001, 0, 0], accumulatedSlipM: [-.001, 0, 0], slipPathLengthM: .001, dissipatedWorkJ: .003 }] })) };
}
describe('friction history presentation (independent SI fixture, no solve)', () => {
  it('retains physical stage order, contact identity and the four signed force expectations', () => {
    const markup = renderToStaticMarkup(<BeamFrictionResults result={result()} />);
    expect([...markup.matchAll(/data-friction-step="(\d+)"/gu)].map(m => m[1])).toEqual(['0', '1', '2', '3']);
    const steps = markup.split(/<details[^>]*data-friction-step="\d+"[^>]*>/u).slice(1);
    for (const [index, force] of [-2, -3, 0, 3].entries()) {
      expect(steps[index]).toContain(`data-unit="N" data-value="${[10, 10, 0, 10][index]}"`);
      expect(steps[index]).toContain(`data-component="0" data-unit="N" data-value="${force}">${force}</td>`);
      expect(steps[index]).toContain('data-friction-contact="plane"');
    }
    expect(markup).toContain(t('beam.frictionStick'));expect(markup).toContain(t('beam.frictionSlip'));
    expect(markup).toContain(t('beam.contactOpen'));expect(markup).not.toContain('pointercad-internal');
  });
  it('converts metres once, preserves SI attributes, and keeps work in joules', () => {
    const markup = renderToStaticMarkup(<BeamFrictionResults result={result()} />);
    expect(markup).toContain('data-unit="m" data-value="0.002">2</td>');
    expect(markup).toContain('data-component="0" data-unit="m" data-value="0.001">1</td>');
    expect(markup).toContain('data-component="0" data-unit="m" data-value="-0.001">-1</td>');
    expect(markup).toContain('data-component="1" data-unit="m" data-value="-0.002">-2</td>');
    expect(markup).toContain('data-unit="J" data-value="0.003">0.003</td>');
    expect(markup).toContain(t('beam.frictionScope'));
    expect(markup).not.toContain('equilibriumResidual');
  });
  it('labels frictionless closed contact independently of stick or slip', () => {
    const source = result();
    const closed = { ...source, states: source.states.map(row => ({ ...row,
      contacts: row.contacts.map(c => ({ ...c, state: 'closed' as const, frictionCoefficient: 0 })) })) };
    expect(renderToStaticMarkup(<BeamFrictionResults result={closed} />)).toContain(t('beam.contactClosed'));
  });
});
