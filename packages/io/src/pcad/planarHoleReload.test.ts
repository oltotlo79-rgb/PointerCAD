import { describe, expect, it } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import { absoluteCoordinate, appendSolid, createDirectKernelBridge, createEmptyPartDocument,
  createSubShapeReference, recomputePart, replaceSolid, type HoleFeature, type PartDocument,
  type PrimitiveFeature, type TransformFeature } from '@pointercad/model';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';

const number = (value: number) => ({ source: String(value), value, display: String(value) });
const savedAt = '2026-10-26T00:00:00.000Z';
function context() {
  const cache = createShapeCache<CachedSolid>(32);
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode, cache));
  return { cache, bridge, dispose: () => { try { bridge.dispose(); } finally { cache.clear(); } } };
}
function baseDocument() {
  const box: PrimitiveFeature = { id: 'box', name: 'box', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0,0,0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: number(40), sizeY: number(30), sizeZ: number(10) } };
  const pose: TransformFeature = { id: 'pose', name: 'pose', kind: 'transform', suppressed: false,
    targetFeatureId: 'box', translation: [number(11),number(-7),number(5)],
    rotationAxis: { kind: 'world', axis: 'x' }, rotationAngle: number(90) };
  return appendSolid(appendSolid(createEmptyPartDocument(), box), pose);
}
async function makeDocument() {
  const ctx = context(); const doc = baseDocument();
  try {
    const result = await recomputePart(doc, ctx.bridge);
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
    const body = result.bodies.find(b => b.featureId === 'pose');
    const face = body?.faces.find(f => f.surfaceKind === 'plane' && f.axis !== null &&
      Math.hypot(f.axis[0], f.axis[1]+1, f.axis[2]) < 1e-9);
    if (body === undefined || face === undefined) throw new Error('Missing rotated top');
    const reference = createSubShapeReference(body, 'face', face.index);
    if (reference === null) throw new Error('Missing persistent face reference');
    const hole: HoleFeature = { id: 'hole', name: 'hole', kind: 'hole', suppressed: false,
      targetFeatureId: 'pose', face: reference, centers: [], diameter: number(6), depth: { kind: 'through' },
      tiltAngle: number(0), tiltAzimuth: number(0),
      planar: { kind: 'plane-face', locations: [{ x: { source: '2 * 5', display: '10', value: 10 },
        y: { source: '12 - 2', display: '10', value: 10 } }] } };
    return appendSolid(doc, hole);
  } finally { ctx.dispose(); }
}
function reopen(doc: PartDocument, format: 'json' | 'zip') {
  const loaded = format === 'json' ? parseDocument(serializeDocument(doc, { savedAt }))
    : readPcadFile(writePcadFile(doc, { savedAt }));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  expect(loaded.document).toEqual(doc);
  return loaded.document;
}
async function verifyVolume(doc: PartDocument, diameter: number) {
  const ctx = context();
  try {
    const result = await recomputePart(doc, ctx.bridge);
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false); expect(result.cacheHits).toBe(0);
    const body = result.bodies.find(b => b.featureId === 'hole');
    if (body === undefined) throw new Error('Missing freshly regenerated hole body');
    // 独立解析体積と再生成した形を比べる。保存した数値の一致だけでは形状の一致としない。
    const expected = 12000 - Math.PI*(diameter/2)**2*10;
    expect(Math.abs(body.volume-expected)/expected).toBeLessThan(1e-9);
    const bores = body.faces.filter(f => f.surfaceKind === 'cylinder');
    expect(bores).toHaveLength(1);
    expect(Math.abs(2*(bores[0].radius ?? NaN)-diameter)).toBeLessThanOrEqual(1e-7);
  } finally { ctx.dispose(); }
}
describe('planar XY fresh save/reopen candidate', () => {
  it.each(['json','zip'] as const)('%s preserves expressions/reference and recomputes after dimension and pose edits', async format => {
    const original = await makeDocument(), loaded = reopen(original, format);
    expect(() => serializeDocument({ ...original, schemaVersion: 21 }, { savedAt })).toThrow();
    await verifyVolume(loaded, 6);
    const hole = loaded.solids.find(s => s.id === 'hole'), pose = loaded.solids.find(s => s.id === 'pose');
    if (hole?.kind !== 'hole' || pose?.kind !== 'transform' || hole.planar === undefined) throw new Error('Missing saved features');
    expect(hole.planar.locations[0].x.source).toBe('2 * 5');
    expect(hole.planar.locations[0].y.source).toBe('12 - 2');
    const editedHole: HoleFeature = { ...hole, diameter: number(8), planar: { ...hole.planar,
      locations: [{ x: { source: '3 * 4', display: '12', value: 12 }, y: hole.planar.locations[0].y }] } };
    const edited = replaceSolid(replaceSolid(loaded, hole.id, editedHole), pose.id, { ...pose, rotationAngle: number(180),
      translation: [number(-13),number(17),number(23)] });
    await verifyVolume(reopen(edited, format), 8);
    const retained = edited.solids.find(s => s.id === 'hole');
    if (retained?.kind !== 'hole') throw new Error('Missing edited hole');
    expect(retained.face).toEqual(hole.face);
  }, 180_000);
});
