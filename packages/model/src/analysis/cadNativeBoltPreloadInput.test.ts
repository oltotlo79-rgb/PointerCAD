import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs, readCadNativeBoltPreloadSavedInput } from './beamInputs.js';
import { readCadNativeBoltPreloadInput } from './cadNativeBoltPreloadInput.js';
import { savedBoltFixture } from './cadNativeBoltPreloadInput.testSupport.js';

describe('saved CAD native bolt preload input', () => {
  it('preserves the old standard-member read and roundtrips the separate saved kind', () => {
    const f = savedBoltFixture();
    const legacy = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: f.definition }] };
    expect(readBeamAnalysisInputs(legacy, f.document.id)).toEqual({ ok: true, value: legacy });
    expect(readCadNativeBoltPreloadSavedInput(JSON.parse(JSON.stringify(f.saved)))).toEqual(f.saved);
    const next = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'native-bolt-preload', definition: f.saved }] };
    expect(readBeamAnalysisInputs(next, f.document.id)).toEqual({ ok: true, value: next });
    expect(readBeamAnalysisInputs(next, 'foreign').ok).toBe(false);
    expect(f.saved.input.declaration.memberCompliance.value).toBe(5 / 3 * 1e-9);
    expect(f.saved.cadDefinition.sections[0].area).toBe(300);
  });
  it('refuses unknown versions, fields, derived state, missing sources and non-JSON accessors', () => {
    const f = savedBoltFixture(); let invoked = false;
    for (const v of [{ ...f.saved, schema: 'pointercad-cad-native-bolt-preload-saved/2' },
      { ...f.saved, states: [] }, { ...f.saved, worldPosition: [0, 0, 0] },
      { ...f.saved, input: { ...f.saved.input, schema: 'unknown' } },
      { ...f.saved, input: { ...f.saved.input, declaration: { ...f.saved.input.declaration, preloadN: { value: 4000 } } } },
      { ...f.saved, get hidden() { invoked = true; return 1; } },
    ]) expect(() => readCadNativeBoltPreloadSavedInput(v)).toThrow();
    expect(invoked).toBe(false);
    const { threadCompliance, ...missing } = f.saved.input.declaration;
    expect(threadCompliance.value).toBe(2e-9);
    expect(() => readCadNativeBoltPreloadInput({ ...f.saved.input, declaration: missing })).toThrow();
  });
  it('refuses contradictions in source, analysis generation and every selected identity', () => {
    const f = savedBoltFixture(), i = f.saved.input;
    for (const input of [{ ...i, source: { ...i.source, documentId: 'foreign' } },
      { ...i, source: { ...i.source, documentRevision: i.source.documentRevision + 1 } },
      { ...i, source: { ...i.source, geometryRevision: 'other' } }, { ...i, analysisId: 'other' },
      { ...i, analysisRevision: i.analysisRevision + 1 }, { ...i, boltComponentId: 'other' },
      { ...i, contactId: 'other' }, { ...i, memberIds: ['b-beam', 'a-beam'] },
      { ...i, declaration: { ...i.declaration, boltId: 'other' } },
    ]) expect(() => readCadNativeBoltPreloadSavedInput({ ...f.saved, input })).toThrow();
  });
  it('refuses changed contact stage order and topology without calculating stiffness or stress', () => {
    const f = savedBoltFixture();
    for (const cadDefinition of [{ ...f.definition, contact: { ...f.definition.contact, loadFactors: [0, 0, 1000] } },
      { ...f.definition, contact: { ...f.definition.contact, segmentsPerMember: 2 } },
      { ...f.definition, contact: { ...f.definition.contact, contacts: [{ ...f.definition.contact.contacts[0], nodeIdA: 'a-base' }] } },
    ]) expect(() => readCadNativeBoltPreloadSavedInput({ ...f.saved, cadDefinition })).toThrow();
  });
});
