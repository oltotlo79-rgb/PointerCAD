import { decodeSolidAnalysis, solidInputSha256 } from '@pointercad/fem';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { readSolidCadSavedInput, withBeamAnalysisInputs, type SavedAnalysisResult,
  type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { analyticalSolid } from '../fatigue/fatigueSolid.testSupport.js';
import { t } from '../i18n/t.js';
import { openedSolidResult, openedSolidResults, restoreSavedSolid, SAVED_SOLID_NOTICE_KEYS, solidResultsToSave,
  type OpenedSolidResults, type SavedSolid } from './savedSolidResults.js';
import { createSolidAnalysisSession, type SolidAnalysisSession } from './solidAnalysisSession.js';

/**
 * J-03b stage 2, screen side: which static solid result goes into the save, and how an opened one comes back. The digest
 * check runs the real fem solidInputSha256 and decodeSolidAnalysis on the independent one-tet analytical result
 * (fatigueSolid.testSupport.ts: u = 0.03 mm, sigma_xx = 6 MPa); no solver, store or worker is involved.
 */
const GENERATION = 7;
const VERSION = '1.0.4';

function savedInput(documentId: string): SolidCadSavedInput {
  return readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId },
    bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200, poisson: 0, tractionMPa: [1, 0, 0],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 0.1 });
}

function documentWithInput(): { readonly document: PartDocument; readonly definition: SolidCadSavedInput } {
  const empty = createEmptyPartDocument(), definition = savedInput(empty.id);
  return { document: withBeamAnalysisInputs(empty, { schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'solid-cad', definition }] }), definition };
}

async function finished(document: PartDocument, definition: SolidCadSavedInput, generation = GENERATION) {
  const outcome = await analyticalSolid(document.id, generation);
  const session: SolidAnalysisSession = { ...createSolidAnalysisSession(document.id, definition), status: 'complete', result: outcome };
  return { outcome, session };
}

/** The store fields the manual and automatic saves pass; the app version is passed explicitly so an unknown one can be tried. */
function savedSolidResults(document: PartDocument, session: SolidAnalysisSession | null, generation: number,
  opened: OpenedSolidResults | null, version: string | null): ReadonlyMap<string, SavedAnalysisResult> | undefined {
  return solidResultsToSave({ solidAnalysisSession: session, completedGeneration: generation, solidOpenedResults: opened },
    document, version);
}

function only(results: ReadonlyMap<string, SavedAnalysisResult> | undefined, id: string): SavedSolid {
  const saved = results?.get(id);
  if (results?.size !== 1 || saved?.kind !== 'oofem-linear-solid-tet4') throw new Error('Expected exactly one saved solid result');
  return saved;
}

describe('saved static solid results (J-03b stage 2)', () => {
  it('saves a finished result of the saved input with its solver input, and nothing otherwise', async () => {
    const { document, definition } = documentWithInput();
    const { outcome, session } = await finished(document, definition);
    const saved = only(savedSolidResults(document, session, GENERATION, null, VERSION), definition.id);
    expect(saved).toMatchObject({ analysisId: definition.id, analysisRevision: 0, appVersion: VERSION });
    expect(saved.result).toBe(outcome.result);
    expect(saved.mesh).toBe(outcome.mesh);
    expect(saved.prepared).toBe(outcome.prepared);
    expect(savedSolidResults(document, session, GENERATION, null, null)).toBeUndefined();
    expect(savedSolidResults(document, session, GENERATION + 1, null, VERSION)).toBeUndefined();
    expect(savedSolidResults(document, { ...session, status: 'editing' }, GENERATION, null, VERSION)).toBeUndefined();
    expect(savedSolidResults(document, { ...session, values: { ...session.values, young: '300' } }, GENERATION, null, VERSION))
      .toBeUndefined();
    expect(savedSolidResults(createEmptyPartDocument(), session, GENERATION, null, VERSION)).toBeUndefined();
  });

  it('keeps an opened result only for that very document and the saved definition', async () => {
    const { document, definition } = documentWithInput();
    const { session } = await finished(document, definition);
    const results = savedSolidResults(document, session, GENERATION, null, VERSION);
    const opened = openedSolidResults(document, results, undefined);
    expect(openedSolidResult(document, opened)).toBe(results?.get(definition.id));
    expect(savedSolidResults(document, null, GENERATION, opened, VERSION)?.get(definition.id)).toBe(results?.get(definition.id));
    expect(openedSolidResult({ ...document }, opened)).toBeUndefined();
    expect(savedSolidResults({ ...document }, null, GENERATION, opened, VERSION)).toBeUndefined();
    expect(openedSolidResults(document, undefined, undefined)).toBeNull();
    expect(openedSolidResults(document, undefined, 'bindingMismatch')).toEqual({ document, results: new Map(), issue: 'bindingMismatch' });
  });

  it('restores a result whose kept solver input matches its digest, rebound to the current generation', async () => {
    const { document, definition } = documentWithInput();
    const { session } = await finished(document, definition);
    const saved = only(savedSolidResults(document, session, GENERATION, null, VERSION), definition.id);
    const restored = await restoreSavedSolid(saved, 11);
    if (restored.kind !== 'restored') throw new Error(`Expected a restored result, got ${restored.kind}`);
    const { outcome } = restored;
    expect([outcome.result.source.revision, outcome.prepared.input.source.revision, outcome.mesh.input.source.revision])
      .toEqual([11, 11, 11]);
    expect(outcome.result.inputSha256).toBe(await solidInputSha256(outcome.prepared.input));
    expect(outcome.result.displacementMm).toEqual(saved.result.displacementMm);
    expect(outcome.result.elements).toEqual(saved.result.elements);
    expect(outcome.prepared.totalForceN).toEqual(saved.prepared?.totalForceN);
    expect(saved.result.source.revision).toBe(GENERATION);
    // Saving the restored result again keeps a pair that the next opening accepts too.
    const again = only(savedSolidResults(document, { ...session, result: outcome }, 11, null, VERSION), definition.id);
    expect((await restoreSavedSolid(again, 12)).kind).toBe('restored');
  });

  it('refuses a result whose kept solver input does not match its digest', async () => {
    const { document, definition } = documentWithInput();
    const { session } = await finished(document, definition);
    const saved = only(savedSolidResults(document, session, GENERATION, null, VERSION), definition.id);
    const prepared = saved.prepared;
    if (prepared === undefined) throw new Error('Missing solver input');
    const changed: SavedSolid = { ...saved, prepared: { ...prepared,
      input: { ...prepared.input, nodalLoads: [{ node: 1, forceN: [2, 0, 0] }] } } };
    expect(await restoreSavedSolid(changed, 11)).toEqual({ kind: 'refused', notice: 'inputMismatch' });
  });

  it('comes back through the real part file writer and reader and is restored from the reopened document', async () => {
    const { document, definition } = documentWithInput();
    const base = await analyticalSolid(document.id, GENERATION), meshKey = 'a'.repeat(64);
    // The file keeps SHA-256 mesh keys and the mesher kind that belongs to the input schema; the same analytical tet is
    // decoded again under such a key.
    const input = { ...base.prepared.input, source: { ...base.prepared.input.source, meshKey } };
    const native = base.result;
    const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
      displacementMm: native.displacementMm, elementForcesN: native.nativeElementForcesN,
      reservedNumericBytes: native.reservedNumericBytes, minimumScaledPivot: native.minimumScaledPivot },
    input, await solidInputSha256(input));
    const outcome = { kind: 'result' as const, result, prepared: { ...base.prepared, input },
      mesh: { ...base.mesh, kind: 'netgen-convex-tetra-mesh' as const, inputSha256: meshKey } };
    const session: SolidAnalysisSession = { ...createSolidAnalysisSession(document.id, definition), status: 'complete', result: outcome };
    const bytes = writePcadFile(document, { savedAt: '2026-11-22T00:00:00.000Z',
      analysisResults: savedSolidResults(document, session, GENERATION, null, VERSION) });
    const read = readPcadFile(bytes);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.analysisResultIssue).toBeUndefined();
    const saved = openedSolidResult(read.document, openedSolidResults(read.document, read.analysisResults, read.analysisResultIssue));
    if (saved === undefined) throw new Error('The reopened document lost its saved result');
    expect(saved.prepared?.input).toEqual(input);
    const restored = await restoreSavedSolid(saved, 11);
    if (restored.kind !== 'restored') throw new Error(`Expected a restored result, got ${restored.kind}`);
    expect(restored.outcome.result.displacementMm).toEqual(result.displacementMm);
  });

  it('falls back to the limited view for a result saved without its solver input, not to a corrupt file', async () => {
    const { document, definition } = documentWithInput();
    const { session } = await finished(document, definition);
    const saved = only(savedSolidResults(document, session, GENERATION, null, VERSION), definition.id);
    const withoutInput: SavedSolid = { analysisId: saved.analysisId, kind: saved.kind, analysisRevision: saved.analysisRevision,
      bindingSha256: saved.bindingSha256, appVersion: saved.appVersion, result: saved.result, mesh: saved.mesh };
    expect(await restoreSavedSolid(withoutInput, 11)).toEqual({ kind: 'limited', notice: 'noSolverInput' });
    expect(t(SAVED_SOLID_NOTICE_KEYS.noSolverInput)).not.toBe(t(SAVED_SOLID_NOTICE_KEYS.invalidResult));
    for (const key of Object.values(SAVED_SOLID_NOTICE_KEYS)) expect(t(key).length, key).toBeGreaterThan(0);
  });
});
