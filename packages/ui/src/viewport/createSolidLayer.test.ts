/**
 * ねじの簡略表示の印(§0.a-0.15)の線分を組み立てる純関数の検査
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク23)。
 *
 * `createSolidLayer()` 本体は three.js の入れ物を作るだけで DOM(canvas・WebGL)には
 * 触れないが、実際に描く判定(材質・renderOrder・当たり判定)は目視と E2E(タスク30)で
 * 確かめる方針(P2 タスク20 から続く決め方)なので、ここでは印の線分の座標を作る
 * `buildThreadMarkPositions` だけを検査する。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appearanceFromPreset,
  DEFAULT_APPEARANCE,
  type AppearanceEntry,
  type AppearanceSpec,
  type AppearanceTable,
  type PrintabilityReport,
  type ResolvedPlane,
  type SubShapeRef,
} from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import type { PatternTextureSource } from '../appearance/createAppearanceMaterial.js';
import { printabilityTriangleOffsets } from '../solid/printabilityColors.js';
import type { SolidFaceEntry } from '../solid/subShapeSelection.js';
import {
  buildSolidGeometry, type AppearanceInput, type SolidBodyWithSubShapes,
  type SolidDrawEntry, type SolidGeometryBundle,
} from './buildSolidGeometry.js';
import { buildSubShapeGeometry, subShapeOverlayBytes } from './buildSubShapeGeometry.js';
import {
  buildThreadMarkPositions,
  createSolidLayer,
  type ThreadMarkInfo,
} from './createSolidLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';
import { buildSphereGridPositions, type SphereGridSpec } from './buildSphereGrid.js';
import { ViewportResourceInitializationFailure } from './viewportLifetime.js';

/** 実測に使う球面の案内線(既定の 5°、半径 10 の球)。 */
const SPHERE_GRID_SPEC: SphereGridSpec = { center: [0, 0, 0], radius: 10, stepDegrees: 5 };

/** 5° の線分の本数(緯線 35 × 72 + 経線 72 × 72、計画書 §2.8.3)。 */
const SPHERE_GRID_SEGMENTS = 35 * 72 + 72 * 72;

/** 1 コマぶんの予算(60fps、NFR-PF-1)。 */
const FRAME_BUDGET_MS = 16;

/** 実測の平均を取る回数。1 回だけだと計測の揺れがそのまま出る。 */
const SPHERE_GRID_ROUNDS = 20;

/** 円 1 つ(48 分割)+ 軸線 1 本ぶんの数値の個数。 */
const FLOATS_PER_MARK = 48 * 6 * 2 + 6;

describe('buildThreadMarkPositions', () => {
  it('印が無ければ空になる', () => {
    expect(buildThreadMarkPositions([])).toEqual(new Float32Array(0));
  });

  it('円2本(48分割の折れ線)+軸線1本ぶんの線分を作る', () => {
    const mark: ThreadMarkInfo = {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      majorDiameter: 10,
      length: 20,
    };
    const positions = buildThreadMarkPositions([mark]);
    expect(positions.length).toBe(FLOATS_PER_MARK);

    // 始めの円(origin 中心、半径5)の最初の点。方位角0のとき、direction=(0,0,1) の
    // 基底は u=(0,-1,0)・v=(1,0,0)(参照軸(1,0,0)との外積)になるので、点は (0,-5,0)。
    expect(Array.from(positions.slice(0, 3))).toEqual([0, -5, 0]);

    // 終わりの円(origin + direction*length = (0,0,20) 中心)の最初の点も同じ向きにずれる。
    const secondCircleStart = 48 * 6;
    expect(Array.from(positions.slice(secondCircleStart, secondCircleStart + 3))).toEqual([
      0, -5, 20,
    ]);

    // 軸線(最後の6個)は origin → origin + direction*length。
    const axisStart = positions.length - 6;
    expect(Array.from(positions.slice(axisStart, axisStart + 6))).toEqual([0, 0, 0, 0, 0, 20]);
  });

  it('外径・長さが違う印を複数まとめて積む(印の数だけ長さが伸びる)', () => {
    const marks: ThreadMarkInfo[] = [
      { origin: [0, 0, 0], direction: [0, 0, 1], majorDiameter: 6, length: 10 },
      { origin: [5, 5, 0], direction: [1, 0, 0], majorDiameter: 8, length: 12 },
    ];
    const positions = buildThreadMarkPositions(marks);
    expect(positions.length).toBe(FLOATS_PER_MARK * 2);
  });

  it('向きが退化した(長さ0の)印は黙って飛ばす(NaN を作らない)', () => {
    const marks: ThreadMarkInfo[] = [
      { origin: [0, 0, 0], direction: [0, 0, 0], majorDiameter: 10, length: 20 },
      { origin: [1, 2, 3], direction: [0, 1, 0], majorDiameter: 4, length: 6 },
    ];
    const positions = buildThreadMarkPositions(marks);
    // 退化した1本目は積まれず、2本目ぶんだけになる。
    expect(positions.length).toBe(FLOATS_PER_MARK);
    expect(Array.from(positions).some((value) => Number.isNaN(value))).toBe(false);
  });
});

/*
 * ここから下は P5 タスク10(外観の材質配列化と配線、FR-1106〜1109)。
 *
 * `createSolidLayer()` は three.js の入れ物を作るだけで WebGL には触れないので、
 * 材質の配列・まとまり(`geometry.addGroup`)・資源の解放は Node のまま確かめられる。
 * 実際に「どう見えるか」(絵の同一性・fps)はヘッドレスの実測で確かめる方針。
 */

/** 面 1 枚 = 三角形 1 枚のボディを作る(まとまりの区切りを面の数で作れるようにする)。 */
function makeBody(featureId: string, faceCount: number): SolidBodyWithSubShapes {
  const indices = new Uint32Array(faceCount * 3);
  for (let position = 0; position < indices.length; position += 1) {
    indices[position] = position;
  }
  const normals = new Float32Array(faceCount * 9);
  for (let vertex = 0; vertex < faceCount * 3; vertex += 1) {
    normals[vertex * 3 + 2] = 1;
  }
  const faces: SolidFaceEntry[] = [];
  for (let face = 0; face < faceCount; face += 1) {
    faces.push({
      index: face,
      surfaceKind: 'plane',
      area: 1,
      centroid: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: face,
      triangleCount: 1,
    });
  }
  return {
    featureId,
    mesh: {
      positions: new Float32Array(faceCount * 9),
      normals,
      indices,
      edgePositions: new Float32Array(12),
      triangleCount: faceCount,
    },
    volume: 1,
    isValid: true,
    faces,
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 色だけを変えた外観(「自分で決める」相当)。 */
function coloredAppearance(color: string): AppearanceSpec {
  return { ...DEFAULT_APPEARANCE, preset: 'custom', color };
}

/** 面の指紋つきの参照(通し番号だけが要る検査なので、指紋の中身は最小にする)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

function tableOf(entries: AppearanceTable['entries']): AppearanceTable {
  return { entries };
}

/**
 * ボディの面のメッシュか(材質が配列のもの)。部分形状の重ね描きは材質が 1 つなので外れる。
 * 中身まで確かめてから絞り込むので、後の取り出しで型を偽らずに済む。
 */
function isBodyMesh(
  object: THREE.Object3D,
): object is THREE.Mesh<THREE.BufferGeometry, THREE.Material[]> {
  if (!(object instanceof THREE.Mesh)) {
    return false;
  }
  const material: unknown = object.material;
  return Array.isArray(material) && material.every((entry) => entry instanceof THREE.Material);
}

/** 層の中の「ボディの面」だけを取り出す。 */
function bodyMeshesOf(group: THREE.Object3D): THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>[] {
  return group.children.filter(isBodyMesh);
}

describe('createSolidLayer(local frameの表示とface pick)', () => {
  it.each(['add-before', 'add-after', 'remove-before', 'remove-after'] as const)(
    'restores actual overlay membership and retains failed new resources on publish %s', fault => {
      const layer = createSolidLayer(), old = makeBody('old-published', 1), next = makeBody('next-published', 1);
      const oldBundle = buildSubShapeGeometry([old], null, ['old-published#face:0']);
      layer.updateSubShapes(oldBundle);
      const children = [...layer.group.children];
      const oldOverlay = children.find((object): object is THREE.Group => object instanceof THREE.Group);
      if (oldOverlay === undefined) throw new Error('missing published overlay');
      const oldGeometries = oldOverlay.children.flatMap<THREE.BufferGeometry>(object => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points)) return [];
        const geometry: unknown = object.geometry;
        return geometry instanceof THREE.BufferGeometry ? [geometry] : [];
      });
      const originalAdd = layer.group.add.bind(layer.group), originalRemove = layer.group.remove.bind(layer.group);
      let refusePublish = true, refuseRelease = true;
      const add = vi.spyOn(layer.group, 'add').mockImplementation(function (...objects) {
        if (refusePublish && fault === 'add-before') throw new Error('publish add before mutation');
        originalAdd.apply(layer.group, objects);
        if (refusePublish && fault === 'add-after') throw new Error('publish add after mutation');
        return layer.group;
      });
      const remove = vi.spyOn(layer.group, 'remove').mockImplementation(function (...objects) {
        if (refusePublish && fault === 'remove-before') throw new Error('publish remove before mutation');
        originalRemove.apply(layer.group, objects);
        if (refusePublish && fault === 'remove-after') throw new Error('publish remove after mutation');
        return layer.group;
      });
      const failed: THREE.BufferGeometry[] = [];
      const release = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry) {
        if (oldGeometries.includes(this)) throw new Error('old published resource must survive failed publication');
        if (failed.length === 0) failed.push(this);
        if (this === failed[0] && refuseRelease) throw new Error('new candidate return refused');
      });
      try {
        const nextBundle = buildSubShapeGeometry([next], 'next-published#face:0', []);
        expect(() => layer.updateSubShapes(nextBundle)).toThrow('initialization failed');
        expect(layer.group.children).toEqual(children);
        expect(oldOverlay.parent).toBe(layer.group);
        expect(release).toHaveBeenCalledTimes(3);
        expect(release.mock.contexts.every(value => !oldGeometries.some(geometry => geometry === value))).toBe(true);
        expect(() => layer.meshBufferBytes()).toThrow('retained backing is unknown');
        refuseRelease = false; refusePublish = false;
        layer.updateSubShapes(buildSubShapeGeometry([old], null, ['old-published#face:0']));
        expect(layer.group.children).toEqual(children); // Actual old Map entry was restored, so no replacement group.
        expect(release).toHaveBeenCalledTimes(4); // Only failed new geometry retried.
        expect(release.mock.contexts.filter(value => value === failed[0])).toHaveLength(2);
      } finally { add.mockRestore(); remove.mockRestore(); release.mockRestore(); layer.dispose(); }
    });

  it.each([false, true])('restores existing overlay state and always cleans new assets (restore failure=%s)', failRestore => {
    const layer = createSolidLayer(), old = makeBody('existing-overlay', 1);
    layer.updateSubShapes(buildSubShapeGeometry([old], null, ['existing-overlay#face:0']));
    const children = [...layer.group.children];
    const group = children.find((object): object is THREE.Group => object instanceof THREE.Group);
    const face = group?.children.find((object): object is THREE.Mesh => object instanceof THREE.Mesh);
    if (group === undefined || face === undefined || !(face.geometry instanceof THREE.BufferGeometry)) throw new Error('missing existing overlay');
    const geometry = face.geometry, attribute = bufferAttribute(geometry, 'position');
    const array = attribute.array, version = attribute.version;
    const sphere = geometry.boundingSphere?.clone(), position = group?.position.toArray();
    const original = Reflect.get(THREE.BufferGeometry.prototype, 'computeBoundingSphere');
    const config = vi.spyOn(THREE.BufferGeometry.prototype, 'computeBoundingSphere').mockImplementation(function (this: THREE.BufferGeometry): void {
      original.call(this);
      if (this === geometry) throw new Error('existing overlay bound calculation refused');
    });
    const materialRelease = vi.spyOn(THREE.Material.prototype, 'dispose');
    const geometryRelease = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    let refuseRestore = failRestore;
    const copy = Reflect.get(THREE.Vector3.prototype, 'copy');
    const restore = vi.spyOn(THREE.Vector3.prototype, 'copy').mockImplementation(function (this: THREE.Vector3, value) {
      if (this === group.position && refuseRestore) throw new Error('overlay transform restoration refused');
      copy.call(this, value); return this;
    });
    try {
      const changed = { ...old, mesh: { ...old.mesh,
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) } };
      const hovered = makeBody('new-hover', 1);
      const bundle = buildSubShapeGeometry([changed, hovered], 'new-hover#face:0', ['existing-overlay#face:0']);
      expect(() => layer.updateSubShapes(bundle)).toThrow('initialization failed');
      expect(layer.group.children).toEqual(children);
      expect(bufferAttribute(geometry, 'position')).toBe(attribute);
      expect(attribute.array).toBe(array); expect(attribute.version).toBe(version);
      expect(geometry.boundingSphere).toEqual(sphere);
      expect(group?.position.toArray()).toEqual(position);
      expect(materialRelease).not.toHaveBeenCalled();
      expect(geometryRelease).toHaveBeenCalledTimes(3);
      if (failRestore) expect(() => layer.meshBufferBytes()).toThrow('retained backing is unknown');
      config.mockRestore(); refuseRestore = false; layer.updateSubShapes(bundle);
      expect(layer.group.children).toHaveLength(children.length + 1);
      layer.dispose();
    } finally { config.mockRestore(); restore.mockRestore(); geometryRelease.mockRestore(); materialRelease.mockRestore(); }
  });

  it('returns all actual overlay resources after a group configuration failure', () => {
    const add = Reflect.get(THREE.Group.prototype, 'add') as THREE.Group['add'];
    const configure = vi.spyOn(THREE.Group.prototype, 'add').mockImplementation(function (
      this: THREE.Group, ...objects: Parameters<THREE.Group['add']>
    ) { add.apply(this, objects); throw new Error('overlay group configuration refused'); });
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materials = vi.spyOn(THREE.Material.prototype, 'dispose');
    try {
      let failure: ViewportResourceInitializationFailure | null = null;
      try { createSolidLayer(); }
      catch (error) { if (error instanceof ViewportResourceInitializationFailure) failure = error; else throw error; }
      expect(failure).not.toBeNull();
      expect(failure?.cleanup.pendingCount).toBe(0);
      expect(geometries).toHaveBeenCalledTimes(3);
      expect(materials).toHaveBeenCalledTimes(6);
      expect(new Set(geometries.mock.contexts).size).toBe(3);
      expect(new Set(materials.mock.contexts).size).toBe(6);
      failure?.cleanup.dispose();
      expect(geometries).toHaveBeenCalledTimes(3);
      configure.mockRestore();
      const fresh = createSolidLayer(); fresh.dispose();
    } finally { configure.mockRestore(); geometries.mockRestore(); materials.mockRestore(); }
  });

  it('returns the acquired overlay geometry and earlier materials when its next material constructor throws', () => {
    const createPattern = vi.fn(() => null), disposePatterns = vi.fn();
    const patterns: PatternTextureSource = { create: createPattern, disposeAll: disposePatterns };
    const original = Reflect.get(THREE.MeshBasicMaterial.prototype, 'setValues');
    const refuse = vi.spyOn(THREE.MeshBasicMaterial.prototype, 'setValues').mockImplementation(() => {
      throw new Error('overlay material constructor refused');
    });
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materials = vi.spyOn(THREE.Material.prototype, 'dispose');
    try {
      let failure: ViewportResourceInitializationFailure | null = null;
      try { createSolidLayer(patterns); }
      catch (error) { if (error instanceof ViewportResourceInitializationFailure) failure = error; else throw error; }
      expect(failure).not.toBeNull();
      expect(failure?.cleanup.pendingCount).toBe(0);
      expect(geometries).toHaveBeenCalledTimes(1);
      expect(materials).toHaveBeenCalledTimes(3);
      expect(createPattern).not.toHaveBeenCalled();
      expect(disposePatterns).not.toHaveBeenCalled();
      failure?.cleanup.dispose();
      expect(geometries).toHaveBeenCalledTimes(1);
      expect(materials).toHaveBeenCalledTimes(3);
      refuse.mockRestore();
      expect(Reflect.get(THREE.MeshBasicMaterial.prototype, 'setValues') as unknown).toBe(original);
      const fresh = createSolidLayer(); fresh.dispose();
    } finally { refuse.mockRestore(); geometries.mockRestore(); materials.mockRestore(); }
  });

  it.each(['dispose', 'detach'] as const)('retains failed update %s while preserving old groups and borrowed overlay materials', kind => {
    const layer = createSolidLayer();
    const first = makeBody('old-overlay', 1), next = makeBody('new-overlay', 1);
    layer.updateSubShapes(buildSubShapeGeometry([first], null, ['old-overlay#face:0']));
    const children = [...layer.group.children];
    const materials = allMaterialsOf(layer.group);
    const materialRelease = vi.spyOn(THREE.Material.prototype, 'dispose');
    const attribute = Reflect.get(THREE.BufferGeometry.prototype, 'setAttribute');
    const config = vi.spyOn(THREE.BufferGeometry.prototype, 'setAttribute').mockImplementation(function (
      this: THREE.BufferGeometry, ...args: Parameters<typeof attribute>
    ) { attribute.apply(this, args); throw new Error('new overlay attribute refused'); });
    let refuseRelease = true;
    const original = Reflect.get(THREE.BufferGeometry.prototype, 'dispose');
    const released = new Set<THREE.BufferGeometry>();
    const geometryRelease = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry): void {
      if (kind === 'dispose' && refuseRelease) throw new Error('new overlay geometry return refused');
      expect(released.has(this)).toBe(false); released.add(this); original.call(this);
    });
    const deleteAttribute = Reflect.get(THREE.BufferGeometry.prototype, 'deleteAttribute');
    const detach = vi.spyOn(THREE.BufferGeometry.prototype, 'deleteAttribute').mockImplementation(function (
      this: THREE.BufferGeometry, name: Parameters<typeof deleteAttribute>[0],
    ) {
      if (kind === 'detach' && refuseRelease) throw new Error('new overlay backing detach refused');
      return deleteAttribute.call(this, name);
    });
    try {
      expect(() => layer.updateSubShapes(buildSubShapeGeometry([next], null, ['new-overlay#face:0']))).toThrow();
      expect(layer.group.children).toEqual(children);
      expect(materialRelease).not.toHaveBeenCalled();
      expect(() => layer.meshBufferBytes()).toThrow('retained backing is unknown');
      config.mockRestore(); refuseRelease = false;
      layer.updateSubShapes(buildSubShapeGeometry([first], null, ['old-overlay#face:0']));
      expect(layer.group.children).toEqual(children);
      for (const material of materials) expect(materialRelease.mock.contexts).not.toContain(material);
      layer.dispose(); layer.dispose();
      for (const material of materials) expect(materialRelease.mock.contexts.filter(context => context === material)).toHaveLength(1);
    } finally { config.mockRestore(); detach.mockRestore(); geometryRelease.mockRestore(); materialRelease.mockRestore(); }
  });

  it('uses the same local UV phase for map and alphaMap and disposes owned resources once', () => {
    const source = makeBody('patterned', 1);
    const positions = Float32Array.from([19.99, 0, 0, 20.01, 0, 0, 19.99, 1, 0]);
    const body: SolidBodyWithSubShapes = { ...source,
      mesh: { ...source.mesh, positions },
      coordinateFrame: { space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.01 },
    };
    const preset = appearanceFromPreset('expandedMetal');
    if (preset.pattern.kind === 'none') throw new Error('expected patterned preset');
    const patterned: AppearanceSpec = { ...preset, pattern: {
      ...preset.pattern, spacing: expressionValueFromNumber(20),
    } };
    const appearance: AppearanceInput = { defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['patterned', { bodyAppearance: patterned, faceAppearances: new Map() }]]),
    };
    let sourceDisposals = 0;
    const patterns: PatternTextureSource = {
      create: () => ({ texture: new THREE.Texture(), alphaTexture: new THREE.Texture() }),
      disposeAll: () => { sourceDisposals += 1; },
    };
    const layer = createSolidLayer(patterns);
    const bundle = buildSolidGeometry([body], null, [], appearance);
    layer.update(bundle, 'shadedWithEdges');
    const mesh = bodyMeshesOf(layer.group)[0];
    const material = mesh.material[0];
    if (!(material instanceof THREE.MeshStandardMaterial)) throw new Error('missing patterned material');
    const uv: unknown = mesh.geometry.getAttribute('uv');
    if (!(uv instanceof THREE.BufferAttribute)) throw new Error('missing patterned uv');
    expect(uv.array).toBe(bundle.entries[0].uv);
    expect(Math.abs((Number(uv.array[0]) + Number(uv.array[2])) / 2 - 20)).toBeLessThan(2e-5);
    if (patterned.pattern.kind === 'none') throw new Error('expected patterned preset');
    expect(material.map?.repeat.x).toBe(1 / patterned.pattern.spacing.value);
    expect(material.alphaMap?.repeat.x).toBe(material.map?.repeat.x);
    let geometryDisposals = 0;
    let mapDisposals = 0;
    let alphaDisposals = 0;
    mesh.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
    material.map?.addEventListener('dispose', () => { mapDisposals += 1; });
    material.alphaMap?.addEventListener('dispose', () => { alphaDisposals += 1; });
    layer.update(buildSolidGeometry([], null, []), 'shadedWithEdges');
    layer.dispose();
    expect(geometryDisposals).toBe(1);
    expect(mapDisposals).toBe(1);
    expect(alphaDisposals).toBe(1);
    expect(sourceDisposals).toBe(1);
    expect(positions[0]).toBe(Math.fround(19.99));
  });
  it('reuses body overlay groups, applies section/theme and disposes stale geometry once', () => {
    const layer = createSolidLayer();
    const makeFramed = (id: string, x: number): SolidBodyWithSubShapes => ({
      ...makeBody(id, 1),
      coordinateFrame: { space: 'local', origin: [x, 0, 0], maximumFloat32ErrorMm: 0.001 },
      vertices: [{ index: 0, position: [x + 0.125, 0, 0] }],
    });
    const first = makeFramed('a', 1e9);
    const second = makeFramed('b', -1e9);
    const active = buildSubShapeGeometry([first, second], null, ['a#vertex:0', 'b#vertex:0']);
    const groups = (): THREE.Group[] => layer.group.children.filter((child): child is THREE.Group =>
      child instanceof THREE.Group && child.children.some((entry) => entry instanceof THREE.Points));
    layer.updateSubShapes(active);
    expect(groups().map((entry) => entry.position.x)).toEqual([1e9, -1e9]);
    const firstGroup = groups()[0];
    const firstPoints = firstGroup.children.find((entry): entry is THREE.Points => entry instanceof THREE.Points);
    if (firstPoints === undefined || !(firstPoints.geometry instanceof THREE.BufferGeometry)) {
      throw new Error('missing overlay points geometry');
    }
    const pointPosition: unknown = firstPoints.geometry.getAttribute('position');
    if (!(pointPosition instanceof THREE.BufferAttribute)) throw new Error('missing overlay points position');
    expect([...pointPosition.array]).toEqual([0.125, 0, 0]);
    const geometry = firstPoints.geometry;
    const material = firstPoints.material;
    if (!(material instanceof THREE.PointsMaterial)) throw new Error('unexpected overlay points material');
    let geometryDisposals = 0;
    let materialDisposals = 0;
    geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
    material.addEventListener('dispose', () => { materialDisposals += 1; });
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -1e9);
    layer.setSectionPlanes([plane]);
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, selected: 0x123456 });
    expect(material.clippingPlanes?.[0]).toBe(plane);
    expect(material.color.getHex()).toBe(0x123456);
    for (let cycle = 0; cycle < 100; cycle += 1) {
      layer.updateSubShapes(buildSubShapeGeometry([first, second], null, ['a#vertex:0', 'b#vertex:0']));
      expect(groups()[0]).toBe(firstGroup);
    }
    layer.updateSubShapes(buildSubShapeGeometry([second], null, ['b#vertex:0']));
    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toBe(0);
    layer.updateSubShapes(buildSubShapeGeometry([], null, []));
    expect(groups()).toHaveLength(0);
    layer.updateSubShapes(buildSubShapeGeometry([first], null, ['a#vertex:0']));
    layer.dispose();
    expect(materialDisposals).toBe(1);
  });
  it('同じdouble originを面と稜線に置き、render前のRaycasterもworldで当てる', () => {
    for (const x of [0, 1e6, -1e9]) {
      const source = makeBody('face', 1);
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const edges = new Float32Array([0, 0, 0, 1, 0, 0]);
      const body: SolidBodyWithSubShapes = {
        ...source,
        mesh: { ...source.mesh, positions, edgePositions: edges },
        coordinateFrame: {
          space: 'local', origin: [x, 2, -3], maximumFloat32ErrorMm: 0.01,
        },
      };
      const layer = createSolidLayer();
      layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges');
      const mesh = bodyMeshesOf(layer.group)[0];
      const line = layer.group.children.find((child) => {
        if (!(child instanceof THREE.LineSegments)
          || !(child.geometry instanceof THREE.BufferGeometry)) return false;
        const linePosition: unknown = child.geometry.getAttribute('position');
        return linePosition instanceof THREE.BufferAttribute && linePosition.array === edges;
      });
      expect(line).toBeInstanceOf(THREE.LineSegments);
      expect(mesh.position.toArray()).toEqual([x, 2, -3]);
      expect(line?.position.toArray()).toEqual([x, 2, -3]);
      const meshPosition: unknown = mesh.geometry.getAttribute('position');
      if (!(meshPosition instanceof THREE.BufferAttribute)) throw new Error('missing body position');
      expect(meshPosition.array).toBe(positions);
      const ray = new THREE.Raycaster(new THREE.Vector3(x + 0.25, 2.25, 7), new THREE.Vector3(0, 0, -1));
      expect(layer.pickFace(ray)).toEqual({ featureId: 'face', triangleIndex: 0 });
      layer.dispose();
    }
  });

  it('同じlocal配列のままoriginが変わっても面と稜線の位置を更新する', () => {
    const source = makeBody('face', 1);
    const frame = { space: 'local' as const, origin: [1e6, 0, 0] as const, maximumFloat32ErrorMm: 0.01 };
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([{ ...source, coordinateFrame: frame }], null, []), 'shadedWithEdges');
    const mesh = bodyMeshesOf(layer.group)[0];
    const positions = mesh.geometry.getAttribute('position');
    layer.update(buildSolidGeometry([{
      ...source, coordinateFrame: { ...frame, origin: [-1e9, 0, 0] },
    }], null, []), 'shadedWithEdges');
    expect(mesh.position.x).toBe(-1e9);
    expect(mesh.geometry.getAttribute('position').array).toBe(positions.array);
    layer.update(buildSolidGeometry([source], null, []), 'shadedWithEdges');
    expect(mesh.position.toArray()).toEqual([0, 0, 0]);
    layer.dispose();
  });

  it('reports one buffer per uploaded mesh attribute, through alias, same-length swap, resize and disposal', () => {
    const entryBytes = (bundle: SolidGeometryBundle): number => bundle.entries.reduce((sum, entry) => sum
      + entry.positions.byteLength + entry.normals.byteLength + entry.uv.byteLength
      + entry.indices.byteLength + entry.edgePositions.byteLength, 0);
    const layer = createSolidLayer();
    expect(layer.meshBufferBytes()).toBe(0);
    const body = makeBody('gpu', 2);
    const bundle = buildSolidGeometry([body], null, []);
    layer.update(bundle, 'shadedWithEdges');
    // positions 72 + normals 72 + UV 48 + indices 24 + edges 48.
    expect(layer.meshBufferBytes()).toBe(264);
    expect(entryBytes(bundle)).toBe(264);
    const overlay = buildSubShapeGeometry([body], 'gpu#face:1', ['gpu#face:0']);
    layer.updateSubShapes(overlay);
    expect(layer.meshBufferBytes()).toBe(264 + subShapeOverlayBytes(overlay));
    // One CPU array used by two attributes is still two GPU buffers.
    const shared = new Float32Array(body.mesh.positions.length);
    const aliased = buildSolidGeometry([{ ...body, mesh: { ...body.mesh, positions: shared, normals: shared } }], null, []);
    layer.update(aliased, 'shadedWithEdges');
    expect(layer.meshBufferBytes()).toBe(entryBytes(aliased) + subShapeOverlayBytes(overlay));
    expect(entryBytes(aliased)).toBe(264);
    const larger = buildSolidGeometry([makeBody('gpu', 4)], null, []);
    layer.update(larger, 'shadedWithEdges');
    layer.updateSubShapes(buildSubShapeGeometry([], null, []));
    expect(layer.meshBufferBytes()).toBe(entryBytes(larger));
    layer.update(buildSolidGeometry([], null, []), 'shadedWithEdges');
    expect(layer.meshBufferBytes()).toBe(0);
    layer.dispose();
  });
});

/*
 * `buildAppearanceInput`(文書の割り当て → 組み立てへ渡す一式)そのものの検査は、
 * 関数の移設(P5 タスク11)に合わせて `appearance/appearanceCommands.test.ts` へ移した。
 * ここでは、その結果を流し込んだ層の見え方(材質の配列・まとまり・資源の解放)を確かめる。
 */

describe('createSolidLayer(材質の配列とまとまり、FR-1106)', () => {
  it('外観を 1 つも割り当てていないときは、材質 1 つ・まとまり 1 つ・P2 と同じ色になる', () => {
    const layer = createSolidLayer();
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, []);
    layer.update(bundle, 'shadedWithEdges', null);

    const meshes = bodyMeshesOf(layer.group);
    expect(meshes.length).toBe(1);
    const material = meshes[0].material[0];
    expect(meshes[0].material.length).toBe(1);
    expect(meshes[0].geometry.groups.length).toBe(1);
    expect(meshes[0].geometry.groups[0]).toMatchObject({ start: 0, count: 18, materialIndex: 0 });
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    // P2〜P4 の faceMaterial と同じ値(§0.a-0.12「1 ドットも変えない」)。
    expect(material.color.getHex()).toBe(DEFAULT_THEME_COLORS.solid);
    expect(material.roughness).toBeCloseTo(0.55, 10);
    expect(material.metalness).toBeCloseTo(0.05, 10);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(1);
    expect(material.polygonOffsetUnits).toBe(1);
    expect(material.transparent).toBe(false);
    layer.dispose();
  });

  it('柄のための箱投影 UV を 2 個組の属性として流し込む(FR-1108)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 2);
    const bundle = buildSolidGeometry([body], null, []);
    layer.update(bundle, 'shadedWithEdges', null);

    const uv = bodyMeshesOf(layer.group)[0].geometry.getAttribute('uv');
    expect(uv.itemSize).toBe(2);
    expect(uv.count).toBe(body.mesh.positions.length / 3);
    layer.dispose();
  });

  it('同じ束を 2 回渡してもまとまりも材質も作り直さない', () => {
    const layer = createSolidLayer();
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, []);
    layer.update(bundle, 'shadedWithEdges', null);
    const mesh = bodyMeshesOf(layer.group)[0];
    const groups = mesh.geometry.groups;
    const materials = mesh.material;

    layer.update(bundle, 'shadedWithEdges', null);
    // clearGroups() は毎回新しい配列を作るので、同一参照なら 1 回も呼ばれていない。
    expect(mesh.geometry.groups).toBe(groups);
    expect(mesh.material).toBe(materials);
    layer.dispose();
  });

  it('ホバーが変わって組み立て直しても、まとまりと材質はそのまま(毎コマ作り直さない)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 6);
    layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges', null);
    const mesh = bodyMeshesOf(layer.group)[0];
    const groups = mesh.geometry.groups;
    const materials = mesh.material;

    // ホバーだけが変わった束(中身は同じまとまり・同じ外観)。
    layer.update(buildSolidGeometry([body], 'extrude-1', []), 'shadedWithEdges', null);
    expect(mesh.geometry.groups).toBe(groups);
    expect(mesh.material).toBe(materials);
    layer.dispose();
  });

  it('面 1 枚へ別の色を割り当てると、材質が 2 つ・まとまりが 2 つ以上になる', () => {
    const layer = createSolidLayer();
    const red = coloredAppearance('#d94f4f');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 2) }, appearance: red },
      ]),
      [],
    );
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', 6)], null, [], input),
      'shadedWithEdges',
      null,
    );

    const mesh = bodyMeshesOf(layer.group)[0];
    expect(mesh.material.length).toBe(2);
    expect(mesh.geometry.groups.length).toBeGreaterThanOrEqual(2);
    // まとまりは索引の全体をちょうど覆う(three の addGroup の約束)。
    const covered = mesh.geometry.groups.reduce((total, group) => total + group.count, 0);
    expect(covered).toBe(18);
    const painted = mesh.material[1];
    if (!(painted instanceof THREE.MeshStandardMaterial)) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    expect(painted.color.getHex()).toBe(0xd94f4f);
    layer.dispose();
  });

  it('外観だけを変えても、三角形の並びは同じものを指したままになる(形を作り直さない)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 6);
    layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges', null);
    const mesh = bodyMeshesOf(layer.group)[0];
    const positions = mesh.geometry.getAttribute('position');

    const input = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-1', 0) },
          appearance: coloredAppearance('#4f7ad9'),
        },
      ]),
      [],
    );
    layer.update(buildSolidGeometry([body], null, [], input), 'shadedWithEdges', null);
    expect(mesh.geometry.getAttribute('position')).toBe(positions);
    expect(mesh.material.length).toBe(2);
    layer.dispose();
  });

  it('材質が上限(8 種)を超える割り当てでは、止めずに既定 1 色へ落とす', () => {
    const layer = createSolidLayer();
    const colors = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999'];
    const entries: AppearanceEntry[] = colors.map((color, face) => ({
      id: `appearance-${String(face)}`,
      target: { kind: 'face', ref: faceRef('extrude-1', face) },
      appearance: coloredAppearance(color),
    }));
    const input = buildAppearanceInput(tableOf(entries), []);
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', colors.length)], null, [], input),
      'shadedWithEdges',
      null,
    );

    const mesh = bodyMeshesOf(layer.group)[0];
    expect(mesh.material.length).toBe(1);
    expect(mesh.geometry.groups.length).toBe(1);
    layer.dispose();
  });

  it('テーマを変えると既定の外観の色だけが塗り替わる(FR-908)', () => {
    const layer = createSolidLayer();
    const red = coloredAppearance('#d94f4f');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 0) }, appearance: red },
      ]),
      [],
    );
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, [], input);
    layer.update(bundle, 'shadedWithEdges', null);

    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, solid: 0x9ea6b4 });
    layer.update(bundle, 'shadedWithEdges', null);

    const mesh = bodyMeshesOf(layer.group)[0];
    const [base, painted] = mesh.material;
    if (
      !(base instanceof THREE.MeshStandardMaterial) ||
      !(painted instanceof THREE.MeshStandardMaterial)
    ) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    expect(base.color.getHex()).toBe(0x9ea6b4);
    // 利用者が選んだ色はテーマで塗り替えない。
    expect(painted.color.getHex()).toBe(0xd94f4f);
    layer.dispose();
  });

  it('環境マップを渡すと材質へ入り、null に戻すと外れる(FR-1107)', () => {
    const layer = createSolidLayer();
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, []);
    const environment = new THREE.Texture();
    layer.update(bundle, 'shadedWithEdges', environment);
    const mesh = bodyMeshesOf(layer.group)[0];
    const material = mesh.material[0];
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    expect(material.envMap).toBe(environment);

    layer.update(bundle, 'shadedWithEdges', null);
    expect(material.envMap).toBe(null);
    environment.dispose();
    layer.dispose();
  });

  it('使われなくなった材質を捨てる(WebGL の資源を漏らさない)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 6);
    const input = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-1', 0) },
          appearance: coloredAppearance('#d94f4f'),
        },
      ]),
      [],
    );
    layer.update(buildSolidGeometry([body], null, [], input), 'shadedWithEdges', null);
    const painted = bodyMeshesOf(layer.group)[0].material[1];
    let disposed = false;
    painted.addEventListener('dispose', () => {
      disposed = true;
    });

    // 割り当てを外した束を渡すと、その材質はもう使われない。
    layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges', null);
    expect(disposed).toBe(true);
    layer.dispose();
  });

  it('dispose() で残っている材質もすべて捨てる', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges', null);
    const material = bodyMeshesOf(layer.group)[0].material[0];
    let disposed = false;
    material.addEventListener('dispose', () => {
      disposed = true;
    });

    layer.dispose();
    expect(disposed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 球面の案内線(球面グリッド、FR-431、P5 タスク21)
 * ------------------------------------------------------------------ */

/**
 * 層の中の「球面の案内線」の線分。色が方眼の主線(`gridMajor`)であることで見分ける。
 * ねじの印・切断の予告・部分形状の重ね描きは別の色なので取り違えない。
 */
type SphereGridLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/**
 * 球面の案内線の線分か。中身まで確かめてから絞り込むので、後の取り出しで型を偽らずに済む
 * (`isBodyMesh` と同じ作り)。
 */
function isSphereGridLines(object: THREE.Object3D): object is SphereGridLines {
  if (!(object instanceof THREE.LineSegments)) {
    return false;
  }
  const material: unknown = object.material;
  return (
    material instanceof THREE.LineBasicMaterial &&
    material.color.getHex() === DEFAULT_THEME_COLORS.gridMajor
  );
}

/** 見つからなければ検査を止める(戻り値の絞り込みを兼ねる)。 */
function requireSphereGridLines(group: THREE.Object3D): SphereGridLines {
  const found = group.children.find(isSphereGridLines);
  if (found === undefined) {
    throw new Error('球面の案内線の入れ物が見つかりません。');
  }
  return found;
}

describe('createSolidLayer の球面の案内線(FR-431、タスク21)', () => {
  it('線分を渡すと出て、null で消える(球を選んでいる間だけ出す土台)', () => {
    const layer = createSolidLayer();
    const lines = requireSphereGridLines(layer.group);
    // 何も渡していない間は出ていない(球が 1 つも無い文書では費用ゼロ)。
    expect(lines.visible).toBe(false);

    layer.updateSphereGrid(buildSphereGridPositions(SPHERE_GRID_SPEC));
    expect(lines.visible).toBe(true);
    expect(lines.geometry.getAttribute('position').count).toBe(SPHERE_GRID_SEGMENTS * 2);

    layer.updateSphereGrid(null);
    expect(lines.visible).toBe(false);
    layer.dispose();
  });

  it('同じ並び(同一参照)を渡し直すと入れ物を 1 つも触らない(NFR-PF-1)', () => {
    const layer = createSolidLayer();
    const positions = buildSphereGridPositions(SPHERE_GRID_SPEC);
    layer.updateSphereGrid(positions);
    const lines = requireSphereGridLines(layer.group);
    const attribute = lines.geometry.getAttribute('position');
    const sphere = lines.geometry.boundingSphere;

    layer.updateSphereGrid(positions);
    expect(lines.geometry.getAttribute('position')).toBe(attribute);
    expect(lines.geometry.boundingSphere).toBe(sphere);
    layer.dispose();
  });

  it('案内線の色はホバー・選択のどちらとも違う(見分けられる、2026-09-03 20:40 ①(b))', () => {
    const layer = createSolidLayer();
    const lines = requireSphereGridLines(layer.group);
    expect(lines.material.color.getHex()).not.toBe(DEFAULT_THEME_COLORS.hovered);
    expect(lines.material.color.getHex()).not.toBe(DEFAULT_THEME_COLORS.selected);
    // 案内であることが分かるよう、形そのものより控えめに出す。
    expect(lines.material.transparent).toBe(true);
    expect(lines.material.opacity).toBeLessThan(1);
    // 球の裏側の線は手前の面に隠れてよい(§0.a-0.21 の手順2)。
    expect(lines.material.depthTest).toBe(true);
    layer.dispose();
  });

  it('テーマを変えると案内線の色も塗り替わる(FR-908。部品は作り直さない)', () => {
    const layer = createSolidLayer();
    const lines = requireSphereGridLines(layer.group);
    const material = lines.material;
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, gridMajor: 0x123456 });
    expect(material.color.getHex()).toBe(0x123456);
    // 部品も材質も作り直さない(同じ入れ物・同じ材質のまま色だけが変わる)。
    expect(layer.group.children).toContain(lines);
    layer.dispose();
  });

  /**
   * §1.5-13 の実測。**5° の案内線(7,704 本)を出し入れする所要**を測る。
   *
   * 上限は 1 コマぶんの予算 16ms(NFR-PF-1 の 60fps)。案内線は球を選んだ瞬間と
   * 間隔を変えたときにしか作り直さない(同じ内容なら `createViewportScene` が
   * 組み立てそのものを省く)ので、この 1 回が 1 コマに収まれば 60fps を割らない。
   */
  it('5° の案内線の組み立てと流し込みが 1 コマ(16ms)に収まる(NFR-PF-1、§1.5-13)', () => {
    const layer = createSolidLayer();
    // 計り始める前に 1 回通して、初回だけの入れ物作りを外へ出す。
    layer.updateSphereGrid(buildSphereGridPositions(SPHERE_GRID_SPEC));

    const started = performance.now();
    for (let round = 0; round < SPHERE_GRID_ROUNDS; round += 1) {
      // 半径を変えた並びを毎回作り直す(球を選び直したときと同じ手間)。
      layer.updateSphereGrid(
        buildSphereGridPositions({ ...SPHERE_GRID_SPEC, radius: 10 + round }),
      );
    }
    const elapsed = (performance.now() - started) / SPHERE_GRID_ROUNDS;
    console.log(
      `[実測] 球面の案内線(5°・線分 ${String(SPHERE_GRID_SEGMENTS)} 本)の更新: ${elapsed.toFixed(3)} ms`,
    );
    process.stdout.write(`[W19 measure] sphereSegments=${SPHERE_GRID_SEGMENTS} rounds=${SPHERE_GRID_ROUNDS} averageMs=${elapsed.toFixed(6)} frameBudgetMs=${FRAME_BUDGET_MS} practicalLimitMs=100\n`);
    expectWithinBudget(elapsed, FRAME_BUDGET_MS, '球面の案内線の更新');
    layer.dispose();
  });
});

/*
 * ここから下は P6 タスク35(ビューの断面表示の配線とつまみ、FR-111、§2.12)。
 *
 * `THREE.Plane` を材質へ配るところまでは WebGL に触れないので Node で確かめられる。
 * **実際に画素が切り取られるか**(ガラス `transmission > 0` の別パスを含む)は
 * 目視と E2E に回す(§1.5-20、タスク44)。
 */

/**
 * 材質か(型を偽らずに絞り込むための番人。`isBodyMesh` と同じ流儀で、
 * 述語の戻り型に既定の型引数を書いて `any` を持ち込まない)。
 */
function isMaterial(value: unknown): value is THREE.Material {
  return value instanceof THREE.Material;
}

/** 層の中にあるすべての材質(同じ材質は 1 回だけ)。 */
function allMaterialsOf(group: THREE.Object3D): THREE.Material[] {
  const collected = new Set<THREE.Material>();
  group.traverse((object) => {
    const material: unknown = Reflect.get(object, 'material');
    if (Array.isArray(material)) {
      for (const entry of material) {
        if (isMaterial(entry)) {
          collected.add(entry);
        }
      }
    } else if (isMaterial(material)) {
      collected.add(material);
    }
  });
  return [...collected];
}

/** メッシュの頂点の数(メッシュでなければ null)。つまみの四角(6 頂点)を見分けるのに使う。 */
function meshVertexCount(object: THREE.Object3D): number | null {
  if (!(object instanceof THREE.Mesh)) {
    return null;
  }
  const geometry: unknown = object.geometry;
  if (!(geometry instanceof THREE.BufferGeometry)) {
    return null;
  }
  const position: unknown = geometry.getAttribute('position');
  return position instanceof THREE.BufferAttribute ? position.count : null;
}

/**
 * 断面表示を配らない材質の数。切断の予告(四角と矢印)と断面表示のつまみ(四角と矢印)の
 * **4 つだけ**が対象外(どちらも平面の上に出るので、自分の切る面で消えてはいけない)。
 */
const UNCLIPPED_MATERIAL_COUNT = 4;

/** つまみを出す平面(XY 面、原点)。`sectionView.ts` の検証表と同じ面。 */
const SECTION_HANDLE_PLANE: ResolvedPlane = {
  origin: [0, 0, 0],
  axisU: [1, 0, 0],
  axisV: [0, 1, 0],
  normal: [0, 0, 1],
};

describe('createSolidLayer(断面表示のクリッピング、FR-111)', () => {
  it('切っているあいだは平面が 1 枚も無い(費用ゼロ、NFR-PF-1)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    for (const mesh of bodyMeshesOf(layer.group)) {
      for (const material of mesh.material) {
        expect(material.clippingPlanes).toEqual([]);
      }
    }
    layer.dispose();
  });

  it('入れると、立体を描く全材質へ同じ 1 枚が配られる(数を数える)', () => {
    const layer = createSolidLayer();
    const bodies = [makeBody('extrude-1', 2), makeBody('extrude-2', 3)];
    layer.update(buildSolidGeometry(bodies, null, []), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    layer.setSectionPlanes([plane]);

    const materials = allMaterialsOf(layer.group);
    const clipped = materials.filter(
      (material) => material.clippingPlanes !== null && material.clippingPlanes.length === 1,
    );
    const untouched = materials.filter((material) => material.clippingPlanes === null);
    // 予告とつまみの 4 つ以外は、1 つ残らず配られている。
    expect(untouched).toHaveLength(UNCLIPPED_MATERIAL_COUNT);
    expect(clipped).toHaveLength(materials.length - UNCLIPPED_MATERIAL_COUNT);
    // 配られたのは**同じ 1 枚**(平面を動かすと全材質へ一度に効く)。
    for (const material of clipped) {
      expect(material.clippingPlanes?.[0]).toBe(plane);
    }
    layer.dispose();
  });

  it('ボディが増えても、新しく作られた材質へ配り直す(配り漏らさない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -5);
    layer.setSectionPlanes([plane]);
    // 外観を割り当てて材質を新しく作らせる(P5 の材質の Map を通る道)。
    const appearance = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-2', 0) },
          appearance: coloredAppearance('#ff0000'),
        },
      ]),
      [],
    );
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', 2), makeBody('extrude-2', 3)], null, [], appearance),
      'shadedWithEdges',
    );
    for (const mesh of bodyMeshesOf(layer.group)) {
      for (const material of mesh.material) {
        expect(material.clippingPlanes?.[0]).toBe(plane);
      }
    }
    layer.dispose();
  });

  it('切ると空へ戻る(元の見た目に戻り、費用もゼロへ戻る)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.setSectionPlanes([new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]);
    layer.setSectionPlanes([]);
    for (const mesh of bodyMeshesOf(layer.group)) {
      for (const material of mesh.material) {
        expect(material.clippingPlanes).toEqual([]);
      }
    }
    layer.dispose();
  });

  it('入れても三角形も稜線も 1 つも変わらない(形を切らない、FR-111)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 3)], null, []), 'shadedWithEdges');
    const [mesh] = bodyMeshesOf(layer.group);
    const before = mesh.geometry.getAttribute('position');
    const beforeIndex = mesh.geometry.getIndex();
    layer.setSectionPlanes([new THREE.Plane(new THREE.Vector3(0, 0, 1), -1)]);
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    expect(mesh.geometry.getAttribute('position')).toBe(before);
    expect(mesh.geometry.getIndex()).toBe(beforeIndex);
    layer.dispose();
  });

  it('入切の所要は 1 コマ(16ms)に収まる(§2.17-7。ボディ 20 個)', () => {
    const layer = createSolidLayer();
    const bodies: SolidBodyWithSubShapes[] = [];
    for (let index = 0; index < 20; index += 1) {
      bodies.push(makeBody(`extrude-${String(index)}`, 6));
    }
    layer.update(buildSolidGeometry(bodies, null, []), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    const started = performance.now();
    layer.setSectionPlanes([plane]);
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    layer.setSectionPlanes([]);
    layer.updateSectionHandle(null);
    const elapsed = performance.now() - started;
    console.log(`断面表示の入切(ボディ 20 個): ${elapsed.toFixed(3)} ms`);
    expectWithinBudget(elapsed, FRAME_BUDGET_MS, '断面表示の入切');
    layer.dispose();
  });
});

describe('far helper lines keep their size through a double origin (G3a C)', () => {
  /** Visible helper objects drawn with a basic material of `hex`. */
  function visibleByColor(group: THREE.Object3D, hex: number): (THREE.Mesh | THREE.LineSegments)[] {
    return group.children.filter((object): object is THREE.Mesh | THREE.LineSegments => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments) || !object.visible) return false;
      const material: unknown = object.material;
      return (material instanceof THREE.MeshBasicMaterial || material instanceof THREE.LineBasicMaterial)
        && material.color.getHex() === hex;
    });
  }
  /** Double object origin plus Float32 local coordinates, summed in double precision. */
  function worldPoints(object: THREE.Mesh | THREE.LineSegments): readonly (readonly [number, number, number])[] {
    const geometry: unknown = object.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) throw new Error('missing helper geometry');
    const attribute: unknown = geometry.getAttribute('position');
    if (!(attribute instanceof THREE.BufferAttribute)) throw new Error('missing helper positions');
    return Array.from({ length: attribute.count }, (_unused, index) => [object.position.x + attribute.getX(index),
      object.position.y + attribute.getY(index), object.position.z + attribute.getZ(index)] as const);
  }
  const extent = (points: readonly (readonly number[])[], axis: number): number =>
    Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]));
  const xPlane = (x: number): ResolvedPlane => ({ origin: [x, 0, 0], axisU: [0, 1, 0], axisV: [0, 0, 1], normal: [1, 0, 0] });

  it('world Float32 cannot hold +1 mm at 1e9 mm, which is why helpers are drawn locally', () => {
    expect(Math.fround(1e9 + 1)).not.toBe(1e9 + 1);
    // The public world contract is unchanged; a far mark's circle collapses in its Float32 output.
    const world = buildThreadMarkPositions([{ origin: [1e9 + 1, 0, 0], direction: [0, 0, 1], majorDiameter: 2, length: 1 }]);
    const xs = Array.from({ length: world.length / 3 }, (_unused, index) => world[index * 3]);
    expect(Math.max(...xs) - Math.min(...xs)).not.toBeCloseTo(2, 3);
  });

  it.each([1e9 + 1, -1e9 - 1])('cut preview at x=%s keeps its exact plane and the 2.83 mm square and 0.72 mm arrow', (x) => {
    const layer = createSolidLayer();
    layer.updateCutPreview({ plane: xPlane(x), diagonal: 4, keep: 'positive' });
    const [face, arrow] = [visibleByColor(layer.group, 0xf0b429).find((object) => object instanceof THREE.Mesh),
      visibleByColor(layer.group, 0xf0b429).find((object) => object instanceof THREE.LineSegments)];
    if (face === undefined || arrow === undefined) throw new Error('missing cut preview');
    const corners = worldPoints(face);
    expect(corners.every((point) => point[0] === x)).toBe(true);
    expect(extent(corners, 1)).toBeCloseTo(2 * Math.SQRT2, 5);
    expect(extent(corners, 2)).toBeCloseTo(2 * Math.SQRT2, 5);
    const arrowPoints = worldPoints(arrow);
    expect(Math.min(...arrowPoints.map((point) => point[0]))).toBe(x);
    expect(extent(arrowPoints, 0)).toBeCloseTo(0.72, 5);
    layer.dispose();
  });

  it.each([1e9 + 1, -1e9 - 1])('section handle at x=%s has the same size as the same shape at the world origin', (x) => {
    const sized = (originX: number): number => {
      const layer = createSolidLayer();
      const triangle: SolidBodyWithSubShapes = { ...makeBody('far-section', 1),
        mesh: { ...makeBody('far-section', 1).mesh, positions: new Float32Array([0, -1, 0, 0, 1, 0, 0, 0, 1]) },
        coordinateFrame: { space: 'local', origin: [originX, 0, 0], maximumFloat32ErrorMm: 0.01 } };
      layer.update(buildSolidGeometry([triangle], null, []), 'shadedWithEdges');
      layer.updateSectionHandle({ plane: xPlane(originX), keep: 'positive' });
      const face = visibleByColor(layer.group, 0x38bdf8).find((object) => object instanceof THREE.Mesh);
      if (face === undefined) throw new Error('missing section handle');
      const corners = worldPoints(face);
      expect(corners.every((point) => point[0] === originX)).toBe(true);
      const size = extent(corners, 1);
      layer.dispose();
      return size;
    };
    const near = sized(0);
    expect(near).toBeGreaterThan(2);
    expect(near).toBeLessThan(10);
    expect(sized(x)).toBeCloseTo(near, 5);
  });

  it('draws each far thread mark at its own double origin with its 2 mm circle, without merging marks', () => {
    const layer = createSolidLayer();
    const mark = (x: number): ThreadMarkInfo => ({ origin: [x, 0, 0], direction: [0, 0, 1], majorDiameter: 2, length: 1 });
    layer.updateThreadMarks([mark(1e9 + 1), mark(-1e9 - 1)]);
    const lines = visibleByColor(layer.group, DEFAULT_THEME_COLORS.threadMark);
    expect(lines.map((line) => line.position.x)).toEqual([1e9 + 1, -1e9 - 1]);
    for (const line of lines) {
      const points = worldPoints(line);
      expect(extent(points, 0)).toBeCloseTo(2, 5);
      expect(extent(points, 2)).toBeCloseTo(1, 5);
      expect(Math.min(...points.map((point) => point[0]))).toBeCloseTo(line.position.x - 1, 5);
    }
    layer.updateThreadMarks([mark(5)]);
    expect(visibleByColor(layer.group, DEFAULT_THEME_COLORS.threadMark).map((line) => line.position.x)).toEqual([5]);
    layer.updateThreadMarks([]);
    expect(visibleByColor(layer.group, DEFAULT_THEME_COLORS.threadMark)).toEqual([]);
    layer.dispose();
  });

  it.each([1e9 + 1, -1e9 - 1])('sphere grid at x=%s is drawn around a local center placed at its double center', (x) => {
    const layer = createSolidLayer();
    layer.updateSphereGrid(buildSphereGridPositions({ center: [0, 0, 0], radius: 1, stepDegrees: 30 }), [x, 0, 0]);
    const grid = visibleByColor(layer.group, DEFAULT_THEME_COLORS.gridMajor).find((object) => object instanceof THREE.LineSegments);
    if (grid === undefined) throw new Error('missing sphere grid');
    const points = worldPoints(grid);
    expect(grid.position.x).toBe(x);
    expect(extent(points, 0)).toBeCloseTo(2, 5);
    expect(Math.min(...points.map((point) => point[0]))).toBeCloseTo(x - 1, 5);
    layer.dispose();
  });
});

describe('createSolidLayer(断面表示のつまみ、§0.42)', () => {
  it('つまみは四角(三角形 2 枚 = 6 頂点)で出る(切断の予告と同じ形)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    const handleFace = layer.group.children.find(
      (object) => object.visible && !isBodyMesh(object) && meshVertexCount(object) === 6,
    );
    expect(handleFace).toBeDefined();
    layer.dispose();
  });

  it('null を渡すと消える', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    const shown = layer.group.children.filter((object) => object.visible).length;
    layer.updateSectionHandle(null);
    expect(layer.group.children.filter((object) => object.visible).length).toBeLessThan(shown);
    layer.dispose();
  });

  it('ボディが 1 つも無くてもつまみは出る(掴めなくならない、NFR-UX-7)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'negative' });
    const shown = layer.group.children.filter(
      (object) => object instanceof THREE.Mesh && object.visible,
    );
    expect(shown.length).toBeGreaterThan(0);
    layer.dispose();
  });

  it('dispose() でつまみの材質も捨てる(WebGL の資源は GC で戻らない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    let disposed = 0;
    const materials = allMaterialsOf(layer.group);
    for (const material of materials) {
      material.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    layer.dispose();
    expect(disposed).toBe(materials.length);
  });
});
/** 三角形の番号の一覧を、カーネルと同じ「下位ビットから」の詰め方でビット列にする。 */
function printBitsOf(triangleCount: number, marked: readonly number[]): Uint8Array {
  const bits = new Uint8Array(Math.ceil(triangleCount / 8));
  for (const triangle of marked) {
    bits[triangle >> 3] |= 1 << (triangle & 7);
  }
  return bits;
}

/** 検査用の点検の結果。層は要約を 1 つも読まないので、要約は型を満たすだけの値。 */
function printReportOf(
  triangleCount: number,
  marked: {
    readonly thin?: readonly number[];
    readonly overhang?: readonly number[];
    readonly openEdge?: readonly number[];
  } = {},
): PrintabilityReport {
  return {
    triangleCount,
    thinTriangles: printBitsOf(triangleCount, marked.thin ?? []),
    overhangTriangles: printBitsOf(triangleCount, marked.overhang ?? []),
    openEdgeTriangles: printBitsOf(triangleCount, marked.openEdge ?? []),
    summary: {
      triangleCount,
      degenerateCount: 0,
      inspectedTriangleCount: triangleCount,
      thinCount: marked.thin?.length ?? 0,
      overhangCount: marked.overhang?.length ?? 0,
      openEdgeCount: marked.openEdge?.length ?? 0,
      openEdgeTriangleCount: marked.openEdge?.length ?? 0,
      watertight: (marked.openEdge?.length ?? 0) === 0,
      minThicknessFoundMm: 20,
      minThicknessMm: 0.8,
      overhangAngleDeg: 45,
      cellSizeMm: 1.6,
    },
    cancelled: false,
  };
}

/** 立体 1 つを点検したときの、層へ渡す一式。 */
function printHighlightOf(
  featureId: string,
  triangleCount: number,
  report: PrintabilityReport,
): { readonly report: PrintabilityReport; readonly triangleOffsets: ReadonlyMap<string, number> } {
  return {
    report,
    triangleOffsets: printabilityTriangleOffsets([{ featureId, triangleCount }]),
  };
}

/** 層の中の「開いた辺の紫の線」の本数(見えているものだけ)。 */
function openEdgeLineCount(group: THREE.Object3D): number {
  let count = 0;
  for (const object of group.children) {
    if (!(object instanceof THREE.LineSegments) || !object.visible) {
      continue;
    }
    const material: unknown = object.material;
    const geometry: unknown = object.geometry;
    if (
      material instanceof THREE.LineBasicMaterial &&
      geometry instanceof THREE.BufferGeometry &&
      material.color.getHex() === DEFAULT_THEME_COLORS.printOpenEdge
    ) {
      const position: unknown = geometry.getAttribute('position');
      count += position instanceof THREE.BufferAttribute ? position.count / 2 : 0;
    }
  }
  return count;
}

describe('createSolidLayer(3D プリントの点検の色、FR-815、§0.53)', () => {
  it('点検を出すと 1 ボディ 3 材質(既定・赤・橙)になり、P5 の上限 8 に触れない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges');
    expect(bodyMeshesOf(layer.group)[0].material).toHaveLength(1);

    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 6, printReportOf(6, { thin: [1], overhang: [3] })),
    );

    const materials = bodyMeshesOf(layer.group)[0].material;
    expect(materials).toHaveLength(3);
    const colored = materials.map((material) =>
      material instanceof THREE.MeshStandardMaterial ? material.color.getHex() : null,
    );
    expect(colored[0]).toBe(DEFAULT_THEME_COLORS.solid);
    expect(colored[1]).toBe(DEFAULT_THEME_COLORS.printThin);
    expect(colored[2]).toBe(DEFAULT_THEME_COLORS.printOverhang);
    layer.dispose();
  });

  it('薄い三角形とせり出しの三角形が、それぞれの材質のまとまりになる', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [1], overhang: [2] })),
    );

    // 索引の単位(三角形 × 3)。0 = 既定、1 = 赤、2 = 橙、3 = 既定 の 4 つに割れる。
    const groups = bodyMeshesOf(layer.group)[0].geometry.groups;
    expect(groups.map((group) => [group.start, group.count, group.materialIndex])).toEqual([
      [0, 3, 0],
      [3, 3, 1],
      [6, 3, 2],
      [9, 3, 0],
    ]);
    layer.dispose();
  });

  it('閉じると元の外観に戻る(材質もまとまりも点検の前と同じ数)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges');
    const before = bodyMeshesOf(layer.group)[0].geometry.groups.length;

    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 6, printReportOf(6, { thin: [2] })),
    );
    expect(bodyMeshesOf(layer.group)[0].material).toHaveLength(3);

    layer.setPrintabilityHighlight(null);
    const mesh = bodyMeshesOf(layer.group)[0];
    expect(mesh.material).toHaveLength(1);
    expect(mesh.geometry.groups).toHaveLength(before);
    const material = mesh.material[0];
    expect(material instanceof THREE.MeshStandardMaterial ? material.color.getHex() : null).toBe(
      DEFAULT_THEME_COLORS.solid,
    );
    layer.dispose();
  });

  it('点検を頼まなかった立体は、点検の間も元の外観のまま', () => {
    const layer = createSolidLayer();
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', 3), makeBody('extrude-2', 3)], null, []),
      'shadedWithEdges',
    );
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 3, printReportOf(3, { thin: [0] })),
    );

    const meshes = bodyMeshesOf(layer.group);
    expect(meshes[0].material).toHaveLength(3);
    expect(meshes[1].material).toHaveLength(1);
    layer.dispose();
  });

  it('三角形の数が点検の結果と噛み合わない立体には色を塗らない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges');
    // 点検は 4 枚ぶんしか持っていないのに、画面には 6 枚ある(点検の後に形が変わった)。
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 6, printReportOf(4, { thin: [0] })),
    );

    expect(bodyMeshesOf(layer.group)[0].material).toHaveLength(1);
    layer.dispose();
  });

  it('開いた辺を持つ三角形の輪郭(3 辺)を紫の線で引き、閉じると消える', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    expect(openEdgeLineCount(layer.group)).toBe(0);

    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { openEdge: [1, 2] })),
    );
    // 三角形 2 枚 × 3 辺 = 線分 6 本。
    expect(openEdgeLineCount(layer.group)).toBe(6);

    layer.setPrintabilityHighlight(null);
    expect(openEdgeLineCount(layer.group)).toBe(0);
    layer.dispose();
  });

  it('閉じた形では紫の線を 1 本も引かない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [0] })),
    );

    expect(openEdgeLineCount(layer.group)).toBe(0);
    layer.dispose();
  });

  it('点検の色にも断面表示の平面が配られる(切ったのに線だけ空中に残らない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [0], openEdge: [1] })),
    );
    layer.setSectionPlanes([new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]);

    const untouched = allMaterialsOf(layer.group).filter(
      (material) => material.clippingPlanes === null,
    );
    expect(untouched).toHaveLength(UNCLIPPED_MATERIAL_COUNT);
    layer.dispose();
  });

  it('dispose() で点検の材質もすべて捨てる(WebGL の資源は GC で戻らない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [0], overhang: [1], openEdge: [2] })),
    );
    let disposed = 0;
    const materials = allMaterialsOf(layer.group);
    for (const material of materials) {
      material.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    layer.dispose();
    expect(disposed).toBe(materials.length);
  });
});

describe('createSolidLayer の繰り返し更新と資源寿命(R07)', () => {
  it('updates mutated sphere backing without replacing its attribute or bounds owner', () => {
    const layer = createSolidLayer();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    layer.updateSphereGrid(positions);
    const lines = requireSphereGridLines(layer.group);
    const attribute = bufferAttribute(lines.geometry, 'position');
    const sphere = lines.geometry.boundingSphere;
    const version = attribute.version;
    positions[3] = 8;
    layer.updateSphereGrid(positions);
    expect(bufferAttribute(lines.geometry, 'position')).toBe(attribute);
    expect(lines.geometry.boundingSphere).toBe(sphere);
    expect(attribute.version).toBeGreaterThan(version);
    expect(lines.geometry.boundingSphere?.center.x).toBe(4);
    expect(lines.geometry.boundingSphere?.radius).toBe(4);
    layer.dispose();
  });

  it.each(['geometry', 'material'] as const)('tries every independent cleanup after a %s failure and retries only that resource', kind => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('cleanup-owner', 1)], null, []), 'shadedWithEdges');
    const geometries = new Set<THREE.BufferGeometry>();
    const isGeometry = (value: unknown): value is THREE.BufferGeometry => value instanceof THREE.BufferGeometry;
    layer.group.traverse(object => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points)) return;
      const geometry: unknown = object.geometry;
      if (isGeometry(geometry)) geometries.add(geometry);
    });
    const materials = allMaterialsOf(layer.group);
    const geometryCounts = new Map<THREE.BufferGeometry, number>();
    const materialCounts = new Map<THREE.Material, number>();
    for (const geometry of geometries) geometry.addEventListener('dispose', () => {
      geometryCounts.set(geometry, (geometryCounts.get(geometry) ?? 0) + 1);
    });
    for (const material of materials) material.addEventListener('dispose', () => {
      materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1);
    });
    const failedGeometry = [...geometries][0];
    const failedMaterial = materials.find(material => material instanceof THREE.LineBasicMaterial);
    if (failedGeometry === undefined || failedMaterial === undefined) throw new Error('cleanup resources missing');
    const fail = (): never => { throw new Error('independent cleanup failure'); };
    if (kind === 'geometry') failedGeometry.addEventListener('dispose', fail);
    else failedMaterial.addEventListener('dispose', fail);
    expect(() => layer.dispose()).toThrow('independent cleanup failure');
    expect(layer.group.children).toHaveLength(0);
    for (const geometry of geometries) expect(geometryCounts.get(geometry)).toBe(1);
    for (const material of materials) expect(materialCounts.get(material)).toBe(1);
    if (kind === 'geometry') failedGeometry.removeEventListener('dispose', fail);
    else failedMaterial.removeEventListener('dispose', fail);
    layer.dispose(); layer.dispose();
    for (const geometry of geometries) expect(geometryCounts.get(geometry)).toBe(kind === 'geometry' && geometry === failedGeometry ? 2 : 1);
    for (const material of materials) expect(materialCounts.get(material)).toBe(kind === 'material' && material === failedMaterial ? 2 : 1);
  });

  it('100回の2体→1体→pick→破棄で旧IDを返さず、各形と材質を1回ずつ解放する', () => {
    const two = buildSolidGeometry([makeBody('first', 1), makeBody('removed', 1)], null, []);
    const one = buildSolidGeometry([makeBody('first', 1)], null, []);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const layer = createSolidLayer();
      layer.update(two, 'shadedWithEdges');
      const meshes = bodyMeshesOf(layer.group);
      expect(meshes).toHaveLength(2);
      const removed = meshes[1];
      const retained = meshes[0];
      const removedEdges = layer.group.children[layer.group.children.indexOf(removed) + 1];
      const retainedEdges = layer.group.children[layer.group.children.indexOf(retained) + 1];
      if (!(removedEdges instanceof THREE.LineSegments) || !(retainedEdges instanceof THREE.LineSegments)) {
        throw new Error('ボディの稜線が見つかりません。');
      }
      if (!(removedEdges.geometry instanceof THREE.BufferGeometry)
        || !(retainedEdges.geometry instanceof THREE.BufferGeometry)) {
        throw new Error('ボディ稜線の形状がありません。');
      }
      let removedGeometryDisposals = 0;
      let removedEdgeDisposals = 0;
      let retainedGeometryDisposals = 0;
      let retainedEdgeDisposals = 0;
      let materialDisposals = 0;
      removed.geometry.addEventListener('dispose', () => { removedGeometryDisposals += 1; });
      removedEdges.geometry.addEventListener('dispose', () => { removedEdgeDisposals += 1; });
      retained.geometry.addEventListener('dispose', () => { retainedGeometryDisposals += 1; });
      retainedEdges.geometry.addEventListener('dispose', () => { retainedEdgeDisposals += 1; });
      const material = retained.material[0];
      material.addEventListener('dispose', () => { materialDisposals += 1; });
      layer.update(one, 'shadedWithEdges');
      expect(removedGeometryDisposals).toBe(1);
      expect(removedEdgeDisposals).toBe(1);
      expect(bodyMeshesOf(layer.group)).toEqual([retained]);
      const raycaster = new THREE.Raycaster();
      let pickCalls = 0;
      const intersect = vi.spyOn(raycaster, 'intersectObjects').mockImplementation((targets) => {
        expect(targets).toEqual(pickCalls === 0 ? [retained] : []);
        pickCalls += 1;
        return [{ distance: 0, point: new THREE.Vector3(), object: removed }];
      });
      expect(layer.pickBody(raycaster)).toBeNull();
      expect(intersect).toHaveBeenCalledOnce();
      layer.dispose();
      expect(retainedGeometryDisposals).toBe(1);
      expect(retainedEdgeDisposals).toBe(1);
      expect(materialDisposals).toBe(1);
      expect(bodyMeshesOf(layer.group)).toHaveLength(0);
      expect(layer.pickBody(raycaster)).toBeNull();
      expect(intersect).toHaveBeenCalledTimes(2);
    }
  });
});

/** Appearance/group metadata comes from the ordinary builder; all tested arrays are independent literals. */
function literalDrawEntry(featureId: string, variant: 'a' | 'b' = 'a'): SolidDrawEntry {
  const metadata = buildSolidGeometry([makeBody(featureId, 1)], null, []).entries[0];
  return variant === 'a' ? {
    ...metadata,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]),
  } : {
    ...metadata,
    positions: new Float32Array([2, 0, 0, 3, 0, 0, 2, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: new Float32Array([2, 0, 3, 0, 2, 1]),
    indices: new Uint32Array([2, 1, 0]),
    edgePositions: new Float32Array([2, 0, 0, 3, 0, 0, 3, 0, 0, 2, 1, 0, 2, 1, 0, 2, 0, 0]),
  };
}

function literalBundle(entries: readonly SolidDrawEntry[]): SolidGeometryBundle {
  return { ...buildSolidGeometry([], null, []), entries };
}

function drawArrayBytes(entry: SolidDrawEntry): readonly Uint8Array[] {
  return [entry.positions, entry.normals, entry.uv, entry.indices, entry.edgePositions].map((array) =>
    Uint8Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)));
}

function bufferAttribute(geometry: THREE.BufferGeometry, name: string): THREE.BufferAttribute {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof THREE.BufferAttribute)) throw new Error('missing buffer attribute: ' + name);
  return attribute;
}

function bodyEdgesAfter(
  group: THREE.Group,
  mesh: THREE.Object3D,
): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const isBodyEdges = (
    object: THREE.Object3D | undefined,
  ): object is THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> =>
    object instanceof THREE.LineSegments && object.geometry instanceof THREE.BufferGeometry
    && object.material instanceof THREE.LineBasicMaterial;
  const edges = group.children[group.children.indexOf(mesh) + 1];
  if (!isBodyEdges(edges)) {
    throw new Error('missing body edges');
  }
  return edges;
}

describe('createSolidLayer borrowed arrays (G3a A1)', () => {
  it('keeps A/B bytes immutable through same-length A→B→A, including another body and layer sharing A', () => {
    const a = literalDrawEntry('first');
    const b = literalDrawEntry('first', 'b');
    const shared = { ...a, featureId: 'shared' };
    const aBefore = drawArrayBytes(a);
    const bBefore = drawArrayBytes(b);
    const first = literalBundle([a, shared]);
    const second = literalBundle([b, shared]);
    const layer = createSolidLayer();
    const otherLayer = createSolidLayer();
    layer.update(first, 'shadedWithEdges');
    otherLayer.update(literalBundle([a]), 'shadedWithEdges');
    const [mesh, sharedMesh] = bodyMeshesOf(layer.group);
    const otherMesh = bodyMeshesOf(otherLayer.group)[0];
    const edges = bodyEdgesAfter(layer.group, mesh);
    const attributes = ['position', 'normal', 'uv'].map((name) => bufferAttribute(mesh.geometry, name));
    const index = mesh.geometry.getIndex();
    if (index === null) throw new Error('missing index');
    const edgeAttribute = bufferAttribute(edges.geometry, 'position');
    expect(attributes.map((attribute) => attribute.array)).toEqual([a.positions, a.normals, a.uv]);
    expect(attributes[0].array).toBe(a.positions);
    expect(index.array).toBe(a.indices);
    expect(edgeAttribute.array).toBe(a.edgePositions);
    let meshDisposals = 0;
    let edgeDisposals = 0;
    mesh.geometry.addEventListener('dispose', () => { meshDisposals += 1; });
    edges.geometry.addEventListener('dispose', () => { edgeDisposals += 1; });

    layer.update(second, 'shadedWithEdges');
    expect(bodyMeshesOf(layer.group)[0]).toBe(mesh);
    for (const [slot, name] of ['position', 'normal', 'uv'].entries()) {
      expect(mesh.geometry.getAttribute(name)).toBe(attributes[slot]);
    }
    expect(attributes.map((attribute) => attribute.array)).toEqual([b.positions, b.normals, b.uv]);
    expect(index.array).toBe(b.indices);
    expect(edgeAttribute.array).toBe(b.edgePositions);
    const versions = [...attributes.map((attribute) => attribute.version), index.version, edgeAttribute.version];
    expect(versions).toEqual([1, 1, 1, 1, 1]);
    layer.update({ ...second }, 'shadedWithEdges');
    expect([...attributes.map((attribute) => attribute.version), index.version, edgeAttribute.version]).toEqual(versions);
    expect(drawArrayBytes(a)).toEqual(aBefore);
    expect(drawArrayBytes(b)).toEqual(bBefore);
    expect(sharedMesh.geometry.getAttribute('position').array).toBe(a.positions);
    expect(otherMesh.geometry.getAttribute('position').array).toBe(a.positions);
    expect(Array.from(sharedMesh.geometry.getAttribute('position').array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    layer.update(first, 'shadedWithEdges');
    expect(Array.from(attributes[0].array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(index.array)).toEqual([0, 1, 2]);
    expect([...attributes.map((attribute) => attribute.version), index.version, edgeAttribute.version]).toEqual([2, 2, 2, 2, 2]);
    expect(meshDisposals).toBe(0);
    expect(edgeDisposals).toBe(0);
    layer.dispose();
    expect(meshDisposals).toBe(1);
    expect(edgeDisposals).toBe(1);
    expect(Object.keys(mesh.geometry.attributes)).toEqual([]);
    expect(mesh.geometry.getIndex()).toBeNull();
    expect(Object.keys(edges.geometry.attributes)).toEqual([]);
    expect(drawArrayBytes(a)).toEqual(aBefore);
    expect(drawArrayBytes(b)).toEqual(bBefore);
    expect(otherMesh.geometry.getAttribute('position').array).toBe(a.positions);
    otherLayer.dispose();
  });

  it('adopts normals-only updates without writing old normals or uploading unchanged slots', () => {
    const entry = literalDrawEntry('normal-only');
    const before = drawArrayBytes(entry);
    const layer = createSolidLayer();
    layer.update(literalBundle([entry]), 'shadedWithEdges');
    const mesh = bodyMeshesOf(layer.group)[0];
    const position = bufferAttribute(mesh.geometry, 'position');
    const normal = bufferAttribute(mesh.geometry, 'normal');
    const uv = bufferAttribute(mesh.geometry, 'uv');
    const index = mesh.geometry.getIndex();
    const nextNormals = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    layer.update(literalBundle([{ ...entry, normals: nextNormals }]), 'shadedWithEdges');
    expect(mesh.geometry.getAttribute('normal')).toBe(normal);
    expect(normal.array).toBe(nextNormals);
    expect(Array.from(normal.array)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    expect(normal.version).toBe(1);
    expect(position.version).toBe(0);
    expect(uv.version).toBe(0);
    expect(index?.version).toBe(0);
    expect(drawArrayBytes(entry)).toEqual(before);
    layer.dispose();
    expect(Array.from(nextNormals)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  });

  it('notifies one GPU release before replacing differently sized attributes and releases CPU refs on removal', () => {
    const entry = literalDrawEntry('resize');
    const layer = createSolidLayer();
    layer.update(literalBundle([entry]), 'shadedWithEdges');
    const mesh = bodyMeshesOf(layer.group)[0];
    const edges = bodyEdgesAfter(layer.group, mesh);
    const oldAttributes = ['position', 'normal', 'uv'].map((name) => mesh.geometry.getAttribute(name));
    const oldIndex = mesh.geometry.getIndex();
    let meshDisposals = 0;
    let edgeDisposals = 0;
    mesh.geometry.addEventListener('dispose', () => {
      meshDisposals += 1;
      if (meshDisposals === 1) {
        expect(['position', 'normal', 'uv'].map((name) => mesh.geometry.getAttribute(name))).toEqual(oldAttributes);
        expect(mesh.geometry.getIndex()).toBe(oldIndex);
        expect(mesh.geometry.getAttribute('position').array).toBe(entry.positions);
        expect(mesh.geometry.getAttribute('normal').array).toBe(entry.normals);
        expect(mesh.geometry.getAttribute('uv').array).toBe(entry.uv);
        expect(mesh.geometry.getIndex()?.array).toBe(entry.indices);
      }
    });
    edges.geometry.addEventListener('dispose', () => { edgeDisposals += 1; });
    const larger: SolidDrawEntry = { ...entry,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0, 0, 1, 2, 0, 3, 0, 2, 1]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      triangleCount: 2, groups: [{ start: 0, count: 6, materialIndex: 0 }],
    };
    layer.update(literalBundle([larger]), 'shadedWithEdges');
    expect(meshDisposals).toBe(1);
    expect(edgeDisposals).toBe(1);
    expect(mesh.geometry.getAttribute('position').array).toBe(larger.positions);
    expect(mesh.geometry.getAttribute('position').count).toBe(6);
    expect(mesh.geometry.getIndex()?.array).toBe(larger.indices);
    layer.update(literalBundle([]), 'shadedWithEdges');
    expect(meshDisposals).toBe(2);
    expect(edgeDisposals).toBe(2);
    expect(Object.keys(mesh.geometry.attributes)).toEqual([]);
    expect(mesh.geometry.getIndex()).toBeNull();
    layer.dispose();
    expect(meshDisposals).toBe(2);
    expect(edgeDisposals).toBe(2);
  });
});

function printOpenLines(group: THREE.Group): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>[] {
  return group.children.filter((object): object is THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> =>
    object instanceof THREE.LineSegments && object.geometry instanceof THREE.BufferGeometry
    && object.material instanceof THREE.LineBasicMaterial
    && object.material.color.getHex() === DEFAULT_THEME_COLORS.printOpenEdge);
}

function worldLineCoordinates(lines: THREE.LineSegments<THREE.BufferGeometry>): number[] {
  const position = lines.geometry.getAttribute('position');
  const result: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    result.push(...lines.localToWorld(new THREE.Vector3().fromBufferAttribute(position, vertex)).toArray());
  }
  return result;
}

describe('createSolidLayer body-local print edges (G3a A2)', () => {
  it('matches literal Double world edges at both ±(1e9+1), reuses origin-only buffers and releases hide/show/dispose', () => {
    const positive: SolidDrawEntry = { ...literalDrawEntry('positive'), coordinateFrame: {
      space: 'local', origin: [1000000001, 2, -3], maximumFloat32ErrorMm: 0.001,
    } };
    const negative: SolidDrawEntry = { ...literalDrawEntry('negative'), coordinateFrame: {
      space: 'local', origin: [-1000000001, 4, 5], maximumFloat32ErrorMm: 0.001,
    } };
    const negativeBefore = drawArrayBytes(negative);
    const highlight = { report: printReportOf(2, { openEdge: [0, 1] }),
      triangleOffsets: new Map([['positive', 0], ['negative', 1]]) };
    const layer = createSolidLayer();
    layer.update(literalBundle([positive, negative]), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -1000000001);
    layer.setSectionPlanes([plane]);
    layer.setPrintabilityHighlight(highlight);
    const [first, second] = printOpenLines(layer.group);
    expect(printOpenLines(layer.group)).toHaveLength(2);
    expect(first.position.toArray()).toEqual([1000000001, 2, -3]);
    expect(second.position.toArray()).toEqual([-1000000001, 4, 5]);
    expect(first.material).toBe(second.material);
    expect(first.material.clippingPlanes?.[0]).toBe(plane);
    const positiveWorld = [1000000001, 2, -3, 1000000002, 2, -3,
      1000000002, 2, -3, 1000000001, 3, -3, 1000000001, 3, -3, 1000000001, 2, -3];
    const negativeWorld = [-1000000001, 4, 5, -1000000000, 4, 5,
      -1000000000, 4, 5, -1000000001, 5, 5, -1000000001, 5, 5, -1000000001, 4, 5];
    expect(worldLineCoordinates(first)).toEqual(positiveWorld);
    expect(worldLineCoordinates(second)).toEqual(negativeWorld);
    const meshes = bodyMeshesOf(layer.group);
    expect(worldLineCoordinates(bodyEdgesAfter(layer.group, meshes[0]))).toEqual(positiveWorld);
    expect(worldLineCoordinates(bodyEdgesAfter(layer.group, meshes[1]))).toEqual(negativeWorld);
    const firstPosition = bufferAttribute(first.geometry, 'position');
    const secondPosition = bufferAttribute(second.geometry, 'position');
    expect(Array.from(firstPosition.array)).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
    let firstDisposals = 0;
    let secondDisposals = 0;
    let materialDisposals = 0;
    first.geometry.addEventListener('dispose', () => { firstDisposals += 1; });
    second.geometry.addEventListener('dispose', () => { secondDisposals += 1; });
    first.material.addEventListener('dispose', () => { materialDisposals += 1; });

    const moved: SolidDrawEntry = { ...positive, coordinateFrame: {
      space: 'local', origin: [1000000009, 2, -3], maximumFloat32ErrorMm: 0.001,
    } };
    layer.update(literalBundle([moved, negative]), 'shadedWithEdges');
    expect(printOpenLines(layer.group)).toEqual([first, second]);
    expect(first.geometry.getAttribute('position')).toBe(firstPosition);
    expect(firstPosition.version).toBe(0);
    expect(second.geometry.getAttribute('position')).toBe(secondPosition);
    expect(worldLineCoordinates(first)).toEqual([1000000009, 2, -3, 1000000010, 2, -3,
      1000000010, 2, -3, 1000000009, 3, -3, 1000000009, 3, -3, 1000000009, 2, -3]);
    expect(worldLineCoordinates(second)).toEqual(negativeWorld);
    expect(firstDisposals).toBe(0);
    expect(secondDisposals).toBe(0);
    expect(drawArrayBytes(negative)).toEqual(negativeBefore);

    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, printOpenEdge: 0x654321 });
    expect(first.material.color.getHex()).toBe(0x654321);
    expect(second.material.color.getHex()).toBe(0x654321);
    expect(first.material.clippingPlanes?.[0]).toBe(plane);
    expect(firstPosition.version).toBe(0);
    layer.setThemeColors(DEFAULT_THEME_COLORS);

    layer.setPrintabilityHighlight(null);
    expect(printOpenLines(layer.group)).toHaveLength(0);
    expect(firstDisposals).toBe(1);
    expect(secondDisposals).toBe(1);
    expect(Object.keys(first.geometry.attributes)).toEqual([]);
    expect(Object.keys(second.geometry.attributes)).toEqual([]);
    expect(materialDisposals).toBe(0);
    layer.setPrintabilityHighlight(highlight);
    const reShown = printOpenLines(layer.group);
    expect(reShown).toHaveLength(2);
    expect(reShown[0]).not.toBe(first);
    expect(worldLineCoordinates(reShown[1])).toEqual(negativeWorld);
    let reShownDisposals = 0;
    for (const lines of reShown) lines.geometry.addEventListener('dispose', () => { reShownDisposals += 1; });
    layer.dispose();
    expect(reShownDisposals).toBe(2);
    expect(materialDisposals).toBe(1);
    expect(printOpenLines(layer.group)).toHaveLength(0);
    expect(reShown.every((lines) => Object.keys(lines.geometry.attributes).length === 0)).toBe(true);
  });

  it('removes only a deleted body batch and preserves the other local buffer and world clipping contract', () => {
    const first: SolidDrawEntry = { ...literalDrawEntry('remove'), coordinateFrame: {
      space: 'local', origin: [1000000001, 0, 0], maximumFloat32ErrorMm: 0.001,
    } };
    const retained: SolidDrawEntry = { ...literalDrawEntry('retain'), coordinateFrame: {
      space: 'local', origin: [-1000000001, 0, 0], maximumFloat32ErrorMm: 0.001,
    } };
    const layer = createSolidLayer();
    layer.update(literalBundle([first, retained]), 'shadedWithEdges');
    layer.setPrintabilityHighlight({ report: printReportOf(2, { openEdge: [0, 1] }),
      triangleOffsets: new Map([['remove', 0], ['retain', 1]]) });
    const [removedLines, retainedLines] = printOpenLines(layer.group);
    const retainedPosition = bufferAttribute(retainedLines.geometry, 'position');
    let removedDisposals = 0;
    let retainedDisposals = 0;
    removedLines.geometry.addEventListener('dispose', () => { removedDisposals += 1; });
    retainedLines.geometry.addEventListener('dispose', () => { retainedDisposals += 1; });
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25);
    layer.setSectionPlanes([plane]);
    layer.update(literalBundle([retained]), 'shadedWithEdges');
    expect(printOpenLines(layer.group)).toEqual([retainedLines]);
    expect(removedDisposals).toBe(1);
    expect(Object.keys(removedLines.geometry.attributes)).toEqual([]);
    expect(retainedDisposals).toBe(0);
    expect(retainedLines.geometry.getAttribute('position')).toBe(retainedPosition);
    expect(retainedPosition.version).toBe(0);
    expect(retainedLines.position.toArray()).toEqual([-1000000001, 0, 0]);
    expect(retainedLines.material.clippingPlanes?.[0]).toBe(plane);
    layer.dispose();
    expect(removedDisposals).toBe(1);
    expect(retainedDisposals).toBe(1);
  });
});
