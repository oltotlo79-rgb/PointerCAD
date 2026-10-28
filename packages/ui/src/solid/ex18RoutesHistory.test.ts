/** W08 real Zustand history. W07 owns numeric-input failure/cancellation atomicity. */
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitContextReference, contentHashOf, contextPointResolverFromBodies, recomputePart, replaceSolid,
  resolveSubShapeReference, type PartDocument, type ResolvedPart, type KernelBridge } from '@pointercad/model';
import { emptyPcadAttachments, readPcadFile, writePcadFile, writeDocumentBundle, readDocumentBundle } from '@pointercad/io';
import { createAssemblyDocumentBundle, partLibraryOfBundle, type PartLibrary } from '@pointercad/model';
import { createInspectableNativeKernelForNodeTests, initializeNativeKernelForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { buildEx18SketchBracket, buildEx18SewnBracket, buildEx18ExpressionBracket,
  buildEx18RevolvedFlange, buildEx18RuledFlange, buildEx18ExpressionFlange,
  buildEx18ExtrudedOblique, buildEx18SewnOblique, buildEx18ExpressionOblique,
  editEx18SketchHoleDiameter, editEx18SewnDiameter, editEx18ExpressionDiameter, moveEx18ExpressionHole,
  editEx18RevolvedFlangeRadius, editEx18FlangeBore, editEx18ObliqueDepth, routeExpression } from '../../../model/src/part/ex18RouteBuilders.js';
import { appendEx18DirectEdit, directFaceReference, directPlanarFace, importEx18DirectSeed } from '../../../model/src/part/ex18RouteBuildersDirect.js';
import { buildEx18ContextAssembly, buildEx18ContextPart, buildEx18ContextSource, contextPlacement,
  ex18ContextSourceFace } from '../../../model/src/assembly/ex18ContextRouteBuilders.js';
import { EX18_ORACLE_EXPECTATIONS, EX18_ORACLE_A_DIAMETER_EIGHT, EX18_ORACLE_B_RADIUS_FOUR,
  EX18_ORACLE_C_DEPTH_TWELVE, EX18_ORACLE_A_HOLE_X_TWELVE, EX18_ORACLE_B_CONTEXT_MOVED,
  EX18_ORACLE_C_CONTEXT_MOVED } from '../../../model/src/part/ex18RouteFixtures.js';
import { compareEx18Shape, type Ex18ShapeExpectation } from '../../../model/src/part/ex18ShapeOracle.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

const TIMEOUT = 180_000, SAVED_AT = '2026-10-26T00:00:00.000Z';
beforeAll(initializeNativeKernelForNodeTests, TIMEOUT);
beforeEach(resetTestStore);
type Native = Awaited<ReturnType<typeof createInspectableNativeKernelForNodeTests>>;
type Shape = 'A' | 'B' | 'C';
const cases = (['A', 'B', 'C'] as const).flatMap(shape =>
  (['sketch', 'surface/wire', 'expression', 'direct STEP'] as const).map(route => ({ shape, route })));
type Route = typeof cases[number]['route'];
const changed: Readonly<Record<Shape, Ex18ShapeExpectation>> = {
  A: EX18_ORACLE_A_DIAMETER_EIGHT, B: EX18_ORACLE_B_RADIUS_FOUR, C: EX18_ORACLE_C_DEPTH_TWELVE,
};
const directChanged: Readonly<Record<Shape, Ex18ShapeExpectation>> = {
  A: { volume: 14400 - 108 * Math.PI, low: [0, 0, 0], high: [40, 30, 12],
    holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 }] },
  B: { volume: 3355 * Math.PI, low: [-15, -15, 0], high: [15, 15, 30],
    holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 3 }] },
  C: { volume: 3000, low: [0, 0, 0], high: [25, 15, 10], holes: [] },
};

async function author(shape: Shape, route: Exclude<Route, 'direct STEP'>, bridge: KernelBridge) {
  if (shape === 'A') return route === 'sketch' ? buildEx18SketchBracket(bridge)
    : route === 'surface/wire' ? buildEx18SewnBracket(bridge) : buildEx18ExpressionBracket(bridge);
  if (shape === 'B') return route === 'sketch' ? buildEx18RevolvedFlange()
    : route === 'surface/wire' ? buildEx18RuledFlange(bridge) : buildEx18ExpressionFlange(bridge);
  return route === 'sketch' ? buildEx18ExtrudedOblique() : route === 'surface/wire' ? buildEx18SewnOblique() : buildEx18ExpressionOblique();
}

async function builtRoute(shape: Shape, route: Route, native: Native) {
  if (route === 'direct STEP') {
    const seed = await importEx18DirectSeed(native.bridge, `direct-seed-${shape}.step`,
      readFileSync(new URL(`../../../model/src/part/fixtures/ex18/direct-seed-${shape}.step`, import.meta.url)));
    const initial = await recomputePart(seed.part, native.bridge, { importedShapes: seed.importedShapes });
    expect(initial.errors).toEqual([]);
    const [body] = initial.bodies;
    if (body === undefined) throw new Error('W08 native STEP source missing');
    const face = directFaceReference(body, directPlanarFace(body, shape === 'C' ? [0, 1, 0] : [0, 0, 1], shape === 'A' ? 8 : shape === 'B' ? 20 : 5));
    return { part: appendEx18DirectEdit(seed, face, shape === 'A' ? '2' : '5'), finalId: 'direct-edit',
      shapes: seed.importedShapes ?? new Map<string, Uint8Array>(), edit: (part: PartDocument): PartDocument => {
        const feature = part.solids.find(entry => entry.id === 'direct-edit');
        if (feature?.kind !== 'faceOffset') throw new Error('W08 saved direct edit missing');
        return replaceSolid(part, feature.id, { ...feature, offset: routeExpression(shape === 'A' ? '4' : '10') });
      } };
  }
  const built = await author(shape, route, native.bridge);
  return { ...built, shapes: new Map<string, Uint8Array>(), edit: (part: PartDocument): PartDocument => {
    if (shape === 'A') {
      const hole = part.solids.find(feature => feature.id === built.finalId);
      if (hole?.kind !== 'hole' || hole.centers[0] === undefined) throw new Error('W08 saved hole missing');
      const input = { ...built, part, centerId: hole.centers[0].pointFeatureId };
      return route === 'sketch' ? editEx18SketchHoleDiameter(input) : route === 'surface/wire'
        ? editEx18SewnDiameter(input) : editEx18ExpressionDiameter(input);
    }
    if (shape === 'B') return route === 'sketch' ? editEx18RevolvedFlangeRadius({ ...built, part })
      : editEx18FlangeBore({ ...built, part }, route === 'expression' ? '2*4' : '8');
    return editEx18ObliqueDepth({ ...built, part }, route === 'expression' ? '3*4' : '12');
  } };
}

function inspect(native: Native, resolved: ResolvedPart | undefined, id: string, expected: Ex18ShapeExpectation): void {
  const key = resolved?.steps.find(step => step.featureId === id)?.key;
  if (key === undefined) throw new Error('W08 completed native key missing');
  const m = native.inspectShape(key).measure(), comparison = compareEx18Shape(m, expected);
  expect(m.validity).toMatchObject({ valid: true, closed: true, solidCount: 1 });
  expect(m.boundsMethod).toBe('analytic-brep'); expect(m.meshApproximation).toBeNull(); expect(m.limitations).toEqual([]);
  expect(m.holesComplete).toBe(true); expect(m.throughHoleCount).toBe(expected.holes.length);
  expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9); expect(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6); expect(comparison.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6); expect(comparison.failures).toEqual([]);
}

async function settled(): Promise<void> {
  await vi.waitFor(() => {
    const state = useAppStore.getState();
    expect(state.isComputing).toBe(false); expect(state.lastOutcome).toBe('success');
    expect(state.completedGeneration).toBe(state.requestedGeneration);
  }, { timeout: 90_000, interval: 20 });
}

describe('EX18 W08 actual store histories for the twelve part routes', () => {
  it.each(cases)('$shape / $route: one dimension edit, one Undo and one Redo restore exact saved inputs and native geometry', async spec => {
    const authoring = await createInspectableNativeKernelForNodeTests(), native = await createInspectableNativeKernelForNodeTests();
    let detach = (): void => {};
    try {
      const built = await builtRoute(spec.shape, spec.route, authoring);
      const bytes = writePcadFile(built.part, { savedAt: SAVED_AT, attachments: { ...emptyPcadAttachments(), shapes: built.shapes } });
      const read = readPcadFile(bytes);
      if (!read.ok) throw new Error(JSON.stringify(read.error));
      expect(read.document).toEqual(built.part);
      useAppStore.setState({ importedShapes: read.attachments.shapes });
      useAppStore.getState().applyDocument(read.document, { opensDocument: true });
      let resolved: ResolvedPart | undefined;
      let firstCacheHits: number | undefined;
      detach = attachPartRecompute(async (part, options) => {
        const result = await recomputePart(part, native.bridge, { ...options, onResolved: value => { resolved = value; } });
        firstCacheHits ??= result.cacheHits;
        return result;
      });
      await settled(); expect(firstCacheHits).toBe(0);
      const original = useAppStore.getState().document, savedHash = await contentHashOf(original);
      expect(useAppStore.getState().undoStack.past).toHaveLength(0);
      inspect(native, resolved, built.finalId, EX18_ORACLE_EXPECTATIONS[spec.shape]);
      const edited = built.edit(original);
      useAppStore.getState().applyDocument(edited);
      await settled();
      const after = useAppStore.getState().document;
      expect(after.solids.map(feature => feature.id)).toEqual(original.solids.map(feature => feature.id));
      expect(useAppStore.getState().undoStack.past).toHaveLength(1);
      expect(useAppStore.getState().importedShapes).toEqual(read.attachments.shapes);
      inspect(native, resolved, built.finalId, (spec.route === 'direct STEP' ? directChanged : changed)[spec.shape]);
      const afterHash = await contentHashOf(after);
      expect(afterHash).not.toBe(savedHash);
      useAppStore.getState().undo(); await settled();
      expect(useAppStore.getState().document).toEqual(original);
      expect(await contentHashOf(useAppStore.getState().document)).toBe(savedHash);
      expect(useAppStore.getState().undoStack.past).toHaveLength(0); expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      inspect(native, resolved, built.finalId, EX18_ORACLE_EXPECTATIONS[spec.shape]);
      useAppStore.getState().redo(); await settled();
      expect(useAppStore.getState().document).toEqual(after);
      expect(await contentHashOf(useAppStore.getState().document)).toBe(afterHash);
      expect(useAppStore.getState().undoStack.past).toHaveLength(1); expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      expect(useAppStore.getState().importedShapes).toEqual(read.attachments.shapes);
      inspect(native, resolved, built.finalId, (spec.route === 'direct STEP' ? directChanged : changed)[spec.shape]);
    } finally { detach(); native.dispose(); authoring.dispose(); }
  }, TIMEOUT);

  it('two expression fields are two separate operations, restored one step at a time with their original sources', async () => {
    const native = await createInspectableNativeKernelForNodeTests();
    let detach = (): void => {};
    try {
      const built = await buildEx18ExpressionBracket(native.bridge);
      useAppStore.getState().applyDocument(built.part, { opensDocument: true });
      let resolved: ResolvedPart | undefined;
      detach = attachPartRecompute((part, options) => recomputePart(part, native.bridge, { ...options, onResolved: next => { resolved = next; } }));
      await settled();
      const before = useAppStore.getState().document;
      useAppStore.getState().applyDocument(editEx18ExpressionDiameter({ ...built, part: before }));
      await settled(); const diameter = useAppStore.getState().document;
      inspect(native, resolved, built.finalId, EX18_ORACLE_A_DIAMETER_EIGHT);
      useAppStore.getState().applyDocument(moveEx18ExpressionHole({ ...built, part: diameter }));
      await settled(); const moved = useAppStore.getState().document;
      const both: Ex18ShapeExpectation = { ...EX18_ORACLE_A_DIAMETER_EIGHT,
        holes: [{ axisOrigin: [12, 15, 0], direction: [0, 0, 1], radius: 4 }] };
      inspect(native, resolved, built.finalId, both);
      expect(useAppStore.getState().undoStack.past).toHaveLength(2);
      const readSources = (): readonly string[] => {
        const part = useAppStore.getState().document, hole = part.solids.find(feature => feature.id === built.finalId);
        const point = part.sketches[0].features.find(feature => feature.id === built.centerId);
        if (hole?.kind !== 'hole' || point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('W08 expression fields missing');
        return [hole.diameter.source, point.at.x.source];
      };
      expect(readSources()).toEqual(['2*4', '40/4+2']);
      useAppStore.getState().undo(); await settled();
      expect(useAppStore.getState().document).toEqual(diameter); expect(readSources()).toEqual(['2*4', '40/4']);
      expect(useAppStore.getState().undoStack.past).toHaveLength(1);
      inspect(native, resolved, built.finalId, EX18_ORACLE_A_DIAMETER_EIGHT);
      useAppStore.getState().undo(); await settled();
      expect(useAppStore.getState().document).toEqual(before); expect(readSources()).toEqual(['2*3', '40/4']);
      expect(useAppStore.getState().undoStack.past).toHaveLength(0);
      inspect(native, resolved, built.finalId, EX18_ORACLE_EXPECTATIONS.A);
      useAppStore.getState().redo(); await settled();
      expect(useAppStore.getState().document).toEqual(diameter); expect(readSources()).toEqual(['2*4', '40/4']);
      inspect(native, resolved, built.finalId, EX18_ORACLE_A_DIAMETER_EIGHT);
      useAppStore.getState().redo(); await settled();
      expect(useAppStore.getState().document).toEqual(moved); expect(readSources()).toEqual(['2*4', '40/4+2']);
      inspect(native, resolved, built.finalId, both);
    } finally { detach(); native.dispose(); }
  }, TIMEOUT);
});

const contextCases = [
  { shape: 'A', position: [-2, 23, 6], moved: [0, 23, 6], expected: EX18_ORACLE_A_HOLE_X_TWELVE },
  { shape: 'B', position: [-12, 8, 21], moved: [-10, 8, 21], expected: EX18_ORACLE_B_CONTEXT_MOVED },
  { shape: 'C', position: [-12, 8, -4], moved: [-5, 11, -2], expected: EX18_ORACLE_C_CONTEXT_MOVED },
] as const;

function partOf(library: PartLibrary, ref: string): PartDocument {
  const part = library.parts.get(ref);
  if (part === undefined) throw new Error('W08 stored embedded part missing');
  return part;
}

describe('EX18 W08 actual assembly store histories', () => {
  it.each(contextCases)('$shape: a manual source update is one Undo including the embedded part revision', async spec => {
    const native = await createInspectableNativeKernelForNodeTests();
    try {
      const built = await buildEx18ContextPart(spec.shape, native.bridge), sourcePart = buildEx18ContextSource();
      const source = await recomputePart(sourcePart, native.bridge);
      expect(source.errors).toEqual([]);
      const [body] = source.bodies;
      if (body === undefined) throw new Error('W08 assembly source body missing');
      const scene = await buildEx18ContextAssembly(built.part, sourcePart, ex18ContextSourceFace(body), contextPlacement(spec.position));
      const resolver = contextPointResolverFromBodies(component => component.id === scene.b.id ? [body] : null, resolveSubShapeReference);
      const initial = await commitContextReference(scene.document, scene.library, scene.link, resolver);
      if ('code' in initial) throw new Error(JSON.stringify(initial));
      const read = await readDocumentBundle(await writeDocumentBundle(createAssemblyDocumentBundle(initial.document, initial.library), { savedAt: SAVED_AT }), 'assembly');
      if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('W08 PCADA read failed');
      const library = partLibraryOfBundle(read.bundle);
      useAppStore.getState().openAssembly(read.bundle.document, library);
      const before = useAppStore.getState();
      const check = async (expected: Ex18ShapeExpectation): Promise<void> => {
        const state = useAppStore.getState(), part = partOf(state.assemblyLibrary, scene.targetRef);
        const fresh = await createInspectableNativeKernelForNodeTests();
        try {
          let resolved: ResolvedPart | undefined;
          const result = await recomputePart(part, fresh.bridge, { onResolved: next => { resolved = next; } });
          expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false); expect(result.cacheHits).toBe(0);
          inspect(fresh, resolved, built.finalId, expected);
        } finally { fresh.dispose(); }
      };
      await check(EX18_ORACLE_EXPECTATIONS[spec.shape]);
      if (before.assembly === null) throw new Error('W08 store assembly missing');
      const moved = { ...before.assembly, components: before.assembly.components.map(component => component.id === scene.b.id
        ? { ...component, placement: contextPlacement(spec.moved) } : component) };
      // Moving the source and manually updating its reference are two separate UI operations.
      useAppStore.getState().applyAssembly(moved);
      const placed = useAppStore.getState();
      expect(placed.assemblyUndoStack?.past).toHaveLength(1);
      expect(placed.assemblyLibrary).toBe(before.assemblyLibrary);
      await check(EX18_ORACLE_EXPECTATIONS[spec.shape]);
      const update = await commitContextReference(moved, placed.assemblyLibrary, scene.link, resolver);
      if ('code' in update) throw new Error(JSON.stringify(update));
      useAppStore.getState().applyAssembly(update.document, update.library);
      const after = useAppStore.getState();
      expect(after.assemblyUndoStack?.past).toHaveLength(2);
      expect(after.assembly?.contextReferences).toEqual(before.assembly.contextReferences);
      expect(await contentHashOf(partOf(after.assemblyLibrary, scene.targetRef)))
        .not.toBe(await contentHashOf(partOf(before.assemblyLibrary, scene.targetRef)));
      await check(spec.expected);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assembly).toEqual(placed.assembly);
      expect(useAppStore.getState().assemblyLibrary).toEqual(placed.assemblyLibrary);
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
      expect(useAppStore.getState().assemblyUndoStack?.future).toHaveLength(1);
      await check(EX18_ORACLE_EXPECTATIONS[spec.shape]);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assembly).toEqual(before.assembly);
      expect(useAppStore.getState().assemblyLibrary).toEqual(before.assemblyLibrary);
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
      expect(useAppStore.getState().assemblyUndoStack?.future).toHaveLength(2);
      await check(EX18_ORACLE_EXPECTATIONS[spec.shape]);
      useAppStore.getState().redo();
      expect(useAppStore.getState().assembly).toEqual(placed.assembly);
      expect(useAppStore.getState().assemblyLibrary).toEqual(placed.assemblyLibrary);
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
      expect(useAppStore.getState().assemblyUndoStack?.future).toHaveLength(1);
      await check(EX18_ORACLE_EXPECTATIONS[spec.shape]);
      useAppStore.getState().redo();
      expect(useAppStore.getState().assembly).toEqual(after.assembly);
      expect(useAppStore.getState().assemblyLibrary).toEqual(after.assemblyLibrary);
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(2);
      expect(useAppStore.getState().assemblyUndoStack?.future).toHaveLength(0);
      await check(spec.expected);
    } finally { native.dispose(); }
  }, TIMEOUT);
});
