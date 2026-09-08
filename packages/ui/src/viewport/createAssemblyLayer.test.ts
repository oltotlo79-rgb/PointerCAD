/**
 * 配置した部品の表示層の検査(計画書 docs/plans/P7-アセンブリ.md タスク10)。
 *
 * 検証表の 6 行(同じ部品 50 個の形の数・異なる部品 3 種・非表示・捨てたときの解放・
 * 描き直しの所要・配置を変えても形を作り直さない)をここで固定する。
 *
 * `createAssemblyLayer()` は three.js の入れ物を作るだけで DOM(canvas・WebGL)には
 * 触れないので、Node の検査からそのまま呼べる(`createSolidLayer.test.ts` と同じ流儀)。
 * 実際の見え方(色・前後関係)は目視と E2E で確かめる。
 */
import {
  DEFAULT_APPEARANCE,
  DEFAULT_COMPONENT_PLACEMENT,
  IDENTITY_PLACEMENT,
  appearanceFromPreset,
  type AppearanceSpec,
  type AssemblyComponent,
  type ComponentSource,
  type RigidPlacement,
  type SolidBody,
} from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAssemblyGeometry,
  assemblyAppearanceSpecs,
  createAssemblyLayer,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
  type AssemblyGeometryInput,
} from './createAssemblyLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';
import type { AppearanceInput } from './buildSolidGeometry.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { subShapeRefOf } from '../solid/subShapeSelection.js';

describe('合致の面pickと強調の回帰', () => {
  it('同距離のglass fallbackでもcomponent pickと同じ部品を選ぶ', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const components = [input.components[0], { ...input.components[1], appearance: appearanceFromPreset('glass') }];
      const placements = new Map(components.map((component) => [component.id, placementAt(0)]));
      const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
      for (const ordered of [components, [...components].reverse()]) {
        layer.update(buildAssemblyGeometry({ ...input, components: ordered, placements }), 'shadedWithEdges');
        expect(layer.pickMateFace(ray)?.componentId).toBe(ordered[0].id);
        expect(layer.pickMateFace(ray)?.componentId).toBe(layer.pickComponent(ray));
      }
    } finally { layer.dispose(); }
  });

  it.each([10, 100_000_000.125])('多body・配置X=%sのfaceを同じinstanceから取る', (offset) => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const second = makeBody('second');
      const moved = { ...second, mesh: { ...second.mesh, positions: second.mesh.positions.map((value, index) => index % 3 === 0 ? value + 3 : value) } };
      layer.update(buildAssemblyGeometry({ ...input, placements: new Map([['component-1', placementAt(0)], ['component-2', placementAt(offset)]]),
        bodies: new Map([['part-1', [makeBody('first'), moved]]]) }), 'shadedWithEdges');
      const ray = new THREE.Raycaster(new THREE.Vector3(offset + 3.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
      expect(layer.pickMateFace(ray)).toEqual({ componentId: 'component-2', partKey: 'part-1', bodyFeatureId: 'second', faceIndex: 0 });
    } finally { layer.dispose(); }
  });

  it('face pickも非表示・削除後のslot詰め直しを反映する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(3);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      layer.update(buildAssemblyGeometry({ ...input, components: [input.components[2], { ...input.components[0], visible: false }] }), 'wireframe');
      const ray = new THREE.Raycaster(new THREE.Vector3(20.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
      expect(layer.pickMateFace(ray)?.componentId).toBe('component-3');
      ray.ray.origin.x = 10.2; expect(layer.pickMateFace(ray)).toBeNull();
      ray.ray.origin.x = 0.2; expect(layer.pickMateFace(ray)).toBeNull();
    } finally { layer.dispose(); }
  });

  it('面の強調だけを局所overlayへ描き、共有形を残して解除時に一度だけ解放する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const ref = subShapeRefOf([makeBody('extrude-1')], 'extrude-1#face:0');
      if (ref === null) throw new Error('fixture');
      const id = assemblyTargetId({ kind: 'subShape', componentId: 'component-2', ref });
      const bundle = buildAssemblyGeometry({ ...input, selectedTargetIds: [id] });
      layer.update(bundle, 'shadedWithEdges');
      const shape = faceBatchesOf(layer)[0].geometry;
      const overlay = layer.group.getObjectByName('assembly-mate-highlight:component-2');
      expect(overlay?.matrix.elements[12]).toBe(10);
      const mesh = overlay?.children.find((object) => object instanceof THREE.Mesh);
      if (mesh === undefined) throw new Error('face overlay');
      const geometry: unknown = mesh.geometry;
      const material: unknown = mesh.material;
      if (!(geometry instanceof THREE.BufferGeometry)) throw new Error('overlay geometry');
      const position: unknown = geometry.getAttribute('position');
      if (!(position instanceof THREE.BufferAttribute)) throw new Error('overlay position');
      expect(position.count).toBe(3);
      const disposed = vi.fn(); geometry.addEventListener('dispose', disposed);
      if (!(material instanceof THREE.MeshBasicMaterial)) throw new Error('overlay material');
      const materialDisposed = vi.fn(); material.addEventListener('dispose', materialDisposed);
      layer.setThemeColors({ ...DEFAULT_THEME_COLORS, selected: 0x123456 });
      layer.update(buildAssemblyGeometry({ ...input, selectedTargetIds: [id] }), 'shadedWithEdges');
      expect(material.color.getHex()).toBe(0x123456);
      expect(layer.group.getObjectByName(overlay?.name ?? '')).toBe(overlay);
      expect(disposed).not.toHaveBeenCalled();
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      expect(disposed).toHaveBeenCalledTimes(1); expect(materialDisposed).toHaveBeenCalledTimes(1);
      expect(faceBatchesOf(layer)[0].geometry).toBe(shape);
      layer.dispose(); expect(disposed).toHaveBeenCalledTimes(1);
    } finally { layer.dispose(); }
  });
});

describe('インスタンス → 部品の面/ボディ → 既定の外観', () => {
  const red: AppearanceSpec = { ...DEFAULT_APPEARANCE, color: '#ff0000' };
  const blue: AppearanceSpec = { ...DEFAULT_APPEARANCE, color: '#0000ff' };
  const green: AppearanceSpec = { ...DEFAULT_APPEARANCE, color: '#00ff00' };
  const appearances: AppearanceInput = {
    defaultAppearance: DEFAULT_APPEARANCE,
    byBody: new Map([['extrude-1', { bodyAppearance: red, faceAppearances: new Map([[0, blue]]) }]]),
  };

  function meshColors(root: THREE.Object3D): string[] {
    const result: string[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials: unknown = object.material;
      if (materials instanceof THREE.MeshStandardMaterial) {
        for (let slot = 0; slot < (object instanceof THREE.InstancedMesh ? object.count : 1); slot += 1) {
          result.push(materials.color.getHexString());
        }
      }
      else if (Array.isArray(materials)) {
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial) result.push(material.color.getHexString());
        }
      }
    });
    return result;
  }

  it('上書きありなら部品の面/ボディ外観より優先し、形は共有する', () => {
    const input = sameParts(2);
    const layer = createAssemblyLayer();
    try {
      layer.update(buildAssemblyGeometry({
        ...input, components: input.components.map((component) => ({ ...component, appearance: green })),
        appearances: new Map([['part-1', appearances]]),
      }), 'shaded');
      expect(meshColors(layer.group)).toEqual(['00ff00', '00ff00']);
      expect(meshGeometriesOf(layer.group).size).toBe(1);
    } finally { layer.dispose(); }
  });

  it('上書き無しなら部品の面とボディの材質を継承する', () => {
    const layer = createAssemblyLayer();
    try {
      layer.update(buildAssemblyGeometry({
        ...sameParts(1),
        bodies: new Map([['part-1', [makeBody('extrude-1'), makeBody('extrude-2')]]]),
        appearances: new Map([['part-1', {
          ...appearances,
          byBody: new Map([...appearances.byBody, ['extrude-2', {
            bodyAppearance: red, faceAppearances: new Map<number, AppearanceSpec>(),
          }]]),
        }]]),
      }), 'shaded');
      expect(meshColors(layer.group)).toEqual(['ff0000', '0000ff', 'ff0000']);
      const groups: unknown[] = [];
      layer.group.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry instanceof THREE.BufferGeometry) {
          groups.push(object.geometry.groups);
        }
      });
      expect(groups).toEqual([
        [{ start: 0, count: 3, materialIndex: 1 }],
        [{ start: 0, count: 3, materialIndex: 0 }],
      ]);
    } finally { layer.dispose(); }
  });

  it('外観の指定が無ければ既定のテーマ色を使う', () => {
    const layer = createAssemblyLayer();
    try {
      layer.update(buildAssemblyGeometry(sameParts(1)), 'shaded');
      expect(meshColors(layer.group)).toEqual([DEFAULT_THEME_COLORS.solid.toString(16).padStart(6, '0')]);
    } finally { layer.dispose(); }
  });
});

/** 1 コマぶんの予算(60fps、NFR-PF-1)。 */
const FRAME_BUDGET_MS = 16;

/** §1.5-23 の実測に使う個数(同じ部品を 50 個置く)。 */
const MANY_INSTANCES = 50;

/** 実測の平均を取る回数。1 回だけだと計測の揺れがそのまま出る。 */
const MEASURE_ROUNDS = 20;

/**
 * 三角形 1 枚の立体。当たり判定に使えるよう、XY 平面の (0,0)-(1,0)-(0,1) に張る
 * (法線は +Z なので、上から下へ向かう光線が表に当たる)。
 */
function makeBody(featureId: string): SolidBody {
  return {
    featureId,
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleCount: 1,
    },
    volume: 1,
    isValid: true,
    faces: [
      {
        index: 0,
        surfaceKind: 'plane',
        area: 0.5,
        centroid: [0, 0, 0],
        axis: [0, 0, 1],
        radius: null,
        triangleOffset: 0,
        triangleCount: 1,
      },
    ],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 大座標で幅が変わらないことを面と稜線の両方で確かめる 20mm 箱。 */
function makeBoxBody(): SolidBody {
  const box = new THREE.BoxGeometry(20, 20, 20);
  const edges = new THREE.EdgesGeometry(box);
  try {
    const indices = box.getIndex();
    if (indices === null) throw new Error('箱の三角形がありません。');
    return { ...makeBody('box'), faces: [], mesh: {
      positions: new Float32Array(box.getAttribute('position').array),
      normals: new Float32Array(box.getAttribute('normal').array),
      indices: new Uint32Array(indices.array),
      edgePositions: new Float32Array(edges.getAttribute('position').array),
      triangleCount: 12,
    } };
  } finally {
    edges.dispose();
    box.dispose();
  }
}

/** shader の各乗算・加算を Float32 に丸める(double の Vector3.applyMatrix4 と分ける)。 */
function float32Transform(point: THREE.Vector3, matrix: THREE.Matrix4): THREE.Vector3 {
  const values = matrix.elements.map(Math.fround);
  return new THREE.Vector3().fromArray([0, 1, 2].map((row) => {
    const products = [values[row] * point.x, values[4 + row] * point.y, values[8 + row] * point.z, values[12 + row]];
    return products.reduce((sum, product) => Math.fround(sum + Math.fround(product)), 0);
  }));
}

/** 置いた部品 1 つ。出どころは仕分けに効かない(鍵は `partKeys` で渡す)ので最小にする。 */
function makeComponent(id: string, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  const source: ComponentSource = { kind: 'part', partRef: 'part-1' };
  return {
    id,
    name: id,
    source,
    placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false,
    visible: true,
    suppressed: false,
    ...overrides,
  };
}

/** 位置だけを動かした配置(向きは恒等)。 */
function placementAt(x: number): RigidPlacement {
  return { position: [x, 0, 0], rotation: IDENTITY_PLACEMENT.rotation };
}

/**
 * 同じ部品を `count` 個置いた一式の材料。**形は 1 つ**(同じ `bodies` の並びを指す)。
 */
function sameParts(count: number, offset = 0): AssemblyGeometryInput {
  const bodies = [makeBody('extrude-1')];
  const components: AssemblyComponent[] = [];
  const placements = new Map<string, RigidPlacement>();
  const partKeys = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    const id = `component-${String(index + 1)}`;
    components.push(makeComponent(id));
    placements.set(id, placementAt(index * 10 + offset));
    partKeys.set(id, 'part-1');
  }
  return {
    components,
    placements,
    partKeys,
    bodies: new Map([['part-1', bodies]]),
    hoveredComponentId: null,
    selectedComponentIds: [],
  };
}

/**
 * 部品の面か(形と材質を中身まで確かめてから絞り込む)。
 * 型引数つきの class は `instanceof` だけでは中身が定まらないので、
 * `createSolidLayer.test.ts` の `isBodyMesh` と同じく述語で確かめる。
 */
function isPartMesh(
  object: THREE.Object3D,
): object is THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  return (
    object instanceof THREE.Mesh &&
    object.geometry instanceof THREE.BufferGeometry &&
    object.material instanceof THREE.MeshStandardMaterial
  );
}

/** 部品の稜線か。確かめ方は面と同じ。 */
function isPartEdges(
  object: THREE.Object3D,
): object is THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  return (
    object instanceof THREE.LineSegments &&
    object.geometry instanceof THREE.BufferGeometry &&
    object.material instanceof THREE.LineBasicMaterial
  );
}

/** 層の中の形(面と稜線)を、重複を除いて数える。 */
function geometriesOf(root: THREE.Object3D): Set<THREE.BufferGeometry> {
  const found = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    if (isPartMesh(object) || isPartEdges(object)) {
      found.add(object.geometry);
    }
  });
  return found;
}

/** 層の中の**面の形**だけを、重複を除いて数える(稜線は別に数える)。 */
function meshGeometriesOf(root: THREE.Object3D): Set<THREE.BufferGeometry> {
  const found = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    if (isPartMesh(object)) {
      found.add(object.geometry);
    }
  });
  return found;
}

/** 層の中の材質を、重複を除いて集める。 */
function materialsOf(root: THREE.Object3D): Set<THREE.Material> {
  const found = new Set<THREE.Material>();
  root.traverse((object) => {
    if (isPartMesh(object) || isPartEdges(object)) {
      found.add(object.material);
    }
  });
  return found;
}

/** 描画する面のバッチ。個別描画への退避を誤って見逃さないよう明示的に絞る。 */
function faceBatchesOf(layer: { readonly group: THREE.Group }): THREE.InstancedMesh[] {
  return layer.group.children.filter((object): object is THREE.InstancedMesh => object instanceof THREE.InstancedMesh);
}

function firstEdges(layer: { readonly group: THREE.Group }): THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.LineBasicMaterial> {
  const edges = layer.group.children.find((object): object is THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.LineBasicMaterial> =>
    isPartEdges(object) && object.geometry instanceof THREE.InstancedBufferGeometry);
  if (edges === undefined) throw new Error('稜線バッチがありません。');
  return edges;
}

function edgeColorAt(layer: { readonly group: THREE.Group }, slot: number): number {
  const attribute = firstEdges(layer).geometry.getAttribute('color');
  return new THREE.Color().setRGB(attribute.getX(slot), attribute.getY(slot), attribute.getZ(slot)).getHex();
}

describe('buildAssemblyGeometry(仕分け、§0.a-0.4)', () => {
  it('部品を 1 つも置いていなければ形も配置も空', () => {
    const bundle = buildAssemblyGeometry({
      components: [],
      placements: new Map(),
      partKeys: new Map(),
      bodies: new Map(),
      hoveredComponentId: null,
      selectedComponentIds: [],
    });
    expect(bundle).toEqual(EMPTY_ASSEMBLY_GEOMETRY);
  });

  it('同じ部品を 50 個置いても形は 1 つ、配置は 50 個', () => {
    const bundle = buildAssemblyGeometry(sameParts(MANY_INSTANCES));
    expect(bundle.parts.length).toBe(1);
    expect(bundle.instances.length).toBe(MANY_INSTANCES);
    // 50 個とも同じ並び(同一参照)を指す。写しは 1 つも作らない。
    expect(bundle.parts[0].bodies).toBe(bundle.parts[0].bodies);
  });

  it('異なる部品 3 種・合計 10 個なら形は 3 つ', () => {
    const keys = ['part-1', 'part-2', 'part-3'];
    const components: AssemblyComponent[] = [];
    const placements = new Map<string, RigidPlacement>();
    const partKeys = new Map<string, string>();
    for (let index = 0; index < 10; index += 1) {
      const id = `component-${String(index + 1)}`;
      components.push(makeComponent(id));
      placements.set(id, placementAt(index));
      partKeys.set(id, keys[index % keys.length]);
    }
    const bundle = buildAssemblyGeometry({
      components,
      placements,
      partKeys,
      bodies: new Map(keys.map((key) => [key, [makeBody('extrude-1')]])),
      hoveredComponentId: null,
      selectedComponentIds: [],
    });
    expect(bundle.parts.map((part) => part.partKey)).toEqual(keys);
    expect(bundle.instances.length).toBe(10);
  });

  it('抑制された部品(配置が無い)と中身を引けない部品(鍵が無い)は描かない', () => {
    const input = sameParts(3);
    const trimmedPlacements = new Map(input.placements);
    trimmedPlacements.delete('component-1');
    const trimmedKeys = new Map(input.partKeys);
    trimmedKeys.delete('component-2');
    const bundle = buildAssemblyGeometry({
      ...input,
      placements: trimmedPlacements,
      partKeys: trimmedKeys,
    });
    expect(bundle.instances.map((instance) => instance.componentId)).toEqual(['component-3']);
  });

  it('形がまだ届いていない鍵の部品は描かない(計算中でも止めない)', () => {
    const input = sameParts(2);
    const bundle = buildAssemblyGeometry({ ...input, bodies: new Map() });
    expect(bundle).toEqual(EMPTY_ASSEMBLY_GEOMETRY);
  });

  it('非表示の部品も並びに残り、visible だけが偽になる(形は消さない)', () => {
    const input = sameParts(2);
    const components = [input.components[0], makeComponent('component-2', { visible: false })];
    const bundle = buildAssemblyGeometry({ ...input, components });
    expect(bundle.parts.length).toBe(1);
    expect(bundle.instances.map((instance) => instance.visible)).toEqual([true, false]);
  });

  it('ホバーと選択の強調が付く(選択がホバーより強い)', () => {
    const input = sameParts(3);
    const bundle = buildAssemblyGeometry({
      ...input,
      hoveredComponentId: 'component-2',
      selectedComponentIds: ['component-2', 'component-3'],
    });
    expect(bundle.instances.map((instance) => instance.emphasis)).toEqual([
      'none',
      'selected',
      'selected',
    ]);
  });

  it('色分け未指定は継承として保持し、指定された上書きはそのまま渡す(FR-605)', () => {
    const painted: AppearanceSpec = { ...DEFAULT_APPEARANCE, preset: 'custom', color: '#ff0000' };
    const input = sameParts(2);
    const components = [input.components[0], makeComponent('component-2', { appearance: painted })];
    const bundle = buildAssemblyGeometry({ ...input, components });
    expect(bundle.instances[0].appearance).toBeUndefined();
    expect(bundle.instances[1].appearance).toBe(painted);
  });
});

describe('createAssemblyLayer(形の共有、§0.a-0.4)', () => {
  it('同じ部品を 50 個置いても面の形は 1 つ(共有)', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(MANY_INSTANCES)), 'shadedWithEdges');

    expect(faceBatchesOf(layer).map((mesh) => mesh.count)).toEqual([MANY_INSTANCES]);
    expect(firstEdges(layer).geometry.instanceCount).toBe(MANY_INSTANCES);
    expect(meshGeometriesOf(layer.group).size).toBe(1);
    // 面 1 つ + 稜線 1 つ。置いた数が増えても形は増えない。
    expect(geometriesOf(layer.group).size).toBe(2);
    layer.dispose();
  });

  it('50 個置いても材質は 2 つ、面と稜線の instanced draw は各 1 回', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(MANY_INSTANCES)), 'shadedWithEdges');

    /*
      P7-11b の実 render が 22.2501fps だったため描画をまとめる。従来の 100 objects を
      2 objects へ削減し、50 配置は各 instance count で維持する(GPU 実測 fps は E2E)。
    */
    expect(materialsOf(layer.group).size).toBe(2);
    let drawn = 0;
    layer.group.traverse((object) => {
      if (isPartMesh(object) || isPartEdges(object)) {
        drawn += 1;
      }
    });
    expect(drawn).toBe(2);
    expect(faceBatchesOf(layer)[0].count).toBe(MANY_INSTANCES);
    expect(firstEdges(layer).geometry.instanceCount).toBe(MANY_INSTANCES);
    layer.dispose();
  });

  it('異なる部品 3 種・合計 10 個なら面の形は 3 つ', () => {
    const layer = createAssemblyLayer();
    const keys = ['part-1', 'part-2', 'part-3'];
    const components: AssemblyComponent[] = [];
    const placements = new Map<string, RigidPlacement>();
    const partKeys = new Map<string, string>();
    for (let index = 0; index < 10; index += 1) {
      const id = `component-${String(index + 1)}`;
      components.push(makeComponent(id));
      placements.set(id, placementAt(index));
      partKeys.set(id, keys[index % keys.length]);
    }
    layer.update(
      buildAssemblyGeometry({
        components,
        placements,
        partKeys,
        bodies: new Map(keys.map((key) => [key, [makeBody('extrude-1')]])),
        hoveredComponentId: null,
        selectedComponentIds: [],
      }),
      'shadedWithEdges',
    );

    expect(faceBatchesOf(layer).reduce((sum, mesh) => sum + mesh.count, 0)).toBe(10);
    expect(meshGeometriesOf(layer.group).size).toBe(3);
    layer.dispose();
  });

  it('位置と四元数を three の配置行列へ写し、全 slot で向きを維持する', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    const placements = new Map(input.placements);
    // Z 軸まわり 90°(§2.4 の検算と同じ四元数)。
    const half = Math.SQRT1_2;
    placements.set('component-2', { position: [5, 6, 7], rotation: [0, 0, half, half] });
    layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');

    const second = new THREE.Matrix4();
    faceBatchesOf(layer)[0].getMatrixAt(1, second);
    const expected = new THREE.Matrix4().compose(new THREE.Vector3(5, 6, 7), new THREE.Quaternion(0, 0, half, half), new THREE.Vector3(1, 1, 1));
    expect(second.elements).toEqual([...new Float32Array(expected.elements)]);
    expect([...firstEdges(layer).geometry.getAttribute('instanceMatrix').array].slice(16, 32)).toEqual(second.elements);
    layer.dispose();
  });

  it('配置を変えても形を作り直さない(同じ並びなら同じ BufferGeometry)', () => {
    const layer = createAssemblyLayer();
    const bodies = [makeBody('extrude-1')];
    const build = (offset: number): AssemblyGeometryBundle => {
      const input = sameParts(3, offset);
      return buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', bodies]]) });
    };
    layer.update(build(0), 'shadedWithEdges');
    const before = [...meshGeometriesOf(layer.group)];
    layer.update(build(25), 'shadedWithEdges');
    const after = [...meshGeometriesOf(layer.group)];

    expect(after.length).toBe(1);
    expect(after[0]).toBe(before[0]);
    layer.dispose();
  });

  it('非表示の部品は可視 slot から外すだけで、形は残る', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    const components = [input.components[0], makeComponent('component-2', { visible: false })];
    layer.update(buildAssemblyGeometry({ ...input, components }), 'shadedWithEdges');

    expect(faceBatchesOf(layer).map((mesh) => mesh.count)).toEqual([1]);
    expect(firstEdges(layer).geometry.instanceCount).toBe(1);
    // 形は共有のまま 1 つ(消した部品のために作り直さない)。
    expect(meshGeometriesOf(layer.group).size).toBe(1);
    layer.dispose();
  });

  it('部品を消すと、その鍵を使う部品が無くなったときに形も捨てる', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(2)), 'shadedWithEdges');
    const disposed: string[] = [];
    for (const geometry of geometriesOf(layer.group)) {
      geometry.addEventListener('dispose', () => disposed.push('geometry'));
    }

    layer.update(EMPTY_ASSEMBLY_GEOMETRY, 'shadedWithEdges');
    expect(disposed.length).toBe(2);
    expect(layer.group.children.length).toBe(0);
    layer.dispose();
  });
});

describe('createAssemblyLayer(表示スタイルと強調、FR-105、FR-106)', () => {
  it('ワイヤーフレームでは面を出さず、シェーディングのみでは稜線を出さない', () => {
    const layer = createAssemblyLayer();
    const bundle = buildAssemblyGeometry(sameParts(1));
    layer.update(bundle, 'wireframe');
    const faceVisible = (): boolean => layer.group.children.filter(isPartMesh)[0].visible;
    const edgeVisible = (): boolean => layer.group.children.filter(isPartEdges)[0].visible;
    expect(faceVisible()).toBe(false);
    expect(edgeVisible()).toBe(true);

    layer.update(bundle, 'shaded');
    expect(faceVisible()).toBe(true);
    expect(edgeVisible()).toBe(false);
    layer.dispose();
  });

  it('選んだ部品の稜線は、面のみの表示でも出る(強調は稜線で示すため)', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    layer.update(
      buildAssemblyGeometry({ ...input, selectedComponentIds: ['component-2'] }),
      'shaded',
    );
    const edges = firstEdges(layer);
    expect(edges.geometry.instanceCount).toBe(1);
    expect(edges.geometry.getAttribute('instanceMatrix').array[12]).toBe(10);
    layer.dispose();
  });

  it('選択・ホバーの稜線の色はテーマの強調色になる', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    layer.update(
      buildAssemblyGeometry({ ...input, hoveredComponentId: 'component-1', selectedComponentIds: ['component-2'] }),
      'shadedWithEdges',
    );
    expect(edgeColorAt(layer, 0)).toBe(DEFAULT_THEME_COLORS.hovered);
    expect(edgeColorAt(layer, 1)).toBe(DEFAULT_THEME_COLORS.selected);
    layer.dispose();
  });
});

describe('createAssemblyLayer(当たり判定、FR-106)', () => {
  it('面合致のpickはinstance・part・body・faceを同じ交点から返す', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(2)), 'shadedWithEdges');
    const raycaster = new THREE.Raycaster(new THREE.Vector3(10.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
    expect(layer.pickMateFace(raycaster)).toEqual({
      componentId: 'component-2', partKey: 'part-1', bodyFeatureId: 'extrude-1', faceIndex: 0,
    });
    layer.dispose();
  });

  it('面の外と非表示instanceは合致対象にならない', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    layer.update(buildAssemblyGeometry({ ...input, components: [input.components[0],
      makeComponent('component-2', { visible: false })] }), 'shadedWithEdges');
    expect(layer.pickMateFace(new THREE.Raycaster(new THREE.Vector3(10.2, 0.2, 5), new THREE.Vector3(0, 0, -1)))).toBeNull();
    expect(layer.pickMateFace(new THREE.Raycaster(new THREE.Vector3(100, 100, 5), new THREE.Vector3(0, 0, -1)))).toBeNull();
    layer.dispose();
  });

  it('光線が当たった部品の id を返す', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');

    // 2 個目は x = 10 に置いてある。その三角形の内側を真上から狙う。
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(10.2, 0.2, 5),
      new THREE.Vector3(0, 0, -1),
    );
    expect(layer.pickComponent(raycaster)).toBe('component-2');
    layer.dispose();
  });

  it('どの部品にも当たらなければ null', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(2)), 'shadedWithEdges');
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(100, 100, 5),
      new THREE.Vector3(0, 0, -1),
    );
    expect(layer.pickComponent(raycaster)).toBeNull();
    layer.dispose();
  });

  it('非表示の部品には当たらない(画面に無いものを選ばせない)', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    const components = [input.components[0], makeComponent('component-2', { visible: false })];
    layer.update(buildAssemblyGeometry({ ...input, components }), 'shadedWithEdges');

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(10.2, 0.2, 5),
      new THREE.Vector3(0, 0, -1),
    );
    expect(layer.pickComponent(raycaster)).toBeNull();
    layer.dispose();
  });
});

describe('createAssemblyLayer(資源の解放、P5 §7.3)', () => {
  it('dispose() で形も材質もすべて捨てる', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(MANY_INSTANCES)), 'shadedWithEdges');

    const disposed: string[] = [];
    for (const geometry of geometriesOf(layer.group)) {
      geometry.addEventListener('dispose', () => disposed.push('geometry'));
    }
    for (const material of materialsOf(layer.group)) {
      material.addEventListener('dispose', () => disposed.push('material'));
    }

    layer.dispose();
    // 形 2(面 + 稜線)、材質 2(面の材質 1 + いま使っている稜線の材質 1)。
    // 個別描画へ退避する場合の稜線材質は、画面に出ていないので数えない。
    expect(disposed.filter((entry) => entry === 'geometry').length).toBe(2);
    expect(disposed.filter((entry) => entry === 'material').length).toBe(2);
    expect(layer.group.children.length).toBe(0);
  });

  it('テーマを変えても形は作り直さない(FR-908)', () => {
    const layer = createAssemblyLayer();
    const bundle = buildAssemblyGeometry(sameParts(3));
    layer.update(bundle, 'shadedWithEdges');
    const before = [...meshGeometriesOf(layer.group)];

    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, solid: 0x112233 });
    layer.update(bundle, 'shadedWithEdges');
    const after = [...meshGeometriesOf(layer.group)];

    expect(after[0]).toBe(before[0]);
    layer.dispose();
  });
});

describe('createAssemblyLayer(環境マップの借用、FR-1107)', () => {
  function firstMesh(layer: ReturnType<typeof createAssemblyLayer>): THREE.Mesh {
    let found: THREE.Mesh | null = null;
    layer.group.traverse((object) => {
      if (found === null && object instanceof THREE.Mesh) found = object;
    });
    if (found === null) throw new Error('面が見つかりません。');
    return found;
  }

  it('表示中インスタンスの上書き外観を環境要否へ列挙する', () => {
    const input = sameParts(1);
    const mirror = appearanceFromPreset('mirror');
    const bundle = buildAssemblyGeometry({
      ...input,
      components: [{ ...input.components[0], appearance: mirror }],
    });
    expect(assemblyAppearanceSpecs(bundle)).toContain(mirror);
  });

  it('上書き済み・非表示の部品外観は環境要否へ含めない', () => {
    const input = sameParts(2);
    const mirror = appearanceFromPreset('mirror');
    const plain = appearanceFromPreset('plastic');
    const inherited: AppearanceInput = { defaultAppearance: mirror, byBody: new Map() };
    const bundle = buildAssemblyGeometry({
      ...input,
      appearances: new Map([['part-1', inherited]]),
      components: [
        { ...input.components[0], appearance: plain },
        { ...input.components[1], visible: false },
      ],
    });
    expect(assemblyAppearanceSpecs(bundle)).toEqual([plain]);
  });

  it('同じbundleでも環境マップの変更を材質へ反映する', () => {
    const layer = createAssemblyLayer();
    const bundle = buildAssemblyGeometry(sameParts(1));
    const first = new THREE.Texture();
    const second = new THREE.Texture();
    layer.update(bundle, 'shaded', first);
    expect((firstMesh(layer).material as THREE.MeshStandardMaterial).envMap).toBe(first);
    layer.update(bundle, 'shaded', second);
    expect((firstMesh(layer).material as THREE.MeshStandardMaterial).envMap).toBe(second);
    layer.dispose();
  });

  it('層を捨ててもシーンから借りた環境マップを捨てない', () => {
    const layer = createAssemblyLayer();
    const environment = new THREE.Texture();
    let disposed = 0;
    environment.addEventListener('dispose', () => { disposed += 1; });
    layer.update(buildAssemblyGeometry(sameParts(1)), 'shaded', environment);
    layer.dispose();
    expect(disposed).toBe(0);
  });
});

describe('createAssemblyLayer(描き直しの所要、§1.5-23、NFR-PF-1)', () => {
  it('高密度の共有形でもホバー・選択・テーマ・表示切替では頂点を再走査しない', () => {
    const layer = createAssemblyLayer();
    const triangleCount = 4096;
    const positions = new Float32Array(triangleCount * 9);
    const edgePositions = new Float32Array(triangleCount * 12);
    const indices = new Uint32Array(triangleCount * 3);
    const normals = new Float32Array(positions.length);
    for (let index = 0; index < triangleCount; index += 1) {
      const x = index % 64;
      const y = Math.floor(index / 64);
      positions.set([x, y, 0, x + 1, y, 0, x, y + 1, 0], index * 9);
      edgePositions.set([x, y, 0, x + 1, y, 0, x + 1, y, 0, x, y + 1, 0], index * 12);
      normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1], index * 9);
      indices.set([index * 3, index * 3 + 1, index * 3 + 2], index * 3);
    }
    const body: SolidBody = { ...makeBody('dense'), faces: [], mesh: { positions, normals, indices, edgePositions, triangleCount } };
    const input = { ...sameParts(8), bodies: new Map([['part-1', [body]]]) };
    layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
    const vertexArrays = new Set([
      faceBatchesOf(layer)[0].geometry.getAttribute('position').array,
      firstEdges(layer).geometry.getAttribute('position').array,
    ]);
    const reads = vi.spyOn(THREE.BufferAttribute.prototype, 'getX');
    try {
      const emphasized = { ...input, hoveredComponentId: 'component-2', selectedComponentIds: ['component-3'] };
      layer.update(buildAssemblyGeometry(emphasized), 'shadedWithEdges');
      expect(edgeColorAt(layer, 1)).toBe(DEFAULT_THEME_COLORS.hovered);
      expect(edgeColorAt(layer, 2)).toBe(DEFAULT_THEME_COLORS.selected);
      layer.setThemeColors({ ...DEFAULT_THEME_COLORS, hovered: 0x123456 });
      layer.update(buildAssemblyGeometry(emphasized), 'shadedWithEdges');
      expect(edgeColorAt(layer, 1)).toBe(0x123456);
      layer.update(buildAssemblyGeometry(emphasized), 'wireframe');
      expect(faceBatchesOf(layer)[0].visible).toBe(false);
      layer.update(buildAssemblyGeometry(emphasized), 'shaded');
      expect(firstEdges(layer).geometry.instanceCount).toBe(2);
      // ViewportCanvas と同じく bundle を毎回作り、値が等しい新しい配置配列も渡す。
      const placements = new Map<string, RigidPlacement>([...input.placements].map(([id, placement]) => [id, {
        position: [...placement.position], rotation: [...placement.rotation],
      } satisfies RigidPlacement]));
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)[0].count).toBe(8);
      expect(firstEdges(layer).geometry.instanceCount).toBe(8);
      // 色の確認で読む color 属性は数えず、共有する面・稜線の position だけを数える。
      const vertexReads = reads.mock.contexts.filter((attribute) =>
        attribute instanceof THREE.BufferAttribute && vertexArrays.has(attribute.array)).length;
      expect(vertexReads).toBe(0);
      reads.mockClear();
      placements.set('component-8', placementAt(75));
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      const movedVertexReads = reads.mock.contexts.filter((attribute) =>
        attribute instanceof THREE.BufferAttribute && vertexArrays.has(attribute.array)).length;
      // 同じ共有形の8配置のうち、動いた1配置だけ面・稜線を1巡ずつ検査する。
      expect(movedVertexReads).toBe((positions.length + edgePositions.length) / 3);
      expect(faceBatchesOf(layer)[0].count).toBe(8);
      expect(faceBatchesOf(layer)[0].instanceMatrix.array[7 * 16 + 12]).toBe(75);
    } finally {
      reads.mockRestore();
      layer.dispose();
    }
  });

  it('カメラだけの再描画では50部品の配置行列を再計算しない', () => {
    const layer = createAssemblyLayer();
    const scene = new THREE.Scene();
    // createViewportScene と同じ、位置が固定されたシーン。
    scene.matrixAutoUpdate = false;
    scene.add(layer.group);
    const bundle = buildAssemblyGeometry(sameParts(MANY_INSTANCES));
    layer.update(bundle, 'shadedWithEdges');
    scene.updateMatrixWorld();
    const compose = vi.spyOn(THREE.Matrix4.prototype, 'compose');
    const multiply = vi.spyOn(THREE.Matrix4.prototype, 'multiplyMatrices');
    try {
      // WebGLRenderer.render が行う実際の scene graph 更新を通す(WebGL は起動しない)。
      for (let frame = 0; frame < MEASURE_ROUNDS; frame += 1) {
        layer.update(bundle, 'shadedWithEdges');
        scene.updateMatrixWorld();
      }
      expect(compose).not.toHaveBeenCalled();
      expect(multiply).not.toHaveBeenCalled();
      const ray = new THREE.Raycaster(new THREE.Vector3(490.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
      expect(layer.pickComponent(ray)).toBe('component-50');
    } finally {
      compose.mockRestore();
      multiply.mockRestore();
      layer.dispose();
    }
  });

  it('ホバーで配置を再計算せず、同じ配置で形が置き換わっても正しい位置で選べる', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
    const compose = vi.spyOn(THREE.Matrix4.prototype, 'compose');
    try {
      layer.update(buildAssemblyGeometry({ ...input, hoveredComponentId: 'component-2' }), 'shadedWithEdges');
      expect(compose).not.toHaveBeenCalled();
      layer.update(buildAssemblyGeometry({
        ...input,
        bodies: new Map([['part-1', [makeBody('replacement')]]]),
      }), 'shadedWithEdges');
      const ray = new THREE.Raycaster(new THREE.Vector3(10.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
      expect(layer.pickComponent(ray)).toBe('component-2');
      ray.ray.origin.x = 0.2;
      expect(layer.pickComponent(ray)).toBe('component-1');
    } finally {
      compose.mockRestore();
      layer.dispose();
    }
  });

  it('同じ部品 50 個の配置を書き換える所要が 1 コマ(16ms)に収まる', () => {
    const layer = createAssemblyLayer();
    const bodies = [makeBody('extrude-1')];
    const bundles: AssemblyGeometryBundle[] = [];
    for (let round = 0; round < MEASURE_ROUNDS; round += 1) {
      const input = sameParts(MANY_INSTANCES, round);
      bundles.push(buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', bodies]]) }));
    }
    // 1 巡目で入れ物を作ってから測る(作る費用と書き換えの費用を混ぜない)。
    layer.update(bundles[0], 'shadedWithEdges');

    const started = performance.now();
    for (const bundle of bundles) {
      layer.update(bundle, 'shadedWithEdges');
    }
    const elapsed = (performance.now() - started) / MEASURE_ROUNDS;
    console.log(
      `[実測] 部品 ${String(MANY_INSTANCES)} 個の配置の書き換え: ${elapsed.toFixed(3)} ms / 回`,
    );
    expectWithinBudget(elapsed, FRAME_BUDGET_MS, 'アセンブリの層の書き換え');
    layer.dispose();
  });
});

describe('createAssemblyLayer(バッチの可視 slot・描画経路・寿命)', () => {
  const down = new THREE.Vector3(0, 0, -1);
  const rayAt = (x: number, y = 0.2, z = 5): THREE.Raycaster => new THREE.Raycaster(new THREE.Vector3(x, y, z), down);

  it('20mm の箱 50 個を一意・非重複に保ち、面・稜線の全 slot を個別に選べる', () => {
    const layer = createAssemblyLayer();
    const box = new THREE.BoxGeometry(20, 20, 20);
    const boxEdges = new THREE.EdgesGeometry(box);
    try {
      const input = sameParts(MANY_INSTANCES);
      const indices = box.getIndex();
      if (indices === null) throw new Error('箱の三角形がありません。');
      const body: SolidBody = { ...makeBody('box'), faces: [], mesh: {
        positions: new Float32Array(box.getAttribute('position').array),
        normals: new Float32Array(box.getAttribute('normal').array),
        indices: new Uint32Array(indices.array),
        edgePositions: new Float32Array(boxEdges.getAttribute('position').array),
        triangleCount: 12,
      } };
      layer.update(buildAssemblyGeometry({
        ...input, bodies: new Map([['part-1', [body]]]),
        placements: new Map(input.components.map((component, index) => [component.id, placementAt(index * 30)])),
        components: input.components.map((component, index) => ({ ...component, fixed: index % 2 === 0 })),
      }), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      const translations = new Set<number>();
      const matrix = new THREE.Matrix4();
      for (let slot = 0; slot < MANY_INSTANCES; slot += 1) {
        face.getMatrixAt(slot, matrix);
        translations.add(matrix.elements[12]);
        expect([...edges.geometry.getAttribute('instanceMatrix').array].slice(slot * 16, (slot + 1) * 16)).toEqual(matrix.elements);
        expect(matrix.elements[12]).toBe(slot * 30);
        const ray = rayAt(slot * 30 + 0.2, 0.2, 50);
        expect(ray.intersectObject(face, false)[0].instanceId).toBe(slot);
        expect(layer.pickComponent(ray)).toBe(`component-${String(slot + 1)}`);
      }
      expect(translations.size).toBe(MANY_INSTANCES);
      expect(face.visible && edges.visible).toBe(true);
      expect(face.instanceMatrix.count).toBeGreaterThanOrEqual(MANY_INSTANCES);
      expect(face.count).toBe(MANY_INSTANCES);
      expect(edges.geometry.instanceCount).toBe(MANY_INSTANCES);
      expect(layer.group.children).toHaveLength(2);
      expect((face.geometry.getIndex()?.count ?? 0) / 3 * face.count).toBe(600);
      expect(edges.geometry.getAttribute('position').count / 2 * edges.geometry.instanceCount).toBe(600);
      console.log('[実測] 20mm 箱 50 個: face objects=1 / edge objects=1 / face count=50 / edge instanceCount=50 / triangles=600 / segments=600');
    } finally { layer.dispose(); box.dispose(); boxEdges.dispose(); }
  });

  it('稜線は標準 shader の instanceMatrix 変換と divisor=1 の色属性を通る', () => {
    const layer = createAssemblyLayer();
    try {
      layer.update(buildAssemblyGeometry(sameParts(2)), 'shadedWithEdges');
      const edges = firstEdges(layer);
      expect(edges.isLineSegments).toBe(true);
      expect(edges.geometry.isInstancedBufferGeometry).toBe(true);
      expect(edges.material).toHaveProperty('defines.USE_INSTANCING', '');
      expect(edges.material.vertexColors).toBe(true);
      expect(edges.material.color.getHex()).toBe(0xffffff);
      for (const name of ['instanceMatrix', 'color']) {
        const attribute = edges.geometry.getAttribute(name);
        expect(attribute).toBeInstanceOf(THREE.InstancedBufferAttribute);
        expect(attribute).toHaveProperty('meshPerAttribute', 1);
      }
      expect(edges.geometry.getAttribute('instanceMatrix').itemSize).toBe(16);
      expect(THREE.ShaderLib.basic.vertexShader).toContain('#include <project_vertex>');
      expect(THREE.ShaderChunk.project_vertex).toContain('instanceMatrix * mvPosition');
      expect(THREE.ShaderChunk.color_vertex).toContain('vColor *= color');
      expect(edges.geometry.getAttribute('instanceMatrix').array[28]).toBe(10);
    } finally { layer.dispose(); }
  });

  it('非表示・並び替え・削除で slot を詰め直し、余剰容量を描かず選ばない', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(4);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      layer.update(buildAssemblyGeometry({ ...input, components: [
        input.components[3], { ...input.components[1], visible: false }, input.components[0],
      ] }), 'wireframe');
      expect(faceBatchesOf(layer)[0]).toBe(face);
      expect(face.count).toBe(2);
      expect(face.visible).toBe(false);
      expect(firstEdges(layer).geometry.instanceCount).toBe(2);
      expect(layer.pickComponent(rayAt(30.2))).toBe('component-4');
      expect(layer.pickComponent(rayAt(0.2))).toBe('component-1');
      expect(layer.pickComponent(rayAt(10.2))).toBeNull();
      expect(layer.pickComponent(rayAt(20.2))).toBeNull();
      expect(rayAt(30.2).intersectObject(face, false)[0].instanceId).toBe(0);
      expect(rayAt(0.2).intersectObject(face, false)[0].instanceId).toBe(1);
    } finally { layer.dispose(); }
  });

  it('全非表示でも形を残し、再表示時に同じバッファで正しい count へ戻る', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(3);
      const bundle = buildAssemblyGeometry(input);
      layer.update(bundle, 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      layer.update(buildAssemblyGeometry({ ...input, components: input.components.map((component) => ({ ...component, visible: false })) }), 'shadedWithEdges');
      expect(face.count).toBe(0);
      expect(edges.geometry.instanceCount).toBe(0);
      expect(face.visible || edges.visible).toBe(false);
      expect(layer.pickComponent(rayAt(0.2))).toBeNull();
      layer.update(bundle, 'shadedWithEdges');
      expect(faceBatchesOf(layer)[0]).toBe(face);
      expect(firstEdges(layer)).toBe(edges);
      expect(face.count).toBe(3);
      expect(edges.geometry.instanceCount).toBe(3);
      expect(layer.pickComponent(rayAt(20.2))).toBe('component-3');
    } finally { layer.dispose(); }
  });

  it('容量拡張で旧 instance buffer を解放し、共有形を生かしたまま末尾まで描く', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const oldFace = faceBatchesOf(layer)[0];
      const oldEdges = firstEdges(layer);
      const disposedFace = vi.fn();
      const disposedEdges = vi.fn();
      const disposedShape = vi.fn();
      oldFace.addEventListener('dispose', disposedFace);
      oldEdges.geometry.addEventListener('dispose', disposedEdges);
      oldFace.geometry.addEventListener('dispose', disposedShape);
      const expanded = buildAssemblyGeometry({ ...sameParts(5), bodies: input.bodies });
      layer.update(expanded, 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      expect(disposedFace).toHaveBeenCalledTimes(1);
      expect(disposedEdges).toHaveBeenCalledTimes(1);
      expect(disposedShape).not.toHaveBeenCalled();
      expect(face.geometry).toBe(oldFace.geometry);
      expect(edges.geometry.getAttribute('position')).not.toBe(oldEdges.geometry.getAttribute('position'));
      expect(edges.geometry.getAttribute('position').array).toBe(oldEdges.geometry.getAttribute('position').array);
      expect(face.count).toBe(5);
      expect(face.instanceMatrix.count).toBe(8);
      expect(edges.geometry.instanceCount).toBe(5);
      expect(layer.pickComponent(rayAt(40.2))).toBe('component-5');
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      expect(faceBatchesOf(layer)[0]).toBe(face);
      expect(face.count).toBe(2);
      expect(layer.pickComponent(rayAt(40.2))).toBeNull();
      layer.dispose();
      expect(disposedShape).toHaveBeenCalledTimes(1);
      expect(disposedFace).toHaveBeenCalledTimes(1);
      expect(disposedEdges).toHaveBeenCalledTimes(1);
    } finally { layer.dispose(); }
  });

  it('形の置換は旧面・稜線・instance buffer を各 1 回解放して pick の形も交換する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      const events = [vi.fn(), vi.fn(), vi.fn()];
      face.addEventListener('dispose', events[0]);
      face.geometry.addEventListener('dispose', events[1]);
      edges.geometry.addEventListener('dispose', events[2]);
      const body = makeBody('replacement');
      const positions = body.mesh.positions.map((value, index) => index % 3 === 0 ? value + 3 : value);
      layer.update(buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [{ ...body, mesh: { ...body.mesh, positions } }]]]) }), 'shadedWithEdges');
      for (const event of events) expect(event).toHaveBeenCalledTimes(1);
      expect(layer.pickComponent(rayAt(10.2))).toBeNull();
      expect(layer.pickComponent(rayAt(13.2))).toBe('component-2');
      layer.dispose();
      for (const event of events) expect(event).toHaveBeenCalledTimes(1);
    } finally { layer.dispose(); }
  });

  it('ホバー・テーマの色だけでは面の配置バッファを再送しない', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(3);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      const faceVersion = face.instanceMatrix.version;
      const edgeMatrices = edges.geometry.getAttribute('instanceMatrix');
      if (!(edgeMatrices instanceof THREE.InstancedBufferAttribute)) throw new Error('配置属性がありません。');
      const edgeVersion = edgeMatrices.version;
      const emphasized = buildAssemblyGeometry({ ...input, hoveredComponentId: 'component-2', selectedComponentIds: ['component-3'] });
      layer.update(emphasized, 'shadedWithEdges');
      expect(face.instanceMatrix.version).toBe(faceVersion);
      expect(edgeMatrices.version).toBe(edgeVersion);
      expect(edgeColorAt(layer, 1)).toBe(DEFAULT_THEME_COLORS.hovered);
      expect(edgeColorAt(layer, 2)).toBe(DEFAULT_THEME_COLORS.selected);
      layer.setThemeColors({ ...DEFAULT_THEME_COLORS, hovered: 0x123456, selected: 0x654321 });
      layer.update(emphasized, 'shaded');
      expect(faceBatchesOf(layer)[0]).toBe(face);
      expect(face.instanceMatrix.version).toBe(faceVersion);
      expect(edges.geometry.instanceCount).toBe(2);
      expect(edgeColorAt(layer, 0)).toBe(0x123456);
      expect(edgeColorAt(layer, 1)).toBe(0x654321);
      expect([...edges.geometry.getAttribute('instanceMatrix').array].filter((_, index) => index === 12 || index === 28)).toEqual([10, 20]);
    } finally { layer.dispose(); }
  });

  it('複数ボディと複数面材質を同じグループ順・UV・配置で描く', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(3);
      const red = { ...DEFAULT_APPEARANCE, color: '#ff0000' };
      const blue = { ...DEFAULT_APPEARANCE, color: '#0000ff' };
      layer.update(buildAssemblyGeometry({
        ...input, bodies: new Map([['part-1', [makeBody('first'), makeBody('second')]]]),
        appearances: new Map([['part-1', { defaultAppearance: DEFAULT_APPEARANCE, byBody: new Map([
          ['first', { bodyAppearance: red, faceAppearances: new Map([[0, blue]]) }],
        ]) }]]),
      }), 'shadedWithEdges');
      const faces = faceBatchesOf(layer);
      expect(faces).toHaveLength(2);
      expect(faces.map((face) => face.count)).toEqual([3, 3]);
      expect(faces[0].geometry.groups).toEqual([{ start: 0, count: 3, materialIndex: 1 }]);
      expect(faces[0].geometry.getAttribute('uv').count).toBe(3);
      const materials: unknown = faces[0].material;
      if (!Array.isArray(materials)) throw new Error('面別材質がありません。');
      expect(materials).toHaveLength(2);
      expect(materials[0]).toHaveProperty('color', new THREE.Color('#ff0000'));
      expect(materials[1]).toHaveProperty('color', new THREE.Color('#0000ff'));
      expect(layer.group.children.filter(isPartEdges)).toHaveLength(2);
      expect(layer.pickComponent(rayAt(20.2))).toBe('component-3');
    } finally { layer.dispose(); }
  });

  it('部品ごとの外観上書きは同じ材質だけをまとめ、稜線は共有する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(3);
      const red = { ...DEFAULT_APPEARANCE, color: '#ff0000' };
      layer.update(buildAssemblyGeometry({ ...input, components: input.components.map((component, index) =>
        index === 1 ? component : { ...component, appearance: red }) }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2, 1]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(3);
      expect(meshGeometriesOf(layer.group).size).toBe(1);
      for (let slot = 0; slot < 3; slot += 1) expect(layer.pickComponent(rayAt(slot * 10 + 0.2))).toBe(`component-${String(slot + 1)}`);
    } finally { layer.dispose(); }
  });

  it('transmission > 0 は transparent=false でも個別 Mesh へ退避する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const bundle = buildAssemblyGeometry({ ...input, components: input.components.map((component) => ({ ...component, appearance: appearanceFromPreset('glass') })) });
      layer.update(bundle, 'shadedWithEdges');
      const faces = layer.group.children.filter(isPartMesh);
      expect(faces).toHaveLength(2);
      expect(faceBatchesOf(layer)).toHaveLength(0);
      for (const face of faces) {
        expect(face.material.transparent).toBe(false);
        expect(face.material).toHaveProperty('transmission', 0.92);
      }
      expect(firstEdges(layer).geometry.instanceCount).toBe(2);
      expect(layer.pickComponent(rayAt(10.2))).toBe('component-2');
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2]);
      expect(layer.group.children).toHaveLength(2);
    } finally { layer.dispose(); }
  });

  it('transparent=true の材質も個別 Mesh へ退避する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const face = layer.group.children.find(isPartMesh);
      if (face === undefined) throw new Error('面がありません。');
      face.material.transparent = true;
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      expect(faceBatchesOf(layer)).toHaveLength(0);
      expect(layer.group.children.filter(isPartMesh)).toHaveLength(2);
      expect(layer.pickComponent(rayAt(10.2))).toBe('component-2');
    } finally { layer.dispose(); }
  });

  it('同距離の重なりは材質バッチや透過 fallback に依存せず元の部品順で選ぶ', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(3);
      const components = [input.components[0], { ...input.components[1], appearance: appearanceFromPreset('glass') }, input.components[2]];
      const placements = new Map(input.components.map((component) => [component.id, placementAt(0)]));
      layer.update(buildAssemblyGeometry({ ...input, components, placements }), 'shadedWithEdges');
      expect(layer.pickComponent(rayAt(0.2))).toBe('component-1');
      layer.update(buildAssemblyGeometry({ ...input, components: [components[1], components[0], components[2]], placements }), 'shadedWithEdges');
      expect(layer.pickComponent(rayAt(0.2))).toBe('component-2');
      placements.set('component-3', { position: [0, 0, 2], rotation: IDENTITY_PLACEMENT.rotation });
      layer.update(buildAssemblyGeometry({ ...input, components, placements }), 'shadedWithEdges');
      expect(layer.pickComponent(rayAt(0.2))).toBe('component-3');
    } finally { layer.dispose(); }
  });

  it('大座標は原点を寄せ、double pick と実 Float32 配置の bounds を維持する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const origin = 100_000_000.125;
      const placements = new Map([['component-1', placementAt(origin)], ['component-2', placementAt(origin + 10.25)]]);
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      expect(face.count).toBe(2);
      expect(face.matrix.elements[12]).toBe(origin);
      expect(face.instanceMatrix.array[12]).toBe(0);
      expect(face.instanceMatrix.array[28]).toBe(10.25);
      expect(layer.pickComponent(rayAt(origin + 10.45))).toBe('component-2');
      const point = new THREE.Vector3(10.25, 0, 0);
      expect(face.boundingSphere?.containsPoint(point)).toBe(true);
      expect(edges.geometry.boundingSphere?.containsPoint(point)).toBe(true);
      expect(face.boundingBox?.containsPoint(point)).toBe(true);
      expect(edges.geometry.boundingBox?.containsPoint(point)).toBe(true);
    } finally { layer.dispose(); }
  });

  it('配置の移動直後に pick と面・稜線の bounds を更新し、非表示では bounds を縮める', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      const placements = new Map(input.placements);
      placements.set('component-2', { position: [1000, 10, 0], rotation: IDENTITY_PLACEMENT.rotation });
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      const point = new THREE.Vector3(1000, 10, 0);
      expect(face.boundingSphere?.containsPoint(point)).toBe(true);
      expect(edges.geometry.boundingSphere?.containsPoint(point)).toBe(true);
      expect(face.boundingBox?.containsPoint(point)).toBe(true);
      expect(edges.geometry.boundingBox?.containsPoint(point)).toBe(true);
      expect(layer.pickComponent(rayAt(1000.2, 10.2))).toBe('component-2');
      expect(layer.pickComponent(rayAt(10.2))).toBeNull();
      layer.update(buildAssemblyGeometry({ ...input, placements,
        components: [input.components[0], { ...input.components[1], visible: false }],
      }), 'shadedWithEdges');
      expect(face.boundingSphere?.radius).toBeLessThan(1);
      expect(edges.geometry.boundingSphere?.radius).toBeLessThan(1);
      expect(face.boundingBox?.max.x).toBe(1);
      expect(edges.geometry.boundingBox?.max.x).toBe(1);
      expect(layer.pickComponent(rayAt(1000.2, 10.2))).toBeNull();
    } finally { layer.dispose(); }
  });

  it('相対座標の丸めが幾何公差を超える部品は面・稜線とも double 個別配置へ退避する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const distant = 100_000_000.125;
      const placements = new Map([['component-1', placementAt(0)], ['component-2', placementAt(distant)]]);
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)[0].count).toBe(1);
      const face = layer.group.children.find((object) => isPartMesh(object) && !(object instanceof THREE.InstancedMesh));
      const edges = layer.group.children.find((object) => isPartEdges(object) && !(object.geometry instanceof THREE.InstancedBufferGeometry));
      expect(face?.matrix.elements[12]).toBe(distant);
      expect(edges?.matrix.elements[12]).toBe(distant);
      expect(layer.pickComponent(rayAt(distant + 0.2))).toBe('component-2');
    } finally { layer.dispose(); }
  });

  it.each([0, 1, 2])('整数の大座標でも第 %i 軸の頂点加算が丸まる箱は面・稜線とも個別配置する', (axis) => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const distant = new THREE.Vector3().setComponent(axis, 100_000_000);
      const placement: RigidPlacement = { position: distant.toArray(), rotation: IDENTITY_PLACEMENT.rotation };
      const bundle = buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [makeBoxBody()]]]),
        placements: new Map([['component-1', placementAt(0)], ['component-2', placement]]),
      });
      layer.update(bundle, 'shadedWithEdges');

      const matrix = new THREE.Matrix4().setPosition(distant);
      expect(matrix.elements.map(Math.fround)).toEqual(matrix.elements);
      const low = new THREE.Vector3().setComponent(axis, -10);
      const high = new THREE.Vector3().setComponent(axis, 10);
      const roundedWidth = float32Transform(high, matrix).getComponent(axis) - float32Transform(low, matrix).getComponent(axis);
      expect(roundedWidth).toBe(16);
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(1);
      const individuals = layer.group.children.filter((object) =>
        (isPartMesh(object) && !(object instanceof THREE.InstancedMesh))
        || (isPartEdges(object) && !(object.geometry instanceof THREE.InstancedBufferGeometry)));
      expect(individuals).toHaveLength(2);
      for (const object of individuals) {
        if (!isPartMesh(object) && !isPartEdges(object)) throw new Error('面か稜線ではありません。');
        expect(object.matrix.elements).toEqual(matrix.elements);
        // 個別描画は camera との減算を double の modelViewMatrix で先に行う。
        const modelView = new THREE.Matrix4().makeTranslation(-distant.x, -distant.y, -distant.z).multiply(object.matrix);
        const positions = object.geometry.getAttribute('position');
        const bounds = new THREE.Box3();
        for (let index = 0; index < positions.count; index += 1) {
          bounds.expandByPoint(float32Transform(new THREE.Vector3().fromBufferAttribute(positions, index), modelView));
        }
        expect(bounds.getSize(new THREE.Vector3()).toArray()).toEqual([20, 20, 20]);
        expect(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray()).toEqual([20, 20, 20]);
      }
      expect(layer.pickComponent(rayAt(distant.x + 9, distant.y + 9, distant.z + 20))).toBe('component-2');
      expect(layer.pickComponent(rayAt(distant.x + 11, distant.y, distant.z + 20))).toBeNull();
      layer.update({ ...bundle, instances: bundle.instances.map((draw) => draw.componentId === 'component-2'
        ? { ...draw, placement: placementAt(30) } : draw) }, 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(2);
      expect(layer.group.children).toHaveLength(2);
      expect(layer.pickComponent(rayAt(39, 9, 20))).toBe('component-2');
      expect(layer.pickComponent(rayAt(distant.x + 9, distant.y + 9, distant.z + 20))).toBe(axis === 2 ? 'component-1' : null);
    } finally { layer.dispose(); }
  });

  it('大座標近傍の 20mm 箱 2 個は共通原点へ寄せて面・稜線とも幅 20mm のバッチを維持する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const origin = 100_000_000.125;
      layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [makeBoxBody()]]]),
        placements: new Map([['component-1', placementAt(origin)], ['component-2', placementAt(origin + 30.25)]]),
      }), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0];
      const edges = firstEdges(layer);
      expect(face.count).toBe(2);
      expect(edges.geometry.instanceCount).toBe(2);
      expect(layer.group.children).toHaveLength(2);
      for (const object of [face, edges]) {
        expect(object.matrix.elements[12]).toBe(origin);
        const matrices = object instanceof THREE.InstancedMesh ? object.instanceMatrix : object.geometry.getAttribute('instanceMatrix');
        const positions = object.geometry.getAttribute('position');
        for (let slot = 0; slot < 2; slot += 1) {
          const matrix = new THREE.Matrix4().fromArray(matrices.array, slot * 16);
          const bounds = new THREE.Box3();
          for (let index = 0; index < positions.count; index += 1) {
            bounds.expandByPoint(float32Transform(new THREE.Vector3().fromBufferAttribute(positions, index), matrix));
          }
          expect(bounds.getSize(new THREE.Vector3()).toArray()).toEqual([20, 20, 20]);
        }
      }
      expect(layer.pickComponent(rayAt(origin + 39.25, 9, 20))).toBe('component-2');
      expect(face.boundingBox?.max.x).toBe(40.25);
      expect(edges.geometry.boundingBox?.max.x).toBe(40.25);
    } finally { layer.dispose(); }
  });

  it('大きな部品は回転の丸めも位置誤差として判定する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(1);
      const body = makeBody('large');
      const positions = body.mesh.positions.map((value) => value * 1000);
      const angle = Math.PI / 8;
      layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [{ ...body, mesh: { ...body.mesh, positions } }]]]),
        placements: new Map([['component-1', { position: [0, 0, 0], rotation: [0, 0, Math.sin(angle), Math.cos(angle)] }]]),
      }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)).toHaveLength(0);
      expect(layer.group.children.filter(isPartMesh)).toHaveLength(1);
      expect(layer.pickComponent(rayAt(0, 100))).toBe('component-1');
    } finally { layer.dispose(); }
  });

  it('回転係数が公差内でも Float32 の乗算で公差を超える形は退避する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(1);
      const size = Math.fround(1.322);
      const halfAngle = Math.PI / 16;
      const rotation: RigidPlacement['rotation'] = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
      const matrix = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().fromArray(rotation));
      const coefficients = matrix.elements;
      const coefficientError = Math.hypot(...[0, 1, 2].map((row) => size * (
        Math.abs(Math.fround(coefficients[row]) - coefficients[row])
        + Math.abs(Math.fround(coefficients[4 + row]) - coefficients[4 + row]))));
      expect(coefficientError).toBeLessThan(1e-7);
      const point = new THREE.Vector3(size, 0, 0);
      expect(float32Transform(point, matrix).distanceTo(point.clone().applyMatrix4(matrix))).toBeGreaterThan(1e-7);
      const body = makeBody('small');
      layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [{ ...body, mesh: { ...body.mesh,
          positions: body.mesh.positions.map((value) => value * size),
          edgePositions: body.mesh.edgePositions.map((value) => value * size),
        } }]]]),
        placements: new Map([['component-1', { position: [0, 0, 0], rotation }]]),
      }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)).toHaveLength(0);
      expect(layer.group.children.filter(isPartMesh)).toHaveLength(1);
      const edges = layer.group.children.filter(isPartEdges);
      expect(edges).toHaveLength(1);
      expect(edges[0].geometry).not.toBeInstanceOf(THREE.InstancedBufferGeometry);
      expect(layer.pickComponent(rayAt(0.2, 0.4))).toBe('component-1');
    } finally { layer.dispose(); }
  });

  it('1 通りの頂点加算は公差内でも加算順を変えると公差を超える配置を退避する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const halfAngle = Math.PI / 8;
      const rotation: RigidPlacement['rotation'] = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
      const matrix = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().fromArray(rotation)).setPosition(8, 0, 0);
      const point = new THREE.Vector3(Math.fround(0.01), Math.fround(0.02), 0);
      const exact = point.clone().applyMatrix4(matrix);
      expect(float32Transform(point, matrix).distanceTo(exact)).toBeLessThan(1e-7);
      const first = Math.fround(Math.fround(matrix.elements[0]) * point.x);
      const second = Math.fround(Math.fround(matrix.elements[4]) * point.y);
      const reorderedX = Math.fround(Math.fround(first + 8) + second);
      expect(Math.abs(reorderedX - exact.x)).toBeGreaterThan(1e-7);
      const body = makeBody('tiny');
      const positions = new Float32Array([0, 0, 0, 0.01, 0.02, 0, 0, 0.02, 0]);
      layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [{ ...body, mesh: { ...body.mesh, positions, edgePositions: positions } }]]]),
        placements: new Map([['component-1', placementAt(0)], ['component-2', { position: [8, 0, 0], rotation }]]),
      }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(1);
      expect(layer.group.children.filter(isPartMesh)).toHaveLength(2);
      expect(layer.group.children.filter(isPartEdges)).toHaveLength(2);
    } finally { layer.dispose(); }
  });

  it('2 個目のボディの稜線だけに小数頂点があっても部品全体を退避する', () => {
    const layer = createAssemblyLayer();
    try {
      const input = sameParts(2);
      const second = makeBody('second');
      layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [makeBody('first'), { ...second, mesh: { ...second.mesh,
          edgePositions: new Float32Array([0, 0, 0, 0.01, 0, 0]),
        } }]]]),
        placements: new Map([['component-1', placementAt(0)], ['component-2', placementAt(1_000_000)]]),
      }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1, 1]);
      const edges = layer.group.children.filter(isPartEdges);
      expect(edges.filter((edge) => edge.geometry instanceof THREE.InstancedBufferGeometry)).toHaveLength(2);
      expect(edges.filter((edge) => !(edge.geometry instanceof THREE.InstancedBufferGeometry))).toHaveLength(2);
      expect(layer.group.children.filter((object) => isPartMesh(object) && !(object instanceof THREE.InstancedMesh))).toHaveLength(2);
      expect(layer.pickComponent(rayAt(1_000_000.2))).toBe('component-2');
    } finally { layer.dispose(); }
  });

  it('配置の各軸・符号・回転が変われば判定を更新し、不正確な判定も表示変更では再走査しない', () => {
    const layer = createAssemblyLayer();
    try {
      const input = { ...sameParts(2), bodies: new Map([['part-1', [makeBoxBody()]]]) };
      const placements = new Map(input.placements);
      placements.set('component-2', placementAt(30));
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2]);
      for (const axis of [0, 1, 2]) {
        for (const sign of [-1, 1]) {
          const position = new THREE.Vector3().setComponent(axis, sign * 100_000_000);
          placements.set('component-2', { position: position.toArray(), rotation: IDENTITY_PLACEMENT.rotation });
          layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
          expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
          expect(firstEdges(layer).geometry.instanceCount).toBe(1);
          expect(layer.pickComponent(rayAt(position.x + 9, position.y + 9, position.z + 20))).toBe('component-2');
          const reads = vi.spyOn(THREE.BufferAttribute.prototype, 'getX');
          try {
            layer.update(buildAssemblyGeometry({ ...input, placements, hoveredComponentId: 'component-2' }), 'shaded');
            expect(reads.mock.calls.length).toBe(0);
          } finally { reads.mockRestore(); }
          placements.set('component-2', placementAt(30));
          layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
          expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2]);
          expect(firstEdges(layer).geometry.instanceCount).toBe(2);
          expect(layer.group.children).toHaveLength(2);
        }
      }
      placements.set('component-2', { position: [30, 0, 0], rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] });
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(1);
      placements.set('component-2', placementAt(30));
      layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(2);
    } finally { layer.dispose(); }
  });

  it('同じ配置で形・部品の鍵・原点が変わっても古い判定を使わず、削除した部品を再登録できる', () => {
    const layer = createAssemblyLayer();
    try {
      const input = { ...sameParts(2),
        placements: new Map([['component-1', placementAt(0)], ['component-2', placementAt(1_000_000)]]),
      };
      layer.update(buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBoxBody()]]]) }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([2]);
      const body = makeBody('small');
      const small = [{ ...body, mesh: { ...body.mesh,
        positions: body.mesh.positions.map((value) => value * 0.01),
        edgePositions: body.mesh.edgePositions.map((value) => value * 0.01),
      } }];
      const bodies = new Map([['part-1', small], ['part-2', small]]);
      const replaced = buildAssemblyGeometry({ ...input, bodies });
      layer.update(replaced, 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
      expect(firstEdges(layer).geometry.instanceCount).toBe(1);
      expect(layer.pickComponent(rayAt(1_000_000.002, 0.002))).toBe('component-2');
      const partKeys = new Map([['component-1', 'part-1'], ['component-2', 'part-2']]);
      layer.update(buildAssemblyGeometry({ ...input, bodies, partKeys }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1, 1]);
      expect(faceBatchesOf(layer)[1].matrix.elements[12]).toBe(1_000_000);
      expect(layer.group.children).toHaveLength(4);
      layer.update(replaced, 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
      layer.update(EMPTY_ASSEMBLY_GEOMETRY, 'shadedWithEdges');
      expect(layer.group.children).toHaveLength(0);
      // 同じ id・形・配置でも、登録し直した共通原点は先頭の部品の大座標になる。
      layer.update(buildAssemblyGeometry({ ...input, bodies, components: [...input.components].reverse() }), 'shadedWithEdges');
      expect(faceBatchesOf(layer).map((face) => face.count)).toEqual([1]);
      expect(faceBatchesOf(layer)[0].matrix.elements[12]).toBe(1_000_000);
      const individual = layer.group.children.find((object) => isPartMesh(object) && !(object instanceof THREE.InstancedMesh));
      expect(individual?.matrix.elements[12]).toBe(0);
      expect(layer.pickComponent(rayAt(0.002, 0.002))).toBe('component-1');
      expect(layer.pickComponent(rayAt(1_000_000.002, 0.002))).toBe('component-2');
    } finally { layer.dispose(); }
  });
});
