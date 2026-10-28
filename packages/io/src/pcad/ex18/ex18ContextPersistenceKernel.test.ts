import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { attachmentsDigestOf, commitContextReference, contentHashOf, contextPointResolverFromBodies,
  createAssemblyDocumentBundle, createUndoStack, partLibraryOfBundle, pushUndo, redo,
  resolveSubShapeReference, undo, type AssemblyDocument, type PartLibrary } from '@pointercad/model';
import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import { buildEx18ContextAssembly, buildEx18ContextPart, buildEx18ContextSource, contextPlacement,
  ex18ContextSourceFace } from '../../../../model/src/assembly/ex18ContextRouteBuilders.js';
import { EX18_ORACLE_A_HOLE_X_TWELVE, EX18_ORACLE_B_CONTEXT_MOVED,
  EX18_ORACLE_C_CONTEXT_MOVED } from '../../../../model/src/part/ex18RouteFixtures.js';
import { readDocumentBundle, writeDocumentBundle } from '../pcadFile.js';
import { EX18_ORACLE_EXPECTATIONS, W08_TIMEOUT, W08_SAVED_AT, w08Session, w08Compute, w08Expect } from './ex18PersistenceSupport.js';

beforeAll(loadOcctForNode, W08_TIMEOUT);
const cases = [
  { shape: 'A', position: [-2, 23, 6], moved: [0, 23, 6], point: [12, 15, 10], expected: EX18_ORACLE_A_HOLE_X_TWELVE },
  { shape: 'B', position: [-12, 8, 21], moved: [-10, 8, 21], point: [2, 0, 25], expected: EX18_ORACLE_B_CONTEXT_MOVED },
  { shape: 'C', position: [-12, 8, -4], moved: [-5, 11, -2], point: [7, 3, 2], expected: EX18_ORACLE_C_CONTEXT_MOVED },
] as const;

function target(library: PartLibrary, ref: string) {
  const part = library.parts.get(ref);
  if (part === undefined) throw new Error('W08 embedded target missing');
  return part;
}

async function reopen(document: AssemblyDocument, library: PartLibrary) {
  const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: W08_SAVED_AT });
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('W08 real PCADA reopen failed');
  expect(read.bundle.document).toEqual(document);
  const restored = partLibraryOfBundle(read.bundle);
  expect(restored.partFiles).toEqual(library.partFiles); expect(restored.parts).toEqual(library.parts);
  expect(restored.attachments).toEqual(new Map([...library.attachments].map(([ref, attachments]) => [ref, {
    ...attachments, shapeDigests: new Map([...attachments.shapes].map(([shapeRef, bytes]) =>
      [shapeRef, createHash('sha256').update(bytes).digest('hex')])),
  }])));
  expect(await writeDocumentBundle(read.bundle, { savedAt: W08_SAVED_AT })).toEqual(bytes);
  for (const file of restored.partFiles) {
    expect(file.contentHash).toBe(await contentHashOf(target(restored, file.ref)));
    const attachments = restored.attachments.get(file.ref);
    if (attachments === undefined) throw new Error('W08 embedded attachments missing');
    expect(file.attachmentsDigest).toBe(await attachmentsDigestOf(attachments));
  }
  return { document: read.bundle.document, library: restored };
}

describe('EX18 W08 three assembly-context routes, actual PCADA and embedded revisions', () => {
  it.each(cases)('$shape cold reopen, manual source update and exact assembly/library Undo/Redo', async spec => {
    const original = w08Session();
    try {
      const built = await buildEx18ContextPart(spec.shape, original.bridge), sourcePart = buildEx18ContextSource();
      const source = await w08Compute(sourcePart, 'source-box', original);
      const scene = await buildEx18ContextAssembly(built.part, sourcePart, ex18ContextSourceFace(source.body), contextPlacement(spec.position));
      // The existing compatibility contract: old assemblies omit contextReferences, without inventing a schema version.
      const legacy = await reopen(scene.document, scene.library);
      expect('contextReferences' in legacy.document).toBe(false);
      const initial = await commitContextReference(scene.document, scene.library, scene.link,
        contextPointResolverFromBodies(component => component.id === scene.b.id ? [source.body] : null, resolveSubShapeReference));
      if ('code' in initial) throw new Error(JSON.stringify(initial));
      const reopened = await reopen(initial.document, initial.library);
      expect(reopened.document.contextReferences).toEqual([scene.link]);
      const beforePart = target(reopened.library, scene.targetRef), beforeHash = await contentHashOf(beforePart);
      const coldCheck = async (state: typeof reopened, changed: boolean): Promise<void> => {
        const cold = w08Session();
        try {
          expect(cold.cache).not.toBe(original.cache); expect(cold.bridge).not.toBe(original.bridge);
          const actual = await w08Compute(target(state.library, scene.targetRef), built.finalId, cold);
          expect(actual.result.cacheHits).toBe(0);
          w08Expect(`${spec.shape}/assembly context/${changed ? 'updated' : 'reopened'}`, actual,
            changed ? spec.expected : EX18_ORACLE_EXPECTATIONS[spec.shape]);
        } finally { cold.dispose(); }
      };
      await coldCheck(reopened, false);
      // Resolve the saved source on a fresh kernel, never through the pre-save bridge/body.
      const sourceCold = w08Session();
      try {
        const freshSource = await w08Compute(target(reopened.library, scene.sourceRef), 'source-box', sourceCold);
        expect(freshSource.result.cacheHits).toBe(0);
        const [link] = reopened.document.contextReferences ?? [];
        if (link === undefined) throw new Error('W08 saved context link missing');
        expect(resolveSubShapeReference(freshSource.body, link.source).status).toBe('matched');
        const moved: AssemblyDocument = { ...reopened.document, components: reopened.document.components.map(component =>
          component.id === scene.b.id ? { ...component, placement: contextPlacement(spec.moved) } : component) };
        const update = await commitContextReference(moved, reopened.library, link,
          contextPointResolverFromBodies(component => component.id === scene.b.id ? [freshSource.body] : null, resolveSubShapeReference));
        if ('code' in update) throw new Error(JSON.stringify(update));
        expect(update.point).toEqual(spec.point);
        expect(update.document.contextReferences).toEqual(reopened.document.contextReferences);
        const afterPart = target(update.library, scene.targetRef);
        expect(afterPart.solids.map(feature => feature.id)).toEqual(beforePart.solids.map(feature => feature.id));
        expect(afterPart.sketches.map(sketch => sketch.features.map(feature => feature.id)))
          .toEqual(beforePart.sketches.map(sketch => sketch.features.map(feature => feature.id)));
        expect(await contentHashOf(afterPart)).not.toBe(beforeHash);
        const previousFile = reopened.library.partFiles.find(file => file.ref === scene.targetRef);
        const nextFile = update.library.partFiles.find(file => file.ref === scene.targetRef);
        expect(nextFile?.contentHash).toBe(await contentHashOf(afterPart));
        expect(nextFile?.contentHash).not.toBe(previousFile?.contentHash);
        expect(nextFile?.attachmentsDigest).toBe(previousFile?.attachmentsDigest);
        expect(update.library.parts.get(scene.sourceRef)).toEqual(reopened.library.parts.get(scene.sourceRef));
        const edited = await reopen(update.document, update.library);
        await coldCheck(edited, true);
        const history = pushUndo(createUndoStack(reopened), edited);
        expect(history.past).toHaveLength(1);
        const back = undo(history);
        expect(back.present).toEqual(reopened); expect(back.future).toHaveLength(1); expect(back.past).toHaveLength(0);
        await coldCheck(back.present, false);
        const again = redo(back);
        expect(again.present).toEqual(edited); expect(again.past).toHaveLength(1); expect(again.future).toHaveLength(0);
        await coldCheck(again.present, true);
      } finally { sourceCold.dispose(); }
      expect(await contentHashOf(beforePart)).toBe(beforeHash);
    } finally { original.dispose(); }
  }, W08_TIMEOUT);
});
