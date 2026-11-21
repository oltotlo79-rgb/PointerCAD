import {
  createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPartDocumentBundle,
  embedPart, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments, type DocumentBundle,
} from '@pointercad/model';
import type { BeamAnalysisResult, SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { IO_LIMITS } from '../limits.js';
import { analysisResultBinding } from './analysisResultBinding.js';
import { isRecord } from './guards.js';
import { readDocumentBundle, readDocumentBundleEntries, readPcadFile, writeDocumentBundle } from './pcadFile.js';
import { encodeSaveDocument } from './saveDocumentEncoding.js';

const savedAt = '2026-01-02T03:04:05.000Z';
const options = { savedAt };
const entry = 'analysis-results/beam-1.json';
const secondEntry = 'analysis-results/beam-2.json';

function record(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(strFromU8(bytes));
  if (!isRecord(value)) throw new Error('Expected an object');
  return value;
}

function saved(id: string, documentId: string): SavedAnalysisResult {
  const zero = [0, 0, 0] as const;
  const result: BeamAnalysisResult = {
    kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic', analysisId: id, analysisRevision: 2,
    source: { documentId, documentRevision: 1, geometryRevision: 'geometry-1' }, inputSha256: '5'.repeat(64),
    nodes: ['a', 'b'].map((nodeId, i) => ({ nodeId, solverNode: i + 1, displacementM: zero, rotationRad: zero,
      reactionN: zero, reactionNm: zero, constrained: i === 0 })),
    elements: [{ memberId: 'member', componentId: 'c', occurrencePath: ['c'], solverElement: 1, nodeIds: ['a', 'b'],
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 1 },
      start: [0, 0, 0, 0, 0, 0], end: [0, 0, 0, 0, 0, 0] }],
    balance: { referenceM: zero, forceN: zero, momentNm: zero, maximumFreeResidual: 0 }, structuralCertification: false,
  };
  return { analysisId: id, analysisRevision: result.analysisRevision, kind: result.kind,
    bindingSha256: '', appVersion: '1.0.4', result };
}

function results(documentId: string) {
  return new Map(['beam-2', 'beam-1'].map(id => [id, saved(id, documentId)]));
}

async function bundles(kind: DocumentBundle['kind'], imageByte = 3) {
  const part = createEmptyPartDocument();
  const attachments = { ...emptyEmbeddedPartAttachments(), canvases: new Map([['image', Uint8Array.of(1, 2, imageByte)]]) };
  if (kind === 'part') return { before: createPartDocumentBundle(part, attachments),
    withResults: createPartDocumentBundle(part, attachments, results(part.id)) };
  const { library } = await embedPart(EMPTY_PART_LIBRARY, part, 'part.pcad', '', { importedAt: savedAt, attachments });
  const document = createAssemblyDocument('assembly');
  return { before: createAssemblyDocumentBundle(document, library),
    withResults: createAssemblyDocumentBundle(document, library, results(document.id)) };
}

describe('saved static beam results', () => {
  it.each(['part', 'assembly'] as const)('%s preserves the document, payload, input digest and exact ZIP bytes', async kind => {
    const { before, withResults } = await bundles(kind);
    const bytes = await writeDocumentBundle(withResults, options);
    const oldBytes = await writeDocumentBundle(before, options);
    const entries = unzipSync(bytes), original = unzipSync(oldBytes);
    expect(Object.keys(entries)).toEqual([...Object.keys(original), entry, secondEntry]);
    for (const [name, data] of Object.entries(original)) expect(entries[name]).toEqual(data);
    const envelope = record(entries[entry]);
    expect(Object.keys(envelope)).toEqual(['schema', 'analysisId', 'kind', 'analysisRevision', 'bindingSha256', 'appVersion', 'result']);
    expect(envelope.schema).toBe('pointercad-analysis-result/1');
    expect(envelope.bindingSha256).toMatch(/^[0-9a-f]{64}$/u);
    const read = await readDocumentBundle(bytes, kind);
    if (!read.ok) throw new Error(read.error.message);
    expect(read).not.toHaveProperty('analysisResultIssue');
    expect(read.bundle.document).toEqual(before.document);
    expect(read.bundle.analysisResults?.get('beam-1')).toEqual({ ...saved('beam-1', before.document.id), bindingSha256: envelope.bindingSha256 });
    expect(read.bundle.analysisResults?.size).toBe(2);
    expect(await readDocumentBundleEntries(new Map(Object.entries(entries)), kind)).toEqual(read);
    expect(await writeDocumentBundle(read.bundle, { savedAt: read.savedAt })).toEqual(bytes);
    const legacy = await readDocumentBundle(oldBytes, kind);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy).not.toHaveProperty('analysisResultIssue');
    expect(legacy.bundle).not.toHaveProperty('analysisResults');
    expect(await writeDocumentBundle(legacy.bundle, options)).toEqual(oldBytes);

    const changed = unzipSync(await writeDocumentBundle(withResults, {
      savedAt: '2026-02-03T04:05:06.000Z', thumbnailPng: Uint8Array.of(42),
    }));
    expect(changed[entry]).toEqual(entries[entry]);
    const workerBytes = withResults.kind === 'part'
      ? await encodeSaveDocument({ kind: 'part', document: withResults.document,
        options: { ...options, attachments: withResults.attachments, analysisResults: withResults.analysisResults } })
      : await encodeSaveDocument({ kind: 'assembly', bundle: withResults, options });
    expect(workerBytes).toEqual(bytes);
  });

  it.each(['part', 'assembly'] as const)('%s rejects a stale input fingerprint after a document edit', async kind => {
    const { withResults } = await bundles(kind);
    const entries = unzipSync(await writeDocumentBundle(withResults, options));
    const envelope = record(entries['document.json']);
    if (!isRecord(envelope.document)) throw new Error('Missing document');
    envelope.document.name = 'changed';
    entries['document.json'] = strToU8(JSON.stringify(envelope));
    const read = await readDocumentBundle(zipSync(entries), kind);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.bundle.document.name).toBe('changed');
    expect(read.analysisResultIssue).toBe('bindingMismatch');
    expect(read.bundle).not.toHaveProperty('analysisResults');
  });

  it.each([
    ['json', 'invalidResult'], ['revision', 'invalidResult'], ['path', 'invalidResult'], ['payload', 'invalidResult'],
    ['kind', 'unknownKind'], ['schema', 'unknownSchema'], ['fingerprint', 'bindingMismatch'],
  ] as const)('omits only the bad result for %s', async (change, issue) => {
    const { withResults } = await bundles('assembly');
    const entries = unzipSync(await writeDocumentBundle(withResults, options));
    const envelope = record(entries[entry]);
    let name = entry;
    switch (change) {
      case 'kind': envelope.kind = '__proto__'; break;
      case 'schema': envelope.schema = 'pointercad-analysis-result/2'; break;
      case 'revision': envelope.analysisRevision = 3; break;
      case 'payload': envelope.result = {}; break;
      case 'path': delete entries[entry]; name = 'analysis-results/other.json'; break;
      case 'fingerprint': envelope.bindingSha256 = '0'.repeat(64); break;
    }
    entries[name] = strToU8(change === 'json' ? '{' : JSON.stringify(envelope));
    const read = await readDocumentBundle(zipSync(entries), 'assembly');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.bundle.document).toEqual(withResults.document);
    expect(read.analysisResultIssue).toBe(issue);
    expect([...(read.bundle.analysisResults?.keys() ?? [])]).toEqual(['beam-2']);
  });

  it('binds the actual attachment bytes and entry names, including a reused byte view', async () => {
    const { withResults } = await bundles('part');
    const entries = unzipSync(await writeDocumentBundle(withResults, options));
    for (const renamed of [true, false]) {
      const changed = { ...entries };
      if (renamed) { changed['canvases/other.png'] = changed['canvases/image.png']; delete changed['canvases/image.png']; }
      else changed['canvases/image.png'] = Uint8Array.of(1, 2, 4);
      const read = readPcadFile(zipSync(changed));
      expect(read).toMatchObject({ ok: true, analysisResultIssue: 'bindingMismatch' });
    }
    const source = withResults.attachments.canvases.get('image');
    if (source === undefined) throw new Error('Missing image');
    source[2] = 9;
    const rewritten = unzipSync(await writeDocumentBundle(withResults, options));
    expect(record(rewritten[entry]).bindingSha256).not.toBe(record(entries[entry]).bindingSha256);
  });

  it('binds embedded part envelopes', async () => {
    const { withResults } = await bundles('assembly');
    const entries = unzipSync(await writeDocumentBundle(withResults, options));
    const embedded = record(entries['parts/part-1.json']);
    if (!isRecord(embedded.document)) throw new Error('Missing embedded document');
    embedded.document.name = 'different part';
    entries['parts/part-1.json'] = strToU8(JSON.stringify(embedded));
    const read = await readDocumentBundle(zipSync(entries), 'assembly');
    expect(read).toMatchObject({ ok: true, analysisResultIssue: 'bindingMismatch' });
    if (read.ok) expect(read.bundle).not.toHaveProperty('analysisResults');
  });

  it('rejects transplanted results when an embedded attachment and its stored digest both changed', async () => {
    const initial = await bundles('assembly'), edited = await bundles('assembly', 4);
    const old = unzipSync(await writeDocumentBundle(initial.withResults, options));
    const current = unzipSync(await writeDocumentBundle(edited.before, options));
    expect(current['document.json']).toEqual(old['document.json']);
    expect(current['parts/part-1/attachments.sha256']).not.toEqual(old['parts/part-1/attachments.sha256']);
    current[entry] = old[entry];
    const read = await readDocumentBundle(zipSync(current), 'assembly');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.analysisResultIssue).toBe('bindingMismatch');
    expect(read.bundle).not.toHaveProperty('analysisResults');
  });

  it('keeps result IDs within one filename and continues writing the other results', async () => {
    const part = createEmptyPartDocument();
    const table = results(part.id);
    for (const id of ['sub/path', 'back\\slash']) table.set(id, saved(id, part.id));
    const bundle = createPartDocumentBundle(part, undefined, table);
    const bytes = await writeDocumentBundle(bundle, options);
    expect(Object.keys(unzipSync(bytes))).toEqual(['document.json', entry, secondEntry]);
    const read = await readDocumentBundle(bytes, 'part');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.bundle.analysisResults?.size).toBe(2);
  });

  it('preserves required entries when the optional payload is too large or has a bad CRC', async () => {
    const document = createEmptyPartDocument();
    const part = createPartDocumentBundle(document, undefined, results(document.id));
    const original = unzipSync(await writeDocumentBundle(part, options));
    const bad = zipSync({ [entry]: original[entry], 'document.json': original['document.json'] }, { level: 0 });
    const intact = readPcadFile(bad);
    if (!intact.ok) throw new Error(intact.error.message);
    expect(intact.analysisResults?.size).toBe(1);
    const budget = { ...IO_LIMITS, archiveTotalExpandedBytes: original['document.json'].byteLength };
    const limited = readPcadFile(bad, { limits: budget });
    expect(limited).toMatchObject({ ok: true, document, analysisResultIssue: 'invalidResult' });
    expect(limited).not.toHaveProperty('analysisResults');
    // Flip the version digit in the stored JSON. The JSON stays valid, but its CRC no longer matches.
    const digit = strFromU8(original[entry]).indexOf('1.0.4') + 4;
    expect(digit).toBeGreaterThan(3);
    bad[30 + entry.length + digit] ^= 1;
    expect(readPcadFile(bad)).toMatchObject({ ok: true, document: part.document, analysisResultIssue: 'invalidResult' });
  });

  it('matches the independent sorted UTF-8 digest vector and keeps nested savedAt', () => {
    const inputs = [
      ['parts/p/shapes/s.brep', Uint8Array.of(0, 255), false],
      ['parts/p.json', strToU8('{"savedAt":"then","document":[2,1]}'), true],
      ['document.json', strToU8('{"schema":22,"savedAt":"now","document":{"savedAt":"inside"}}'), true],
    ] as const;
    expect(analysisResultBinding(inputs)).toBe('da940801ccb71f8b17de340fbe37cbbbeca92af6e82e6b69d38297d92031b5f4');
    expect(analysisResultBinding([...inputs].reverse())).toBe(analysisResultBinding(inputs));
  });

  it('reproduces a fixed pre-result assembly archive', async () => {
    const legacy = { schema: 22, kind: 'assembly', app: 'PointerCAD', savedAt,
      document: { id: 'assembly-1', name: 'old', schemaVersion: 22, components: [], mates: [], joints: [],
        presentation: [], parameters: [], bom: { columns: ['number'], sortBy: 'number', expandSubAssemblies: false },
        namedViews: [] }, partFiles: [] };
    const bytes = zipSync({ 'document.json': [strToU8(JSON.stringify(legacy, null, 2) + '\n'),
      { level: 6, mtime: new Date(1980, 0, 2, 12, 0, 0, 0) }] });
    const read = await readDocumentBundle(bytes, 'assembly');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.bundle).not.toHaveProperty('analysisResults');
    expect(await writeDocumentBundle(read.bundle, { savedAt: read.savedAt })).toEqual(bytes);
  });
});
