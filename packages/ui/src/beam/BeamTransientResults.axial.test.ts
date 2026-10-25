import type { BeamTransientResult, TransientAxialResponse, TransientNodeResponse } from '@pointercad/fem';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { BeamTransientResults } from './BeamTransientResults.js';

const zero = [0, 0, 0] as const;
const node = (solverNode: number, nodeId: string, x: number): TransientNodeResponse => ({ solverNode, nodeId,
  displacementM: [x, 0, 0], rotationRad: zero, velocityMPerS: zero, angularVelocityRadPerS: zero,
  accelerationMPerS2: zero, angularAccelerationRadPerS2: zero });
// Presentation-only values; the numerical derivation is qualified in packages/fem/src/transientAxial.test.ts.
const result: BeamTransientResult = {
  kind: 'oofem-beam-transient-3d', method: 'oofem-beam3d-matrices-newmark-average-acceleration/1',
  scope: 'linear-elastic-undamped-small-displacement-nodal-loads', nativeTransientSolver: false,
  analysisId: 'presentation-only', analysisRevision: 3,
  source: { documentId: 'assembly', documentRevision: 4, geometryRevision: '7' }, inputSha256: 'a'.repeat(64),
  timeStepS: 0.5, stepCount: 2, normalizationLengthM: 2, meshNodes: 2, meshElements: 1, freeDofs: 1,
  maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0,
  peakDisplacementM: 0.002, peakDisplacementTimeS: 0.5, peakDisplacementSolverNode: 2,
  peakRotationRad: 0, peakRotationTimeS: 0, peakRotationSolverNode: 1, structuralCertification: false,
  samples: [{ timeS: 0, loadFactor: 1, nodes: [node(1, 'start', 0), node(2, 'end', 0)] },
    { timeS: 0.5, loadFactor: 1, nodes: [node(1, 'start', 0), node(2, 'end', 0.002)] },
    { timeS: 1, loadFactor: 1, nodes: [node(1, 'start', 0), node(2, 'end', -0.001)] }],
};
// L = 2 m along +x, E = 2e11 Pa: strain = u/2, stress = 2e11 * strain.
const axial: TransientAxialResponse = {
  measure: 'member-mean-linear-axial-from-sampled-end-translations/1', analysisId: 'presentation-only',
  analysisRevision: 3, inputSha256: 'a'.repeat(64), sampleTimesS: [0, 0.5, 1],
  members: [{ memberId: 'beam-1', startNodeId: 'start', endNodeId: 'end', startSolverNode: 1, endSolverNode: 2,
    lengthM: 2, axis: [1, 0, 0], youngPa: 2e11, strain: [0, 0.001, -0.0005], stressPa: [0, 2e8, -1e8],
    maximum: { sample: 1, timeS: 0.5, strain: 0.001, stressPa: 2e8 },
    minimum: { sample: 2, timeS: 1, strain: -0.0005, stressPa: -1e8 } }],
};
const render = (sample: number, value: TransientAxialResponse | null): string =>
  renderToStaticMarkup(createElement(BeamTransientResults, { result, view: { sample, node: 1 }, axial: value }));

describe('transient axial presentation (linear member-mean measure, not a stress or capacity check)', () => {
  it('shows cumulative final energy only for Rayleigh, independently of the selected sample', () => {
    // Presentation fixture only; this is not a physical solver or energy oracle.
    const rayleigh: BeamTransientResult = { ...result,
      method: 'oofem-beam3d-matrices-newmark-average-acceleration/2',
      scope: 'linear-elastic-rayleigh-small-displacement-nodal-loads',
      damping: { kind: 'rayleigh', massCoefficientPerS: 0.4, stiffnessCoefficientS: 0.002 },
      dissipatedEnergyJ: 0.125 };
    const html = renderToStaticMarkup(createElement(BeamTransientResults,
      { result: rayleigh, view: { sample: 0, node: 1 }, axial: null }));
    expect(html).toContain(t('beam.transientDampingRayleigh'));
    expect(html).toContain('0.4 1/s');
    expect(html).toContain('0.002 s');
    expect(html).toContain(t('beam.transientDissipatedEnergy'));
    expect(html).toContain('data-testid="beam-transient-dissipated-energy" data-value="0.125"');
    expect(render(0, null)).not.toContain('data-testid="beam-transient-dissipated-energy"');
    const explicitZero: BeamTransientResult = { ...rayleigh,
      damping: { kind: 'rayleigh', massCoefficientPerS: 0, stiffnessCoefficientS: 0 }, dissipatedEnergyJ: 0 };
    const zeroHtml = renderToStaticMarkup(createElement(BeamTransientResults,
      { result: explicitZero, view: { sample: 2, node: 1 }, axial: null }));
    expect(zeroHtml).toContain('data-testid="beam-transient-dissipated-energy" data-value="0"');
    expect(zeroHtml).toContain(t('beam.transientDampingRayleigh'));
  });

  it('shows the selected sample and the signed sample-only extrema with their times, ends and units', () => {
    const html = render(2, axial);
    expect(html).toContain('data-testid="beam-transient-axial"');
    expect(html).toContain(t('beam.transientAxial'));
    expect(html).toContain(t('beam.transientAxialScope'));
    expect(html).toContain(t('beam.transientAxialLimits'));
    expect(html).toContain('data-beam-transient-axial-member="beam-1"');
    expect(html).toContain('data-quantity="strain" data-value="-0.0005"');
    expect(html).toContain('data-quantity="stress" data-value="-100000000"');
    expect(html).toContain('data-extreme="maximum" data-value="200000000" data-time="0.5"');
    expect(html).toContain('data-extreme="minimum" data-value="-100000000" data-time="1"');
    expect(html).toContain('start (' + t('beam.node') + ' 1)');
    expect(html).toContain('end (' + t('beam.node') + ' 2)');
    expect(html).toContain('(Pa)');
  });

  it('omits the axial table when no matching derived measure exists and never claims a capacity check', () => {
    expect(render(0, null)).not.toContain('beam-transient-axial');
    const full = render(0, axial);
    for (const word of ['ミーゼス', '許容', '安全率']) expect(full).not.toContain(word);
  });
});
