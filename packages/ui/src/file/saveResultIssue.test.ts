import { decodeSolidAnalysis, solidInputSha256 } from '@pointercad/fem';
import { encodeSaveDocument, readPcadFile } from '@pointercad/io';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { readSolidCadSavedInput, withBeamAnalysisInputs, type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyticalSolid } from '../fatigue/fatigueSolid.testSupport.js';
import { t } from '../i18n/t.js';
import { createSolidAnalysisSession } from '../solidAnalysis/solidAnalysisSession.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FileGateway } from './fileGateway.js';
import { savePart } from './partFile.js';
import { createPcadSaveEncoder, type PcadSaveWorkerPort } from './pcadSaveWorker.js';
import { encodeOwnedSaveInput, encodeOwnedSaveInputParts } from './pcadSaveWorkerEncoding.js';
import { savedMessageKey } from './saveResultIssue.js';

/**
 * ui-2b: a result the writer leaves out (J-03b stage 2) no longer disappears silently. The save Worker's own encoding
 * (pcadSaveWorkerEncoding) collects the codes, the success reply carries them, the client hands them to the caller, and the
 * part save names the reason in its saved message. The port runs the Worker's encoding in-process (no Worker thread).
 */
function workerPort(): PcadSaveWorkerPort {
  const port: PcadSaveWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, terminate: () => undefined,
    postMessage: (value, transfer) => {
      if (!('input' in value)) return;
      const request = structuredClone(value, { transfer });
      const reply = (data: unknown): void => { port.onmessage?.(new MessageEvent('message', { data })); };
      const issues = (list: readonly unknown[]) => list.length === 0 ? {} : { analysisResultIssues: list };
      void (request.replyAsParts === true
        ? encodeOwnedSaveInputParts(request.input, () => undefined).then(({ parts, analysisResultIssues }) => {
          reply({ id: request.id, kind: 'success', parts, ...issues(analysisResultIssues) }); })
        : encodeOwnedSaveInput(request.input, () => undefined).then(({ bytes, analysisResultIssues }) => {
          reply({ id: request.id, kind: 'success', bytes, ...issues(analysisResultIssues) }); }));
    } };
  return port;
}

function savedInput(documentId: string): SolidCadSavedInput {
  return readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId },
    bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200, poisson: 0, tractionMPa: [1, 0, 0],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 0.1 });
}

/**
 * The independent one-tet analytical result at the store's generation. As fatigueSolid.testSupport.ts builds it, its mesher
 * kind does not belong to its input schema, so the writer refuses it (invalidResult). `fileReady` re-keys it with a SHA-256
 * mesh key and the matching kind, which the writer accepts.
 */
async function storeWithSolidResult(fileReady: boolean): Promise<{ readonly document: PartDocument; readonly saved: Uint8Array[] }> {
  const empty = createEmptyPartDocument(), definition = savedInput(empty.id);
  const document = withBeamAnalysisInputs(empty, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition }] });
  useAppStore.getState().applyDocument(document);
  const generation = useAppStore.getState().completedGeneration;
  const base = await analyticalSolid(document.id, generation), meshKey = 'a'.repeat(64);
  const input = fileReady ? { ...base.prepared.input, source: { ...base.prepared.input.source, meshKey } } : base.prepared.input;
  const native = base.result;
  const result = fileReady ? decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: native.displacementMm, elementForcesN: native.nativeElementForcesN,
    reservedNumericBytes: native.reservedNumericBytes, minimumScaledPivot: native.minimumScaledPivot },
  input, await solidInputSha256(input)) : native;
  const mesh = fileReady ? { ...base.mesh, kind: 'netgen-convex-tetra-mesh' as const, inputSha256: meshKey } : base.mesh;
  useAppStore.setState({ solidAnalysisSession: { ...createSolidAnalysisSession(document.id, definition), status: 'complete',
    result: { kind: 'result', result, prepared: { ...base.prepared, input }, mesh } } });
  const saved: Uint8Array[] = [];
  const gateway: FileGateway = { openPcad: () => Promise.resolve(null), hasSaveTarget: () => false,
    savePcad: (_name, bytes) => { saved.push(bytes); return Promise.resolve('部品.pcad'); } };
  useAppStore.setState({ fileGateway: gateway });
  return { document, saved };
}

const deps = { captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };

beforeEach(() => {
  useAppStore.setState({ ...createInitialDocumentState(), saveDocumentEncoder: createPcadSaveEncoder(workerPort),
    documentSaveOperation: null, solidAnalysisSession: null, solidOpenedResults: null });
});

describe('保存で入れなかった解析の結果の理由(ui-2b)', () => {
  it('chooses the saved message from the first refused result and keeps the plain one otherwise', () => {
    expect(savedMessageKey([])).toBe('file.saved');
    expect(savedMessageKey([{ analysisId: 'a', issue: 'resultTooLarge' }])).toBe('file.savedWithoutResult.tooLarge');
    expect(savedMessageKey([{ analysisId: 'a', issue: 'invalidResult' }, { analysisId: 'b', issue: 'resultTooLarge' }]))
      .toBe('file.savedWithoutResult.invalid');
    const texts = (['file.saved', 'file.savedWithoutResult.invalid', 'file.savedWithoutResult.tooLarge'] as const).map(key => t(key));
    expect(new Set(texts).size).toBe(3);
  });

  it('the save Worker reply carries the refused result to the caller of the encoder', async () => {
    const reported: [string, string][] = [];
    const document = createEmptyPartDocument(), base = await analyticalSolid(document.id, 0);
    const saved = { analysisId: 'solid-cad', kind: base.result.kind, analysisRevision: 0, bindingSha256: '', appVersion: '1.0.4',
      result: base.result, mesh: base.mesh, prepared: base.prepared };
    const bytes = await createPcadSaveEncoder(workerPort)({ kind: 'part', document,
      options: { savedAt: '2026-11-22T00:00:00.000Z', analysisResults: new Map([['solid-cad', saved]]) } },
    { onAnalysisResultIssue: (id, issue) => { reported.push([id, issue]); } });
    expect(reported).toEqual([['solid-cad', 'invalidResult']]);
    const read = readPcadFile(bytes);
    expect(read.ok && read.analysisResults === undefined).toBe(true);
  });

  it('a part save names the reason when the writer leaves the solid result out, and the document is still saved', async () => {
    const { document, saved } = await storeWithSolidResult(false);
    await savePart(deps, false);
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.savedWithoutResult.invalid', failed: false });
    expect(saved).toHaveLength(1);
    const read = readPcadFile(saved[0]);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.document).toEqual(document);
    expect(read.analysisResults).toBeUndefined();
  });

  it('a part save keeps the plain message and the result when the writer accepts it (also with the in-thread encoder)', async () => {
    for (const encoder of [createPcadSaveEncoder(workerPort), encodeSaveDocument]) {
      useAppStore.setState({ saveDocumentEncoder: encoder });
      const { saved } = await storeWithSolidResult(true);
      await savePart(deps, false);
      expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.saved', failed: false });
      const read = readPcadFile(saved[0]);
      if (!read.ok) throw new Error(read.error.message);
      expect(read.analysisResults?.get('solid-cad')?.kind).toBe('oofem-linear-solid-tet4');
    }
  });
});
