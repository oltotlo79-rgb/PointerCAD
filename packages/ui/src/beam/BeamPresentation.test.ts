import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Parameter } from '@pointercad/model';
import type { BeamAnalysisResult } from '@pointercad/model/beam-analysis';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { BeamResults } from './BeamResults.js';
import { beamExpressionField } from './beamFields.js';
import { beamUiFixture } from './beam.testSupport.js';

beforeEach(resetTestStore);

describe('beam physical values in existing presentation controls', () => {
  it('preserves the entered physical unit and uses assembly parameter context for expression inspection', () => {
    const parameters: readonly Parameter[] = [{ name: '荷重', value: { source: '10', value: 10, display: '10' },
      unit: 'none', description: 'Explicit assembly load' }];
    const field = beamExpressionField('endFx', '荷重 N', parameters);
    expect(field.result.value?.value).toBe(10);
    const markup = renderToStaticMarkup(createElement(ExpressionField, {
      ...field, focused: true, onChange: () => undefined, onFocus: () => undefined,
    }));
    expect(markup).toContain('value="荷重 N"');
    expect(markup).toContain('class="pcad-field__unit">N</span>');
    expect(markup).toContain('= 10');
    expect(markup).not.toContain('aria-invalid="true"');
    expect(markup).not.toContain('未定義');
  });

  it('converts SI displacements and moments once, with signs and global axis labels', () => {
    const fixture = beamUiFixture(), member = fixture.session.members[0];
    // Presentation fixture only; actual decoded OOFEM values must also pass the product E2E.
    const result: BeamAnalysisResult = {
      kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic', analysisId: 'view', analysisRevision: 0,
      source: fixture.source.source, inputSha256: '0'.repeat(64), structuralCertification: false,
      nodes: [{ nodeId: member.startNodeId, solverNode: 1, constrained: true,
        displacementM: [0, 0, 0], rotationRad: [0, 0, 0], reactionN: [-10, 0, 0], reactionNm: [0, -20, 0] },
      { nodeId: member.endNodeId, solverNode: 2, constrained: false,
        displacementM: [0.00125, -0.0005, 0], rotationRad: [0, 0.002, 0], reactionN: [0, 0, 0], reactionNm: [0, 0, 0] }],
      elements: [], balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 },
    };
    const markup = renderToStaticMarkup(createElement(BeamResults, { result, members: fixture.session.members }));
    expect(markup).toContain('data-beam-result="displacement-mm"');
    expect(markup).toContain('data-value="1.25"');
    expect(markup).toContain('data-value="-0.5"');
    expect(markup).toContain('data-value="-20000"');
    expect(markup.match(/data-beam-result="reaction-N"/gu)).toHaveLength(1);
    expect(markup).toContain('mm');
    expect(markup).toContain('N·mm');
  });
});
