import { encodeSaveDocument, readDocumentBundle, readPcadFile } from '@pointercad/io';
import { createAssemblyDocument, createEmptyPartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { saveAssembly } from './assemblyFile.js';
import type { FileGateway } from './fileGateway.js';
import { createDefaultPartFileDeps, savePart } from './partFile.js';

// Fixed independent 1x1 PNG, with an independently verified IDAT CRC (the prior helper literal had a bad CRC).
// It is not obtained from the viewport or from the encoder being checked.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='),
  character => character.charCodeAt(0));
type Kind = 'part' | 'assembly';

function deferredImage() {
  let resolve: (image: Uint8Array | null) => void = () => { throw new Error('Image not initialized'); };
  const promise = new Promise<Uint8Array | null>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Observe the real queue notification instead of sleeping or polling a guessed clock. */
function preparing(): Promise<void> {
  return new Promise(resolve => {
    const stop = useAppStore.subscribe(state => {
      if (state.documentSaveOperation?.stage !== 'preparing') return;
      stop(); resolve();
    });
  });
}

function documentAndHistory() {
  const state = useAppStore.getState();
  return { document: state.document, assembly: state.assembly,
    undo: state.undoStack, assemblyUndo: state.assemblyUndoStack, session: state.activeDocumentId };
}

function expectUnchanged(before: ReturnType<typeof documentAndHistory>): void {
  const after = documentAndHistory();
  expect(after.document).toBe(before.document); expect(after.assembly).toBe(before.assembly);
  expect(after.undo).toBe(before.undo); expect(after.assemblyUndo).toBe(before.assemblyUndo);
  expect(after.session).toBe(before.session);
}

function fixture(kind: Kind) {
  if (kind === 'part') useAppStore.getState().applyDocument({ ...createEmptyPartDocument(), name: 'PNG boundary part' });
  else useAppStore.getState().openAssembly(createAssemblyDocument('PNG boundary assembly'));
  const savePcad = vi.fn<FileGateway['savePcad']>(name => Promise.resolve(name));
  const gateway: FileGateway = { openPcad: () => Promise.resolve(null), hasSaveTarget: () => false, savePcad };
  useAppStore.getState().setFileGateway(gateway);
  const deps = { ...createDefaultPartFileDeps(), recentFilesStorage: null };
  return { savePcad, save: () => kind === 'part' ? savePart(deps, false) : saveAssembly(deps, false) };
}

async function expectStored(
  kind: Kind, writer: ReturnType<typeof fixture>['savePcad'],
  before: ReturnType<typeof documentAndHistory>, image: Uint8Array | undefined,
): Promise<void> {
  expect(writer).toHaveBeenCalledTimes(1);
  const bytes = writer.mock.calls[0]?.[1];
  if (bytes === undefined) throw new Error('Actual encoded PCAD bytes missing');
  if (kind === 'part') {
    const result = readPcadFile(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Encoded part failed the real PCAD decoder');
    expect(result.document).toEqual(before.document); expect(result.thumbnailPng).toEqual(image);
  } else {
    const result = await readDocumentBundle(bytes, 'assembly');
    expect(result.ok).toBe(true);
    if (!result.ok || result.bundle.kind !== 'assembly') throw new Error('Encoded assembly failed the real bundle decoder');
    expect(result.bundle.document).toEqual(before.assembly); expect(result.thumbnailPng).toEqual(image);
  }
  expectUnchanged(before);
}

beforeEach(() => {
  resetTestStore();
  // Existing headless fixture: real IO encoder, never a fake byte result or browser Worker.
  useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument, documentSaveOperation: null });
});

describe('FileSlice producer → default dependencies → actual save consumer', () => {
  for (const kind of ['part', 'assembly'] as const) {
    it(`${kind}: waits for the registered pending image, then saves the exact PNG without editing history`, async () => {
      const value = fixture(kind), image = deferredImage();
      useAppStore.getState().setCaptureThumbnail(() => image.promise);
      const before = documentAndHistory(), started = preparing(), saving = value.save();
      await started;
      expect(value.savePcad).not.toHaveBeenCalled(); expectUnchanged(before);
      image.resolve(PNG); await saving;
      await expectStored(kind, value.savePcad, before, PNG);
    });

    it(`${kind}: a recomputation generation change omits the old image but preserves the saved document`, async () => {
      const value = fixture(kind), image = deferredImage();
      useAppStore.getState().setCaptureThumbnail(() => image.promise);
      const before = documentAndHistory(), generation = useAppStore.getState().requestedGeneration;
      const started = preparing(), saving = value.save(); await started;
      expect(value.savePcad).not.toHaveBeenCalled();
      useAppStore.setState({ requestedGeneration: generation + 1 });
      image.resolve(PNG); await saving;
      await expectStored(kind, value.savePcad, before, undefined);
      expect(useAppStore.getState().requestedGeneration).toBe(generation + 1);
    });

    it(`${kind}: cancellation releases the queue before a stalled image and its late result cannot write`, async () => {
      const value = fixture(kind), image = deferredImage();
      useAppStore.getState().setCaptureThumbnail(() => image.promise);
      const before = documentAndHistory(), started = preparing(), cancelledSave = value.save(); await started;
      const cancel = useAppStore.getState().documentSaveOperation?.cancel;
      if (cancel === null || cancel === undefined) throw new Error('Preparing save must offer cancellation');
      cancel(); await cancelledSave;
      expect(value.savePcad).not.toHaveBeenCalled(); expectUnchanged(before);
      // A real second encode/save on the SAME gateway must complete before the first image settles.
      useAppStore.getState().setCaptureThumbnail(() => PNG);
      await value.save(); await expectStored(kind, value.savePcad, before, PNG);
      image.resolve(PNG); await image.promise;
      expect(value.savePcad).toHaveBeenCalledTimes(1); expectUnchanged(before);
    });
  }

  it.each(['null', 'reject'] as const)('assembly: the registered %s image still saves the same document without a PNG', async mode => {
    const value = fixture('assembly');
    useAppStore.getState().setCaptureThumbnail(() => mode === 'null' ? null : Promise.reject(new Error('image unavailable')));
    const before = documentAndHistory(); await value.save();
    await expectStored('assembly', value.savePcad, before, undefined);
  });

});
