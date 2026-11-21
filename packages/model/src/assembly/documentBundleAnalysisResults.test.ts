import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BeamAnalysisResult, SavedAnalysisResult } from '../analysis/index.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { createAssemblyDocument } from './createAssemblyDocument.js';
import { createAssemblyDocumentBundle, createPartDocumentBundle, partLibraryOfBundle } from './documentBundle.js';
import { embedPart, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments } from './partLibrary.js';

function savedBeamResult(documentId: string, analysisRevision: number): SavedAnalysisResult {
  const result: BeamAnalysisResult = {
    kind: 'oofem-linear-beam-3d',
    model: 'linear-timoshenko-isotropic',
    analysisId: 'beam-1',
    analysisRevision,
    source: { documentId, documentRevision: 1, geometryRevision: `${documentId}:1` },
    inputSha256: '1'.repeat(64),
    nodes: [{ nodeId: 'node-1', solverNode: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0],
      reactionN: [0, 1, 0], reactionNm: [0, 0, 0], constrained: true }],
    elements: [],
    balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 },
    structuralCertification: false,
  };
  return { analysisId: result.analysisId, kind: result.kind, analysisRevision, bindingSha256: '2'.repeat(64),
    appVersion: '1.0.4', result };
}

describe('文書の束に含める保存済み解析結果', () => {
  it('部品・アセンブリとも、結果の指定なしと空の表では既存のキーだけを持つ', () => {
    const part = createEmptyPartDocument();
    const assembly = createAssemblyDocument('組立1');
    const emptyResults = new Map<string, SavedAnalysisResult>();
    const partKeys = ['kind', 'document', 'attachments'];
    const assemblyKeys = ['kind', 'document', 'attachments', 'partFiles', 'embeddedDocuments', 'embeddedAssemblies'];

    expect(Reflect.ownKeys(createPartDocumentBundle(part))).toEqual(partKeys);
    expect(Reflect.ownKeys(createPartDocumentBundle(part, undefined, emptyResults))).toEqual(partKeys);
    expect(Reflect.ownKeys(createAssemblyDocumentBundle(assembly))).toEqual(assemblyKeys);
    expect(Reflect.ownKeys(createAssemblyDocumentBundle(assembly, undefined, emptyResults))).toEqual(assemblyKeys);
  });

  it('部品の文書と原本を保ち、梁の静解析結果をそのまま持つ', () => {
    const document = createEmptyPartDocument();
    const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(1, 2, 3)]]) };
    const saved = savedBeamResult(document.id, 1);
    const { analysisResults, ...otherFields } = createPartDocumentBundle(document, attachments,
      new Map([[saved.analysisId, saved]]));

    expect(otherFields).toStrictEqual(createPartDocumentBundle(document, attachments));
    expect(otherFields.document).toBe(document);
    expect(otherFields.attachments).toBe(attachments);
    expect(analysisResults?.get(saved.analysisId)).toBe(saved);
    expect(analysisResults?.get(saved.analysisId)?.result).toBe(saved.result);
    expectTypeOf<SavedAnalysisResult['result']>().toEqualTypeOf<BeamAnalysisResult>();
    expectTypeOf<SavedAnalysisResult['kind']>().toEqualTypeOf<BeamAnalysisResult['kind']>();
  });

  it('組立の結果を足しても抱き込んだ部品・添付・サブアセンブリを保つ', async () => {
    const document = createAssemblyDocument('組立1');
    const part = createEmptyPartDocument();
    const attachments = { ...emptyEmbeddedPartAttachments(), canvases: new Map([['image-1', Uint8Array.of(4, 5)]]) };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'part.pcad', './part.pcad',
      { importedAt: '2026-09-07T00:00:00.000Z', attachments });
    const child = { ...createAssemblyDocument('子組立'), id: 'assembly-2' };
    const library = { ...embedded.library, assemblies: new Map([[child.id, child]]) };
    const saved = savedBeamResult(document.id, 1);
    const bundle = createAssemblyDocumentBundle(document, library, new Map([[saved.analysisId, saved]]));
    const { analysisResults, ...otherFields } = bundle;

    expect(otherFields).toStrictEqual(createAssemblyDocumentBundle(document, library));
    expect(partLibraryOfBundle(bundle)).toStrictEqual(library);
    expect(bundle.embeddedDocuments.get(embedded.partRef)?.attachments).toBe(attachments);
    expect(analysisResults?.get(saved.analysisId)?.result).toBe(saved.result);
  });

  it.each(['part', 'assembly'] as const)('%s の次の束で同じ解析 ID を差し替えても前の結果を保つ', kind => {
    const part = createEmptyPartDocument();
    const assembly = createAssemblyDocument('組立1');
    const document = kind === 'part' ? part : assembly;
    const before = savedBeamResult(document.id, 1);
    const after = savedBeamResult(document.id, 2);
    const results = new Map([[before.analysisId, before]]);
    const makeBundle = () => kind === 'part'
      ? createPartDocumentBundle(part, undefined, results) : createAssemblyDocumentBundle(assembly, undefined, results);
    const first = makeBundle();

    results.set(after.analysisId, after);
    const next = makeBundle();

    expect(first.analysisResults?.get(before.analysisId)).toBe(before);
    expect(next.analysisResults?.get(after.analysisId)).toBe(after);
  });
});
