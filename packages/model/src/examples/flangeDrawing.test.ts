import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { expect, it } from 'vitest';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import { drawingDimensionContext, resolveDrawingDimensions } from '../drawing/dimensionTarget.js';
import { createDrawingResolveKernel, resolveDrawing } from '../drawing/resolveDrawing.js';
import { drawingSourceCenter } from '../drawing/sourceCenter.js';
import { drawingSourceInputOf } from '../drawing/sourceLibrary.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { withinMagnitude } from '../numericTolerance.js';
import { createDefaultConfigurations } from '../part/configurationDefaults.js';
import { recomputePart } from '../part/recomputePart.js';
import { DRAWING_EXAMPLES } from './drawingExamples.js';

it('フランジを埋め込んだ新しい図面で、体積・三面の投影・寸法が求まる', async () => {
  expect(DRAWING_EXAMPLES.map(example => example.id)).toEqual(['flangeDrawing']);
  const [example] = DRAWING_EXAMPLES;
  const { document, library } = await example.create();
  const fresh = await example.create();
  expect(fresh.document).not.toBe(document);
  expect(fresh.library).not.toBe(library);
  expect(library.sources).toHaveLength(1);
  const [entry] = library.sources;
  expect(entry.metadata).toEqual(document.source);
  const source = drawingSourceInputOf(entry);
  if (source?.sourceKind !== 'part') throw new Error('Expected a flange part');
  expect(fresh.library.sources[0].document).not.toBe(source.document);
  expect(source.document.configurations).toEqual(createDefaultConfigurations(source.document.parameters));

  const partId = source.document.id;
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  try {
    const shapeKeys = new Map<string, string>();
    const result = await recomputePart(source.document, bridge, { partId, onResolved: part => {
      for (const step of part.steps) if (step.visible) shapeKeys.set(step.featureId, step.key);
    } });
    try {
      expect(result.cancelled).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const [body] = result.bodies;
      expect(body).toMatchObject({ isValid: true, bodyKind: 'solid' });
      const frustum = (39 ** 2 + 39 * 40 + 40 ** 2) / 3;
      const volume = Math.PI * (19 * 40 ** 2 + frustum - 20 * (12 ** 2 + 4 * 4 ** 2));
      expect(withinMagnitude(body.volume - volume, 1e-9 * volume)).toBe(true);

      const bodyId = shapeKeys.get(body.featureId);
      if (bodyId === undefined) throw new Error('Missing flange shape key');
      const instances = [{ sourceRef: document.source.sourceRef, bodyId, body, placement: IDENTITY_PLACEMENT }];
      const center = drawingSourceCenter(instances);
      if (center === null) throw new Error('Missing flange bounds');
      const prepared = { bodyIds: [bodyId], center, dimensionInstances: instances };
      const kernel = createDrawingResolveKernel(bridge, () => Promise.resolve(prepared));
      const projected = await resolveDrawing(document, kernel);
      if (!projected.ok) throw new Error(projected.message);
      expect(projected.cancelled).toBe(false);
      expect(projected.failures).toEqual([]);
      expect(document.views.map(view => view.kind)).toEqual(['front', 'top', 'right']);
      expect(projected.views.map(view => view.viewId)).toEqual(document.views.map(view => view.id));
      for (const view of projected.views) expect(view.visible.length).toBeGreaterThan(0);
      const dimensions = resolveDrawingDimensions(document, drawingDimensionContext({ ...prepared, viewFrames: projected.viewFrames }));
      expect(dimensions.map(item => [item.status, item.value])).toEqual([['resolved', 80], ['resolved', 20]]);
    } finally {
      await result.referenceMeshScope?.close();
    }
  } finally {
    await bridge.releasePart(partId);
    bridge.dispose();
  }
}, 180_000);
