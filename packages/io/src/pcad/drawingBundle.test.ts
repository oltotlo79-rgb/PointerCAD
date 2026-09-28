import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createEmptyPartDocument,
  createPartDocumentBundle, embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary,
  emptyEmbeddedPartAttachments, partLibraryOfBundle, type DrawingDocument, type DrawingSourceInput,
  type PartDocument } from '@pointercad/model';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { IO_LIMITS } from '../limits.js';
import { readDrawingBundle, writeDrawingBundle } from './drawingBundle.js';
import { FIXED_ENTRY_MTIME, PCAD_DOCUMENT_ENTRY, readDocumentBundle, readPcaddFile, writeDocumentBundle,
  writePcaddFile, type ReadPcaddFileResult, type WritePcaddFileOptions } from './pcadFile.js';
import { ARCHIVE_TOO_LARGE_MESSAGE, readArchive, type ArchiveReadLimits } from './readArchive.js';

const savedAt = '2026-09-10T00:00:00.000Z';
async function fixture(source: DrawingSourceInput) {
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'source.pcad', '', { importedAt: savedAt });
  return { document: createDrawingDocument('図面', embedded.source), source };
}
async function assemblySource(): Promise<Extract<DrawingSourceInput, { sourceKind: 'assembly' }>> {
  const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['original', new Uint8Array([1, 2, 3, 4])]]) };
  const part = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'part.pcad', '', { attachments, importedAt: savedAt });
  return { sourceKind: 'assembly', document: createAssemblyDocument('組'), library: part.library };
}

describe('図面が参照元の部品文書と原本を一緒に保存する(P8-59/64)', () => {
  it('新しい部品の図面を往復する', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    const read = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(read).toMatchObject({ ok: true, document: input.document, source: input.source, savedAt });
  });
  it('従来の添付なしpcaddも開ける', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    expect(await readDrawingBundle(writePcaddFile(input.document, { source: input.source, savedAt }))).toMatchObject({ ok: true, document: input.document });
  });
  it('部品の未参照原本も捨てずに保存する', async () => {
    const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['source-a', new Uint8Array([8, 9])]]),
      canvases: new Map([['canvas-a', new Uint8Array([10, 11])]]) };
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument(), attachments });
    const result = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(result).toMatchObject({ ok: true, source: { attachments } });
  });
  it('組図の部品文書・原本・素性を再起動後にも取り出せる', async () => {
    const input = await fixture(await assemblySource());
    const read = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(read).toMatchObject({ ok: true, source: input.source });
  });
  it('同じ名前空間にあるサブアセンブリ文書も保持する', async () => {
    const source = await assemblySource();
    if (source.library === undefined) throw new Error('Missing fixture library');
    const nested = createAssemblyDocument('内部の組');
    const input = await fixture({ ...source, library: { ...source.library, assemblies: new Map([['assembly-1', nested]]) } });
    const read = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(read).toMatchObject({ ok: true, source: { library: { assemblies: new Map([['assembly-1', nested]]) } } });
  });
  it('同じ時刻と文書なら組図のZIP全体が一致する', async () => {
    const input = await fixture(await assemblySource());
    expect(await writeDrawingBundle(input.document, { source: input.source, savedAt }))
      .toEqual(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
  });
  it('部品の原本が書き換わったときはダイジェスト検査で断る', async () => {
    const input = await fixture(await assemblySource());
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const path = Object.keys(entries).find((key) => key.endsWith('/shapes/original.brep'));
    if (path === undefined) throw new Error('Missing fixture original');
    entries[path] = new Uint8Array([99]);
    expect(await readDrawingBundle(zipSync(entries))).toMatchObject({ ok: false });
  });
  it('欠落した部品の参照と素性を保持し、開いた後に未解決を知らせられる', async () => {
    const input = await fixture(await assemblySource());
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const path = Object.keys(entries).find((key) => key.endsWith('/parts/part-1.json'));
    if (path === undefined) throw new Error('Missing fixture part');
    delete entries[path];
    const read = await readDrawingBundle(zipSync(entries));
    expect(read).toMatchObject({ ok: true, source: { library: { parts: new Map(),
      partFiles: [{ ref: 'part-1', fileName: 'part.pcad' }] } } });
  });
  it('壊れた抱き込み文書のJSONを断る', async () => {
    const input = await fixture(await assemblySource());
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const path = Object.keys(entries).find((key) => key.endsWith('/parts/part-1.json'));
    if (path === undefined) throw new Error('Missing fixture part');
    entries[path] = strToU8('{');
    expect(await readDrawingBundle(zipSync(entries))).toMatchObject({ ok: false });
  });
  it('種類の異なる参照を誤って保存しない', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    await expect(writeDrawingBundle(input.document, { source: await assemblySource(), savedAt })).rejects.toThrow('kind mismatch');
  });
  it('危険な参照名で名前空間の外へ書かない', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    await expect(writeDrawingBundle({ ...input.document, source: { ...input.document.source, sourceRef: '../outside' } },
      { source: input.source, savedAt })).rejects.toThrow('reference');
  });
  it('ZIPでない入力は例外を漏らさず断る', async () => {
    expect(await readDrawingBundle(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// R06: 結合のためだけの圧縮・展開をなくした後も、出力のバイト列・読み取り結果・上限・断りが変わらない
// ---------------------------------------------------------------------------

function legacyArchiveEntries(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const archive = readArchive(bytes, { shouldExtract: () => true });
  if (!archive.ok) throw new Error(archive.error.reason);
  return archive.entries;
}
function legacyAdd(entries: Zippable, name: string, bytes: Uint8Array, level: 0 | 6): void {
  Object.defineProperty(entries, name, { configurable: true, enumerable: true, writable: true,
    value: [bytes, { level, mtime: FIXED_ENTRY_MTIME }] });
}
/** R06 の前の書き手(参照元と図面を一度 ZIP にし、展開し直して結合し、もう一度 ZIP にする)。互換の基準。 */
async function legacyWriteDrawingBundle(document: DrawingDocument, options: WritePcaddFileOptions): Promise<Uint8Array> {
  const prefix = `source/${document.source.sourceRef}/`;
  const savedAt = options.savedAt ?? new Date().toISOString();
  const source = options.source;
  const bundle = source.sourceKind === 'part'
    ? createPartDocumentBundle(source.document, source.attachments)
    : createAssemblyDocumentBundle(source.document, source.library);
  const native = legacyArchiveEntries(await writeDocumentBundle(bundle, { savedAt }));
  const entries: Zippable = {};
  for (const [name, bytes] of legacyArchiveEntries(writePcaddFile(document, { ...options, savedAt }))) {
    legacyAdd(entries, name, bytes, 6);
  }
  for (const [name, bytes] of native) {
    legacyAdd(entries, name === PCAD_DOCUMENT_ENTRY ? `source/${document.source.sourceRef}.json` : `${prefix}${name}`, bytes, 6);
  }
  return zipSync(entries);
}
/** R06 の前の読み手(取り出した参照元を ZIP に作り直して部品・アセンブリの読み手へ渡す)。互換の基準。 */
async function legacyReadDrawingBundle(bytes: Uint8Array): Promise<ReadPcaddFileResult> {
  const drawing = readPcaddFile(bytes);
  if (!drawing.ok) return drawing;
  const ref = drawing.document.source.sourceRef;
  const prefix = `source/${ref}/`;
  const archive = readArchive(bytes, { shouldExtract: (name) => name === `source/${ref}.json` || name.startsWith(prefix) });
  if (!archive.ok) return { ok: false, error: { code: 'notZip', message: archive.error.reason } };
  const entries: Zippable = {};
  for (const [name, value] of archive.entries) {
    legacyAdd(entries, name === `source/${ref}.json` ? PCAD_DOCUMENT_ENTRY : name.slice(prefix.length), value, 0);
  }
  const parsed = await readDocumentBundle(zipSync(entries), drawing.source.sourceKind);
  if (!parsed.ok) return parsed;
  const bundle = parsed.bundle;
  const source: DrawingSourceInput = bundle.kind === 'part'
    ? { sourceKind: 'part', document: bundle.document, attachments: bundle.attachments }
    : { sourceKind: 'assembly', document: bundle.document, library: partLibraryOfBundle(bundle) };
  return { ...drawing, source };
}

const ev = (source: string, value: number) => ({ source, value, display: String(value) });
/** 式・パラメータ・添付への参照(読み込んだ形・三角形・下絵)を持つ部品文書。 */
function richPartDocument(): PartDocument {
  const base = createEmptyPartDocument();
  return {
    ...base,
    parameters: [{ name: '板厚', value: ev('2*3', 6), unit: 'mm', description: '板の厚み' }],
    configurations: base.configurations.map((configuration) => ({ ...configuration, values: { 板厚: '2*3' } })),
    solids: [
      { id: 'importedSolid-1', kind: 'importedSolid', name: '読み込んだ形1', suppressed: false, shapeRef: 'shape-1',
        source: { format: 'step', fileName: 'bracket.step', unit: 'mm', byteLength: 64, importedAt: savedAt }, bodyKind: 'solid' },
      { id: 'importedMesh-1', kind: 'importedMesh', name: '読み込んだ三角形の形1', suppressed: false, meshRef: 'mesh-1',
        source: { format: 'stl', fileName: 'cover.stl', unit: 'mm', byteLength: 84 }, triangleCount: 1 },
    ],
    canvases: [{ id: 'canvas-1', name: '下絵1', plane: 'xy', imageId: 'canvas-1', width: ev('板厚*100', 600),
      height: ev('300', 300), origin: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      rotation: ev('0', 0), opacity: ev('0.5', 0.5), visible: true }],
  };
}
/** 圧縮がよく効く大きめの原本(展開後の大きさが圧縮後よりずっと大きい)。 */
function richAttachments(shapeBytes = 64) {
  const shape = new Uint8Array(shapeBytes);
  for (let i = 0; i < shape.length; i += 1) shape[i] = i % 7;
  return { ...emptyEmbeddedPartAttachments(),
    shapes: new Map([['shape-1', shape]]),
    meshes: new Map([['mesh-1', { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }]]),
    canvases: new Map([['canvas-1', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]]) };
}
async function richPartInput(shapeBytes?: number) {
  return fixture({ sourceKind: 'part', document: richPartDocument(), attachments: richAttachments(shapeBytes) });
}
async function richAssemblyInput() {
  const part = await embedPart(EMPTY_PART_LIBRARY, richPartDocument(), 'part.pcad', 'sub/part.pcad',
    { attachments: richAttachments(), importedAt: savedAt });
  const library = { ...part.library, assemblies: new Map([['assembly-1', createAssemblyDocument('内部の組')]]) };
  return fixture({ sourceKind: 'assembly', document: createAssemblyDocument('組'), library });
}
const thumbnailPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

describe('図面の束の保存・読込で結合のための往復をしない(R06)', () => {
  it('新しい書き手の出力は以前の書き手とバイト単位で一致する(部品・組図、サムネイルあり)', async () => {
    for (const input of [await richPartInput(), await richAssemblyInput()]) {
      const options = { source: input.source, savedAt, thumbnailPng };
      expect(await writeDrawingBundle(input.document, options)).toEqual(await legacyWriteDrawingBundle(input.document, options));
    }
  });

  it('新しい出力を以前の読み手で、以前の出力を新しい読み手で同じ結果に読める', async () => {
    for (const input of [await richPartInput(), await richAssemblyInput()]) {
      const options = { source: input.source, savedAt, thumbnailPng };
      const current = await writeDrawingBundle(input.document, options);
      const legacy = await legacyWriteDrawingBundle(input.document, options);
      const expected = await legacyReadDrawingBundle(legacy);
      expect(expected.ok).toBe(true);
      expect(await legacyReadDrawingBundle(current)).toEqual(expected);
      expect(await readDrawingBundle(legacy)).toEqual(expected);
    }
  });

  it('保存して開き直すと文書・式・参照・添付・サムネイルが同じ', async () => {
    const part = await richPartInput();
    const readPart = await readDrawingBundle(await writeDrawingBundle(part.document, { source: part.source, savedAt, thumbnailPng }));
    if (!readPart.ok || readPart.source.sourceKind !== 'part') throw new Error('部品の図面が読めない');
    expect(readPart.document).toEqual(part.document);
    expect(readPart.savedAt).toBe(savedAt);
    expect(readPart.thumbnailPng).toEqual(thumbnailPng);
    expect(readPart.source.document).toEqual(richPartDocument());
    const expected = richAttachments();
    expect(readPart.source.attachments?.shapes).toEqual(expected.shapes);
    expect(readPart.source.attachments?.meshes).toEqual(expected.meshes);
    expect(readPart.source.attachments?.canvases).toEqual(expected.canvases);
    const assembly = await richAssemblyInput();
    const readAssembly = await readDrawingBundle(await writeDrawingBundle(assembly.document, { source: assembly.source, savedAt }));
    expect(readAssembly).toMatchObject({ ok: true, document: assembly.document, source: assembly.source });
  });

  it('保存できた図面は同じ上限の読み手で必ず開け、上限を1つでも下回れば保存も読込も断る', async () => {
    const input = await richPartInput(64 * 1024);
    const bytes = await writeDrawingBundle(input.document, { source: input.source, savedAt });
    const entries = unzipSync(bytes);
    const sizes = Object.entries(entries);
    const drawingTotal = sizes.filter(([name]) => !name.startsWith('source/source-1/'))
      .reduce((sum, [, value]) => sum + value.length, 0);
    const sourceTotal = sizes.filter(([name]) => name.startsWith('source/source-1'))
      .reduce((sum, [, value]) => sum + value.length, 0);
    const exact: ArchiveReadLimits = {
      archiveCompressedBytes: bytes.length,
      archiveEntryCount: sizes.length,
      archiveEntryExpandedBytes: Math.max(...sizes.map(([, value]) => value.length)),
      archiveTotalExpandedBytes: Math.max(drawingTotal, sourceTotal),
    };
    expect(Object.keys(entries)).toContain('source/source-1.json');
    // 展開後の参照元は圧縮後の図面より大きい。読み手は参照元を ZIP に作り直さないので、
    // 圧縮後の大きさの上限は元のファイルにだけ効き、保存できた図面を開けないことはない。
    expect(sourceTotal).toBeGreaterThan(bytes.length);
    expect(await writeDrawingBundle(input.document, { source: input.source, savedAt }, exact)).toEqual(bytes);
    expect(await readDrawingBundle(bytes, { limits: exact })).toMatchObject({ ok: true, source: input.source });
    for (const key of Object.keys(exact) as (keyof ArchiveReadLimits)[]) {
      const tight = { ...exact, [key]: exact[key] - 1 };
      await expect(writeDrawingBundle(input.document, { source: input.source, savedAt }, tight)).rejects.toThrow(ARCHIVE_TOO_LARGE_MESSAGE);
      expect(await readDrawingBundle(bytes, { limits: tight })).toMatchObject({ ok: false, error: { message: ARCHIVE_TOO_LARGE_MESSAGE } });
    }
    expect(await readDrawingBundle(bytes)).toMatchObject({ ok: true });
    expect(IO_LIMITS.archiveEntryCount).toBe(4_096);
  });

  it('参照元の原本の CRC が合わないものを断る', async () => {
    const input = await richPartInput();
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const stored: Zippable = {};
    for (const [name, value] of Object.entries(entries)) stored[name] = [value, { level: 0, mtime: FIXED_ENTRY_MTIME }];
    const bytes = zipSync(stored);
    const shape = entries['source/source-1/shapes/shape-1.brep'];
    if (shape === undefined) throw new Error('Missing fixture shape');
    const at = bytes.findIndex((_, index) => shape.every((value, offset) => bytes[index + offset] === value));
    expect(at).toBeGreaterThan(0);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    expect(await readDrawingBundle(bytes)).toMatchObject({ ok: false, error: { code: 'notZip' } });
    expect(await legacyReadDrawingBundle(bytes)).toMatchObject({ ok: false, error: { code: 'notZip' } });
  });

  it('参照元の名前空間で名前を戻すと不正になる項目(空・先頭の斜線・ドライブ名)を以前と同じく断る', async () => {
    const input = await richPartInput();
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    for (const name of ['source/source-1/', 'source/source-1//outside.brep', 'source/source-1/C:outside.brep']) {
      const bytes = zipSync({ ...entries, [name]: new Uint8Array([1]) });
      const expected = await legacyReadDrawingBundle(bytes);
      expect(expected).toMatchObject({ ok: false, error: { code: 'notZip' } });
      expect(await readDrawingBundle(bytes)).toEqual(expected);
    }
  });
});
