import { describe, expect, it } from 'vitest';
import { standardMembersToBeamAnalysis } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';

describe('modal CAD input persistence and fresh geometry regeneration', () => {
  it('round-trips only versioned inputs, then regenerates shared CAD geometry under fresh revision evidence', () => {
    const fixture = beamCadFixture();
    const definition = { ...fixture.definition, schema: 'pointercad-standard-beam/2' as const,
      modal: { modeCount: 4, segmentsPerMember: 12 }, loads: [] };
    const document = withBeamAnalysisInputs(fixture.document, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'standard-members', definition }] });
    const options = { savedAt: '2026-10-11T00:00:00.000Z' };
    const serialized = writeAssemblyDocument(document, options);
    const decoded = readAssemblyDocument(serialized);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(writeAssemblyDocument(decoded.document, options)).toBe(serialized);
    const saved = decoded.document.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'standard-members') throw new Error('Saved modal inputs absent');
    expect(saved.definition).toEqual(definition);
    expect(JSON.stringify(saved)).not.toMatch(/"(?:nodes|modes|frequencyHz|results|worldPlacement)"/u);
    const fresh = { ...fixture.stamp, documentRevision: fixture.stamp.documentRevision + 1,
      geometryRevision: 'fresh-regenerated-modal-geometry' };
    const stale = standardMembersToBeamAnalysis(decoded.document, saved.definition,
      { currentSource: fresh, bodies: new Map(), assemblyOptions: {} });
    expect(stale.ok).toBe(false);
    const regenerated = standardMembersToBeamAnalysis(decoded.document, { ...saved.definition, source: fresh },
      { currentSource: fresh, bodies: new Map(), assemblyOptions: {} });
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) throw new Error(regenerated.issue.message);
    expect(regenerated.document.schema).toBe('pointercad-beam/2');
    expect(regenerated.document.modal).toEqual(definition.modal);
    expect(regenerated.document.loads).toEqual([]);
    expect(regenerated.document.source).toEqual(fresh);
  });

  it('rejects result injection and unknown modal settings through the actual document codec', () => {
    const fixture = beamCadFixture();
    for (const extra of [{ modes: [] }, { modal: { modeCount: 4, segmentsPerMember: 8, solver: 'arbitrary' } }]) {
      expect(() => withBeamAnalysisInputs(fixture.document, { schema: 'pointercad-beam-inputs/1', analyses: [{
        kind: 'standard-members', definition: { ...fixture.definition, schema: 'pointercad-standard-beam/2',
          modal: { modeCount: 4, segmentsPerMember: 8 }, loads: [], ...extra },
      }] })).toThrow();
    }
  });
});
