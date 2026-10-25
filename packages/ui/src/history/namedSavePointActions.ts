import {
  emptyPcadAttachments, readDocumentBundle, readDrawingBundle, readPcadFile, type SaveDocumentInput,
} from '@pointercad/io';
import { createAssemblyDocumentBundle, drawingSourceInputOf, partLibraryOfBundle } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocument } from '../store/documentKind.js';
import { beginDocumentRequest } from '../store/documentRequest.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { captureSaveSnapshot } from '../file/pcadSaveSnapshot.js';
import { loadedPartAttachments } from '../file/loadedPartAttachments.js';
import { createPcadSavePointClient, type PcadSavePointClient } from '../file/pcadSaveWorker.js';
import type { PcadCloneAndListResult } from '../file/pcadSaveProtocol.js';
import { t } from '../i18n/t.js';
import { DEFINITION_DIFF_MAX_FILE_BYTES } from '../diff/definitionDiffProtocol.js';
import type { ComparisonFile } from '../diff/pickComparisonFile.js';
import { SavePointError, type CreatedSavePointListing, type NamedSavePoint, type SavePointKind } from './namedSavePoints.js';

type Repository = Omit<PcadSavePointClient, 'cloneAndList' | 'createAndList'> & Partial<Pick<PcadSavePointClient, 'cloneAndList' | 'createAndList'>>;
export interface SavePointComparison {
  readonly before: ComparisonFile;
  readonly after: ComparisonFile;
  readonly relationship: 'versions' | 'unrelated';
}

/** 比較Workerの一入力32MiB制限。保存点の総容量512MiBとは別の拒否。 */
export class ComparisonLimitError extends SavePointError {
  constructor() { super('limitBytes', t('documentDiff.fileLimit')); this.name = 'ComparisonLimitError'; }
}

/** 保存点の原本から、比較の画面に出す文書名を読む。読めなければnull。 */
async function documentNameOf(bytes: Uint8Array, kind: SavePointKind): Promise<string | null> {
  if (kind === 'part') { const file = readPcadFile(bytes); return file.ok && file.kind === 'part' ? file.document.name : null; }
  if (kind === 'assembly') { const file = await readDocumentBundle(bytes, 'assembly'); return file.ok ? file.bundle.document.name : null; }
  const file = await readDrawingBundle(bytes);
  return file.ok ? file.document.name : null;
}

function cancelled(): never { throw new DOMException('Operation cancelled', 'AbortError'); }

/** 通常保存先とは独立したローカル保存点。文書へ反映する口はrestoreだけ。部品・組立・図面を開いている種類で扱う。 */
export function createNamedSavePointActions(repository: Repository = createPcadSavePointClient()) {
  let active: AbortController | null = null;
  function begin(channel: 'create' | 'restore', external?: AbortSignal) {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const request = beginDocumentRequest(`namedSavePoint:${channel}`);
    const onAbort = (): void => controller.abort();
    external?.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = useAppStore.subscribe(() => { if (!request.isCurrent()) controller.abort(); });
    if (external?.aborted || !request.isCurrent()) controller.abort();
    return {
      signal: controller.signal,
      current: (): boolean => !controller.signal.aborted && request.isCurrent(),
      finish: (): void => {
        unsubscribe(); external?.removeEventListener('abort', onAbort);
        if (active === controller) active = null;
      },
    };
  }
  async function create<T>(signal: AbortSignal | undefined,
    save: (bytes: Uint8Array, kind: SavePointKind, signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = begin('create', signal);
    try {
      const state = useAppStore.getState();
      const kind = activeDocument(state).kind;
      const savedAt = new Date().toISOString();
      let snapshot: SaveDocumentInput;
      if (kind === 'assembly' && state.assembly !== null) {
        snapshot = captureSaveSnapshot({ kind: 'assembly',
          bundle: createAssemblyDocumentBundle(state.assembly, state.assemblyLibrary), options: { savedAt } });
      } else if (kind === 'drawing' && state.drawing !== null) {
        const drawing = state.drawing;
        const entry = state.drawingSources.sources.find(item => item.metadata.sourceRef === drawing.source.sourceRef
          && item.metadata.contentHash === drawing.source.contentHash);
        const source = entry === undefined ? null : drawingSourceInputOf(entry);
        if (source === null) throw new SavePointError('invalid', t('drawing.error.selectSource'));
        snapshot = captureSaveSnapshot({ kind: 'drawing', document: drawing, options: { source, savedAt } });
      } else {
        snapshot = captureSaveSnapshot({ kind: 'part', document: state.document,
          options: { savedAt, attachments: currentPcadAttachments(state.document) } });
      }
      if (!operation.current()) cancelled();
      const bytes = await state.saveDocumentEncoder(snapshot, { signal: operation.signal });
      if (!operation.current()) cancelled();
      const point = await save(bytes, kind, operation.signal);
      if (!operation.current()) cancelled();
      return point;
    } finally { operation.finish(); }
  }
  return {
    list: (signal?: AbortSignal): Promise<readonly NamedSavePoint[]> => repository.list(signal),
    clone: (id: string, name: string, signal?: AbortSignal): Promise<NamedSavePoint> => repository.clone(id, name, signal),
    async cloneAndList(id: string, name: string, signal?: AbortSignal): Promise<PcadCloneAndListResult> {
      if (repository.cloneAndList !== undefined) return repository.cloneAndList(id, name, signal);
      // Explicitly injected repositories retain their separate clone/list validation.
      const point = await repository.clone(id, name, signal);
      try {
        signal?.throwIfAborted();
        const points = await repository.list(signal);
        signal?.throwIfAborted();
        return { point, listing: { ok: true, points } };
      } catch (cause) {
        if (signal?.aborted) throw cause;
        return { point, listing: { ok: false,
          reason: cause instanceof SavePointError ? cause.reason : 'unavailable',
          message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096) } };
      }
    },
    create: (name: string, signal?: AbortSignal): Promise<NamedSavePoint> =>
      create(signal, (bytes, kind, operationSignal) => repository.create(name, bytes, kind, operationSignal)),
    createAndList: (name: string, signal?: AbortSignal): Promise<CreatedSavePointListing> =>
      create(signal, async (bytes, kind, operationSignal) => {
        if (repository.createAndList !== undefined) return repository.createAndList(name, bytes, kind, operationSignal);
        const point = await repository.create(name, bytes, kind, operationSignal);
        operationSignal.throwIfAborted();
        return { point, points: await repository.list(operationSignal) };
      }),
    async restore(id: string, signal?: AbortSignal): Promise<NamedSavePoint> {
      const operation = begin('restore', signal);
      try {
        const saved = await repository.read(id, operation.signal);
        if (!operation.current()) cancelled();
        const wrongKind = (): SavePointError => new SavePointError('invalid', t('file.error.wrongKind'));
        const corrupt = (): SavePointError => new SavePointError('corrupt', t('file.error.corrupted'));
        if (activeDocument(useAppStore.getState()).kind !== saved.point.kind) throw wrongKind();
        if (saved.point.kind === 'assembly') {
          const opened = await readDocumentBundle(saved.bytes, 'assembly');
          if (!operation.current()) cancelled();
          if (!opened.ok || opened.bundle.kind !== 'assembly') throw corrupt();
          const state = useAppStore.getState();
          if (state.assembly === null) throw wrongKind();
          // No await after this check: the document and its library return together in one Undo step.
          operation.finish();
          state.applyAssembly(opened.bundle.document, partLibraryOfBundle(opened.bundle));
          return saved.point;
        }
        if (saved.point.kind === 'drawing') {
          const opened = await readDrawingBundle(saved.bytes);
          if (!operation.current()) cancelled();
          if (!opened.ok) throw corrupt();
          const state = useAppStore.getState();
          if (state.drawing === null) throw wrongKind();
          operation.finish();
          state.applyDrawing(opened.document, { sources: [{ metadata: opened.document.source, ...opened.source }] });
          return saved.point;
        }
        const opened = readPcadFile(saved.bytes);
        if (!opened.ok || opened.kind !== 'part') throw corrupt();
        const state = useAppStore.getState();
        if (state.assembly !== null || state.drawing !== null) throw wrongKind();
        const retained = { ...emptyPcadAttachments(), shapes: state.importedShapes,
          meshes: state.importedMeshes, canvases: state.canvases };
        const loaded = loadedPartAttachments(opened.document, opened.attachments, retained,
          kind => `${kind}-asset-${crypto.randomUUID()}`);
        if (!operation.current()) cancelled();
        // No await after this check: asset registry and one Undo step are applied together.
        operation.finish();
        state.setImportedAttachments(loaded.attachments.shapes, loaded.attachments.meshes);
        state.setCanvasImages(loaded.attachments.canvases);
        state.applyDocument(loaded.document, { replacesDocument: true });
        return saved.point;
      } finally { operation.finish(); }
    },
    async comparison(beforeId: string, afterId: string, signal?: AbortSignal): Promise<SavePointComparison> {
      const before = await repository.read(beforeId, signal);
      signal?.throwIfAborted();
      const after = await repository.read(afterId, signal);
      signal?.throwIfAborted();
      const kind = before.point.kind;
      if (after.point.kind !== kind) throw new SavePointError('invalid', t('documentDiff.kindMismatch'));
      if (before.bytes.byteLength > DEFINITION_DIFF_MAX_FILE_BYTES || after.bytes.byteLength > DEFINITION_DIFF_MAX_FILE_BYTES)
        throw new ComparisonLimitError();
      const first = await documentNameOf(before.bytes, kind), second = await documentNameOf(after.bytes, kind);
      signal?.throwIfAborted();
      if (first === null || second === null) throw new SavePointError('corrupt', t('file.error.corrupted'));
      const extension = kind === 'part' ? 'pcad' : kind === 'assembly' ? 'pcada' : 'pcadd';
      return {
        before: { fileName: `${before.point.name}.${extension}`, documentName: first, bytes: before.bytes, documentKind: kind },
        after: { fileName: `${after.point.name}.${extension}`, documentName: second, bytes: after.bytes, documentKind: kind },
        relationship: before.point.originId === after.point.originId ? 'versions' : 'unrelated',
      };
    },
  };
}

export type NamedSavePointActions = ReturnType<typeof createNamedSavePointActions>;
