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
import { expressionValueFromNumber } from '@pointercad/expression';
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
import { ViewportResourceInitializationFailure } from './viewportLifetime.js';
import { describe, expect, it, vi } from 'vitest';
import type { PatternTextureSource } from '../appearance/createAppearanceMaterial.js';

import {
  buildAssemblyGeometry,
  assemblyAppearanceSpecs,
  createAssemblyLayer as createLayer,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
  type AssemblyGeometryInput,
  type AssemblyLayerOptions,
} from './createAssemblyLayer.js';
import { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';
import type { AppearanceInput } from './buildSolidGeometry.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { subShapeRefOf } from '../solid/subShapeSelection.js';
import { createGpuMeshBudget } from './solidMeshAdmission.js';

function createAssemblyLayer(patterns?: PatternTextureSource, options: AssemblyLayerOptions = {}) {
  return createLayer(patterns, { uiBackings: new AssemblyUiBackingLedger(), ...options });
}

describe('合致の面pickと強調の回帰', () => {
  it('retains local patterned UV phase through the shared assembly geometry and disposes it once', () => {
    const source = makeBody('patterned-part');
    const positions = Float32Array.from([19.99, 0, 0, 20.01, 0, 0, 19.99, 1, 0]);
    const body: SolidBody = { ...source, mesh: { ...source.mesh, positions },
      coordinateFrame: { space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.01 } };
    const preset = appearanceFromPreset('expandedMetal');
    if (preset.pattern.kind === 'none') throw new Error('expected patterned preset');
    const patterned: AppearanceSpec = { ...preset, pattern: {
      ...preset.pattern, spacing: expressionValueFromNumber(20),
    } };
    const appearance: AppearanceInput = { defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['patterned-part', {
        bodyAppearance: patterned, faceAppearances: new Map(),
      }]]),
    };
    const bundle: AssemblyGeometryBundle = {
      parts: [{ partKey: 'patterned-key', bodies: [body], appearances: appearance }],
      instances: [{ componentId: 'patterned-component', partKey: 'patterned-key', visible: true,
        emphasis: 'none', placement: placementAt(0) }],
    };
    let sourceDisposals = 0;
    const patterns: PatternTextureSource = {
      create: () => ({ texture: new THREE.Texture(), alphaTexture: new THREE.Texture() }),
      disposeAll: () => { sourceDisposals += 1; },
    };
    const layer = createAssemblyLayer(patterns);
    try {
      layer.update(bundle, 'shadedWithEdges');
      const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
      layer.group.traverse((object) => {
        if (isPartMesh(object) && object.geometry.getAttribute('uv') !== undefined) meshes.push(object);
      });
      expect(meshes).toHaveLength(1);
      const mesh = meshes[0];
      const uv: unknown = mesh.geometry.getAttribute('uv');
      if (!(uv instanceof THREE.BufferAttribute)) throw new Error('missing assembly patterned UV');
      expect(Math.abs((Number(uv.array[0]) + Number(uv.array[2])) / 2 - 20)).toBeLessThan(2e-5);
      expect(mesh.geometry.getIndex()?.count).toBe(3);
      const material: unknown = mesh.material;
      if (!(material instanceof THREE.MeshStandardMaterial)) throw new Error('missing patterned material');
      expect(material.map?.repeat.x).toBe(material.alphaMap?.repeat.x);
      let geometryDisposals = 0;
      mesh.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
      layer.update({ parts: [], instances: [] }, 'shadedWithEdges');
      expect(geometryDisposals).toBe(1);
      expect(Array.from(positions)).toEqual([
        Math.fround(19.99), 0, 0, Math.fround(20.01), 0, 0, Math.fround(19.99), 1, 0,
      ]);
    } finally { layer.dispose(); }
    expect(sourceDisposals).toBe(1);
  });
  it('applies the local result mesh-byte limit through public assembly update', () => {
    const source = makeBody('assembly-budget');
    const mesh = source.mesh;
    const required = mesh.positions.byteLength + mesh.normals.byteLength
      + mesh.indices.byteLength + mesh.edgePositions.byteLength + mesh.indices.length * 36;
    const appearance: AppearanceInput = {
      defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['assembly-budget', {
        bodyAppearance: appearanceFromPreset('expandedMetal'), faceAppearances: new Map(),
      }]]),
    };
    for (const [limit, shouldPass] of [[required - 1, false], [required, true]] as const) {
      const body: SolidBody = { ...source, coordinateFrame: {
        space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.01,
        maximumLiveMeshBytes: limit,
      } };
      const bundle: AssemblyGeometryBundle = {
        parts: [{ partKey: 'budget-part', bodies: [body], appearances: appearance }],
        instances: [{ componentId: 'budget-component', partKey: 'budget-part', visible: true,
          emphasis: 'none', placement: placementAt(0) }],
      };
      const layer = createAssemblyLayer();
      try {
        if (shouldPass) {
          expect(() => layer.update(bundle, 'shadedWithEdges')).not.toThrow();
          expect(geometriesOf(layer.group).size).toBeGreaterThan(0);
        } else {
          expect(() => layer.update(bundle, 'shadedWithEdges')).toThrow(/live-byte budget/);
          expect(layer.group.children).toHaveLength(0);
        }
      } finally { layer.dispose(); }
    }
  });
  it.each([0, -1e6, 1e9])('keeps two face batches separate near world X=%s', (x) => {
    const bodies: SolidBody[] = ['a', 'b'].map((id, index): SolidBody => ({
      ...makeBody(id),
      coordinateFrame: { space: 'local', origin: [x + index * 100, 0, 0], maximumFloat32ErrorMm: 0.001 },
    }));
    const bundle: AssemblyGeometryBundle = {
      parts: [{ partKey: 'part-1', bodies }],
      instances: [{ componentId: 'component-1', partKey: 'part-1', visible: true, emphasis: 'none',
        placement: placementAt(5), subShapes: { hovered: null, selected: ['a#face:0', 'b#face:0'] } }],
    };
    const layer = createAssemblyLayer();
    try {
      layer.update(bundle, 'shadedWithEdges');
      const overlay = layer.group.getObjectByName('assembly-mate-highlight:component-1');
      expect(overlay?.children.map((child) => child.position.x)).toEqual([x, x + 100]);
      expect(overlay?.children.every((child) => child.children.length === 1)).toBe(true);
    } finally { layer.dispose(); }
  });

  it('uses component × body Double origins for both batches and CPU face picks', () => {
    const origins = [1e9, -1e9];
    const bodies = origins.map((x, index): SolidBody => ({ ...makeBody(`body-${String(index)}`),
      coordinateFrame: { space: 'local', origin: [x, 0, 0], maximumFloat32ErrorMm: 0.001 } }));
    const layer = createAssemblyLayer();
    try {
      layer.update({ parts: [{ partKey: 'part-1', bodies }], instances: [{
        componentId: 'component-1', partKey: 'part-1', visible: true, emphasis: 'none',
        placement: { position: [7, 8, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      }] }, 'shadedWithEdges');
      const faces = faceBatchesOf(layer);
      const edges = layer.group.children.filter((object): object is THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.LineBasicMaterial> =>
        isPartEdges(object) && object.geometry instanceof THREE.InstancedBufferGeometry);
      expect(faces).toHaveLength(2);
      expect(edges).toHaveLength(2);
      for (const [index, x] of origins.entries()) {
        const worldX = 7;
        const worldY = 8 + x;
        expect(faces[index].matrix.elements[12]).toBeCloseTo(worldX, 6);
        expect(faces[index].matrix.elements[13]).toBeCloseTo(worldY, 6);
        expect(edges[index].matrix.elements[12]).toBeCloseTo(worldX, 6);
        expect(edges[index].matrix.elements[13]).toBeCloseTo(worldY, 6);
        const instanceMatrix = new THREE.Matrix4();
        faces[index].getMatrixAt(0, instanceMatrix);
        expect(instanceMatrix.elements[12]).toBe(0);
        expect(instanceMatrix.elements[13]).toBe(0);
        const bounds = new THREE.Box3().setFromObject(faces[index]);
        expect(bounds.min.x).toBeCloseTo(6, 6);
        expect(bounds.max.y).toBeCloseTo(worldY + 1, 6);
        const ray = new THREE.Raycaster(new THREE.Vector3(6.8, worldY + 0.2, 5), new THREE.Vector3(0, 0, -1));
        expect(layer.pickMateFace(ray)).toEqual({ componentId: 'component-1', partKey: 'part-1',
          bodyFeatureId: `body-${String(index)}`, faceIndex: 0 });
      }
      const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
      layer.setSectionPlanes([plane]);
      expect(faces.every((face) => isPartMesh(face) && face.material.clippingPlanes?.[0] === plane)).toBe(true);
    } finally { layer.dispose(); }
  });

  it('keeps 50 local instances in one precise batch and falls back only for a distant slot', () => {
    const body: SolidBody = { ...makeBody('local'), coordinateFrame: {
      space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.001,
    } };
    const input = sameParts(MANY_INSTANCES);
    const bodies = [body];
    const layer = createAssemblyLayer();
    try {
      layer.update(buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', bodies]]) }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)).toHaveLength(1);
      expect(faceBatchesOf(layer)[0].count).toBe(MANY_INSTANCES);
      expect(firstEdges(layer).geometry.instanceCount).toBe(MANY_INSTANCES);
      const regular = new THREE.Raycaster(new THREE.Vector3(1e9 + 490.2, 0.2, 5), new THREE.Vector3(0, 0, -1));
      expect(layer.pickMateFace(regular)?.componentId).toBe('component-50');
      const placements = new Map(input.placements);
      placements.set('component-50', placementAt(1e9 + 0.125));
      layer.update(buildAssemblyGeometry({ ...input, placements, bodies: new Map([['part-1', bodies]]) }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)[0].count).toBe(MANY_INSTANCES - 1);
      expect(firstEdges(layer).geometry.instanceCount).toBe(MANY_INSTANCES - 1);
      const fallback = layer.group.children.find((object): object is THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> =>
        isPartMesh(object) && !(object instanceof THREE.InstancedMesh));
      if (fallback === undefined) throw new Error('missing local-frame fallback');
      expect(fallback.matrix.elements[12]).toBe(2e9 + 0.125);
      const distant = new THREE.Raycaster(new THREE.Vector3(2e9 + 0.325, 0.2, 5), new THREE.Vector3(0, 0, -1));
      expect(layer.pickMateFace(distant)).toEqual({ componentId: 'component-50', partKey: 'part-1',
        bodyFeatureId: 'local', faceIndex: 0 });
    } finally { layer.dispose(); }
  });

  it('rejects a sparse local frame rather than drawing it as world coordinates', () => {
    const origin: [number, number, number] = [1e9, 0, 0];
    Reflect.deleteProperty(origin, '0');
    const body: SolidBody = { ...makeBody('invalid'), coordinateFrame: {
      space: 'local', origin, maximumFloat32ErrorMm: 0.001,
    } };
    const layer = createAssemblyLayer();
    try {
      expect(() => layer.update({ parts: [{ partKey: 'part-1', bodies: [body] }], instances: [{
        componentId: 'component-1', partKey: 'part-1', visible: true, emphasis: 'none',
        placement: placementAt(0),
      }] }, 'shadedWithEdges')).toThrow(RangeError);
      expect(layer.group.children).toHaveLength(0);
    } finally { layer.dispose(); }
  });

  it('retains two local body shapes through 100 placement changes and releases each once', () => {
    const bodies: SolidBody[] = [1e9, -1e9].map((x, index): SolidBody => ({
      ...makeBody(`lifetime-${String(index)}`),
      coordinateFrame: { space: 'local', origin: [x, 0, 0], maximumFloat32ErrorMm: 0.001 },
    }));
    const layer = createAssemblyLayer();
    const bundleAt = (x: number): AssemblyGeometryBundle => ({
      parts: [{ partKey: 'part-1', bodies }],
      instances: [{ componentId: 'component-1', partKey: 'part-1', visible: true,
        emphasis: 'none', placement: placementAt(x) }],
    });
    try {
      layer.update(bundleAt(0), 'shadedWithEdges');
      const shapes = geometriesOf(layer.group);
      expect(shapes.size).toBe(4);
      const disposals = [...shapes].map((shape) => {
        const disposed = vi.fn();
        shape.addEventListener('dispose', disposed);
        return disposed;
      });
      for (let update = 1; update <= 100; update += 1) {
        layer.update(bundleAt(update * 0.125), 'shadedWithEdges');
        expect(geometriesOf(layer.group)).toEqual(shapes);
        expect(layer.group.children).toHaveLength(4);
      }
      layer.update({ parts: [], instances: [] }, 'shadedWithEdges');
      expect(layer.group.children).toHaveLength(0);
      for (const disposed of disposals) expect(disposed).toHaveBeenCalledTimes(1);
      layer.dispose();
      for (const disposed of disposals) expect(disposed).toHaveBeenCalledTimes(1);
    } finally { layer.dispose(); }
  });

  it('keeps face, edge and vertex overlay geometry local to each body under component rotation', () => {
    const framed = (id: string, x: number): SolidBody => {
      const source = makeBody(id);
      return {
        ...source,
        coordinateFrame: { space: 'local', origin: [x, 0, 0], maximumFloat32ErrorMm: 0.001 },
        edges: [{ index: 0, curveKind: 'line', length: 1, midpoint: [x + 0.5, 0, 0],
          start: [x, 0, 0], end: [x + 1, 0, 0], axis: null, radius: null,
          segmentOffset: 0, segmentCount: 1 }],
        vertices: [{ index: 0, position: [x + 0.125, 0, 0] }],
      };
    };
    const bodies = [framed('positive', 1e6), framed('negative', -1e9)];
    const instance: AssemblyGeometryBundle['instances'][number] = {
      componentId: 'component-1', partKey: 'part-1', visible: true, emphasis: 'none',
      placement: { position: [7, 8, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      subShapes: { hovered: null, selected: [
        'positive#face:0', 'positive#edge:0', 'positive#vertex:0',
        'negative#face:0', 'negative#edge:0', 'negative#vertex:0',
      ] },
    };
    const bundle: AssemblyGeometryBundle = { parts: [{ partKey: 'part-1', bodies }], instances: [instance] };
    const layer = createAssemblyLayer();
    try {
      layer.update(bundle, 'shadedWithEdges');
      const overlay = layer.group.getObjectByName('assembly-mate-highlight:component-1');
      if (overlay === undefined) throw new Error('missing assembly overlay');
      expect(overlay.children.map((body) => body.name)).toEqual([
        'assembly-mate-body:positive', 'assembly-mate-body:negative',
      ]);
      for (const [index, x] of [1e6, -1e9].entries()) {
        const bodyGroup = overlay.children[index];
        expect(bodyGroup.position.x).toBe(x);
        expect(bodyGroup.children).toHaveLength(3);
        const face = bodyGroup.children.find((entry) => entry instanceof THREE.Mesh);
        const edge = bodyGroup.children.find((entry) => entry instanceof THREE.LineSegments);
        const point = bodyGroup.children.find((entry) => entry instanceof THREE.Points);
        if (!(face instanceof THREE.Mesh) || !(edge instanceof THREE.LineSegments)
          || !(point instanceof THREE.Points)
          || !(face.geometry instanceof THREE.BufferGeometry)
          || !(edge.geometry instanceof THREE.BufferGeometry)
          || !(point.geometry instanceof THREE.BufferGeometry)) throw new Error('missing overlay kind');
        const facePosition: unknown = face.geometry.getAttribute('position');
        const edgePosition: unknown = edge.geometry.getAttribute('position');
        const pointPosition: unknown = point.geometry.getAttribute('position');
        if (!(facePosition instanceof THREE.BufferAttribute)
          || !(edgePosition instanceof THREE.BufferAttribute)
          || !(pointPosition instanceof THREE.BufferAttribute)) throw new Error('missing overlay position');
        expect([...facePosition.array.slice(0, 3)]).toEqual([0, 0, 0]);
        expect([...edgePosition.array.slice(0, 3)]).toEqual([0, 0, 0]);
        expect([...pointPosition.array]).toEqual([0, 0, 0, 1, 0, 0, 0.125, 0, 0]);
        expect(face.geometry.getIndex()?.count).toBe(3);
        bodyGroup.updateWorldMatrix(true, true);
        const world = bodyGroup.localToWorld(new THREE.Vector3(0.125, 0, 0));
        expect(world.x).toBeCloseTo(7, 6);
        expect(world.y).toBeCloseTo(8 + x + 0.125, 6);
      }
      const firstFace = overlay.children[0].children[0];
      if (!(firstFace instanceof THREE.Mesh) || !(firstFace.material instanceof THREE.MeshBasicMaterial)
        || !(firstFace.geometry instanceof THREE.BufferGeometry)) {
        throw new Error('missing face material or geometry');
      }
      const geometry = firstFace.geometry;
      const material = firstFace.material;
      const geometryDisposed = vi.fn();
      const materialDisposed = vi.fn();
      geometry.addEventListener('dispose', geometryDisposed);
      material.addEventListener('dispose', materialDisposed);
      const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
      layer.setSectionPlanes([plane]);
      layer.setThemeColors({ ...DEFAULT_THEME_COLORS, selected: 0x123456 });
      layer.update({ ...bundle }, 'shadedWithEdges');
      expect(material.clippingPlanes?.[0]).toBe(plane);
      expect(material.color.getHex()).toBe(0x123456);
      for (let cycle = 0; cycle < 100; cycle += 1) {
        layer.update({ ...bundle }, 'shadedWithEdges');
        expect(layer.group.getObjectByName(overlay.name)).toBe(overlay);
      }
      layer.update({ ...bundle, instances: [{ ...instance, subShapes: undefined }] }, 'shadedWithEdges');
      expect(geometryDisposed).toHaveBeenCalledTimes(1);
      expect(materialDisposed).toHaveBeenCalledTimes(1);
      layer.update(bundle, 'shadedWithEdges');
      expect(layer.group.getObjectByName(overlay.name)).not.toBe(overlay);
    } finally { layer.dispose(); }
  });
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
      const mesh = overlay?.children.flatMap((bodyGroup) => bodyGroup.children)
        .find((object) => object instanceof THREE.Mesh);
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
  it('断面の平面を面と稜線へ配り、解除時は空へ戻す(P7 タスク26)', () => {
    const layer = createAssemblyLayer();
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -5);
    layer.update(buildAssemblyGeometry(sameParts(2)), 'shadedWithEdges');
    layer.setSectionPlanes([plane]);
    const materials = materialsOf(layer.group);
    expect(materials.size).toBeGreaterThanOrEqual(2);
    for (const material of materials) expect(material.clippingPlanes).toEqual([plane]);
    layer.setSectionPlanes([]);
    for (const material of materials) expect(material.clippingPlanes).toEqual([]);
    layer.dispose();
  });

  it('断面を先に入れても後から作る共有材質へ同じ平面を配る', () => {
    const layer = createAssemblyLayer();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    layer.setSectionPlanes([plane]);
    layer.update(buildAssemblyGeometry(sameParts(1)), 'shadedWithEdges');
    for (const material of materialsOf(layer.group)) expect(material.clippingPlanes).toEqual([plane]);
    layer.dispose();
  });
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
  it('picks independent hole walls at A=0 and B=60 through selection/hover updates before any render', () => {
    // Analytic fixture mesh, actual Three ray intersections: no mocked hit or renderer.
    // This isolates the proposed pre-render matrix failure; it does not reproduce native E2E ownership.
    const holeWall = (featureId: string): SolidBody => {
      const geometry = new THREE.CylinderGeometry(3, 3, 10, 32, 1, true);
      try {
        geometry.rotateX(Math.PI / 2);
        geometry.translate(20, 15, 5);
        const positions = Float32Array.from(geometry.getAttribute('position').array);
        const normals = Float32Array.from(geometry.getAttribute('normal').array, value => -value);
        const index = geometry.getIndex();
        if (index === null) throw new Error('Indexed hole-wall fixture required');
        const indices = Uint32Array.from(index.array);
        for (let at = 0; at < indices.length; at += 3) {
          const previous = indices[at]; indices[at] = indices[at + 2]; indices[at + 2] = previous;
        }
        const triangleCount = indices.length / 3;
        return { ...makeBody(featureId), mesh: { positions, normals, indices,
          edgePositions: new Float32Array(), triangleCount },
          faces: [{ index: 0, surfaceKind: 'cylinder', area: 60 * Math.PI, centroid: [20, 15, 5],
            axis: [0, 0, 1], axisOrigin: [20, 15, 0], radius: 3, triangleOffset: 0, triangleCount }] };
      } finally { geometry.dispose(); }
    };
    const a = holeWall('hole-A'), b = holeWall('hole-B');
    const parts = [{ partKey: 'saved-part-A', bodies: [a] }, { partKey: 'saved-part-B', bodies: [b] }];
    expect(a.mesh.positions).not.toBe(b.mesh.positions);
    const first = { componentId: 'component-A', partKey: parts[0].partKey, visible: true,
      emphasis: 'none' as const, placement: placementAt(0) };
    const second = { componentId: 'component-B', partKey: parts[1].partKey, visible: true,
      emphasis: 'none' as const, placement: placementAt(60) };
    const eye = new THREE.Vector3(200 / Math.sqrt(3), -200 / Math.sqrt(3), 200 / Math.sqrt(3));
    const inset = 3 * Math.SQRT1_2;
    const rayAt = (x: number): THREE.Raycaster => new THREE.Raycaster(eye.clone(),
      new THREE.Vector3(x - inset, 15 + inset, 9).sub(eye).normalize());
    const layer = createAssemblyLayer();
    const scene = new THREE.Scene();
    scene.matrixAutoUpdate = false;
    scene.add(layer.group);
    try {
      layer.update({ parts, instances: [first, second] }, 'shadedWithEdges');
      expect(layer.pickMateFace(rayAt(20))).toEqual({ componentId: first.componentId,
        partKey: first.partKey, bodyFeatureId: a.featureId, faceIndex: 0 });
      // The actual A-select -> B-hover transition rebuilds overlays but must retain B's placement/face map.
      layer.update({ parts, instances: [
        { ...first, subShapes: { hovered: null, selected: ['hole-A#face:0'] } },
        { ...second, subShapes: { hovered: 'hole-B#face:0', selected: [] } },
      ] }, 'shadedWithEdges');
      expect(layer.pickMateFace(rayAt(80))).toEqual({ componentId: second.componentId,
        partKey: second.partKey, bodyFeatureId: b.featureId, faceIndex: 0 });
      expect(layer.pickMateFace(rayAt(20))).toEqual({ componentId: first.componentId,
        partKey: first.partKey, bodyFeatureId: a.featureId, faceIndex: 0 });
    } finally { layer.dispose(); }
  });

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
    process.stdout.write(`[PG3b measure] instances=${MANY_INSTANCES} rounds=${MEASURE_ROUNDS} averageMs=${elapsed.toFixed(6)} practicalLimitMs=100\n`);
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

describe('assembly shared backing reservations and update transactions', () => {
  const down = new THREE.Vector3(0, 0, -1);
  const rayAt = (x: number, y = 0.2, z = 5): THREE.Raycaster => new THREE.Raycaster(new THREE.Vector3(x, y, z), down);
  it.each(['rejected', 'published'] as const)('does not skip actual asset returns when finally registration fails after %s publication', outcome => {
    const ledger = new AssemblyUiBackingLedger(), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { uiBackings: ledger, gpuMeshBudget: pool });
    const input = sameParts(2), oldBundle = buildAssemblyGeometry(input);
    layer.update(oldBundle, 'shadedWithEdges');
    const oldChildren = [...layer.group.children], before = layer.meshReservation();
    const oldPick = layer.pickComponent(rayAt(0.002, 0.002));
    const borrower = new Float32Array(6), oldGeometries = new Set<object>();
    for (const child of oldChildren) if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      const geometry: unknown = child.geometry;
      if (!(geometry instanceof THREE.BufferGeometry)) throw new Error('Actual published geometry required');
      oldGeometries.add(geometry);
    }
    let registrationFails = false;
    const adopt = ledger.adopt.bind(ledger);
    const registration = vi.spyOn(ledger, 'adopt').mockImplementation(buffers => {
      const actual = [...buffers];
      if (registrationFails && actual.includes(borrower.buffer)) throw new Error('actual final backing registration refused');
      adopt(actual);
    });
    const add = layer.group.add.bind(layer.group);
    const acquired = new Set<object>();
    const publication = vi.spyOn(layer.group, 'add').mockImplementation((...objects) => {
      add(...objects);
      for (const object of objects) if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        const geometry: unknown = object.geometry;
        if (!(geometry instanceof THREE.BufferGeometry)) throw new Error('Actual acquired geometry required');
        acquired.add(geometry);
        if (object instanceof THREE.Mesh && geometry.getAttribute('uv') !== undefined) {
          geometry.setAttribute('uv', new THREE.BufferAttribute(borrower, 2));
        }
      }
      registrationFails = true;
      if (outcome === 'rejected') throw new Error('actual publication rejected after add');
      return layer.group;
    });
    const returns = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const next = buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBody('new-finally-owner')]]]) });
    try {
      if (outcome === 'rejected') {
        expect(() => layer.update(next, 'shadedWithEdges')).toThrow('actual publication rejected after add');
        expect(layer.group.children).toEqual(oldChildren);
        expect(layer.pickComponent(rayAt(0.002, 0.002))).toBe(oldPick);
        expect(layer.meshReservation()).toEqual(before);
        expect([...acquired].every(geometry => returns.mock.contexts.includes(geometry))).toBe(true);
        expect([...oldGeometries].every(geometry => !returns.mock.contexts.includes(geometry))).toBe(true);
      } else {
        expect(() => layer.update(next, 'shadedWithEdges')).not.toThrow();
        expect(layer.group.children.some(child => oldChildren.includes(child))).toBe(false);
        expect([...oldGeometries].every(geometry => returns.mock.contexts.includes(geometry))).toBe(true);
        expect([...acquired].every(geometry => !returns.mock.contexts.includes(geometry))).toBe(true);
      }
      expect(acquired.size).toBeGreaterThan(0);
      expect(layer.meshReservation().cleanupStatus).toBe('complete');
      expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
      expect(ledger.pending()).toBe(0); expect(ledger.known()).toBe(false);
      expect(borrower.buffer.byteLength).toBe(24);
      expect(() => ledger.reserve({}, 0, 0, 100000)).toThrow('registration is unknown');
      registrationFails = false; publication.mockRestore();
      ledger.retryRegistration();
      expect(ledger.known()).toBe(true); expect(ledger.buffers()).toContain(borrower.buffer);
      expect(() => layer.update(oldBundle, 'shadedWithEdges')).not.toThrow();
      layer.dispose();
      expect(ledger.pending()).toBe(0); expect(pool.reservedBytes()).toBe(0);
      expect(ledger.bytes()).toBeGreaterThanOrEqual(borrower.buffer.byteLength);
    } finally { registrationFails = false; publication.mockRestore(); registration.mockRestore(); returns.mockRestore(); layer.dispose(); }
  });

  it('keeps the historical world source union path distinct from supplied unknown budget evidence', () => {
    let unknown = false;
    const layer = createAssemblyLayer(undefined, { readBudget: () => unknown ? null : undefined });
    try {
      const bundle = buildAssemblyGeometry(sameParts(2));
      layer.update(bundle, 'shadedWithEdges');
      const before = layer.meshReservation(), children = [...layer.group.children];
      expect(before.sourceBackingBytes).toBeGreaterThan(0);
      unknown = true;
      expect(() => layer.update(bundle, 'shadedWithEdges')).toThrow('receipt is unknown');
      expect(layer.meshReservation()).toEqual(before);
      expect(layer.group.children).toEqual(children);
      unknown = false;
      expect(() => layer.update(bundle, 'shadedWithEdges')).not.toThrow();
    } finally { layer.dispose(); }
  });

  it('keeps exact registered rollback backings across 100 updates and restores a failed capacity growth with borrowers alive', () => {
    const ledger = new AssemblyUiBackingLedger(), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { uiBackings: ledger, gpuMeshBudget: pool });
    const input = sameParts(2);
    layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
    const first = ledger.buffers(), bytes = ledger.bytes();
    const face = layer.group.children.find(child => child instanceof THREE.InstancedMesh);
    if (!(face instanceof THREE.InstancedMesh)) throw new Error('Actual instanced face');
    const borrower = face.instanceMatrix.array;
    const add = layer.group.add.bind(layer.group);
    let refuse = true;
    const publication = vi.spyOn(layer.group, 'add').mockImplementation((...objects) => {
      add(...objects);
      if (refuse) throw new Error('Actual capacity publication refused');
      return layer.group;
    });
    try {
      for (let cycle = 0; cycle < 100; cycle += 1) {
        layer.update(buildAssemblyGeometry({ ...sameParts(2, cycle), bodies: input.bodies }), 'shadedWithEdges');
        expect(ledger.buffers()).toEqual(first);
        expect(ledger.bytes()).toBe(bytes);
        expect(ledger.pending()).toBe(0);
      }
      const before = layer.meshReservation(), children = [...layer.group.children];
      const values = Array.from(borrower);
      const setMatrix = face.setMatrixAt.bind(face);
      const mutation = vi.spyOn(face, 'setMatrixAt').mockImplementation((...args) => {
        setMatrix(...args);
        throw new Error('Actual in-place matrix update refused');
      });
      try {
        expect(() => layer.update(buildAssemblyGeometry({ ...sameParts(2, 200), bodies: input.bodies }), 'shadedWithEdges'))
          .toThrow('Actual in-place matrix update refused');
        expect(Array.from(borrower)).toEqual(values);
        expect(layer.group.children).toEqual(children);
        expect(layer.meshReservation()).toEqual(before);
        expect(ledger.buffers()).toEqual(first);
        expect(ledger.pending()).toBe(0);
      } finally { mutation.mockRestore(); }
      expect(() => layer.update(buildAssemblyGeometry({ ...sameParts(5), bodies: input.bodies }), 'shadedWithEdges'))
        .toThrow('Actual capacity publication refused');
      expect(layer.group.children).toEqual(children);
      expect(layer.meshReservation()).toEqual(before);
      expect(Array.from(borrower)).toEqual(values);
      expect(ledger.buffers()).toContain(borrower.buffer);
      expect(ledger.bytes()).toBeGreaterThan(bytes);
      expect(ledger.pending()).toBe(0);
      refuse = false;
      layer.update(buildAssemblyGeometry({ ...sameParts(5), bodies: input.bodies }), 'shadedWithEdges');
      layer.dispose();
      expect(pool.reservedBytes()).toBe(0);
      expect(ledger.pending()).toBe(0);
      expect(ledger.buffers()).toContain(borrower.buffer);
      expect(ledger.bytes()).toBeGreaterThan(0);
    } finally { refuse = false; publication.mockRestore(); layer.dispose(); }
  });

  it('rolls back initial publication when actual rollback storage cannot be reserved', () => {
    const input = sameParts(2), probe = createAssemblyLayer(undefined, { uiBackings: new AssemblyUiBackingLedger() });
    probe.update(buildAssemblyGeometry(input), 'shadedWithEdges');
    const reading = probe.meshReservation();
    probe.dispose();
    const ledger = new AssemblyUiBackingLedger(), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { uiBackings: ledger, gpuMeshBudget: pool,
      limitBytes: Math.max(reading.sourceBackingBytes + reading.displayCopyBytes + reading.instanceBytes, reading.gpuMeshBytes) });
    const acquired = vi.spyOn(layer.group, 'add');
    try {
      expect(() => layer.update(buildAssemblyGeometry(input), 'shadedWithEdges')).toThrow(/live-byte budget/);
      expect(acquired.mock.calls.flat().some(child => child instanceof THREE.InstancedMesh)).toBe(true);
      expect(acquired.mock.calls.flat().some(child => child instanceof THREE.LineSegments)).toBe(true);
      expect(layer.group.children).toHaveLength(0);
      expect(layer.meshReservation().gpuMeshBytes).toBe(0);
      expect(pool.reservedBytes()).toBe(0);
      expect(ledger.pending()).toBe(0);
      expect(ledger.bytes()).toBeGreaterThan(0);
    } finally { acquired.mockRestore(); layer.dispose(); }
  });

  it('checks the shared actual attribute reservations of another Layer against a smaller fresh limit', () => {
    const pool = createGpuMeshBudget(100000), ledger = new AssemblyUiBackingLedger();
    let limit = 100000;
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool, uiBackings: ledger, readBudget: () => ({
      limitBytes: limit, baselineBytes: 0, isCurrent: () => true }) });
    const peer = createAssemblyLayer(undefined, { gpuMeshBudget: pool, uiBackings: ledger });
    try {
      const bundle = buildAssemblyGeometry(sameParts(2));
      layer.update(bundle, 'shadedWithEdges');
      peer.update(buildAssemblyGeometry(sameParts(1)), 'shadedWithEdges');
      const total = pool.reservedBytes(), before = layer.meshReservation(), children = [...layer.group.children];
      const admittedBound = Math.max(total, ledger.bytes());
      expect(total).toBeGreaterThan(before.gpuMeshBytes);
      limit = admittedBound - 1;
      expect(() => layer.update(bundle, 'shadedWithEdges')).toThrow('live-byte budget');
      expect(pool.reservedBytes()).toBe(total);
      expect(layer.meshReservation()).toEqual(before);
      expect(layer.group.children).toEqual(children);
      limit = admittedBound;
      expect(() => layer.update(bundle, 'shadedWithEdges')).not.toThrow();
    } finally { peer.dispose(); layer.dispose(); }
  });

  it('independently returns all assets when actual group.clear throws, retaining only failed detach for retry', () => {
    const pool = createGpuMeshBudget(100000), ledger = new AssemblyUiBackingLedger();
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool, uiBackings: ledger });
    layer.update(buildAssemblyGeometry(sameParts(2)), 'shadedWithEdges');
    const before = pool.reservedBytes(), children = [...layer.group.children];
    const clear = layer.group.clear.bind(layer.group);
    let refuse = true;
    const detach = vi.spyOn(layer.group, 'clear').mockImplementation(() => {
      if (refuse) throw new Error('actual Assembly detach refused');
      return clear();
    });
    const returns = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    try {
      expect(() => layer.dispose()).not.toThrow();
      expect(returns.mock.contexts.length).toBeGreaterThan(0);
      const released = [...returns.mock.contexts];
      expect(new Set(released).size).toBe(released.length);
      expect(layer.meshReservation().cleanupStatus).toBe('pending');
      expect(pool.reservedBytes()).toBe(before);
      expect(layer.group.children).toEqual(children);
      refuse = false;
      layer.dispose();
      expect(detach).toHaveBeenCalledTimes(2);
      expect(returns.mock.contexts).toEqual(released);
      expect(layer.group.children).toHaveLength(0);
      expect(layer.meshReservation().cleanupStatus).toBe('complete');
      expect(pool.reservedBytes()).toBe(0);
      expect(ledger.pending()).toBe(0);
    } finally { detach.mockRestore(); returns.mockRestore(); layer.dispose(); }
  });

  it.each(['before', 'after'] as const)('keeps candidate resources reachable when actual group.add throws %s mutation', position => {
    const pool = createGpuMeshBudget(100000), layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    const input = sameParts(2), oldBundle = buildAssemblyGeometry(input);
    layer.update(oldBundle, 'shadedWithEdges');
    const children = [...layer.group.children], before = layer.meshReservation();
    const pick = layer.pickComponent(rayAt(0.002, 0.002));
    const add = layer.group.add.bind(layer.group);
    const publication = vi.spyOn(layer.group, 'add').mockImplementation((...objects) => {
      if (position === 'before') throw new Error('actual Assembly publication add refused');
      add(...objects);
      throw new Error('actual Assembly publication add refused');
    });
    let refuseReturn = true;
    const failed: THREE.BufferGeometry[] = [];
    const returned = new Set<THREE.BufferGeometry>();
    const original = Reflect.get(THREE.BufferGeometry.prototype, 'dispose');
    const release = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry): void {
      if (failed.length === 0) failed.push(this);
      if (refuseReturn && this === failed[0]) throw new Error('actual new geometry return refused');
      expect(returned.has(this)).toBe(false);
      original.call(this); returned.add(this);
    });
    try {
      const next = buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBody('next-published')]]]) });
      expect(() => layer.update(next, 'shadedWithEdges')).toThrow('publication add refused');
      expect(layer.group.children).toEqual(children);
      expect(children.every(child => child.parent === layer.group)).toBe(true);
      expect(layer.pickComponent(rayAt(0.002, 0.002))).toBe(pick);
      expect(release.mock.contexts.length).toBeGreaterThan(0);
      expect(layer.meshReservation().cleanupStatus).toBe('pending');
      expect(pool.reservedBytes()).toBeGreaterThanOrEqual(before.gpuMeshBytes);
      refuseReturn = false; publication.mockRestore();
      layer.update(oldBundle, 'shadedWithEdges');
      expect(layer.meshReservation().cleanupStatus).toBe('complete');
      expect(pool.reservedBytes()).toBe(before.gpuMeshBytes);
      expect(release.mock.contexts.filter(value => value === failed[0])).toHaveLength(2);
    } finally { publication.mockRestore(); release.mockRestore(); layer.dispose(); }
  });

  it('reads one fresh baseline and limit even when the published bundle is offered again', () => {
    let baseline = 0, limit = 100000, epoch = 1;
    const layer = createAssemblyLayer(undefined, { readBudget: () => {
      const capturedEpoch = epoch;
      return { baselineBytes: baseline, limitBytes: limit, isCurrent: () => epoch === capturedEpoch };
    } });
    try {
      const bundle = buildAssemblyGeometry(sameParts(2));
      layer.update(bundle, 'shadedWithEdges');
      const children = [...layer.group.children], reservation = layer.meshReservation();
      baseline = limit;
      expect(() => layer.update(bundle, 'shadedWithEdges')).toThrow('live-byte budget');
      expect(layer.group.children).toEqual(children);
      expect(layer.meshReservation()).toEqual(reservation);
      baseline = 0; limit = 1;
      expect(() => layer.update(bundle, 'shadedWithEdges')).toThrow('live-byte budget');
      expect(layer.group.children).toEqual(children);
      limit = 100000; epoch += 1;
      expect(() => layer.update(bundle, 'shadedWithEdges')).not.toThrow();
    } finally { layer.dispose(); }
  });

  it('rejects unknown, throwing and invalid fresh receipts before changing the old display', () => {
    let refusal: 'none' | 'unknown' | 'throw' | 'invalid' = 'none';
    const layer = createAssemblyLayer(undefined, { readBudget: () => {
      if (refusal === 'unknown') return null;
      if (refusal === 'throw') throw new Error('receipt getter refused');
      return { baselineBytes: refusal === 'invalid' ? NaN : 0, limitBytes: 100000, isCurrent: () => true };
    } });
    try {
      const input = sameParts(2), bundle = buildAssemblyGeometry(input);
      layer.update(bundle, 'shadedWithEdges');
      const children = [...layer.group.children], reservation = layer.meshReservation();
      for (const kind of ['unknown', 'throw', 'invalid'] as const) {
        refusal = kind;
        expect(() => layer.update(buildAssemblyGeometry(input), 'shadedWithEdges')).toThrow();
        expect(layer.group.children).toEqual(children);
        expect(layer.meshReservation()).toEqual(reservation);
      }
      refusal = 'none';
      expect(() => layer.update(buildAssemblyGeometry(input), 'shadedWithEdges')).not.toThrow();
    } finally { layer.dispose(); }
  });

  it('refuses an epoch change at the first actual candidate allocation and restores old pick targets', () => {
    let checks = 0, invalidate = false;
    const pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool, readBudget: () => ({
      baselineBytes: 0, limitBytes: 100000,
      isCurrent: () => !invalidate || ++checks < 2,
    }) });
    try {
      const input = sameParts(2);
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const children = [...layer.group.children], reservation = layer.meshReservation();
      const oldPick = layer.pickComponent(rayAt(0.002, 0.002));
      invalidate = true;
      expect(() => layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [makeBody('changed')]]]) }), 'shadedWithEdges')).toThrow('owner changed');
      expect(layer.group.children).toEqual(children);
      expect(layer.meshReservation()).toEqual(reservation);
      expect(layer.pickComponent(rayAt(0.002, 0.002))).toBe(oldPick);
      invalidate = false;
      expect(() => layer.update(buildAssemblyGeometry(input), 'shadedWithEdges')).not.toThrow();
    } finally { layer.dispose(); }
  });

  it('hands successful factory materials to the controller without disposing them', () => {
    const returned: THREE.LineBasicMaterial[] = [];
    const original = Reflect.get(THREE.LineBasicMaterial.prototype, 'setValues');
    const acquire = vi.spyOn(THREE.LineBasicMaterial.prototype, 'setValues').mockImplementation(function (
      this: THREE.LineBasicMaterial, values: Parameters<THREE.Material['setValues']>[0],
    ): void { original.call(this, values); returned.push(this); });
    const release = vi.spyOn(THREE.Material.prototype, 'dispose');
    try {
      const layer = createAssemblyLayer();
      expect(returned).toHaveLength(4);
      expect(release).not.toHaveBeenCalled();
      layer.dispose(); layer.dispose();
      for (const material of returned) expect(release.mock.contexts.filter(context => context === material)).toHaveLength(1);
    } finally { acquire.mockRestore(); release.mockRestore(); }
  });

  it('returns every earlier material after a later constructor throws and keeps only failed release', () => {
    const createPattern = vi.fn(() => null), disposePatterns = vi.fn();
    const patterns: PatternTextureSource = { create: createPattern, disposeAll: disposePatterns };
    const returned: THREE.LineBasicMaterial[] = [];
    const original = Reflect.get(THREE.LineBasicMaterial.prototype, 'setValues');
    const acquire = vi.spyOn(THREE.LineBasicMaterial.prototype, 'setValues').mockImplementation(function (
      this: THREE.LineBasicMaterial, values: Parameters<THREE.Material['setValues']>[0],
    ): void {
      if (returned.length === 2) throw new Error('later assembly material constructor');
      original.call(this, values); returned.push(this);
    });
    let refuse = true;
    const dispose = Reflect.get(THREE.Material.prototype, 'dispose');
    const release = vi.spyOn(THREE.Material.prototype, 'dispose').mockImplementation(function (this: THREE.Material): void {
      if (this === returned[0] && refuse) throw new Error('retained assembly material');
      dispose.call(this);
    });
    try {
      let failure: ViewportResourceInitializationFailure | null = null;
      try { createAssemblyLayer(patterns); }
      catch (error) { if (error instanceof ViewportResourceInitializationFailure) failure = error; else throw error; }
      expect(failure).not.toBeNull();
      expect(returned).toHaveLength(2);
      expect(failure?.cleanup.pendingCount).toBe(1);
      expect(release.mock.contexts.filter(context => context === returned[1])).toHaveLength(1);
      expect(createPattern).not.toHaveBeenCalled();
      expect(disposePatterns).not.toHaveBeenCalled();
      refuse = false;
      failure?.cleanup.dispose(); failure?.cleanup.dispose();
      expect(failure?.cleanup.pendingCount).toBe(0);
      expect(release.mock.contexts.filter(context => context === returned[0])).toHaveLength(2);
      expect(release.mock.contexts.filter(context => context === returned[1])).toHaveLength(1);
      acquire.mockRestore();
      const fresh = createAssemblyLayer(); fresh.dispose();
    } finally { acquire.mockRestore(); release.mockRestore(); }
  });

  it('keeps a published generation when retirement throws, tries every release and retries retained debt', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const oldFace = faceBatchesOf(layer)[0], oldEdge = firstEdges(layer).geometry;
      const otherReleased = vi.fn();
      oldEdge.addEventListener('dispose', otherReleased);
      const refusal = () => { throw new Error('old geometry release refused'); };
      oldFace.geometry.addEventListener('dispose', refusal);
      const next = buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBody('new-body')]]]) });
      expect(() => layer.update(next, 'shadedWithEdges')).not.toThrow();
      const newFace = faceBatchesOf(layer)[0];
      expect(newFace).not.toBe(oldFace);
      expect(otherReleased).toHaveBeenCalledTimes(1);
      expect(layer.meshReservation().cleanupStatus).toBe('pending');
      expect(layer.meshReservation().cleanupReservedCpuBytes).toBeGreaterThan(0);
      expect(layer.meshReservation().uncovered).toContain('retiredResources');
      expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
      // Rendering the committed bundle needs no new allocation and remains usable.
      expect(() => layer.update(next, 'shadedWithEdges')).not.toThrow();
      const replacement = buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBody('third-body')]]]) });
      expect(() => layer.update(replacement, 'shadedWithEdges')).toThrow(/cleanup is pending/);
      expect(faceBatchesOf(layer)[0]).toBe(newFace);
      oldFace.geometry.removeEventListener('dispose', refusal);
      layer.update(replacement, 'shadedWithEdges');
      expect(layer.meshReservation().cleanupStatus).toBe('complete');
      expect(layer.meshReservation().cleanupReservedCpuBytes).toBe(0);
      expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('restores the old display before a rollback material release fails and still disposes all new geometry', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(100000);
    let rejectPublication = false, checks = 0;
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool,
      isCurrent: () => !rejectPublication || ++checks === 1 });
    try {
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const oldChildren = [...layer.group.children], oldFace = faceBatchesOf(layer)[0];
      const oldReleased = vi.fn(); oldFace.geometry.addEventListener('dispose', oldReleased);
      const replacement = buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [makeBody('extrude-1')]]]),
        appearances: new Map([['part-1', { defaultAppearance: appearanceFromPreset('plastic'), byBody: new Map() }]]) });
      const materialFailure = vi.spyOn(THREE.MeshStandardMaterial.prototype, 'dispose').mockImplementation(() => {
        throw new Error('candidate material release refused');
      });
      const geometryRelease = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
      const meshRelease = vi.spyOn(THREE.InstancedMesh.prototype, 'dispose');
      rejectPublication = true;
      try {
        expect(() => layer.update(replacement, 'shadedWithEdges')).toThrow('Assembly display owner changed');
        expect(layer.group.children).toEqual(oldChildren);
        expect(faceBatchesOf(layer)[0]).toBe(oldFace);
        expect(oldReleased).not.toHaveBeenCalled();
        expect(geometryRelease.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(meshRelease).toHaveBeenCalled();
        expect(layer.meshReservation().cleanupStatus).toBe('pending');
        expect(layer.meshReservation().cleanupReservedCpuBytes).toBeGreaterThan(0);
        expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
        expect(() => layer.update(replacement, 'shadedWithEdges')).toThrow(/cleanup is pending/);
        expect(layer.group.children).toEqual(oldChildren);
      } finally { rejectPublication = false; materialFailure.mockRestore(); geometryRelease.mockRestore(); meshRelease.mockRestore(); }
      layer.update(replacement, 'shadedWithEdges');
      expect(oldReleased).toHaveBeenCalledTimes(1);
      expect(layer.meshReservation().cleanupStatus).toBe('complete');
      expect(layer.meshReservation().cleanupReservedCpuBytes).toBe(0);
      expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('keeps both GPU generations reserved while old geometry is retired', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const before = pool.reservedBytes();
      const duringRetirement: number[] = [];
      faceBatchesOf(layer)[0].geometry.addEventListener('dispose', () => duringRetirement.push(pool.reservedBytes()));
      layer.update(buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBody('new-generation')]]]) }), 'shadedWithEdges');
      expect(duringRetirement).toHaveLength(1);
      expect(duringRetirement[0]).toBeGreaterThanOrEqual(before + layer.meshReservation().gpuMeshBytes);
      expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('returns partial overlay reservations after failure and recovers without replacing shared geometry', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      const initial = buildAssemblyGeometry(input);
      layer.update(initial, 'shadedWithEdges');
      const children = [...layer.group.children], before = layer.meshReservation();
      const ref = subShapeRefOf(initial.parts[0].bodies, 'extrude-1#face:0');
      if (ref === null) throw new Error('fixture needs face reference');
      const selected = buildAssemblyGeometry({ ...input,
        selectedTargetIds: [assemblyTargetId({ componentId: 'component-1', kind: 'subShape', ref })] });
      const injection = vi.spyOn(THREE.BufferGeometry.prototype, 'setAttribute').mockImplementationOnce(() => {
        throw new Error('overlay attribute allocation failed');
      });
      try { expect(() => layer.update(selected, 'shadedWithEdges')).toThrow('overlay attribute allocation failed'); }
      finally { injection.mockRestore(); }
      expect(layer.group.children).toEqual(children);
      expect(layer.meshReservation()).toEqual(before);
      expect(pool.reservedBytes()).toBe(before.gpuMeshBytes);
      layer.update(selected, 'shadedWithEdges');
      expect(faceBatchesOf(layer)[0].geometry).toBe((children.find(isPartMesh) as THREE.Mesh).geometry);
      expect(layer.meshReservation().displayCopyBytes).toBeGreaterThan(before.displayCopyBytes);
      layer.update(initial, 'shadedWithEdges');
      expect(layer.meshReservation()).toEqual(before);
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('keeps exact integer subsets through the IEEE boundary and rejects overflowing or cancelling sums', () => {
    // A separate shader calculation supplies the boundary oracle; no implementation helper is called.
    for (const [offset, expectedCount] of [[2 ** 24 - 2, 2], [2 ** 24 - 1, 2],
      [2 ** 24, 1], [2 ** 24 + 1, 1], [-(2 ** 24), 2], [-(2 ** 24) - 2, 1]] as const) {
      const input = sameParts(2);
      const matrix = new THREE.Matrix4().makeTranslation(offset, 0, 0);
      const point = new THREE.Vector3(1, 0, 0);
      const error = Math.abs(float32Transform(point, matrix).x - (offset + 1));
      expect(error === 0).toBe(expectedCount === 2);
      const layer = createAssemblyLayer();
      try {
        layer.update(buildAssemblyGeometry({ ...input,
          placements: new Map([['component-1', placementAt(0)], ['component-2', placementAt(offset)]]) }), 'shadedWithEdges');
        expect(faceBatchesOf(layer).map(face => face.count)).toEqual([expectedCount]);
      } finally { layer.dispose(); }
    }
    const first = Math.fround(2 ** 24), last = Math.fround(-(2 ** 24));
    expect(Math.fround(Math.fround(first + 1) + last)).toBe(0);
    expect(first + 1 + last).toBe(1);
    const input = sameParts(2), body = makeBody('cancellation');
    const positions = new Float32Array([2 ** 24, 1, 0, 2 ** 24, 2, 0, 2 ** 24 - 2, 1, 0]);
    const halfAngle = Math.PI / 8;
    const rotation: RigidPlacement['rotation'] = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
    const rotated = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().fromArray(rotation));
    const vertex = new THREE.Vector3().fromArray(positions);
    expect(float32Transform(vertex, rotated).distanceTo(vertex.clone().applyMatrix4(rotated))).toBeGreaterThan(1e-7);
    const layer = createAssemblyLayer();
    try {
      layer.update(buildAssemblyGeometry({ ...input,
        bodies: new Map([['part-1', [{ ...body, mesh: { ...body.mesh, positions, edgePositions: positions } }]]]),
        placements: new Map([['component-1', { position: [0, 0, 0], rotation }],
          ['component-2', { position: [-(2 ** 24), 0, 0], rotation }]]) }), 'shadedWithEdges');
      expect(faceBatchesOf(layer)).toHaveLength(0);
    } finally { layer.dispose(); }
  });

  it('counts shared source backings once, with capacity and distinct GPU attributes', () => {
    const base = makeBody('shared-backing');
    const backing = new ArrayBuffer(4096);
    const positions = new Float32Array(backing, 0, 9), normals = new Float32Array(backing, 36, 9);
    positions.set(base.mesh.positions); normals.set(base.mesh.normals);
    const body = { ...base, mesh: { ...base.mesh, positions, normals } };
    const input = sameParts(50);
    const pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      layer.update(buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [body]]]) }), 'shadedWithEdges');
      const reading = layer.meshReservation();
      expect(reading.sourceBackingBytes).toBe(4096 + 12 + 48);
      expect(reading.displayCopyBytes).toBe(24);
      expect(reading.instanceBytes).toBe(64 * (16 + 16 + 3) * 4);
      // Mesh attributes 156B, edge batch's separate position attribute 48B, instance attrs 8960B.
      expect(reading.gpuMeshBytes).toBe(156 + 48 + 8960);
      expect(pool.reservedBytes()).toBe(reading.gpuMeshBytes);
      expect(reading.uncovered).toContain('native');
      expect(reading.uncovered).toContain('pmrem');
      expect(Array.from(positions)).toEqual(Array.from(base.mesh.positions));
      expect(Array.from(normals)).toEqual(Array.from(base.mesh.normals));
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
    expect(layer.meshReservation().sourceBackingBytes).toBe(0);
    expect(layer.meshReservation().displayCopyBytes).toBe(0);
    expect(layer.meshReservation().instanceBytes).toBe(0);
  });

  it('refuses capacity growth before allocation and leaves published objects and pick unchanged', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(156 + 48 + 2 * 140);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0], edge = firstEdges(layer);
      const oldChildren = [...layer.group.children], oldMatrices = Array.from(face.instanceMatrix.array);
      const before = layer.meshReservation(), reserved = pool.reservedBytes();
      const setMatrix = vi.spyOn(THREE.InstancedMesh.prototype, 'setMatrixAt');
      try {
        expect(() => layer.update(buildAssemblyGeometry({ ...sameParts(5), bodies: input.bodies }), 'shadedWithEdges'))
          .toThrow(/live-byte budget/);
        expect(setMatrix).not.toHaveBeenCalled();
      } finally { setMatrix.mockRestore(); }
      expect(layer.group.children).toEqual(oldChildren);
      expect(faceBatchesOf(layer)[0]).toBe(face); expect(firstEdges(layer)).toBe(edge);
      expect(Array.from(face.instanceMatrix.array)).toEqual(oldMatrices);
      expect(layer.meshReservation()).toEqual(before); expect(pool.reservedBytes()).toBe(reserved);
      expect(layer.pickComponent(new THREE.Raycaster(new THREE.Vector3(10.2, 0.2, 5), new THREE.Vector3(0, 0, -1))))
        .toBe('component-2');
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('restores shared shapes after geometry construction throws, then accepts the independent retry', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(100000);
    const layer = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      layer.update(buildAssemblyGeometry(input), 'shadedWithEdges');
      const children = [...layer.group.children], shapes = geometriesOf(layer.group);
      const oldReservation = layer.meshReservation(), oldPool = pool.reservedBytes();
      const disposals = [...shapes].map(shape => { const disposed = vi.fn(); shape.addEventListener('dispose', disposed); return disposed; });
      const replacement = buildAssemblyGeometry({ ...input, bodies: new Map([['part-1', [makeBody('replacement')]]]) });
      const injection = vi.spyOn(THREE.BufferGeometry.prototype, 'setAttribute').mockImplementationOnce(() => {
        throw new Error('injected assembly normal failure');
      });
      try { expect(() => layer.update(replacement, 'shadedWithEdges')).toThrow('injected assembly normal failure'); }
      finally { injection.mockRestore(); }
      expect(layer.group.children).toEqual(children); expect(geometriesOf(layer.group)).toEqual(shapes);
      for (const disposed of disposals) expect(disposed).not.toHaveBeenCalled();
      expect(layer.meshReservation()).toEqual(oldReservation); expect(pool.reservedBytes()).toBe(oldPool);
      layer.update(replacement, 'shadedWithEdges');
      for (const disposed of disposals) expect(disposed).toHaveBeenCalledTimes(1);
      expect(pool.reservedBytes()).toBe(layer.meshReservation().gpuMeshBytes);
    } finally { layer.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('restores instance writes after a mid-update exception without modifying source geometry', () => {
    const input = sameParts(2), layer = createAssemblyLayer();
    try {
      const initial = buildAssemblyGeometry(input);
      layer.update(initial, 'shadedWithEdges');
      const face = faceBatchesOf(layer)[0], matrices = Array.from(face.instanceMatrix.array);
      const injection = vi.spyOn(THREE.InstancedMesh.prototype, 'setMatrixAt').mockImplementationOnce(function (this: THREE.InstancedMesh) {
        this.instanceMatrix.array[0] = 123456;
        throw new Error('injected instance write failure');
      });
      const changed = buildAssemblyGeometry({ ...sameParts(2, 3), bodies: input.bodies });
      try { expect(() => layer.update(changed, 'shadedWithEdges')).toThrow('injected instance write failure'); }
      finally { injection.mockRestore(); }
      expect(Array.from(face.instanceMatrix.array)).toEqual(matrices);
      expect(faceBatchesOf(layer)[0]).toBe(face);
      layer.update(changed, 'shadedWithEdges');
      expect(Array.from(face.instanceMatrix.array)).not.toEqual(matrices);
      expect(initial.parts[0].bodies).toBe(changed.parts[0].bodies);
      expect(Array.from(initial.parts[0].bodies[0].mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    } finally { layer.dispose(); }
  });

  it('returns reservations through 100 placement/highlight updates and leaves an independent owner live', () => {
    const input = sameParts(2), pool = createGpuMeshBudget(100000);
    const first = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    const second = createAssemblyLayer(undefined, { gpuMeshBudget: pool });
    try {
      const initial = buildAssemblyGeometry(input);
      first.update(initial, 'shadedWithEdges'); second.update(initial, 'shadedWithEdges');
      const observedGeometries = new Set<THREE.BufferGeometry>(), releasedGeometries = new Set<THREE.BufferGeometry>();
      const observedMeshes = new Set<THREE.InstancedMesh>(), releasedMeshes = new Set<THREE.InstancedMesh>();
      const observe = () => {
        for (const geometry of geometriesOf(first.group)) if (!observedGeometries.has(geometry)) {
          observedGeometries.add(geometry);
          geometry.addEventListener('dispose', () => releasedGeometries.add(geometry));
        }
        for (const mesh of faceBatchesOf(first)) if (!observedMeshes.has(mesh)) {
          observedMeshes.add(mesh);
          mesh.addEventListener('dispose', () => releasedMeshes.add(mesh));
        }
      };
      observe();
      const independent = second.meshReservation().gpuMeshBytes;
      const shape = faceBatchesOf(first)[0].geometry, geometryDisposed = vi.fn();
      shape.addEventListener('dispose', geometryDisposed);
      const ref = subShapeRefOf(initial.parts[0].bodies, 'extrude-1#face:0');
      if (ref === null) throw new Error('fixture needs a face reference');
      const highlightId = assemblyTargetId({ componentId: 'component-1', kind: 'subShape', ref });
      for (let cycle = 0; cycle < 100; cycle += 1) {
        const bundle = buildAssemblyGeometry({ ...sameParts(2, cycle), bodies: input.bodies,
          selectedTargetIds: cycle % 2 === 0 ? [highlightId] : [] });
        first.update(bundle, 'shadedWithEdges');
        observe();
        expect(faceBatchesOf(first)[0].geometry).toBe(shape);
        expect(pool.reservedBytes()).toBe(first.meshReservation().gpuMeshBytes + independent);
      }
      first.update(EMPTY_ASSEMBLY_GEOMETRY, 'shadedWithEdges');
      expect(geometryDisposed).toHaveBeenCalledTimes(1);
      expect(first.meshReservation()).toMatchObject({ sourceBackingBytes: 0, displayCopyBytes: 0, instanceBytes: 0, gpuMeshBytes: 0 });
      expect(pool.reservedBytes()).toBe(independent);
      expect(releasedGeometries).toEqual(observedGeometries);
      expect(releasedMeshes).toEqual(observedMeshes);
    } finally { first.dispose(); second.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });
});
