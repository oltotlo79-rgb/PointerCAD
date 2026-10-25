import type { BeamBucklingResult } from '@pointercad/fem';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { BeamBucklingResults } from './BeamBucklingResults.js';

const result: BeamBucklingResult = {
  kind: 'oofem-beam-buckling-3d', method: 'oofem-axial-geometric-stiffness-flexural-eigh/1',
  scope: 'linear-elastic-axial-prestress-flexural-buckling', analysisId: 'presentation-only', analysisRevision: 2,
  source: { documentId: 'assembly', documentRevision: 4, geometryRevision: '7' }, inputSha256: 'a'.repeat(64),
  normalizationLengthM: 2, meshNodes: 2, meshElements: 1, freeDofs: 6,
  referenceEquilibriumResidual: 1e-12, maximumStiffnessOrthogonalityError: 2e-12, structuralCertification: false,
  modes: [{ number: 1, loadFactor: 12.5, normalizedResidual: 3e-12, nodes: [
    { solverNode: 2, nodeId: 'end', positionM: [2, 0, 0], translation: [0, 1, 0], rotation: [0, 0, 0.5] },
    { solverNode: 1, nodeId: 'start', positionM: [0, 0, 0], translation: [0, 0, 0], rotation: [0, 0, 0] },
  ] }],
};

describe('buckling result presentation (relative shapes, not numerical qualification)', () => {
  it('labels dimensionless reference-load factors and relative mode components without displacement or frequency units', () => {
    const html = renderToStaticMarkup(<BeamBucklingResults result={result} edges={[[1, 2]]} />);
    expect(html).toContain(t('beam.bucklingResults'));
    expect(html).toContain(t('beam.loadFactor'));
    expect(html).toContain('data-beam-load-factor="12.5"');
    expect(html).toContain(t('beam.bucklingNormalization'));
    expect(html).toContain(t('beam.bucklingResultScope'));
    expect(html).toContain('uX/L');
    expect(html).toContain('θZ');
    expect(html).toContain('data-component="5" data-value="0.5"');
    expect(html).toContain('data-testid="beam-buckling-length">2 m');
    expect(html).not.toContain(' Hz');
    expect(html).not.toContain(t('beam.displacement'));
    expect(html).not.toContain('12.5 N');
  });

  it('draws actual element pairs in all three projections using solver identities, independent of node-array order', () => {
    const html = renderToStaticMarkup(<BeamBucklingResults result={result} edges={[[1, 2]]} />);
    expect(html.match(/<svg /gu)).toHaveLength(3);
    expect(html.match(/<line /gu)).toHaveLength(6);
    expect(html).toContain('x1="30" y1="110" x2="190" y2="97.2"');
    expect(html).toContain('stroke-dasharray="3 3"');
    expect(html).toContain('data-beam-buckling-mode="1"');
    expect(html).toContain('data-beam-eigen-residual="3e-12"');
    const withMissingNode = renderToStaticMarkup(<BeamBucklingResults result={result} edges={[[1, 99]]} />);
    expect(withMissingNode).not.toContain('<line ');
  });
});
