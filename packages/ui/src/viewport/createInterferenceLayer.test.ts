import type { AssemblyInterferencePair, AssemblyInterferenceResult } from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createInterferenceLayer } from './createInterferenceLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';

function pair(a: string, b: string, volume = 1): AssemblyInterferencePair {
  return {
    aComponentId: a, bComponentId: b, volume,
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]), triangleCount: 1,
    },
  };
}

function result(pairs: readonly AssemblyInterferencePair[]): AssemblyInterferenceResult {
  return { kind: 'checked', failure: null, requestId: 'r', pairs, failures: [], skips: [],
    totalPairCount: pairs.length, checkedPairCount: pairs.length, skippedPairCount: 0,
    pendingPairCount: 0, cancelled: false };
}

function meshesOf(group: THREE.Group): readonly THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] {
  return group.children.filter((object): object is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> =>
    object instanceof THREE.Mesh && object.geometry instanceof THREE.BufferGeometry
      && object.material instanceof THREE.MeshBasicMaterial);
}

describe('P7-26 干渉の独立描画層', () => {
  it('組ごとに接頭辞つきの別meshを作る', () => {
    const layer = createInterferenceLayer();
    layer.update(result([pair('a', 'b'), pair('a', 'c')]), null);
    expect(meshesOf(layer.group).map((mesh) => mesh.name))
      .toEqual(['interference:a:b', 'interference:a:c']);
    layer.dispose();
  });

  it('選んだ重なりだけ明るい材質へ替える', () => {
    const layer = createInterferenceLayer();
    layer.update(result([pair('a', 'b'), pair('a', 'c')]), 'interference:a:c');
    const [first, second] = meshesOf(layer.group);
    expect(first.material).not.toBe(second.material);
    expect(first.material.opacity).toBe(0.5);
    expect(second.material.opacity).toBe(0.9);
    layer.update(result([pair('a', 'b')]), null);
    layer.dispose();
  });

  it('同じ結果と選択を渡し直してgeometryを作り直さない', () => {
    const layer = createInterferenceLayer(); const value = result([pair('a', 'b')]);
    layer.update(value, null); const geometry = meshesOf(layer.group)[0].geometry;
    layer.update(value, null); layer.update(value, null);
    expect(meshesOf(layer.group)[0].geometry).toBe(geometry);
    layer.dispose();
  });

  it('閉じると独立層だけが空になり、そのgeometryを解放する', () => {
    const layer = createInterferenceLayer(); layer.update(result([pair('a', 'b')]), null);
    const geometry = meshesOf(layer.group)[0].geometry; let disposed = 0;
    geometry.addEventListener('dispose', () => { disposed += 1; });
    layer.update(null, null);
    expect(layer.group.children).toHaveLength(0);
    expect(disposed).toBe(1);
    layer.dispose();
  });

  it('テーマ色を共有材質2つへ反映する', () => {
    const layer = createInterferenceLayer(); layer.update(result([pair('a', 'b'), pair('a', 'c')]), 'interference:a:c');
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, interference: 0x123456 });
    expect(meshesOf(layer.group).map((mesh) => mesh.material.color.getHex())).toEqual([0x123456, 0x123456]);
    layer.dispose();
  });

  it('断面の平面を通常材質と選択材質の両方へ配る', () => {
    const layer = createInterferenceLayer(); layer.update(result([pair('a', 'b'), pair('a', 'c')]), 'interference:a:c');
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 3); layer.setSectionPlanes([plane]);
    for (const mesh of meshesOf(layer.group)) expect(mesh.material.clippingPlanes).toEqual([plane]);
    layer.setSectionPlanes([]);
    for (const mesh of meshesOf(layer.group)) expect(mesh.material.clippingPlanes).toEqual([]);
    layer.dispose();
  });

  it('disposeで全geometryと2つの材質を一度ずつ解放する', () => {
    const layer = createInterferenceLayer(); layer.update(result([pair('a', 'b'), pair('a', 'c')]), 'interference:a:c');
    const disposed: string[] = [];
    const meshes = meshesOf(layer.group);
    for (const [index, mesh] of meshes.entries()) {
      mesh.geometry.addEventListener('dispose', () => disposed.push(`geometry-${String(index)}`));
    }
    const materials = [...new Set(meshes.map((mesh) => mesh.material))];
    expect(materials).toHaveLength(2);
    for (const [index, material] of materials.entries()) {
      material.addEventListener('dispose', () => disposed.push(`material-${String(index)}`));
    }
    layer.dispose();
    expect(disposed.filter((entry) => entry.startsWith('geometry'))).toHaveLength(2);
    expect(disposed.filter((entry) => entry.startsWith('material'))).toHaveLength(2);
  });
});
