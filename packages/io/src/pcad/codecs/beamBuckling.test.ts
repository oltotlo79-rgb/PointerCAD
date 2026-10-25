import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { bucklingCadFixture } from '../../../../model/src/analysis/beamBuckling.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from '../schema.js';

describe('buckling input codec', () => {
  it('round-trips explicit inputs exactly with no derived geometry or results', () => {
    const fixture = bucklingCadFixture();
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: fixture.definition },
    ] };
    const document = withBeamAnalysisInputs(fixture.document, attachment);
    const options = { savedAt: '2026-10-11T00:00:00.000Z' };
    const serialized = writeAssemblyDocument(document, options);
    const reopened = readAssemblyDocument(serialized);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(serialized);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs)).not.toMatch(/"(?:nodes|modes|factors|results|worldPlacement)"/u);
    expect(reopened.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });

  it('refuses unknown definitions and result injection through the real file reader', () => {
    const fixture = bucklingCadFixture();
    const document = withBeamAnalysisInputs(fixture.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: fixture.definition },
    ] });
    const serialized = writeAssemblyDocument(document, { savedAt: '2026-10-11T00:00:00.000Z' });
    expect(readAssemblyDocument(serialized.replace('pointercad-standard-beam/3', 'pointercad-standard-beam/999')).ok).toBe(false);
    const injected = serialized.replace('"referenceLoads":', '"results":[],"referenceLoads":');
    expect(injected).not.toBe(serialized);
    expect(readAssemblyDocument(injected).ok).toBe(false);
  });
});
