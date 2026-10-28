import { describe, expect, it } from 'vitest';
import { savedBoltFixture } from '../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { prepareNativeBoltPreload } from '../../../fem/src/nativeBoltPreload.js';
import { decodeNativeBoltPreloadOwned, NATIVE_BOLT_KIND } from '../../../fem/src/nativeBoltPreloadBinding.js';
import nativeInputBytes from '../../../fem/src/nativeBoltPreload.input.fixture.json?raw';
import nativeResult from '../../../fem/src/nativeBoltPreload.result.fixture.json';
import { beamUiFixture } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { boltPreloadDraftSavedInput, confirmBoltPreloadDraft, editBoltPreloadDraft, invalidateBoltPreloadDraft,
  restoreBoltPreloadDraft, reviewBoltPreloadDraft, reviewedBoltPreloadWire, type BoltPreloadDraft } from './boltPreloadDraft.js';

/** Real source-admission logic with existing unit publication metadata; no OCCT/native claim. */
function fixture() {
  const f = savedBoltFixture(), ui = beamUiFixture(), view = ui.state.assemblyView;
  if (view === null) throw new Error('Existing fixture view missing');
  const owner = { ...ui.owner, document: f.document, activeDocumentId: f.document.id,
    documentVersion: f.saved.source.documentRevision, generation: 1 };
  // Capture's generation spelling is a real producer contract, not an editable source stamp.
  const geometryRevision = `${f.document.id}:1`;
  const source = { ...f.saved.source, geometryRevision };
  const bolts = f.saved.cadDefinition.axialBolts;
  if (bolts === undefined) throw new Error('Existing bolt association missing');
  const saved = { ...f.saved, source, input: { ...f.saved.input, source },
    cadDefinition: { ...f.saved.cadDefinition, source, axialBolts: { ...bolts, source } } };
  const state = { ...ui.state, assembly: f.document, activeDocumentId: f.document.id,
    documentVersion: source.documentRevision, requestedGeneration: 1, completedGeneration: 1,
    assemblyView: { ...view, sourceDocument: f.document, meshOwnership: owner } };
  const snapshot = captureBeamSource(state);
  if (snapshot === null) throw new Error('Real source-admission fixture failed');
  return { ...f, saved, state, snapshot, session: restoreBoltPreloadDraft(saved) };
}
describe('explicit saved bolt UI draft, pure preparation', () => {
  it('restores unchanged saved values and SI units without defaults or physics', () => {
    const f = savedBoltFixture(), session = restoreBoltPreloadDraft(f.saved);
    expect(boltPreloadDraftSavedInput(session)).toEqual(f.saved);
    expect(session.values.preloadN).toBe('4000');
    expect(Number(session.values.threadCompliance)).toBe(2e-9);
    expect(Number(session.values.memberCompliance)).toBeCloseTo(1 / 600000000, 18);
    expect(session.loadsN).toEqual(['1000', '0']);
    expect(session.confirmed).toBe(false); expect(session.reviewed).toBeNull();
  });
  it('one explicit edit invalidates confirmation, reviewed input and a previously decoded result', async () => {
    const f = fixture(); let session = confirmBoltPreloadDraft(f.session, true);
    session = await reviewBoltPreloadDraft(session, f.snapshot, () => ({ state: f.state, session }));
    // Prior native fixture belongs to its own numeric input. Seed only to test invalidation;
    // this draft has no reply-admission API and never adopts this as a new CAD result.
    const source = { documentId: 'previous-result', revision: 0 };
    const prepared = await prepareNativeBoltPreload(JSON.parse(nativeInputBytes), nativeInputBytes);
    const job = { source, prepared };
    const decoded = decodeNativeBoltPreloadOwned({ ...nativeResult.result, kind: NATIVE_BOLT_KIND, source }, job);
    const edited = editBoltPreloadDraft({ ...session, result: decoded }, { kind: 'number', field: 'preloadN', text: '4100' });
    expect(edited.confirmed).toBe(false); expect(edited.reviewed).toBeNull(); expect(edited.result).toBeNull();
    expect(edited.revision).toBe(f.saved.revision + 1);
    expect(boltPreloadDraftSavedInput(edited).input.declaration.preloadN.value).toBe(4100);
    expect(() => reviewedBoltPreloadWire(edited, f.state)).toThrow();
    expect(invalidateBoltPreloadDraft(session).reviewed).toBeNull();
  });
  it('requires explicit confirmation and prepares through the real CAD adapter', async () => {
    const f = fixture(); let session = f.session;
    await expect(reviewBoltPreloadDraft(session, f.snapshot, () => ({ state: f.state, session }))).rejects.toThrow();
    session = confirmBoltPreloadDraft(session, true);
    session = await reviewBoltPreloadDraft(session, f.snapshot, () => ({ state: f.state, session }));
    const prepared = await prepareNativeBoltPreload(reviewedBoltPreloadWire(session, f.state).plan);
    // Independent approved FB50x6/50+50mm/E200000MPa/A300 and bolt100mm/A100:
    expect(prepared.cm).toBeCloseTo(1 / 600000000, 18);
    expect(prepared.cb).toBeCloseTo(1e-8, 18);
    expect(prepared.plan.shorteningM).toBeCloseTo(7 / 150000, 16);
    expect(boltPreloadDraftSavedInput(session)).toEqual(f.saved);
  });
  it('rejects stale document/geometry/analysis identity and an edit during asynchronous preparation', async () => {
    const f = fixture(); const session = confirmBoltPreloadDraft(f.session, true);
    for (const source of [{ ...f.saved.source, documentId: 'other' },
      { ...f.saved.source, documentRevision: f.saved.source.documentRevision + 1 },
      { ...f.saved.source, geometryRevision: 'other' }]) {
      const old = { ...f.saved, source, input: { ...f.saved.input, source },
        cadDefinition: { ...f.saved.cadDefinition, source, axialBolts: { ...f.definition.axialBolts, source } } };
      const stale = confirmBoltPreloadDraft(restoreBoltPreloadDraft(old), true);
      await expect(reviewBoltPreloadDraft(stale, f.snapshot, () => ({ state: f.state, session: stale }))).rejects.toThrow();
    }
    expect(() => restoreBoltPreloadDraft({ ...f.saved, input: { ...f.saved.input, analysisRevision: 99 } })).toThrow();
    let current: BoltPreloadDraft = session;
    const pending = reviewBoltPreloadDraft(session, f.snapshot, () => ({ state: f.state, session: current }));
    current = editBoltPreloadDraft(session, { kind: 'loads', valuesN: ['0', '1000', '0'] });
    await expect(pending).rejects.toThrow('bolt-draft-stale-review');
    const reviewed = await reviewBoltPreloadDraft(session, f.snapshot, () => ({ state: f.state, session }));
    expect(() => reviewedBoltPreloadWire(reviewed, { ...f.state, documentVersion: f.state.documentVersion + 1 })).toThrow();
  });
  it('rejects unknown saved fields/accessors, blank/NaN/negative values and missing provenance', () => {
    const f = savedBoltFixture(); let invoked = false;
    expect(() => restoreBoltPreloadDraft({ ...f.saved, extra: 1 })).toThrow();
    expect(() => restoreBoltPreloadDraft({ ...f.saved, get extra() { invoked = true; return 1; } })).toThrow();
    expect(invoked).toBe(false);
    const session = restoreBoltPreloadDraft(f.saved);
    for (const text of ['', ' ', 'NaN', 'Infinity', '-1', '0x10']) {
      expect(() => confirmBoltPreloadDraft(editBoltPreloadDraft(session, { kind: 'number', field: 'preloadN', text }), true)).toThrow();
    }
    expect(() => confirmBoltPreloadDraft(editBoltPreloadDraft(session, { kind: 'source', field: 'memberCompliance',
      value: { kind: 'user-supplied', reference: '', condition: '' } }), true)).toThrow();
  });
  it('keeps explicit source edits and ordered external loads in the strict saved roundtrip', () => {
    const f = savedBoltFixture(), source = { kind: 'user-supplied' as const, reference: 'Explicit new shank evidence', condition: 'Same authored E/A, no inferred property' };
    let session = editBoltPreloadDraft(restoreBoltPreloadDraft(f.saved), { kind: 'source', field: 'shankSource', value: source });
    session = editBoltPreloadDraft(session, { kind: 'loads', valuesN: ['0', '1000', '0'] });
    const saved = boltPreloadDraftSavedInput(session);
    expect(saved.input.memberIds).toEqual(['a-beam', 'b-beam']);
    expect(saved.input.declaration.shankSource).toEqual(source);
    expect(saved.cadDefinition.axialBolts?.bolts[0].propertySource).toEqual(source);
    expect(saved.cadDefinition.contact.loadFactors).toEqual([0, 0, 1000, 0]);
    expect(boltPreloadDraftSavedInput(restoreBoltPreloadDraft(saved))).toEqual(saved);
    expect(saved.input.declaration.threadCompliance.value).toBe(2e-9);
  });
});
