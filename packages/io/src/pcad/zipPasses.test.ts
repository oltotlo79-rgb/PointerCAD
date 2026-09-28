/**
 * 保存・読込で ZIP を圧縮・展開する回数の見張り(レビュー R06)。
 *
 * 図面の束は以前、参照元と図面をそれぞれ ZIP にしてから展開し直して結合し(圧縮 3 回・展開 2 回)、
 * 読込でも取り出した参照元を ZIP に作り直して読み直していた。同じ種類の往復を戻さないよう、
 * fflate の入口の呼出し回数と、`zipSync` を呼んでよい場所を照合する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createEmptyPartDocument,
  createPartDocumentBundle, embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary,
  emptyEmbeddedPartAttachments, type DrawingSourceInput } from '@pointercad/model';
import * as fflate from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return { ...actual, zipSync: vi.fn(actual.zipSync), inflateSync: vi.fn(actual.inflateSync), unzipSync: vi.fn(actual.unzipSync) };
});

const { readDrawingBundle, writeDrawingBundle } = await import('./drawingBundle.js');
const { readDocumentBundle, readPcadFile, writeDocumentBundle, writePcadaFile, writePcadFile } = await import('./pcadFile.js');

const savedAt = '2026-09-10T00:00:00.000Z';
const zipSync = vi.mocked(fflate.zipSync);
const inflateSync = vi.mocked(fflate.inflateSync);
const unzipSync = vi.mocked(fflate.unzipSync);

function attachments(seed: number) {
  const shape = new Uint8Array(4096).map((_, index) => (index * seed) % 251);
  return { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', shape]]),
    meshes: new Map([['mesh-1', { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }]]),
    canvases: new Map([['canvas-1', new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed])]]) };
}
async function drawingInputs() {
  const part: DrawingSourceInput = { sourceKind: 'part', document: createEmptyPartDocument(), attachments: attachments(3) };
  let library = EMPTY_PART_LIBRARY;
  for (const seed of [5, 7]) {
    library = (await embedPart(library, { ...createEmptyPartDocument(), name: `部品${String(seed)}` }, `p${String(seed)}.pcad`, '',
      { attachments: attachments(seed), importedAt: savedAt })).library;
  }
  const assembly: DrawingSourceInput = { sourceKind: 'assembly', document: createAssemblyDocument('組'), library };
  return Promise.all([part, assembly].map(async (source) => {
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'source.pcad', '', { importedAt: savedAt });
    return { document: createDrawingDocument('図面', embedded.source), source };
  }));
}
function resetCounts(): void {
  zipSync.mockClear(); inflateSync.mockClear(); unzipSync.mockClear();
}

describe('保存・読込の圧縮と展開の回数(R06)', () => {
  beforeEach(resetCounts);

  it('図面の束の保存は圧縮 1 回・展開 0 回(部品・組図の参照元)', async () => {
    for (const input of await drawingInputs()) {
      resetCounts();
      const bytes = await writeDrawingBundle(input.document, { source: input.source, savedAt, thumbnailPng: new Uint8Array([1]) });
      expect(zipSync).toHaveBeenCalledTimes(1);
      expect(inflateSync).not.toHaveBeenCalled();
      expect(unzipSync).not.toHaveBeenCalled();
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it('図面の束の読込は ZIP を作り直さず、各項目の展開は高々 1 回(参照元の封筒だけ 2 回)', async () => {
    for (const input of await drawingInputs()) {
      const bytes = await writeDrawingBundle(input.document, { source: input.source, savedAt });
      const entryCount = Object.keys(fflate.unzipSync(bytes)).length;
      resetCounts();
      const read = await readDrawingBundle(bytes);
      expect(read).toMatchObject({ ok: true });
      expect(zipSync).not.toHaveBeenCalled();
      expect(unzipSync).not.toHaveBeenCalled();
      // 参照元の封筒だけは図面の読み手と参照元の読み手の両方が読むので、項目の数 + 1 回が上限。
      expect(inflateSync.mock.calls.length).toBeLessThanOrEqual(entryCount + 1);
    }
  });

  it('部品・組立の保存は圧縮 1 回・展開 0 回、読込は圧縮 0 回', async () => {
    const [, drawing] = await drawingInputs();
    if (drawing?.source.sourceKind !== 'assembly') throw new Error('Missing assembly fixture');
    const part = writePcadFile(createEmptyPartDocument(), { savedAt, attachments: attachments(3) });
    const assembly = await writePcadaFile(createAssemblyDocument('組'), { savedAt });
    const bundle = await writeDocumentBundle(createAssemblyDocumentBundle(drawing.source.document, drawing.source.library), { savedAt });
    const partBundle = await writeDocumentBundle(createPartDocumentBundle(createEmptyPartDocument(), attachments(3)), { savedAt });
    expect(zipSync).toHaveBeenCalledTimes(4);
    expect(inflateSync).not.toHaveBeenCalled();
    resetCounts();
    expect(readPcadFile(part)).toMatchObject({ ok: true });
    expect(await readDocumentBundle(assembly, 'assembly')).toMatchObject({ ok: true });
    expect(await readDocumentBundle(bundle, 'assembly')).toMatchObject({ ok: true });
    expect(await readDocumentBundle(partBundle, 'part')).toMatchObject({ ok: true });
    expect(zipSync).not.toHaveBeenCalled();
    expect(unzipSync).not.toHaveBeenCalled();
  });

  it('pcad 系の製品コードで zipSync を呼ぶのは最後の圧縮の 1 か所(と図面ひな形)だけで、unzipSync は使わない', () => {
    const directory = new URL('./', import.meta.url);
    const sources = readdirSync(directory).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const calls = sources.flatMap((name) => {
      const text = readFileSync(new URL(name, directory), 'utf8');
      return [...text.matchAll(/\b(zipSync|unzipSync)\s*\(/gu)].map((match) => `${name}:${match[1] ?? ''}`);
    });
    expect(sources).toContain('drawingBundle.ts');
    // 図面ひな形(.pcadt)は設定 1 項目だけを直接 1 回圧縮する別の形式なので、名前を挙げて許す。
    expect(calls.sort()).toEqual(['drawingTemplateFile.ts:zipSync', 'pcadFile.ts:zipSync']);
    // その 1 か所は、項目の表を受け取って最後に圧縮する zipPcadEntries の中にある。
    const pcadFile = readFileSync(new URL('pcadFile.ts', directory), 'utf8');
    const start = pcadFile.indexOf('export function zipPcadEntries(');
    const call = pcadFile.indexOf('zipSync(');
    const next = pcadFile.indexOf('export ', start + 1);
    expect(start).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(start);
    expect(call).toBeLessThan(next);
  });
});
