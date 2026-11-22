import {
  createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPartDocumentBundle,
  emptyEmbeddedPartAttachments, sha256HexSync, type DocumentBundle,
} from '@pointercad/model';
import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readAnalysisResult, serializeAnalysisResult } from './codecs/analysisResult.js';
import { SOLID_RESULT_MAX_BYTES } from './codecs/solidResultBinary.js';
import { isRecord } from './guards.js';
import { readDocumentBundle, readDocumentBundleEntries, writeDocumentBundle } from './pcadFile.js';

type Solid = Extract<SavedAnalysisResult, { kind: 'oofem-linear-solid-tet4' }>;
const id = 'solid-1';
const jsonName = 'analysis-results/solid-1.json';
const binName = 'analysis-results/solid-1.bin';
const options = { savedAt: '2026-01-02T03:04:05.000Z', thumbnailPng: Uint8Array.of(17, 18) };
const binding = '0'.repeat(64);

function sample(documentId: string, optional = true): Solid {
  const hash = '3'.repeat(64), revision = 3;
  const source = { documentId, revision, featureId: 'feature', bodyKey: 'body' };
  const coordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const triangles = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3], tags = [0, 1, 2, 3];
  const common = { source, tagCount: 4, units: 'mm' as const, coordinates, triangles, tags };
  const input: Solid['mesh']['input'] = optional ? { ...common, schema: 'pointercad-plc/2',
    shells: [{ role: 'outer', triangles: [0, 1, 2, 3] }], meshing: { targetSizeMm: 0.125, grading: 0.5, maximumOptimizationPasses: 2,
      quality: { minimumMeanRatio: 0.2, maximumEdgeRatio: 8 }, localSizeConstraints: [{ positionMm: [0.25, 0.5, 0.25], targetSizeMm: 0.1 }] } }
    : { ...common, schema: 'pointercad-convex-plc/1' };
  const vectors = Array.from({ length: 4 }, (_, i) => [i, Number.MIN_VALUE, -1.0000000000000002] as const);
  const kind = 'oofem-linear-solid-tet4';
  return { analysisId: id, analysisRevision: 2, bindingSha256: '', appVersion: '1.0.4', kind,
    mesh: { input, inputSha256: hash, kind: optional ? 'netgen-tetra-mesh' : 'netgen-convex-tetra-mesh', coordinates,
      tetrahedra: [0, 1, 2, 3], boundaryTriangles: triangles, boundaryTags: tags, volumeMm3: 1 / 6, minTetVolumeMm3: 1 / 6 },
    result: { kind, method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', source: { documentId, revision, meshKey: hash },
      inputSha256: '4'.repeat(64), displacementMm: vectors, reactionN: vectors, ...(optional ? { reactionsN: vectors } : {}),
      elements: [{ strain: [1, 2, 3, 4, 5, 6], stressMPa: [7, 8, 9, 10, 11, 12] }],
      strainEnergyNmm: 0.123, maximumRelativeEquilibriumResidual: 1e-14, reservedNumericBytes: 3000, minimumScaledPivot: 0.25,
      nativeElementForcesN: [Array.from({ length: 12 }, (_, i) => i / 7)], structuralCertification: false } };
}

function bundles(kind: DocumentBundle['kind']) {
  if (kind === 'assembly') {
    const doc = createAssemblyDocument('assembly'), saved = sample(doc.id);
    return { saved, before: createAssemblyDocumentBundle(doc), after: createAssemblyDocumentBundle(doc, undefined, new Map([[id, saved]])) };
  }
  const doc = createEmptyPartDocument(), saved = sample(doc.id, false);
  const attachments = { ...emptyEmbeddedPartAttachments(), canvases: new Map([['image', Uint8Array.of(4, 2)]]) };
  return { saved, before: createPartDocumentBundle(doc, attachments), after: createPartDocumentBundle(doc, attachments, new Map([[id, saved]])) };
}

function record(bytes: Uint8Array) {
  const raw: unknown = JSON.parse(strFromU8(bytes));
  if (!isRecord(raw) || !isRecord(raw.result)) throw new Error('Expected solid envelope');
  return { raw, payload: raw.result };
}

describe('saved static solid analysis', () => {
  it.each(['part', 'assembly'] as const)('%s preserves every existing entry and all result bits', async kind => {
    const { saved, before, after } = bundles(kind);
    const bare = await writeDocumentBundle(before, options), bytes = await writeDocumentBundle(after, options);
    const original = unzipSync(bare), entries = unzipSync(bytes);
    expect(Object.keys(entries)).toEqual([...Object.keys(original), jsonName, binName]);
    for (const [name, data] of Object.entries(original)) expect(entries[name]).toEqual(data);
    const { raw, payload } = record(entries[jsonName]);
    expect(raw.schema).toBe('pointercad-analysis-result/1');
    expect(payload.binarySha256).toBe(sha256HexSync(entries[binName]));
    expect(entries[binName].slice(0, 12)).toEqual(Uint8Array.of(80, 83, 82, 49, 4, 0, 0, 0, 1, 0, 0, 0));
    expect(entries[binName].slice(64, 72)).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 240, 63));
    const opened = await readDocumentBundle(bytes, kind);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.analysisResultIssue).toBeUndefined();
    expect(opened.bundle.document).toEqual(before.document);
    expect(opened.bundle.analysisResults?.get(id)).toStrictEqual({ ...saved, bindingSha256: raw.bindingSha256 });
    expect(await readDocumentBundleEntries(new Map(Object.entries(entries)), kind)).toEqual(opened);
    expect(await writeDocumentBundle(opened.bundle, options)).toEqual(bytes);
    const old = await readDocumentBundle(bare, kind);
    if (!old.ok) throw new Error(old.error.message);
    expect(await writeDocumentBundle(old.bundle, options)).toEqual(bare);
  });

  it.each(['length', 'digest', 'index', 'tag', 'count', 'magic', 'missing', 'orphan', 'fingerprint', 'nonfinite', 'minusZero'] as const)(
    'opens the document and omits the damaged result (%s)', async change => {
      const { after } = bundles('part');
      const entries = unzipSync(await writeDocumentBundle(after, options));
      const { raw, payload } = record(entries[jsonName]);
      const bytes = entries[binName], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      switch (change) {
        case 'length': entries[binName] = bytes.subarray(0, -1); break;
        case 'digest': payload.binarySha256 = 'f'.repeat(64); break;
        case 'count': payload.nodes = 3; break;
        case 'magic': view.setUint32(0, 0, true); break;
        case 'index': view.setUint32(40 + 12 * 8, 4, true); break;
        case 'tag': view.setUint32(40 + 12 * 8 + 12 * 4, 4, true); break;
        case 'missing': delete entries[binName]; break;
        case 'fingerprint': raw.bindingSha256 = binding; break;
        case 'nonfinite': view.setFloat64(40, Infinity, true); break;
        case 'minusZero': view.setFloat64(40, -0, true); break;
      }
      if (change !== 'digest' && entries[binName]) payload.binarySha256 = sha256HexSync(entries[binName].subarray());
      entries[jsonName] = strToU8(JSON.stringify(raw));
      if (change === 'orphan') delete entries[jsonName];
      const opened = await readDocumentBundle(zipSync(entries), 'part');
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.bundle.document).toEqual(after.document);
      expect(opened.analysisResultIssue).toBe(change === 'fingerprint' ? 'bindingMismatch' : 'invalidResult');
      expect(opened.bundle.analysisResults).toBeUndefined();
    });

  it.each([-0, NaN, Infinity])('rejects an invalid value on write and commits neither entry (%s)', async n => {
    const { saved, before } = bundles('part');
    const invalid: Solid = { ...saved, result: { ...saved.result, strainEnergyNmm: n } };
    const issues: string[] = [];
    const bytes = await writeDocumentBundle({ ...before, analysisResults: new Map([[id, invalid]]) },
      { ...options, onAnalysisResultIssue: (key, issue) => issues.push(key + '/' + issue) });
    expect(issues).toEqual(['solid-1/invalidResult']);
    expect(bytes).toEqual(await writeDocumentBundle(before, options));
  });

  it('accepts the inclusive combined byte limit and rejects one more byte on both paths', () => {
    const saved = sample('p');
    const encoded = serializeAnalysisResult(saved, id, binding);
    if (!encoded.ok || !encoded.binary) throw new Error('Expected a solid pair');
    const padding = SOLID_RESULT_MAX_BYTES - encoded.binary.length - encoded.json.length;
    for (const delta of [-1, 0, 1]) {
      const appVersion = saved.appVersion + 'x'.repeat(padding + delta);
      const writer = serializeAnalysisResult({ ...saved, appVersion }, id, binding);
      const { raw } = record(encoded.json);
      const json = strToU8(JSON.stringify({ ...raw, appVersion }));
      expect(json.length + encoded.binary.length).toBe(SOLID_RESULT_MAX_BYTES + delta);
      const reader = readAnalysisResult(json, id, binding, encoded.binary);
      for (const value of [writer, reader]) {
        if (delta > 0) expect(value).toEqual({ ok: false, issue: 'resultTooLarge' });
        else expect(value.ok).toBe(true);
      }
    }
  });
});

/** The solver input of the CAD path for the sample mesh: its nodes and elements are the mesh's own. */
function withPrepared(saved: Solid, traction: readonly [number, number, number] = [0, 0, -1]): Solid {
  const { coordinates, tetrahedra } = saved.mesh;
  const nodes = [0, 1, 2, 3].map(i => [coordinates[3 * i], coordinates[3 * i + 1], coordinates[3 * i + 2]] as const);
  const prepared: NonNullable<Solid['prepared']> = { loadedAreaMm2: 0.5, totalForceN: [0, 0, -0.5], input: {
    schema: 'pointercad-solid-tet4/1', source: saved.result.source, units: 'N-mm-MPa', numericBudgetBytes: 3000, nodes,
    elements: [{ materialId: 'steel', nodes: [tetrahedra[0], tetrahedra[1], tetrahedra[2], tetrahedra[3]] }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 3, fixed: [true, false, true], prescribedMm: [0.25, 0, 0] }],
    gravity: { accelerationMps2: [0, 0, -9.80665], densities: [{ materialId: 'steel', densityKgM3: 7850 }] },
    nodalLoads: [{ node: 2, forceN: [1, 0, 0] }], surfaceLoads: [{ nodes: [0, 1, 2], tractionMPa: traction }] } };
  return { ...saved, prepared };
}

describe('the solver input kept with a saved static solid result', () => {
  it('rebuilds the nodes and elements from the mesh and writes the same bytes again', () => {
    const saved = withPrepared(sample('p'));
    const encoded = serializeAnalysisResult(saved, id, binding);
    if (!encoded.ok || !encoded.binary) throw new Error('Expected a solid pair');
    const read = readAnalysisResult(encoded.json, id, binding, encoded.binary);
    if (!read.ok) throw new Error(read.issue);
    expect(read.value).toStrictEqual({ ...saved, bindingSha256: binding });
    expect(serializeAnalysisResult(read.value, id, binding)).toEqual(encoded);
    // The section adds 16 count bytes, 8 per support, 24 per prescribed displacement, 36 per loaded face and 28 per nodal load.
    const bare = serializeAnalysisResult(sample('p'), id, binding);
    if (!bare.ok || !bare.binary) throw new Error('Expected a solid pair');
    expect(encoded.binary.length - bare.binary.length).toBe(16 + 2 * 8 + 24 + 36 + 28);
  });

  it('stores a negative zero load as zero, which the input digest already treats as the same JSON text', () => {
    const encoded = serializeAnalysisResult(withPrepared(sample('p'), [-0, 0, -1]), id, binding);
    if (!encoded.ok || !encoded.binary) throw new Error('Expected a solid pair');
    const read = readAnalysisResult(encoded.json, id, binding, encoded.binary);
    if (!read.ok || read.value.kind !== 'oofem-linear-solid-tet4') throw new Error('Expected a solid result');
    expect(Object.is(read.value.prepared?.input.surfaceLoads[0]?.tractionMPa[0], 0)).toBe(true);
    expect(JSON.stringify(read.value.prepared?.input.surfaceLoads)).toBe(JSON.stringify([{ nodes: [0, 1, 2], tractionMPa: [-0, 0, -1] }]));
  });

  it.each(['material', 'node'] as const)('refuses to write a solver input that is not the mesh (%s)', change => {
    const saved = withPrepared(sample('p')), prepared = saved.prepared;
    if (prepared === undefined) throw new Error('Expected a solver input');
    const input = change === 'material'
      ? { ...prepared.input, elements: [{ ...prepared.input.elements[0], materialId: 'other' }] }
      : { ...prepared.input, nodes: [[0.5, 0, 0] as const, ...prepared.input.nodes.slice(1)] };
    expect(serializeAnalysisResult({ ...saved, prepared: { ...prepared, input } }, id, binding)).toEqual({ ok: false, issue: 'invalidResult' });
  });

  it.each(['missing scalars', 'missing section', 'no fixed axis'] as const)('drops a result whose two halves disagree (%s)', change => {
    const kept = serializeAnalysisResult(withPrepared(sample('p')), id, binding);
    const bare = serializeAnalysisResult(sample('p'), id, binding);
    if (!kept.ok || !kept.binary || !bare.ok || !bare.binary) throw new Error('Expected solid pairs');
    const { raw, payload } = record(kept.json);
    let binary = kept.binary;
    if (change === 'missing scalars') delete payload.solverInput;
    if (change === 'missing section') binary = bare.binary;
    if (change === 'no fixed axis') {
      binary = kept.binary.slice();
      const section = bare.binary.length;
      new DataView(binary.buffer).setUint32(section + 16 + 4, 8, true);
    }
    payload.byteLength = binary.length;
    payload.binarySha256 = sha256HexSync(binary);
    expect(readAnalysisResult(strToU8(JSON.stringify(raw)), id, binding, binary)).toEqual({ ok: false, issue: 'invalidResult' });
  });
});
