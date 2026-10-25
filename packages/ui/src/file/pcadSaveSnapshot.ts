import type { SaveDocumentInput } from '@pointercad/io';
import type { AssemblyDocumentBundle, EmbeddedPartAttachments, PartDocumentBundle, DrawingSourceInput,
  PartLibrary } from '@pointercad/model';

/** コピー用の予算。原本は不変参照で借り、所有するコピーだけをWorkerへ移す。 */
export const SAVE_COPY_CHUNK_BYTES = 1024 * 1024;
export const SAVE_COPY_SLICE_MS = 8;

function captureAttachments(value: EmbeddedPartAttachments): EmbeddedPartAttachments {
  return { shapes: new Map(value.shapes), meshes: new Map(value.meshes), canvases: new Map(value.canvases) };
}

function capturePart(value: PartDocumentBundle): PartDocumentBundle {
  return { ...value, attachments: captureAttachments(value.attachments) };
}

function captureAssembly(value: AssemblyDocumentBundle): AssemblyDocumentBundle {
  return { ...value, attachments: captureAttachments(value.attachments),
    partFiles: [...value.partFiles], embeddedAssemblies: new Map(value.embeddedAssemblies),
    embeddedDocuments: new Map([...value.embeddedDocuments].map(([key, part]) => [key, capturePart(part)])) };
}

function captureSource(source: DrawingSourceInput): DrawingSourceInput {
  if (source.sourceKind === 'part') return { ...source,
    ...(source.attachments === undefined ? {} : { attachments: captureAttachments(source.attachments) }) };
  if (source.library === undefined) return source;
  return { ...source, library: { ...source.library, parts: new Map(source.library.parts),
    partFiles: [...source.library.partFiles], assemblies: new Map(source.library.assemblies),
    attachments: new Map([...source.library.attachments].map(([key, value]) => [key, captureAttachments(value)])) } };
}

/** 依頼時に文書と添付の対応を固定する。文書・各原本バイトは既存の不変データ契約で借りる。 */
export function captureSaveSnapshot(input: SaveDocumentInput): SaveDocumentInput {
  if (input.kind === 'drawingTemplate') return { kind: input.kind, savedAt: input.savedAt,
    template: { name: input.template.name, sheet: input.template.sheet, layers: input.template.layers } };
  if (input.kind === 'part') return { ...input, options: { ...input.options,
    ...(input.options.attachments === undefined ? {} : { attachments: captureAttachments(input.options.attachments) }) } };
  if (input.kind === 'assembly') return { ...input, bundle: captureAssembly(input.bundle), options: { ...input.options } };
  return { ...input, options: { ...input.options, source: captureSource(input.options.source) } };
}

export interface OwnedSaveSnapshot {
  readonly input: SaveDocumentInput;
  readonly transfer: ArrayBuffer[];
  readonly copiedBytes: number;
  readonly maxSliceMs: number;
  readonly yields: number;
}

/** 1回の大きいslice()/structuredClone()で入力を止めない。取消で部分コピーも手放す。 */
export async function copySaveSnapshot(input: SaveDocumentInput, signal?: AbortSignal): Promise<OwnedSaveSnapshot> {
  const transfer: ArrayBuffer[] = [];
  let copiedBytes = 0, maxSliceMs = 0, yields = 0, sliceStart = performance.now();
  const yieldInput = async (): Promise<void> => {
    maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    yields += 1;
    signal?.throwIfAborted();
    sliceStart = performance.now();
  };
  async function copyBuffer(view: Uint8Array | Float32Array | Uint32Array): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    const buffer = new ArrayBuffer(view.byteLength);
    const target = new Uint8Array(buffer);
    const source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let offset = 0; offset < source.length; offset += SAVE_COPY_CHUNK_BYTES) {
      target.set(source.subarray(offset, Math.min(source.length, offset + SAVE_COPY_CHUNK_BYTES)), offset);
      if (performance.now() - sliceStart >= SAVE_COPY_SLICE_MS) await yieldInput();
    }
    transfer.push(buffer);
    copiedBytes += buffer.byteLength;
    return buffer;
  }
  async function bytesMap(values: ReadonlyMap<string, Uint8Array>): Promise<ReadonlyMap<string, Uint8Array>> {
    const copied = new Map<string, Uint8Array>();
    for (const [key, value] of values) copied.set(key, new Uint8Array(await copyBuffer(value)));
    return copied;
  }
  async function attachments(value: EmbeddedPartAttachments): Promise<EmbeddedPartAttachments> {
    const meshes = new Map<string, { positions: Float32Array; normals: Float32Array; indices: Uint32Array }>();
    for (const [key, mesh] of value.meshes) meshes.set(key, {
      positions: new Float32Array(await copyBuffer(mesh.positions)),
      normals: new Float32Array(await copyBuffer(mesh.normals)),
      indices: new Uint32Array(await copyBuffer(mesh.indices)),
    });
    return { meshes, shapes: await bytesMap(value.shapes), canvases: await bytesMap(value.canvases) };
  }
  async function library(value: PartLibrary): Promise<PartLibrary> {
    const copied = new Map<string, EmbeddedPartAttachments>();
    for (const [key, item] of value.attachments) copied.set(key, await attachments(item));
    return { ...value, attachments: copied };
  }
  async function source(value: DrawingSourceInput): Promise<DrawingSourceInput> {
    return value.sourceKind === 'part'
      ? { ...value, ...(value.attachments === undefined ? {} : { attachments: await attachments(value.attachments) }) }
      : { ...value, ...(value.library === undefined ? {} : { library: await library(value.library) }) };
  }
  await yieldInput(); // 進捗表示と取消入口を、最初のコピーの前に描画できるようにする。
  let copied: SaveDocumentInput;
  if (input.kind === 'part') {
    copied = { ...input, options: { ...input.options,
      ...(input.options.attachments === undefined ? {} : { attachments: await attachments(input.options.attachments) }),
      ...(input.options.thumbnailPng === undefined ? {} : { thumbnailPng: new Uint8Array(await copyBuffer(input.options.thumbnailPng)) }) } };
  } else if (input.kind === 'assembly') {
    const embedded = new Map<string, PartDocumentBundle>();
    for (const [key, part] of input.bundle.embeddedDocuments) {
      embedded.set(key, { ...part, attachments: await attachments(part.attachments) });
    }
    copied = { ...input, bundle: { ...input.bundle, embeddedDocuments: embedded,
      attachments: await attachments(input.bundle.attachments) }, options: { ...input.options,
      ...(input.options.thumbnailPng === undefined ? {} : { thumbnailPng: new Uint8Array(await copyBuffer(input.options.thumbnailPng)) }) } };
  } else if (input.kind === 'drawingTemplate') {
    copied = captureSaveSnapshot(input);
  } else {
    copied = { ...input, options: { ...input.options, source: await source(input.options.source),
      ...(input.options.thumbnailPng === undefined ? {} : { thumbnailPng: new Uint8Array(await copyBuffer(input.options.thumbnailPng)) }) } };
  }
  signal?.throwIfAborted();
  maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
  return { input: copied, transfer, copiedBytes, maxSliceMs, yields };
}
