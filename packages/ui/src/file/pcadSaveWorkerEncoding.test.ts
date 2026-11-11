import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createEmptyPartDocument,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { encodeSaveDocument, writePcadFile, type SaveDocumentInput } from '@pointercad/io';
import { captureSaveSnapshot, copySaveSnapshot } from './pcadSaveSnapshot.js';
import { encodeOwnedSaveInput, releaseOwnedMeshCopies } from './pcadSaveWorkerEncoding.js';

const savedAt = '2026-10-04T00:00:00.000Z';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const view = (array: Float32Array | Uint32Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

/** The same transfer the encoder performs, so the moved input is owned exactly as inside the Worker. */
async function workerOwned(input: SaveDocumentInput): Promise<{ moved: SaveDocumentInput; transfers: number }> {
  const copied = await copySaveSnapshot(captureSaveSnapshot(input));
  const moved: SaveDocumentInput = structuredClone(copied.input, { transfer: copied.transfer });
  return { moved, transfers: copied.transfer.length };
}
function ownedMeshes(input: SaveDocumentInput): { positions: Float32Array; normals: Float32Array; indices: Uint32Array }[] {
  if (input.kind === 'part') return [...(input.options.attachments?.meshes.values() ?? [])];
  if (input.kind === 'assembly') return [...input.bundle.attachments.meshes.values(),
    ...[...input.bundle.embeddedDocuments.values()].flatMap(part => [...part.attachments.meshes.values()])];
  if (input.kind === 'drawing' && input.options.source.sourceKind === 'assembly')
    return [...(input.options.source.library?.attachments.values() ?? [])].flatMap(value => [...value.meshes.values()]);
  return [];
}

describe('保存Workerの所有する三角形の写しを圧縮の前に手放す(E24)', () => {
  it('部品・組立・図面で写しの三角形だけを切り離し、形状とサムネイルは保ち、ZIPの全バイトと原本を変えない', async () => {
    const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]) };
    const shape = Uint8Array.of(1, 3, 5, 7), thumbnailPng = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 9);
    const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', shape]]), meshes: new Map([['mesh', mesh]]) };
    const document = { ...createEmptyPartDocument(), name: '解放の試験' };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, document, 'part.pcad', '', { attachments, importedAt: savedAt });
    const assembly = createAssemblyDocumentBundle(createAssemblyDocument('組立'), embedded.library);
    const source = { sourceKind: 'assembly' as const, document: assembly.document, library: embedded.library };
    const drawingSource = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'assembly.pcada', '', { importedAt: savedAt });
    const inputs: SaveDocumentInput[] = [
      { kind: 'part', document, options: { savedAt, attachments, thumbnailPng } },
      { kind: 'assembly', bundle: assembly, options: { savedAt } },
      { kind: 'drawing', document: createDrawingDocument('図面', drawingSource.source), options: { savedAt, source } },
    ];
    const originals = [view(mesh.positions), view(mesh.normals), view(mesh.indices), shape, thumbnailPng].map(digest);
    for (const input of inputs) {
      const expected = await encodeSaveDocument(input), { moved, transfers } = await workerOwned(input);
      const meshes = ownedMeshes(moved);
      expect(meshes.length).toBeGreaterThan(0);
      expect(transfers).toBeGreaterThanOrEqual(3 * meshes.length);
      const stages: [string, number][] = [];
      const result = await encodeOwnedSaveInput(moved, stage => stages.push([stage,
        meshes.reduce((sum, row) => sum + row.positions.byteLength + row.normals.byteLength + row.indices.byteLength, 0)]));
      // Still owned while the entries are built; already released when compression starts.
      expect(stages).toEqual([['preparing', 84 * meshes.length], ['compressing', 0]]);
      expect(result.releasedMeshBytes).toBe(84 * meshes.length);
      expect(digest(result.bytes)).toBe(digest(expected));
      for (const row of meshes) expect([row.positions.byteLength, row.normals.byteLength, row.indices.byteLength]).toEqual([0, 0, 0]);
      if (moved.kind === 'part') {
        expect(moved.options.attachments?.shapes.get('shape')).toEqual(shape);
        expect(moved.options.thumbnailPng).toEqual(thumbnailPng);
      }
      expect(releaseOwnedMeshCopies(moved)).toBe(0);
      expect([view(mesh.positions), view(mesh.normals), view(mesh.indices), shape, thumbnailPng].map(digest)).toEqual(originals);
      expect(mesh.positions.byteLength).toBe(36);
    }
    expect(digest(await encodeSaveDocument(inputs[0]))).toBe(digest(writePcadFile(document, { savedAt, attachments, thumbnailPng })));
  });

  it('原本で1つの領域を共有する三角形・形状・画像・サムネイルの混在でも、写しの三角形だけを手放し原本を変えない', async () => {
    // One original ArrayBuffer behind every view: mesh 0..83, shape 84..87, canvas 88..92, thumbnail 96..100.
    const shared = new ArrayBuffer(104), bytes = new Uint8Array(shared);
    const positions = new Float32Array(shared, 0, 9), normals = new Float32Array(shared, 36, 9), indices = new Uint32Array(shared, 72, 3);
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]); normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]); indices.set([0, 1, 2]);
    bytes.set([1, 3, 5, 7], 84); bytes.set([0x89, 0x50, 0x4e, 0x47, 5], 88); bytes.set([0x89, 0x50, 0x4e, 0x47, 6], 96);
    const shape = new Uint8Array(shared, 84, 4), canvas = new Uint8Array(shared, 88, 5), thumbnailPng = new Uint8Array(shared, 96, 5);
    const input: SaveDocumentInput = { kind: 'part', document: createEmptyPartDocument(), options: { savedAt, thumbnailPng,
      attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', shape]]), canvases: new Map([['canvas', canvas]]),
        meshes: new Map([['mesh', { positions, normals, indices }]]) } } };
    const before = digest(bytes), expected = digest(await encodeSaveDocument(input));
    const { moved } = await workerOwned(input);
    if (moved.kind !== 'part') throw new Error('part expected');
    const result = await encodeOwnedSaveInput(moved, () => undefined);
    expect(result.releasedMeshBytes).toBe(84);
    expect(digest(result.bytes)).toBe(expected);
    expect(moved.options.attachments?.shapes.get('shape')).toEqual(shape);
    expect(moved.options.attachments?.canvases.get('canvas')).toEqual(canvas);
    expect(moved.options.thumbnailPng).toEqual(thumbnailPng);
    expect(shared.byteLength).toBe(104); expect(digest(bytes)).toBe(before);
    expect([positions.length, normals.length, indices.length]).toEqual([9, 9, 3]);
  });

  it('Workerの入力で三角形が形状の項目と同じ領域を参照する時は、その領域を切り離さずZIPを保つ', async () => {
    // A cloned (not copySaveSnapshot) Worker input keeps view sharing; the shape entry aliases the mesh's buffer.
    const shared = new ArrayBuffer(88);
    const positions = new Float32Array(shared, 0, 9), normals = new Float32Array(shared, 36, 9), indices = new Uint32Array(shared, 72, 3);
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]); normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]); indices.set([0, 1, 2]);
    new Uint8Array(shared).set([2, 4, 6, 8], 84);
    const input: SaveDocumentInput = { kind: 'part', document: createEmptyPartDocument(), options: { savedAt,
      attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', new Uint8Array(shared, 84, 4)]]),
        meshes: new Map([['mesh', { positions, normals, indices }]]) } } };
    const expected = digest(await encodeSaveDocument(input)), moved = structuredClone(input);
    if (moved.kind !== 'part') throw new Error('part expected');
    const [mesh] = ownedMeshes(moved), clonedShape = moved.options.attachments?.shapes.get('shape');
    expect(clonedShape?.buffer).toBe(mesh.positions.buffer);
    const result = await encodeOwnedSaveInput(moved, () => undefined);
    expect(result.releasedMeshBytes).toBe(0);
    expect(digest(result.bytes)).toBe(expected);
    expect(clonedShape).toEqual(Uint8Array.of(2, 4, 6, 8));
    expect(mesh.positions.length).toBe(9);
  });

  it('三角形の無い部品では何も手放さず形状を保つ', async () => {
    const shape = Uint8Array.of(2, 4, 6);
    const input: SaveDocumentInput = { kind: 'part', document: createEmptyPartDocument(),
      options: { savedAt, attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', shape]]) } } };
    const { moved } = await workerOwned(input);
    const result = await encodeOwnedSaveInput(moved, () => undefined);
    expect(result.releasedMeshBytes).toBe(0);
    if (moved.kind !== 'part') throw new Error('part expected');
    expect(moved.options.attachments?.shapes.get('shape')).toEqual(shape);
    expect(digest(result.bytes)).toBe(digest(await encodeSaveDocument(input)));
  });

  it('128MiBの三角形の写しを圧縮の前に手放し、従来の書き手と同じZIPを作る', async () => {
    // The e2e fixture size: ceil(128 MiB / 84 B) triangles of distinct vertices; deterministic finite values.
    const triangles = Math.ceil(128 * 1024 * 1024 / 84), vertexCount = triangles * 3;
    const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3), indices = new Uint32Array(vertexCount);
    let state = 0x2545f491;
    for (let i = 0; i < positions.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      positions[i] = (state / 0xffff_ffff - 0.5) * 2048; normals[i] = ((state >>> 7) & 1) === 0 ? 0.6 : -0.8;
    }
    for (let i = 0; i < indices.length; i += 1) indices[i] = (i * 7919) % vertexCount;
    const mesh = { positions, normals, indices }, rawBytes = positions.byteLength + normals.byteLength + indices.byteLength;
    expect(rawBytes).toBeGreaterThanOrEqual(128 * 1024 * 1024);
    const attachments = { ...emptyEmbeddedPartAttachments(), meshes: new Map([['large', mesh]]) };
    const document = createEmptyPartDocument(), before = digest(view(positions));
    const legacy = digest(writePcadFile(document, { savedAt, attachments }));
    const { moved } = await workerOwned({ kind: 'part', document, options: { savedAt, attachments } });
    const [owned] = ownedMeshes(moved);
    const atCompression: number[] = [];
    const result = await encodeOwnedSaveInput(moved, stage => {
      if (stage === 'compressing') atCompression.push(owned.positions.byteLength + owned.normals.byteLength + owned.indices.byteLength);
    });
    expect(atCompression).toEqual([0]);
    expect(result.releasedMeshBytes).toBe(rawBytes);
    expect(digest(result.bytes)).toBe(legacy);
    expect(digest(view(positions))).toBe(before);
    expect(positions.length).toBe(vertexCount * 3);
  });
});
