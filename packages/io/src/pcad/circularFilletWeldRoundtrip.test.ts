import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyPlacementToPoint, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, resolveAssembly, resolvePart,
  type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVED_AT = '2026-10-29T00:00:00.000Z';
// Independently authored wire fixture. No call to the new codec creates expected data.
function source(orientation: 1 | -1): StandardPartSource {
  const parent = { documentId: 'assembly-1', ownerId: 'cylinder', occurrencePath: ['child', 'cylinder'], sourceKey: 'part:c@3',
    placementKey: 'pose-2', bodyFeatureId: 'primitive-1', bodyKey: 'body-c' };
  const payload = { weldId: 'weld-1', beadId: 'bead-1', radialDirection: 1, normalDirection: 1,
    path: { kind: 'circular-weld-path', evidence: { kind: 'circle-edge', source: { ...parent, edgeIndex: 0 },
      centerMm: [11, 13, 17], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0], radiusMm: 10,
      parameterRange: [Math.PI / 2, Math.PI], orientation },
    intervals: [{ beadId: 'bead-1', beadSourceKey: 'draft-epoch-7', fromParameter: orientation === 1 ? Math.PI / 2 : Math.PI,
      toParameter: orientation === 1 ? Math.PI : Math.PI / 2 }] },
    parents: [
      { ...parent, role: 'plane', ownerId: 'plate', occurrencePath: ['child', 'plate'], sourceKey: 'part:p@4', bodyKey: 'body-p',
        reference: { bodyFeatureId: 'primitive-1', index: 1, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1600,
          position: [0, 0, 0], axis: [0, 0, 1], radius: null } } },
      { ...parent, role: 'cylinder', reference: { bodyFeatureId: 'primitive-1', index: 2,
        fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 200 * Math.PI, position: [0, 0, 5], axis: [0, 0, 1], radius: 10 } } },
    ] };
  const weldCircular = JSON.stringify(payload, (_key: string, value: unknown): unknown => typeof value !== 'object' || value === null || Array.isArray(value)
    ? value : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return { kind: 'standardPart', catalog: 'filletWeld', catalogRevision: 'weld-1', generatorRevision: 'fillet-weld-5', size: '3x4', options: { weldCircular } };
}
function document(orientation: 1 | -1): AssemblyDocument {
  const assembly = createAssemblyDocument('円弧保存');
  // R=(z,x,y), followed by the nonzero start parameter. This is a saved component
  // placement, not a second occurrence transform inside the generated part.
  const half = Math.SQRT1_2;
  const rotation: readonly [number, number, number, number] = orientation === 1 ? [half, 0, half, 0] : [-.5, .5, -.5, .5];
  const component = createComponentFor(assembly, source(orientation), { partName: '円弧ビード', placement: {
    position: [expressionValueFromNumber(11), expressionValueFromNumber(13), expressionValueFromNumber(17)], rotation,
  } });
  return addComponent(assembly, { ...component, materialId: 'stainless', rigidGroupId: 'rigid-7' });
}
function assertRestored(before: AssemblyDocument, after: AssemblyDocument): void {
  expect(after.components).toEqual(before.components);
  const bead = after.components[0];
  if (bead?.source.kind !== 'standardPart') throw new Error('Saved standard bead missing');
  expect(bead.id).toBe('component-1'); expect(bead.materialId).toBe('stainless'); expect(bead.rigidGroupId).toBe('rigid-7');
  expect(bead.source.size).toBe('3x4'); expect(Object.keys(bead.source.options)).toEqual(['weldCircular']);
  const part = buildStandardPartFromSource(bead.source);
  if (part === null) throw new Error('Saved v5 geometry must reconstruct');
  const plan = resolvePart(part).steps[0]?.plan;
  if (plan?.kind !== 'revolve') throw new Error('Expected exact revolve');
  expect(plan.angle).toBeCloseTo(Math.PI / 2, 14);
  expect(plan.profile.map(row => row.kind === 'segment' ? row.from : null)).toEqual([[10, 0, 0], [13, 0, 0], [10, 0, 4]]);
  expect(plan.angle * 6 * 11).toBeCloseTo(33 * Math.PI, 11);
  const resolved = resolveAssembly(after, { standardPart: buildStandardPartFromSource });
  expect(resolved.errors).toEqual([]); expect(resolved.placements.get(bead.id)?.position).toEqual([11, 13, 17]);
  expect(resolved.placements.get(bead.id)?.rotation).toEqual(bead.placement.rotation);
  const placement = resolved.placements.get(bead.id);
  if (placement === undefined) throw new Error('Saved placement missing');
  const start = applyPlacementToPoint(placement, [10, 0, 0]);
  const raw: unknown = JSON.parse(bead.source.options.weldCircular ?? '{}');
  const reversed = typeof raw === 'object' && raw !== null && 'path' in raw
    && JSON.stringify(raw.path).includes('"orientation":-1');
  (reversed ? [11, 3, 17] : [11, 13, 27]).forEach((value, i) => expect(start[i]).toBeCloseTo(value, 11));
}

describe('circular fillet v5 persistence: saved geometry, not contact certification', () => {
  it.each([1, -1] as const)('keeps all source/component/material/placement bytes through JSON at orientation %s', orientation => {
    const original = document(orientation), text = writeAssemblyDocument(original, { savedAt: SAVED_AT });
    const read = readAssemblyDocument(text);
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    assertRestored(original, read.document);
    expect(writeAssemblyDocument(read.document, { savedAt: SAVED_AT })).toBe(text);
  });
  it.each([1, -1] as const)('keeps the same input and savedAt through actual PCAD archive bytes at orientation %s', async orientation => {
    const original = document(orientation), bytes = await writePcadaFile(original, { savedAt: SAVED_AT });
    const read = await readPcadaFile(bytes);
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    assertRestored(original, read.document);
    expect(read.savedAt).toBe(SAVED_AT);
    expect(await writePcadaFile(read.document, { savedAt: SAVED_AT })).toEqual(bytes);
  });
  it('preserves unsupported/malformed source text but refuses geometry, without mutating saved bytes', () => {
    const original = document(1), bead = original.components[0];
    if (bead?.source.kind !== 'standardPart') throw new Error('Missing standard source');
    for (const next of [{ ...bead.source, generatorRevision: 'fillet-weld-6' },
      { ...bead.source, options: { weldCircular: '{"bad":true}' } },
      { ...bead.source, generatorRevision: 'fillet-weld-1', options: { ...bead.source.options, length: '5' } }]) {
      const bad = { ...original, components: [{ ...bead, source: next }] };
      const text = writeAssemblyDocument(bad, { savedAt: SAVED_AT }), read = readAssemblyDocument(text);
      if (!read.ok) throw new Error(JSON.stringify(read.error));
      const source = read.document.components[0]?.source;
      if (source?.kind !== 'standardPart') throw new Error('Original unsupported source must be retained');
      expect(buildStandardPartFromSource(source)).toBeNull();
      expect(writeAssemblyDocument(read.document, { savedAt: SAVED_AT })).toBe(text);
    }
  });
});
