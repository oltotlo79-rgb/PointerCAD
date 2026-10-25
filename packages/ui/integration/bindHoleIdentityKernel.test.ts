import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '../../kernel/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readPcadFile, writePcadFile } from '../../io/src/pcad/pcadFile.js';
import {
  commitBoltedJointDraft, createBoltedJointDraft, previewBoltedJointDraft, type BoltedJointThreadGroupTarget,
} from '../src/assembly/boltedJointDraft.js';
import type { AssemblyView } from '../src/store/assemblySlice.js';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type SolidBody, type SolidFaceEntry } from '../../model/src/kernelBridge.js';
import { createSubShapeReference } from '../../model/src/kernelBridge/createSubShapeReference.js';
import { resolveSubShapeReference } from '../../model/src/kernelBridge/referenceResolution.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from '../../model/src/part/createPartDocument.js';
import { recomputePart } from '../../model/src/part/recomputePart.js';
import type { HoleFeature, PartDocument, PrimitiveFeature, SubShapeRef, ThreadHoleFeature } from '../../model/src/part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../../model/src/sketch/createSketchDocument.js';
import { threadMinorDiameter } from '../../model/src/thread/metricThread.js';
import { addComponent, createComponentFor } from '../../model/src/assembly/assemblyEdit.js';
import { createAssemblyDocument } from '../../model/src/assembly/createAssemblyDocument.js';
import { emptyEmbeddedPartAttachments, type PartLibrary } from '../../model/src/assembly/partLibrary.js';
import { partKeyOf, resolveAssembly } from '../../model/src/assembly/resolveAssembly.js';
import {
  bindHoleSelection, faceResolverFromBodies, type FasteningGeometryContext, holeFeatureForSelection,
  modeledThreadGroupPickAt, modeledThreadResolverFromBodies,
} from '../../model/src/assembly/fastening/bindHoleSelection.js';

/*
 * 実カーネル(OCCT)で、40×30×10 の板(上の面 z=10)に、離れた同径 φ6 の貫通穴を 2 つあける
 * (穴1 は点 (10,15)、穴2 は点 (30,15))。今の形から選んだ壁の面を、kernel が付けた今の由来で
 * 結び付ける。期待するフィーチャーは、壁の軸の x 座標から独立に決める(由来を注入しない)。
 * 部品の経路は primitiveKernel.test.ts、組立の文脈は filletWeldKernel.test.ts と同じ。
 */

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

const value = (n: number) => expressionValueFromNumber(n);

function plateBox(): PrimitiveFeature {
  return { id: 'box-1', name: 'box-1', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 5) }, axis: { kind: 'world', axis: 'z' },
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

describe('実カーネルの今の由来で、離れた同径の穴を正しく結び付ける(hole-identity-r1)', () => {
  it('選んだ壁ごとに自分の穴になり、誤った id・古い由来は断る', async () => {
    const base = { ...createEmptyPartDocument(), id: 'plate-part' };
    const pointA = createPointFeature(base.sketches[0], absoluteCoordinate(10, 15, 10));
    const withA = appendFeature(base.sketches[0], pointA);
    const pointB = createPointFeature(withA, absoluteCoordinate(30, 15, 10));
    const sketch = appendFeature(withA, pointB);
    const boxOnly: PartDocument = appendSolid(replaceSketch(base, sketch), plateBox());
    try {
      // 1. 板だけを作り、今の上の面の参照を今の由来から作る(保存の指紋を寸法の正本にしない)。
      const plate = await recomputePart(boxOnly, bridge);
      expect(plate.errors).toEqual([]);
      const plateBody = plate.bodies.find((body) => body.featureId === 'box-1');
      if (plateBody === undefined) throw new Error('box body missing');
      const topRef = currentRef(plateBody, topOf(plateBody));
      const hole = (id: string, pointFeatureId: string): HoleFeature => ({ id, name: id, suppressed: false, kind: 'hole',
        targetFeatureId: id === 'hole-1' ? 'box-1' : 'hole-1', face: id === 'hole-1' ? topRef : { ...topRef, bodyFeatureId: 'hole-1' },
        centers: [{ sketchId: sketch.id, pointFeatureId }], diameter: value(6), depth: { kind: 'through' },
        tiltAngle: value(0), tiltAzimuth: value(0) });
      const part = appendSolid(appendSolid(boxOnly, hole('hole-1', pointA.id)), hole('hole-2', pointB.id));

      // 2. 2 つの穴まで作り直し、最後のボディから今の壁と上の面を選ぶ。
      const result = await recomputePart(part, bridge);
      expect(result.errors).toEqual([]);
      const body = result.bodies.find((entry) => entry.featureId === 'hole-2');
      if (body === undefined) throw new Error('final body missing');
      const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - 3) < 1e-7);
      expect(walls).toHaveLength(2);
      const wallAt = (x: number): SolidFaceEntry => {
        const found = walls.filter((face) => Math.abs((face.axisOrigin?.[0] ?? NaN) - x) < 1e-7);
        const [face] = found;
        if (found.length !== 1 || face === undefined) throw new Error(`wall at x=${String(x)}: ${String(found.length)}`);
        return face;
      };
      const refA = currentRef(body, wallAt(10)), refB = currentRef(body, wallAt(30));
      const mating = currentRef(body, topOf(body));

      let assembly = createAssemblyDocument('穴の正体');
      assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'plate' }));
      const component = assembly.components[0];
      if (component === undefined) throw new Error('component missing');
      const context: FasteningGeometryContext = { document: assembly, partRevisions: new Map([['plate', 'rev-1']]),
        partDocument: () => part, resolveFace: faceResolverFromBodies(() => [body], resolveSubShapeReference) };

      // 3. 自動の選択: 壁の軸 x=10 は穴1、x=30 は穴2(径は同じなので径だけでは決まらない)。
      expect(holeFeatureForSelection(context, component, refA)).toBe('hole-1');
      expect(holeFeatureForSelection(context, component, refB)).toBe('hole-2');

      // 4. 明示の id: 正しい組は結び、実の円筒から長さ 10・径 6 を読む。
      for (const [featureId, holeFace, x] of [['hole-1', refA, 10], ['hole-2', refB, 30]] as const) {
        const bound = bindHoleSelection(context, { componentId: component.id, holeFeatureId: featureId, holeFace, matingFace: mating });
        if ('code' in bound) throw new Error(JSON.stringify(bound));
        expect(bound.holeFeatureId).toBe(featureId);
        expect(bound.hole).toMatchObject({ kind: 'clearance' });
        if (bound.hole.kind !== 'clearance') throw new Error('not clearance');
        expect(bound.hole.diameter).toBeCloseTo(6, 9);
        expect(bound.hole.length).toBeCloseTo(10, 9);
        expect(bound.axisOrigin[0]).toBeCloseTo(x, 9);
        expect(bound.axisOrigin[2]).toBeCloseTo(10, 9);
      }

      // 5. 誤った明示 id(別の位置の同径の穴)は断る。旧版は径と合わせ面だけで通していた。
      expect(bindHoleSelection(context, { componentId: component.id, holeFeatureId: 'hole-2', holeFace: refA, matingFace: mating }))
        .toMatchObject({ code: 'holeFaceMismatch', detail: { reason: 'holeIdentityMismatch', originFeatureId: 'hole-1' } });

      // 6. 古い由来(今の表に無い生成元)を持つ参照は、今の壁として認めない。
      if (refA.origin === undefined || refA.origin.shapeKind !== 'face' || refA.origin.identity.kind !== 'hole-face') {
        throw new Error('wall reference without hole-face origin');
      }
      const stale: SubShapeRef = { ...refA, origin: { ...refA.origin, identity: { ...refA.origin.identity, featureId: 'stale-hole' } } };
      expect(holeFeatureForSelection(context, component, stale)).toBeNull();
      expect('code' in bindHoleSelection(context, { componentId: component.id, holeFeatureId: 'hole-1', holeFace: stale,
        matingFace: mating })).toBe(true);
    } finally {
      await bridge.releasePart('plate-part');
    }
  }, 180_000);
});

describe('実カーネルの実らせんの穴を、当たった壁の面から組で選び、今のボディで結び付ける', () => {
  const MINOR = threadMinorDiameter(6, 1);

  function plate(height: number): PrimitiveFeature {
    return { ...plateBox(), origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, height / 2) },
      shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(height) } };
  }

  function topAt(body: SolidBody, z: number): SolidFaceEntry {
    const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
      && Math.abs(face.axis[2] - 1) < 1e-9 && Math.abs(face.centroid[2] - z) < 1e-9);
    const [face] = found;
    if (found.length !== 1 || face === undefined) throw new Error(`top faces at z=${String(z)}: ${String(found.length)}`);
    return face;
  }

  /** 当たりの代わり: 今のボディの下穴の半径の円筒の面(由来ではなく形で選ぶ。viewport の当たりと同じく番地だけを渡す)。 */
  function hitWall(body: SolidBody): number {
    const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - MINOR / 2) < 1e-7);
    const [first] = walls;
    if (first === undefined) throw new Error('no drill wall');
    expect(walls.length).toBeGreaterThan(1);
    return first.index;
  }

  it.each([
    { label: '止まり', height: 20, depth: { kind: 'blind', depth: value(12) } as const },
    { label: '貫通', height: 10, depth: { kind: 'through' } as const },
  ])('$label: 普通の参照は split で作れず、組の選択で結び、作り直した後も新しく選べる', async ({ height, depth }) => {
    const base = { ...createEmptyPartDocument(), id: 'thread-part' };
    const point = createPointFeature(base.sketches[0], absoluteCoordinate(20, 15, height));
    const sketch = appendFeature(base.sketches[0], point);
    const boxOnly: PartDocument = appendSolid(replaceSketch(base, sketch), plate(height));
    try {
      const plateResult = await recomputePart(boxOnly, bridge);
      expect(plateResult.errors).toEqual([]);
      const plateBody = plateResult.bodies.find((body) => body.featureId === 'box-1');
      if (plateBody === undefined) throw new Error('box body missing');
      const thread: ThreadHoleFeature = { id: 'thread-1', name: 'M6', suppressed: false, kind: 'threadHole',
        targetFeatureId: 'box-1', face: currentRef(plateBody, topAt(plateBody, height)),
        centers: [{ sketchId: sketch.id, pointFeatureId: point.id }], designation: 'M6', series: 'coarse',
        pitch: value(1), drillDiameter: value(MINOR), depth, threadLength: value(8), representation: 'modeled',
        tiltAngle: value(0), tiltAzimuth: value(0) };
      const part = appendSolid(boxOnly, thread);

      let assembly = createAssemblyDocument('実らせんの穴');
      assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'plate' }));
      const component = assembly.components[0];
      if (component === undefined) throw new Error('component missing');

      /** 作り直した今のボディで、当たり → 組 → 結び付けを通す。 */
      const bindFresh = async (document: PartDocument) => {
        const result = await recomputePart(document, bridge);
        expect(result.errors).toEqual([]);
        const body = result.bodies.find((entry) => entry.featureId === 'thread-1');
        if (body === undefined) throw new Error('thread body missing');
        const hit = hitWall(body);
        // 普通の参照(保存できる1枚の面)は、分かれた壁では作れない(曖昧さを保つ)。
        expect(createSubShapeReference(body, 'face', hit)).toBeNull();
        const group = modeledThreadGroupPickAt(body, hit);
        if (group === null) throw new Error('no modeled thread group at the hit wall');
        expect(group.bodyFeatureId).toBe('thread-1');
        expect(group.origin).toMatchObject({ featureId: 'thread-1', stage: 'bore', role: 'wall' });
        const context: FasteningGeometryContext = { document: assembly, partRevisions: new Map([['plate', 'rev-1']]),
          // 今の作り直しの全てのボディ(貫通ではねじの入口の面を板のボディで選び直す)。
          partDocument: () => document, resolveFace: faceResolverFromBodies(() => result.bodies, resolveSubShapeReference),
          resolveModeledThread: modeledThreadResolverFromBodies(() => result.bodies) };
        const bound = bindHoleSelection(context, { componentId: component.id, holeFeatureId: group.origin.featureId,
          holeGroup: group, matingFace: currentRef(body, topAt(body, height)) });
        if ('code' in bound) throw new Error(JSON.stringify(bound));
        return { bound, group };
      };

      const first = await bindFresh(part);
      expect(first.bound.holeFeatureId).toBe('thread-1');
      expect(first.bound.axisOrigin[0]).toBeCloseTo(20, 6);
      expect(first.bound.axisOrigin[1]).toBeCloseTo(15, 6);
      expect(first.bound.axisOrigin[2]).toBeCloseTo(height, 6);
      if (height === 20) {
        // 止まり: 今の壁は z 8〜20(下穴の深さ 12)。ねじ部は 8。
        expect(first.bound.hole).toMatchObject({ kind: 'blindThreaded', nominal: 'M6' });
        if (first.bound.hole.kind !== 'blindThreaded') throw new Error('not blind');
        expect(first.bound.hole.drillDepth).toBeCloseTo(12, 6);
        expect(first.bound.hole.usableThreadDepth).toBeCloseTo(8, 6);
      } else {
        expect(first.bound.hole).toMatchObject({ kind: 'throughThreaded', nominal: 'M6' });
        if (first.bound.hole.kind !== 'throughThreaded') throw new Error('not through');
        expect(first.bound.hole.length).toBeCloseTo(10, 6);
      }

      // 実際の .pcad のバイト列へ保存して読み直し、カーネルの持ち物を手放してから作り直し、新しい当たりで選び直す。
      const read = readPcadFile(writePcadFile(part, { savedAt: '2026-10-01T00:00:00.000Z' }));
      if (!read.ok) throw new Error(read.error.message);
      const reopened = read.document;
      expect(reopened).not.toBe(part);
      await bridge.releasePart('thread-part');
      const second = await bindFresh(reopened);
      expect(second.group.origin).toEqual(first.group.origin);
      expect(second.bound.hole).toEqual(first.bound.hole);
    } finally {
      await bridge.releasePart('thread-part');
    }
  }, 180_000);
});

describe('実カーネルの2つの部品を、実際の UI の下書きで予告・確定する(実らせんの穴は組で選ぶ)', () => {
  const DRILL = threadMinorDiameter(8, 1.25);

  function box(id: string, height: number, centerZ: number): PrimitiveFeature {
    return { ...plateBox(), id, name: id, origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, centerZ) },
      shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(height) } };
  }

  /** z=0 の平面(向きは normal の z 符号)。合わせ面と穴の入口。 */
  function planeAtZero(body: SolidBody, normalZ: 1 | -1): SolidFaceEntry {
    const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
      && Math.abs(face.axis[2] - normalZ) < 1e-9 && Math.abs(face.centroid[2]) < 1e-9);
    const [face] = found;
    if (found.length !== 1 || face === undefined) throw new Error(`planes at z=0: ${String(found.length)}`);
    return face;
  }

  function cylindersOf(body: SolidBody, radius: number): readonly SolidFaceEntry[] {
    return body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - radius) < 1e-7);
  }

  async function recomputed(document: PartDocument, featureId: string) {
    const result = await recomputePart(document, bridge);
    expect(result.errors).toEqual([]);
    const body = result.bodies.find((entry) => entry.featureId === featureId);
    if (body === undefined) throw new Error(`${featureId} body missing`);
    return { bodies: result.bodies, body };
  }

  it('A の普通の貫通穴と B の実らせんの止まり穴で M8 を予告し、確定で部品が加わり、元の組立は変わらない', async () => {
    // A: z -28〜0 の板、上の面 z=0 から φ9 の貫通穴。B: z 0〜30 の板、下の面 z=0 から M8 の実らせん(深さ 20、ねじ部 16)。
    const baseA = { ...createEmptyPartDocument(), id: 'plate-a-part' };
    const pointA = createPointFeature(baseA.sketches[0], absoluteCoordinate(20, 15, 0));
    const sketchA = appendFeature(baseA.sketches[0], pointA);
    const boxA = appendSolid(replaceSketch(baseA, sketchA), box('box-a', 28, -14));
    const baseB = { ...createEmptyPartDocument(), id: 'plate-b-part' };
    const pointB = createPointFeature(baseB.sketches[0], absoluteCoordinate(20, 15, 0));
    const sketchB = appendFeature(baseB.sketches[0], pointB);
    const boxB = appendSolid(replaceSketch(baseB, sketchB), box('box-b', 30, 15));
    try {
      const plateA = await recomputed(boxA, 'box-a');
      const plateB = await recomputed(boxB, 'box-b');
      const holeA: HoleFeature = { id: 'hole-a', name: 'hole-a', suppressed: false, kind: 'hole', targetFeatureId: 'box-a',
        face: currentRef(plateA.body, planeAtZero(plateA.body, 1)), centers: [{ sketchId: sketchA.id, pointFeatureId: pointA.id }],
        diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
      const threadB: ThreadHoleFeature = { id: 'thread-b', name: 'M8', suppressed: false, kind: 'threadHole', targetFeatureId: 'box-b',
        face: currentRef(plateB.body, planeAtZero(plateB.body, -1)), centers: [{ sketchId: sketchB.id, pointFeatureId: pointB.id }],
        designation: 'M8', series: 'coarse', pitch: value(1.25), drillDiameter: value(DRILL), depth: { kind: 'blind', depth: value(20) },
        threadLength: value(16), representation: 'modeled', tiltAngle: value(0), tiltAzimuth: value(0) };
      const partA = appendSolid(boxA, holeA);
      const partB = appendSolid(boxB, threadB);
      const finalA = await recomputed(partA, 'hole-a');
      const finalB = await recomputed(partB, 'thread-b');

      let assembly = createAssemblyDocument('実カーネルの締結');
      assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'plate-a' }));
      assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'plate-b' }));
      const [componentA, componentB] = assembly.components;
      if (componentA === undefined || componentB === undefined) throw new Error('components missing');
      const parts = new Map([['plate-a', partA], ['plate-b', partB]]);
      const library: PartLibrary = { parts, attachments: new Map([...parts.keys()].map((ref) => [ref, emptyEmbeddedPartAttachments()])),
        partFiles: [...parts.keys()].map((ref) => ({ ref, fileName: `${ref}.pcad`, path: `${ref}.pcad`, contentHash: `revision-${ref}`,
          attachmentsDigest: 'empty', importedAt: '2026-10-01T00:00:00Z' })) };
      const keyA = partKeyOf(componentA.source), keyB = partKeyOf(componentB.source);
      // 表示の元の文書は、予告・確定に渡す組立そのもの。ボディは今の作り直しの全てのボディ。
      const view: AssemblyView = { sourceDocument: assembly, resolved: { ...resolveAssembly(assembly),
        partKeys: new Map([[componentA.id, keyA], [componentB.id, keyB]]) },
      bodies: new Map([[keyA, finalA.bodies], [keyB, finalB.bodies]]), appearances: new Map(), diagnosis: null,
      mateTargetErrors: new Map() };

      // 穴A: 普通の貫通穴の壁(1枚、unique)。穴B: 実らせんの壁は split なので、当たった面から組を作る。
      const [wallA] = cylindersOf(finalA.body, 4.5);
      if (wallA === undefined) throw new Error('hole A wall missing');
      const wallsB = cylindersOf(finalB.body, DRILL / 2);
      const [hitB] = wallsB;
      if (hitB === undefined) throw new Error('thread B wall missing');
      expect(wallsB.length).toBeGreaterThan(1);
      expect(createSubShapeReference(finalB.body, 'face', hitB.index)).toBeNull();
      const group = modeledThreadGroupPickAt(finalB.body, hitB.index);
      if (group === null) throw new Error('no modeled thread group at the hit wall');
      const groupTarget: BoltedJointThreadGroupTarget = { kind: 'modeledThreadGroup', componentId: componentB.id, group };
      const draft = { ...createBoltedJointDraft('assembly'), engagementSource: '12', bottomClearanceSource: '2', picks: [
        { kind: 'subShape' as const, componentId: componentA.id, ref: currentRef(finalA.body, wallA) },
        { kind: 'subShape' as const, componentId: componentA.id, ref: currentRef(finalA.body, planeAtZero(finalA.body, 1)) },
        groupTarget,
        { kind: 'subShape' as const, componentId: componentB.id, ref: currentRef(finalB.body, planeAtZero(finalB.body, -1)) },
      ] };

      const original = JSON.stringify(assembly);
      const preview = previewBoltedJointDraft(assembly, view, library, draft);
      if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
      // 期待は作った部品から決める: 呼びは B のねじ穴の M8、ねじ込みは指定の 12。
      expect(preview.result.plan.nominal).toBe('M8');
      expect(preview.result.plan.engagedLength).toBeCloseTo(12, 6);
      const committed = commitBoltedJointDraft(assembly, view, library, draft, preview.result.plan);
      if (!committed.ok) throw new Error(JSON.stringify(committed));
      expect(committed.document.components).toHaveLength(assembly.components.length + preview.result.plan.operations.length);
      expect(JSON.stringify(assembly)).toBe(original);
    } finally {
      await bridge.releasePart('plate-a-part');
      await bridge.releasePart('plate-b-part');
    }
  }, 180_000);
});
