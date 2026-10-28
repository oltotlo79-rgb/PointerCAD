/** Node-only E2E oracle. Saved authored bytes are recomputed in a new native session per measurement. */
import { createHash } from 'node:crypto';
import { expect, type TestInfo } from '@playwright/test';
import { readDocumentBundle, readPcadFile, type ReadPcadFileResult } from '../../packages/io/src/index.js';
import type { PartDocument } from '../../packages/model/src/part/types.js';
import type { ResolvedPart } from '../../packages/model/src/part/resolvePart.js';
import { recomputePart } from '../../packages/model/src/part/recomputePart.js';
import { compareEx18Shape, type Ex18ShapeExpectation } from '../../packages/model/src/part/ex18ShapeOracle.js';
import { createInspectableNativeKernelForNodeTests } from '../../packages/model/src/testing/createNativeKernelBridge.node.js';

export const EX18_A6: Ex18ShapeExpectation = {
  volume: 12000 - 90 * Math.PI, low: [0, 0, 0], high: [40, 30, 10],
  holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 }],
};
export const EX18_A8: Ex18ShapeExpectation = {
  volume: 12000 - 160 * Math.PI, low: [0, 0, 0], high: [40, 30, 10],
  holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 4 }],
};
export const EX18_BLANK8: Ex18ShapeExpectation = { volume: 9600, low: [0, 0, 0], high: [40, 30, 8], holes: [] };
export const EX18_BLANK10: Ex18ShapeExpectation = { volume: 12000, low: [0, 0, 0], high: [40, 30, 10], holes: [] };

// gap-report §3 and ex18RouteFixtures.ts: B = π(225*5 + 100*20 - r²*25).
export const EX18_B6: Ex18ShapeExpectation = {
  volume: 2900 * Math.PI, low: [-15, -15, 0], high: [15, 15, 25],
  holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 3 }],
};
export const EX18_B8: Ex18ShapeExpectation = {
  volume: 2725 * Math.PI, low: [-15, -15, 0], high: [15, 15, 25],
  holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 4 }],
};

export function ex18BytesSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function ex18ReadPart(bytes: Uint8Array): Extract<ReadPcadFileResult, { readonly ok: true }> {
  const read = readPcadFile(bytes);
  if (!read.ok) throw new Error(`EX18 saved part rejected: ${read.error.message}`);
  return read;
}

async function measureDocument(document: PartDocument, shapes: ReadonlyMap<string, Uint8Array>,
  expected: Ex18ShapeExpectation, info: TestInfo, label: string, inputSha: string): Promise<void> {
  const native = await createInspectableNativeKernelForNodeTests();
  try {
    let resolved: ResolvedPart | undefined;
    const result = await recomputePart(document, native.bridge, {
      importedShapes: shapes, onResolved: value => { resolved = value; },
    });
    expect(result.cancelled, label).toBe(false);
    expect(result.errors, label).toEqual([]);
    expect(result.bodies, label).toHaveLength(1);
    const body = result.bodies[0];
    const step = resolved?.steps.find(item => item.featureId === body?.featureId);
    if (body === undefined || step === undefined) throw new Error(`EX18 native final body missing: ${label}`);
    const measurement = native.inspectShape(step.key).measure();
    const comparison = compareEx18Shape(measurement, expected);
    await info.attach(`ex18-${label}-native-oracle`, {
      body: JSON.stringify({ inputSha, documentId: document.id, featureId: body.featureId,
        authoredKinds: document.solids.map(feature => feature.kind), expected, measurement, comparison }),
      contentType: 'application/json',
    });
    expect(measurement.validity.valid, label).toBe(true);
    expect(measurement.validity.solidCount, label).toBe(1);
    expect(measurement.validity.closed, label).toBe(true);
    expect(measurement.holesComplete, label).toBe(true);
    expect(measurement.meshApproximation, label).toBeNull();
    expect(measurement.throughHoleCount, label).toBe(expected.holes.length);
    expect(comparison.volumeRelativeError, label).toBeLessThanOrEqual(1e-9);
    expect(comparison.boundsMaximumErrorMm, label).toBeLessThanOrEqual(1e-6);
    expect(comparison.holeAxisMaximumErrorMm, label).toBeLessThanOrEqual(1e-6);
    expect(comparison.holeRadiusMaximumErrorMm, label).toBeLessThanOrEqual(1e-6);
    expect(comparison.holeDirectionMaximumError, label).toBeLessThanOrEqual(1e-6);
    expect(comparison.failures, label).toEqual([]);
    expect(comparison.matches, label).toBe(true);
  } finally { native.dispose(); }
}

export async function expectEx18Part(bytes: Uint8Array, expected: Ex18ShapeExpectation,
  info: TestInfo, label: string): Promise<void> {
  const read = ex18ReadPart(bytes);
  await measureDocument(read.document, read.attachments.shapes, expected, info, label, ex18BytesSha(bytes));
}

export async function ex18ReadAssembly(bytes: Uint8Array) {
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('EX18 saved assembly rejected');
  return read.bundle;
}

export async function expectEx18AssemblyPart(bytes: Uint8Array, expected: Ex18ShapeExpectation,
  info: TestInfo, label: string) {
  const bundle = await ex18ReadAssembly(bytes);
  const component = bundle.document.components[0];
  if (component?.source.kind !== 'part') throw new Error('EX18 first assembly part missing');
  const embedded = bundle.embeddedDocuments.get(component.source.partRef);
  if (embedded === undefined) throw new Error('EX18 embedded authored part missing');
  await measureDocument(embedded.document, embedded.attachments.shapes, expected, info, label, ex18BytesSha(bytes));
  return { document: bundle.document, part: embedded.document };
}

export const EX18_B_BLANK: Ex18ShapeExpectation = { volume: 3125 * Math.PI, low: [-15, -15, 0], high: [15, 15, 25], holes: [] };


// UI-authored B/c seed has no bore: π(225*5 + 100*15), top z20.
export const EX18_B_BLANK20: Ex18ShapeExpectation = { volume: 2625 * Math.PI, low: [-15, -15, 0], high: [15, 15, 20], holes: [] };


export const EX18_C10: Ex18ShapeExpectation = { volume: 2000, low: [0, 0, 0], high: [25, 10, 10], holes: [] };
export const EX18_C5: Ex18ShapeExpectation = { volume: 1000, low: [0, 0, 0], high: [25, 5, 10], holes: [] };
export const EX18_C3: Ex18ShapeExpectation = { volume: 600, low: [0, 0, 0], high: [25, 3, 10], holes: [] };
