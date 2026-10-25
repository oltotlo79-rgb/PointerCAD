import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type SolidBody, type SolidFaceEntry } from '../kernelBridge.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import { resolveSubShapeReference } from '../kernelBridge/referenceResolution.js';
import { appendReference, appendSolid, createEmptyPartDocument, findReference, replaceSketch } from '../part/createPartDocument.js';
import { recomputePart } from '../part/recomputePart.js';
import type { HoleFeature, PartDocument, PrimitiveFeature, ReferencePointFeature, SubShapeRef } from '../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../sketch/createSketchDocument.js';
import type { Vec3 } from '../sketch/vec3.js';
import { addComponent, createComponentFor } from './assemblyEdit.js';
import { applyContextReference, contextPointResolverFromBodies, type ContextReferenceLink } from './contextReference.js';
import { createAssemblyDocument } from './createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument, Placement } from './types.js';

/*
 * 実カーネル(OCCT)で、部品の原点から離れた板(中心 (120,40,5)、40×30×10、上の面 z=10)に φ6 の貫通穴を
 * 点 (130,40) にあける。今の穴の壁の面の中心は、軸 x=130・y=40 と板の厚みの中点 z=5 から独立に決まる。
 * その面を、回転と移動をした別の置いた部品の基準点へ結ぶ。期待は配置の式から手で計算した値で、
 * 照合の結果を写したものではない。部品の経路は bindHoleIdentityKernel.test.ts と同じ。
 */

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

const value = (n: number) => expressionValueFromNumber(n);
const HALF = Math.SQRT1_2;

function placement(position: Vec3, rotation: readonly [number, number, number, number]): Placement {
  return { position: [value(position[0]), value(position[1]), value(position[2])], rotation };
}

function plateBox(): PrimitiveFeature {
  return { id: 'box-1', name: 'box-1', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(120, 40, 5) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(10) } };
}

function topOf(body: SolidBody): SolidFaceEntry {
  const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(face.axis[2] - 1) < 1e-9 && Math.abs(face.centroid[2] - 10) < 1e-9);
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`top faces: ${String(found.length)}`);
  return face;
}

function currentRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const ref = createSubShapeReference(body, 'face', face.index);
  if (ref === null) throw new Error(`no current proof for face ${String(face.index)}`);
  return ref;
}

const POINT: ReferencePointFeature = { id: 'point-1', name: '点1', visible: true, kind: 'referencePoint',
  definition: { kind: 'coordinate', at: { mode: 'absolute', x: value(0), y: value(0), z: value(0) } } };

describe('実カーネルの穴の壁の面の中心を、回転・移動した別の配置の基準点へ結ぶ(EX-18 文脈の参照)', () => {
  it('部品の座標の面の中心を、元の配置で組立へ、先の配置の逆で先の部品の座標へ写す', async () => {
    const base = { ...createEmptyPartDocument(), id: 'base-part' };
    const center = createPointFeature(base.sketches[0], absoluteCoordinate(130, 40, 10));
    const sketch = appendFeature(base.sketches[0], center);
    const boxOnly: PartDocument = appendSolid(replaceSketch(base, sketch), plateBox());
    const plate = await recomputePart(boxOnly, bridge);
    expect(plate.errors).toEqual([]);
    const plateBody = plate.bodies.find((body) => body.featureId === 'box-1');
    if (plateBody === undefined) throw new Error('box body missing');
    const hole: HoleFeature = { id: 'hole-1', name: 'hole-1', suppressed: false, kind: 'hole', targetFeatureId: 'box-1',
      face: currentRef(plateBody, topOf(plateBody)), centers: [{ sketchId: sketch.id, pointFeatureId: center.id }],
      diameter: value(6), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
    const result = await recomputePart(appendSolid(boxOnly, hole), bridge);
    expect(result.errors).toEqual([]);
    const body = result.bodies.find((entry) => entry.featureId === 'hole-1');
    if (body === undefined) throw new Error('final body missing');
    const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - 3) < 1e-7);
    const [wall] = walls;
    if (walls.length !== 1 || wall === undefined) throw new Error(`walls: ${String(walls.length)}`);
    // 面の中心は、kernel の今の形の値。期待は穴の軸と板の厚みから独立に決める。
    [130, 40, 5].forEach((expected, axis) => expect(Math.abs(wall.centroid[axis] - expected)).toBeLessThanOrEqual(1e-6));
    const source = currentRef(body, wall);

    // A(先): 移動 (10,20,0)・z 軸まわり 90°。B(元): 移動 (0,50,0)・x 軸まわり 90°。
    let document: AssemblyDocument = createAssemblyDocument('文脈');
    const a: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: 'bracket' }),
      placement: placement([10, 20, 0], [0, 0, HALF, HALF]) };
    document = addComponent(document, a);
    const b: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: 'base' }),
      placement: placement([0, 50, 0], [HALF, 0, 0, HALF]) };
    document = addComponent(document, b);
    const parts = new Map<string, PartDocument>([['bracket', appendReference(createEmptyPartDocument(), POINT)],
      ['base', appendSolid(boxOnly, hole)]]);
    const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1',
      sourceComponentId: b.id, source };
    const update = applyContextReference({ document, links: [link],
      partDocument: (component) => component.source.kind === 'part' ? parts.get(component.source.partRef) ?? null : null,
      resolvePoint: contextPointResolverFromBodies((component) => component.id === b.id ? result.bodies : null,
        resolveSubShapeReference),
    }, link);
    if ('code' in update) throw new Error(JSON.stringify(update));
    // B: (130,40,5) を x 軸まわり 90° → (130,−5,40)、移動 → 組立 (130,45,40)。
    // A の逆: (130,45,40) − (10,20,0) = (120,25,40)、z 軸まわり −90° → (25,−120,40)。
    const expected: Vec3 = [25, -120, 40];
    expected.forEach((coordinate, axis) => expect(Math.abs(update.point[axis] - coordinate)).toBeLessThanOrEqual(1e-6));
    const written = findReference(update.part, 'point-1');
    if (written?.kind !== 'referencePoint' || written.definition.kind !== 'coordinate' || written.definition.at.mode !== 'absolute') {
      throw new Error('written point');
    }
    const at = written.definition.at;
    [at.x.value, at.y.value, at.z.value].forEach((coordinate, axis) =>
      expect(Math.abs(coordinate - expected[axis])).toBeLessThanOrEqual(1e-6));
    // 部品の座標を世界座標と取り違えると (25,−120,40) にならない: 原点のずれ (120,40,5) は面の中心に含まれる。
    expect(Math.abs(update.point[1] - (-120))).toBeLessThanOrEqual(1e-6);
  }, 120_000);
});
