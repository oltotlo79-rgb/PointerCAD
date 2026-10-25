import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../../kernelBridge.js';
import { replaceSketch } from '../../part/createPartDocument.js';
import { recomputePart } from '../../part/recomputePart.js';
import type { PartDocument } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { SketchArcFeature, SketchLineFeature } from '../../sketch/types.js';
import { buildStandardPart, buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { STEEL_PRODUCTS, steelProductOptions } from './steelCatalog.js';
import { H_BEAM_ORACLE } from './steelHBeamOracle.fixture.js';
import { steelSectionProfile } from './steelSectionProfiles.js';

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

// Independent selection by increasing printed cross-sectional area within each nominal series class.
const boundarySizes = ['H 100×50×5×7', 'H 918×303×19×37', 'H 148×100×6×9',
  'H 594×302×14×23', 'H 100×100×6×8', 'H 498×432×45×70'];
const boundaries = boundarySizes.map(size => {
  const row = H_BEAM_ORACLE.find(item => item.size === size);
  if (row === undefined) throw new Error('Missing independent H boundary');
  return row;
});
const cases = boundaries.flatMap(oracle => (['legacy', 'profile'] as const).map(route => ({ oracle, route, size: oracle.size })));

/** H100 is deliberately grade-unassigned. Exercise the actual profile segments through normal
 * extrusion/recomputation without inventing a material product or saved generator revision for it.
 */
function unassignedProfileDocument(size: string, length: number): PartDocument {
  const document = buildStandardPart('hBeam', size, { length: String(length) });
  const profile = steelSectionProfile('hBeam', size);
  if (document === null || profile === undefined) throw new Error('Missing unassigned H geometry');
  const extrude = document.solids.find(solid => solid.kind === 'extrude');
  if (extrude?.kind !== 'extrude') throw new Error('Missing H extrusion');
  const sketch = document.sketches.find(item => item.id === extrude.profile.sketchId);
  const face = sketch?.features.find(item => item.id === extrude.profile.faceFeatureId);
  if (sketch === undefined || face?.kind !== 'face') throw new Error('Missing H face');
  const features = profile.segments.map((segment, index): SketchLineFeature | SketchArcFeature => {
    const common = { id: `w7-boundary-${index}`, name: `boundary ${index}`, planeId: face.planeId, construction: false };
    return segment.kind === 'line' ? { ...common, kind: 'line',
      from: absoluteCoordinate(segment.from[0], segment.from[1], 0),
      to: absoluteCoordinate(segment.to[0], segment.to[1], 0) } : { ...common, kind: 'arc',
      center: absoluteCoordinate(segment.center[0], segment.center[1], 0),
      radius: expressionValueFromNumber(segment.radius),
      startAngle: expressionValueFromNumber(segment.startAngle * 180 / Math.PI),
      endAngle: expressionValueFromNumber(segment.endAngle * 180 / Math.PI) };
  });
  return replaceSketch(document, { ...sketch, features: [...features,
    { ...face, boundary: features.map(feature => ({ featureId: feature.id })) }] });
}

async function checkVolume(document: PartDocument, size: string, route: string, area: number, length: number): Promise<void> {
  try {
    const result = await recomputePart(document, bridge);
    expect(result.errors).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    const body = result.bodies[0];
    expect(body.isValid).toBe(true);
    expect(body.mesh.triangleCount).toBeGreaterThan(0);
    const expected = area * length;
    const relativeError = Math.abs(body.volume - expected) / expected;
    expect(relativeError).toBeLessThan(1e-8);
    process.stdout.write('W7_H_VOLUME ' + JSON.stringify({ size, route, lengthMm: length,
      areaMm2: area, expectedMm3: expected, actualMm3: body.volume, relativeError }) + String.fromCharCode(10));
  } finally { await bridge.releasePart(document.id); }
}

describe('W7 three H series min/max through real OCCT', () => {
  it('covers the six printed-area extrema on both geometry routes', () => {
    expect(cases).toHaveLength(12);
    for (const flange of ['細幅', '中幅', '広幅']) {
      const all = H_BEAM_ORACLE.filter(row => row.flange === flange);
      const selected = boundaries.filter(row => row.flange === flange);
      expect(selected.map(row => row.areaMm2.value))
        .toEqual([Math.min(...all.map(row => row.areaMm2.value)), Math.max(...all.map(row => row.areaMm2.value))]);
    }
  });

  it.each(cases)('$size $route has independent area times length within relative 1e-8', async ({ oracle, route }) => {
    const length = 100;
    const product = STEEL_PRODUCTS.find(row => row.key === oracle.key);
    let document: PartDocument | null;
    let testedRoute: string;
    if (product === undefined) {
      expect(oracle.size).toBe('H 100×100×6×8');
      document = route === 'legacy' ? buildStandardPart('hBeam', oracle.size, { length: String(length) })
        : unassignedProfileDocument(oracle.size, length);
      testedRoute = route === 'legacy' ? 'unassigned-legacy' : 'unassigned-profile-segments';
    } else {
      const source = createStandardPartSource(product.catalog, product.size,
        { ...steelProductOptions(product), length: String(length) });
      expect(source.generatorRevision).toBe('3-steel-profile-1');
      const revision = route === 'legacy' ? '2-steel-1' : '3-steel-profile-1';
      document = buildStandardPartFromSource({ ...source, generatorRevision: revision });
      testedRoute = revision;
      if (route === 'legacy') {
        const old = buildStandardPart(product.catalog, product.size, { length: String(length) });
        expect(document?.sketches).toEqual(old?.sketches);
        expect(document?.solids).toEqual(old?.solids);
      }
    }
    if (document === null) throw new Error('Missing H document');
    await checkVolume(document, oracle.size, testedRoute,
      route === 'legacy' ? oracle.legacyPolygonAreaMm2.value : oracle.exactAreaMm2.value, length);
  });

  it.each(['2-steel-1', '3-steel-profile-1'])('also checks the smallest material-supported wide H through saved revision %s', async revision => {
    const oracle = H_BEAM_ORACLE.find(row => row.size === 'H 150×150×7×10');
    const product = STEEL_PRODUCTS.find(row => row.key === oracle?.key);
    if (oracle === undefined || product === undefined) throw new Error('Missing wide H material control');
    const length = 100;
    const source = createStandardPartSource(product.catalog, product.size,
      { ...steelProductOptions(product), length: String(length) });
    const document = buildStandardPartFromSource({ ...source, generatorRevision: revision });
    if (document === null) throw new Error('Missing material wide H document');
    await checkVolume(document, oracle.size, revision,
      revision === '2-steel-1' ? oracle.legacyPolygonAreaMm2.value : oracle.exactAreaMm2.value, length);
  });
});
