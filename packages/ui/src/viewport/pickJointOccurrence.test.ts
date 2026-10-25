import {
  addComponent, createAssemblyDocument, createComponentFor, EMPTY_PART_LIBRARY,
  type AssemblyComponent, type AssemblyDocument, type ComponentSource, type PartLibrary, type ResolvedAssembly, type RigidPlacement,
  type SolidBody,
} from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';

import { planeBody } from '../assembly/filletWeldBodies.testSupport.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { pickAssemblyMateTarget } from './attachAssemblyInteraction.js';
import type { AssemblyMateFaceHit } from './createAssemblyLayer.js';
import {
  jointOccurrenceInputsOf, pickJointOccurrenceTarget, resolveJointOccurrencePick, type JointOccurrencePick,
} from './pickJointOccurrence.js';

const AT_ORIGIN: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
const SHIFTED: RigidPlacement = { position: [0, 100, 0], rotation: [0, 0, 0, 1] };
const CHILD: ComponentSource = { kind: 'subAssembly', assemblyRef: 'child' };
/** 部品座標の正方形の板(面 0、辺 0 は (0,0,0)→(10,0,0))。 */
const PLATE_GEOMETRY = planeBody([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], [0, 0, 1]);
// planeBody は幾何参照用で線分メッシュを持たない。クリック試験には同じ4直線を描画する線分も渡す。
// 当たり判定を模擬せず、辺の始点・終点から対応する範囲表と配列を同時に作る。
const PLATE: SolidBody = { ...PLATE_GEOMETRY,
  edges: PLATE_GEOMETRY.edges.map((edge, index) => ({ ...edge, segmentOffset: index, segmentCount: 1 })),
  mesh: { ...PLATE_GEOMETRY.mesh,
    edgePositions: new Float32Array(PLATE_GEOMETRY.edges.flatMap(edge => [...edge.start, ...edge.end])) },
};

function documentOf(name: string, entries: readonly (readonly [string, ComponentSource])[]): AssemblyDocument {
  let document = createAssemblyDocument(name);
  for (const [id, source] of entries) {
    const component: AssemblyComponent = { ...createComponentFor(document, source, {}), id };
    document = addComponent(document, component);
  }
  return document;
}

/**
 * 同じ子の組(葉 `plate`)を `組,A` と `B` の2か所に置いた根。子の中の配置は解いた世界座標で、`B` の板だけ y=100 にある。
 */
function repeatedChild(): { readonly document: AssemblyDocument; readonly view: AssemblyView } {
  const child = documentOf('子', [['plate', { kind: 'part', partRef: 'plate-part' }]]);
  const document = documentOf('根', [['組,A', CHILD], ['B', CHILD]]);
  const leaf = (placement: RigidPlacement): ResolvedAssembly => ({ parts: new Map(), errors: [],
    placements: new Map([['plate', placement]]), partKeys: new Map([['plate', 'plate-part']]) });
  const resolved: ResolvedAssembly = { parts: new Map(), errors: [], partKeys: new Map(),
    placements: new Map([['組,A', AT_ORIGIN], ['B', AT_ORIGIN]]),
    subAssemblies: new Map([
      ['組,A', { componentId: '組,A', assemblyRef: 'child', assembly: child, placement: AT_ORIGIN, resolved: leaf(AT_ORIGIN) }],
      ['B', { componentId: 'B', assemblyRef: 'child', assembly: child, placement: AT_ORIGIN, resolved: leaf(SHIFTED) }],
    ]) };
  return { document, view: { sourceDocument: document, resolved, bodies: new Map([['plate-part', [PLATE]]]),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } };
}

function sceneWith(hit: AssemblyMateFaceHit | null) {
  return { pickAssemblyFace: vi.fn(() => hit), pickComponent: vi.fn(() => null),
    worldToScreen: (point: readonly [number, number, number]): readonly [number, number] => [point[0], point[1]] };
}

describe('締結・溶接の接合の選択(入れ子の葉の部品を経路で指す)', () => {
  it('面: 描いた一式が添えた経路をそのまま使い、部品の中の面の参照と組にする', () => {
    const { document, view } = repeatedChild();
    const scene = sceneWith({ componentId: '組,A/plate', partKey: 'plate-part', bodyFeatureId: 'extrude-1', faceIndex: 0,
      occurrencePath: ['組,A', 'plate'] });
    const pick = pickJointOccurrenceTarget(document, view, scene, [5, 5], 'face');
    expect(pick?.path).toEqual(['組,A', 'plate']);
    expect([pick?.kind, pick?.partKey, pick?.ref.bodyFeatureId, pick?.ref.index, pick?.ref.fingerprint.kind])
      .toEqual(['jointOccurrence', 'plate-part', 'extrude-1', 0, 'face']);
  });

  it('面: 経路の無い当たり(行 ID が別の配置と重なったもの)は選ばない', () => {
    const { document, view } = repeatedChild();
    const scene = sceneWith({ componentId: 'a/b', partKey: 'plate-part', bodyFeatureId: 'extrude-1', faceIndex: 0 });
    expect(pickJointOccurrenceTarget(document, view, scene, [5, 5], 'face')).toBeNull();
  });

  it('辺: 同じ子の組の2か所のうち、押した所に近い配置の辺を、その配置の経路で選ぶ', () => {
    const { document, view } = repeatedChild();
    const scene = sceneWith(null);
    // B の板の辺 0 は世界で (0,100,0)→(10,100,0)。画面は x・y をそのまま使う。
    const onB = pickJointOccurrenceTarget(document, view, scene, [5, 100], 'edge');
    expect(onB?.path).toEqual(['B', 'plate']);
    expect(onB?.ref.fingerprint.kind).toBe('edge');
    const onA = pickJointOccurrenceTarget(document, view, scene, [5, 0], 'edge');
    expect(onA?.path).toEqual(['組,A', 'plate']);
    expect(pickJointOccurrenceTarget(document, view, scene, [500, 500], 'edge')).toBeNull();
  });

  it('普通の合致の選択は今までどおり平らな配置だけを見て、入れ子の葉の当たりを選ばない', () => {
    const { document, view } = repeatedChild();
    const scene = sceneWith({ componentId: '組,A/plate', partKey: 'plate-part', bodyFeatureId: 'extrude-1', faceIndex: 0,
      occurrencePath: ['組,A', 'plate'] });
    expect(pickAssemblyMateTarget(document, view, scene, [5, 5], 'face')).toBeNull();
    expect(pickAssemblyMateTarget(document, view, scene, [5, 100], 'edge')).toBeNull();
  });
});

describe('選んだ経路を解く入力(解いた時の物と今の物が同じ時だけ)', () => {
  it('子の組を持たない一式でも、解く所と選ぶ所の入力の子の組の表は同じ物になる', () => {
    const { document } = repeatedChild();
    const library: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
    expect(jointOccurrenceInputsOf(document, library).subAssemblies).toBe(jointOccurrenceInputsOf(document, library).subAssemblies);
    expect(jointOccurrenceInputsOf(document, EMPTY_PART_LIBRARY).subAssemblies).toBe(EMPTY_PART_LIBRARY.assemblies);
  });

  it('表示に解いた時の入力が無い・今の文書と違う物なら stale-view で断る', () => {
    const { document, view } = repeatedChild();
    const pick: JointOccurrencePick = { kind: 'jointOccurrence', path: ['B', 'plate'], partKey: 'plate-part',
      ref: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'edge', curveKind: 'line', length: 10,
        position: [5, 100, 0], axis: [1, 0, 0], radius: null } } };
    expect(resolveJointOccurrencePick(document, EMPTY_PART_LIBRARY, view, pick)).toEqual({ ok: false, code: 'stale-view', index: 0 });
    const solvedFor = jointOccurrenceInputsOf({ ...document, name: '古い文書' }, EMPTY_PART_LIBRARY);
    expect(resolveJointOccurrencePick(document, EMPTY_PART_LIBRARY, { ...view, source: solvedFor }, pick))
      .toEqual({ ok: false, code: 'stale-view', index: 0 });
  });
});
