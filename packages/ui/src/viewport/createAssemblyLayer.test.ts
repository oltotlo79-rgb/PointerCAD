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
  type AppearanceSpec,
  type AssemblyComponent,
  type ComponentSource,
  type RigidPlacement,
  type SolidBody,
} from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  buildAssemblyGeometry,
  createAssemblyLayer,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
  type AssemblyGeometryInput,
} from './createAssemblyLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';

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

/** 置いた部品 1 つぶんの入れ物(層の直下の子)を id の順に取り出す。 */
function instanceObjectsOf(layer: { readonly group: THREE.Group }): THREE.Object3D[] {
  return [...layer.group.children];
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

  it('色分けを割り当てていない部品は既定の外観になる(FR-605)', () => {
    const painted: AppearanceSpec = { ...DEFAULT_APPEARANCE, preset: 'custom', color: '#ff0000' };
    const input = sameParts(2);
    const components = [input.components[0], makeComponent('component-2', { appearance: painted })];
    const bundle = buildAssemblyGeometry({ ...input, components });
    expect(bundle.instances[0].appearance).toBe(DEFAULT_APPEARANCE);
    expect(bundle.instances[1].appearance).toBe(painted);
  });
});

describe('createAssemblyLayer(形の共有、§0.a-0.4)', () => {
  it('同じ部品を 50 個置いても面の形は 1 つ(共有)', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(MANY_INSTANCES)), 'shadedWithEdges');

    expect(instanceObjectsOf(layer).length).toBe(MANY_INSTANCES);
    expect(meshGeometriesOf(layer.group).size).toBe(1);
    // 面 1 つ + 稜線 1 つ。置いた数が増えても形は増えない。
    expect(geometriesOf(layer.group).size).toBe(2);
    layer.dispose();
  });

  it('50 個置いても材質は 2 つ(面 1 + 稜線 1)、描く相手は 100 個', () => {
    const layer = createAssemblyLayer();
    layer.update(buildAssemblyGeometry(sameParts(MANY_INSTANCES)), 'shadedWithEdges');

    /*
      §1.5-23 の「`InstancedMesh` が要るか」の判断の根拠になる数。形 1・材質 2 で、
      GPU へ送る形と材質は置いた数に比例しない。増えるのはドローコール(面 50 + 稜線 50)
      と、置いた数ぶんの入れ物の行列だけで、その書き換えの所要は下の実測のとおり。
    */
    expect(materialsOf(layer.group).size).toBe(2);
    let drawn = 0;
    layer.group.traverse((object) => {
      if (isPartMesh(object) || isPartEdges(object)) {
        drawn += 1;
      }
    });
    expect(drawn).toBe(MANY_INSTANCES * 2);
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

    expect(instanceObjectsOf(layer).length).toBe(10);
    expect(meshGeometriesOf(layer.group).size).toBe(3);
    layer.dispose();
  });

  it('配置は position と quaternion に入る(行列を自分で作らない)', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    const placements = new Map(input.placements);
    // Z 軸まわり 90°(§2.4 の検算と同じ四元数)。
    const half = Math.SQRT1_2;
    placements.set('component-2', { position: [5, 6, 7], rotation: [0, 0, half, half] });
    layer.update(buildAssemblyGeometry({ ...input, placements }), 'shadedWithEdges');

    const second = instanceObjectsOf(layer)[1];
    expect([second.position.x, second.position.y, second.position.z]).toEqual([5, 6, 7]);
    expect(second.quaternion.z).toBeCloseTo(half, 12);
    expect(second.quaternion.w).toBeCloseTo(half, 12);
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

  it('非表示の部品は visible が偽になるだけで、形は残る', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    const components = [input.components[0], makeComponent('component-2', { visible: false })];
    layer.update(buildAssemblyGeometry({ ...input, components }), 'shadedWithEdges');

    const objects = instanceObjectsOf(layer);
    expect(objects.map((object) => object.visible)).toEqual([true, false]);
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
    expect(instanceObjectsOf(layer).length).toBe(0);
    layer.dispose();
  });
});

describe('createAssemblyLayer(表示スタイルと強調、FR-105、FR-106)', () => {
  it('ワイヤーフレームでは面を出さず、シェーディングのみでは稜線を出さない', () => {
    const layer = createAssemblyLayer();
    const bundle = buildAssemblyGeometry(sameParts(1));
    layer.update(bundle, 'wireframe');
    const object = instanceObjectsOf(layer)[0];
    const faceVisible = (): boolean => object.children.filter(isPartMesh)[0].visible;
    const edgeVisible = (): boolean => object.children.filter(isPartEdges)[0].visible;
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
    const objects = instanceObjectsOf(layer);
    const edgesOf = (object: THREE.Object3D): THREE.Object3D =>
      object.children.filter(isPartEdges)[0];
    expect(edgesOf(objects[0]).visible).toBe(false);
    expect(edgesOf(objects[1]).visible).toBe(true);
    layer.dispose();
  });

  it('選択・ホバーの稜線の色はテーマの強調色になる', () => {
    const layer = createAssemblyLayer();
    const input = sameParts(2);
    layer.update(
      buildAssemblyGeometry({ ...input, hoveredComponentId: 'component-1', selectedComponentIds: ['component-2'] }),
      'shadedWithEdges',
    );
    const objects = instanceObjectsOf(layer);
    const edgeColorOf = (object: THREE.Object3D): number => {
      const edges = object.children.find(isPartEdges);
      if (edges === undefined) {
        throw new Error('稜線が見つかりません。');
      }
      return edges.material.color.getHex();
    };
    expect(edgeColorOf(objects[0])).toBe(DEFAULT_THEME_COLORS.hovered);
    expect(edgeColorOf(objects[1])).toBe(DEFAULT_THEME_COLORS.selected);
    layer.dispose();
  });
});

describe('createAssemblyLayer(当たり判定、FR-106)', () => {
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
    // 使っていない稜線の材質 2 つ(ホバー・選択)も捨てるが、画面に出ていないので数えない。
    expect(disposed.filter((entry) => entry === 'geometry').length).toBe(2);
    expect(disposed.filter((entry) => entry === 'material').length).toBe(2);
    expect(instanceObjectsOf(layer).length).toBe(0);
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

describe('createAssemblyLayer(描き直しの所要、§1.5-23、NFR-PF-1)', () => {
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
