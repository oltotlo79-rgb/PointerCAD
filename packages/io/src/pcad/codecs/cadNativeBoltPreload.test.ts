import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { savedBoltFixture } from '../../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';
import { readOptionalBeamAnalysisInputs, serializeBeamAnalysisInputs } from './beamAnalysis.js';

describe('assembly-only saved CAD preload PCAD boundary', () => {
  it('roundtrips the real assembly encoder/decoder without persisting results or derived geometry', () => {
    const f = savedBoltFixture(), attachment = { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'native-bolt-preload', definition: f.saved }] };
    const saved = withBeamAnalysisInputs(f.document, attachment), options = { savedAt: '2026-10-27T00:00:00.000Z' };
    const bytes = writeAssemblyDocument(saved, options), reopened = readAssemblyDocument(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(bytes);
    expect(reopened.document.components).toEqual(f.document.components);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs)).not.toMatch(/"(?:states|planSha256|positionM|shorteningM|nativeContactSolver)"/u);
  });
  it('rejects a part owner at both codec entrances, and rejects a foreign document', () => {
    const f = savedBoltFixture(), value = { schema: 'pointercad-beam-inputs/1' as const,
      analyses: [{ kind: 'native-bolt-preload' as const, definition: f.saved }] };
    expect(readOptionalBeamAnalysisInputs({ beamAnalysisInputs: value }, f.document.id, 'part', '$').ok).toBe(false);
    expect(() => serializeBeamAnalysisInputs(value, f.document.id, 'part')).toThrow('assembly');
    expect(readOptionalBeamAnalysisInputs({ beamAnalysisInputs: value }, 'foreign', 'assembly', '$').ok).toBe(false);
  });
  it('rejects corrupt saved versions/fields through the actual codec reader', () => {
    const f = savedBoltFixture();
    for (const definition of [{ ...f.saved, schema: 'unknown' }, { ...f.saved, result: {} },
      { ...f.saved, input: { ...f.saved.input, contactId: 'foreign' } }]) {
      expect(readOptionalBeamAnalysisInputs({ beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1',
        analyses: [{ kind: 'native-bolt-preload', definition }] } }, f.document.id, 'assembly', '$').ok).toBe(false);
    }
  });
});
