import {
  addComponent, createAssemblyDocument, createComponentFor,
  type AssemblyComponent, type AssemblyDocument, type ComponentSource, type ResolvedAssembly, type RigidPlacement, type SolidBody,
} from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import { buildAssemblyGeometry, createAssemblyLayer, flattenAssemblyGeometry } from './createAssemblyLayer.js';

/** 部品座標の三角形 1 枚(面 0、z=0、x・y 0〜1)。 */
function triangleBody(): SolidBody {
  return { featureId: 'extrude-1', volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [],
    mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]), edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0]), triangleCount: 1 },
    faces: [{ index: 0, surfaceKind: 'plane', area: 0.5, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 }] };
}

const at = (x: number): RigidPlacement => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1] });

function documentOf(name: string, entries: readonly (readonly [string, ComponentSource])[]): AssemblyDocument {
  let document = createAssemblyDocument(name);
  for (const [id, source] of entries) {
    const component: AssemblyComponent = { ...createComponentFor(document, source, {}), id };
    document = addComponent(document, component);
  }
  return document;
}

/** 同じ子の組(葉 `plate`)を `組,A`(x=0)と `B`(x=10)に置いた根。子の中の配置は解いた世界座標。 */
function repeatedChild(): { readonly document: AssemblyDocument; readonly resolved: ResolvedAssembly } {
  const child = documentOf('子', [['plate', { kind: 'part', partRef: 'part-1' }]]);
  const document = documentOf('根', [['組,A', { kind: 'subAssembly', assemblyRef: 'child' }], ['B', { kind: 'subAssembly', assemblyRef: 'child' }]]);
  const leaf = (x: number): ResolvedAssembly => ({ parts: new Map(), errors: [],
    placements: new Map([['plate', at(x)]]), partKeys: new Map([['plate', 'part-1']]) });
  return { document, resolved: { parts: new Map(), errors: [], partKeys: new Map(), placements: new Map([['組,A', at(0)], ['B', at(0)]]),
    subAssemblies: new Map([
      ['組,A', { componentId: '組,A', assemblyRef: 'child', assembly: child, placement: at(0), resolved: leaf(0) }],
      ['B', { componentId: 'B', assemblyRef: 'child', assembly: child, placement: at(0), resolved: leaf(10) }],
    ]) } };
}

describe('組立の層の面の当たりに、入れ子の配置の経路が届く(本物の three.js の光線)', () => {
  it('同じ子の組の2か所の葉の面を、当たった配置の経路で返し、外れた所は当たらない', () => {
    const { document, resolved } = repeatedChild();
    const flat = flattenAssemblyGeometry(document, resolved);
    const layer = createAssemblyLayer(undefined, { uiBackings: new AssemblyUiBackingLedger() });
    try {
      layer.update(buildAssemblyGeometry({ ...flat, bodies: new Map([['part-1', [triangleBody()]]]),
        hoveredComponentId: null, selectedComponentIds: [] }), 'shadedWithEdges');
      const down = new THREE.Vector3(0, 0, -1);
      expect(layer.pickMateFace(new THREE.Raycaster(new THREE.Vector3(10.2, 0.2, 5), down))).toEqual({
        componentId: 'B/plate', partKey: 'part-1', bodyFeatureId: 'extrude-1', faceIndex: 0, occurrencePath: ['B', 'plate'] });
      expect(layer.pickMateFace(new THREE.Raycaster(new THREE.Vector3(0.2, 0.2, 5), down))).toEqual({
        componentId: '組,A/plate', partKey: 'part-1', bodyFeatureId: 'extrude-1', faceIndex: 0, occurrencePath: ['組,A', 'plate'] });
      expect(layer.pickMateFace(new THREE.Raycaster(new THREE.Vector3(5.2, 0.2, 5), down))).toBeNull();
    } finally { layer.dispose(); }
  });

  it('行 ID が別の配置と重なった葉の当たりには経路を添えない(どちらの配置か決めない)', () => {
    // 根の葉 `a/b`(x=0)と、子の組 `a` の中の葉 `b`(x=0)は、どちらも行 ID が `a/b`。
    const child = documentOf('子', [['b', { kind: 'part', partRef: 'part-1' }]]);
    const document = documentOf('根', [['a/b', { kind: 'part', partRef: 'part-1' }], ['a', { kind: 'subAssembly', assemblyRef: 'child' }]]);
    const resolved: ResolvedAssembly = { parts: new Map(), errors: [], partKeys: new Map([['a/b', 'part-1']]),
      placements: new Map([['a/b', at(0)], ['a', at(0)]]),
      subAssemblies: new Map([['a', { componentId: 'a', assemblyRef: 'child', assembly: child, placement: at(0),
        resolved: { parts: new Map(), errors: [], placements: new Map([['b', at(0)]]), partKeys: new Map([['b', 'part-1']]) } }]]) };
    const flat = flattenAssemblyGeometry(document, resolved);
    const layer = createAssemblyLayer(undefined, { uiBackings: new AssemblyUiBackingLedger() });
    try {
      layer.update(buildAssemblyGeometry({ ...flat, bodies: new Map([['part-1', [triangleBody()]]]),
        hoveredComponentId: null, selectedComponentIds: [] }), 'shadedWithEdges');
      const hit = layer.pickMateFace(new THREE.Raycaster(new THREE.Vector3(0.2, 0.2, 5), new THREE.Vector3(0, 0, -1)));
      expect(hit?.componentId).toBe('a/b');
      expect(hit?.occurrencePath).toBeUndefined();
    } finally { layer.dispose(); }
  });
});
