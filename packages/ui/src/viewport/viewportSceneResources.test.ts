import type { ResolvedPlane } from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createAssemblyLayer } from './createAssemblyLayer.js';
import { createViewportLifetime, type ViewportLifetime } from './viewportLifetime.js';
import {
  createSceneConstruction, createSceneLayers, createSectionClipping, registerSceneLayerCleanup,
  type ViewportSceneLayers,
} from './viewportSceneResources.js';

/** createViewportScene と同じ取得順の層一式。ラベルは取得した順に `labels` へ入る。 */
function layersWithLabels(scene = new THREE.Scene()): { layers: ViewportSceneLayers; labels: string[]; assemblyAfter: string[] } {
  const labels: string[] = [], assemblyAfter: string[] = [];
  const layers = createSceneLayers(scene, (label, resource) => { labels.push(label); return resource; }, () => {
    assemblyAfter.push(labels.at(-1) ?? '');
    return createAssemblyLayer();
  });
  return { layers, labels, assemblyAfter };
}

function disposeLayers(layers: ViewportSceneLayers): void {
  const lifetime = createViewportLifetime();
  registerSceneLayerCleanup(lifetime, layers, { dispose: () => undefined }, { returnResources: () => true },
    { dispose: () => undefined });
  lifetime.dispose();
  expect(lifetime.pendingCount).toBe(0);
}

describe('Scene の構築中の取得の台帳', () => {
  it('返した取得は台帳から外れ、返せなかった取得は残り、引き渡し後はその場で返す', () => {
    const construction = createSceneConstruction();
    const calls: string[] = [];
    let refuse = true;
    const first = { dispose: () => { calls.push('first'); } };
    const second = { dispose: () => { calls.push('second'); if (refuse) throw new Error('second retained'); } };
    const third = { dispose: () => { calls.push('third'); } };
    construction.acquired('first', first);
    construction.acquired('second', second);
    construction.acquired('third', third, () => { calls.push('third custom'); });
    construction.returnAcquired(first);
    expect(() => { construction.returnAcquired(second); }).toThrow('second retained');
    expect([...construction.pending()].map(entry => entry.label)).toEqual(['second', 'third']);
    refuse = false;
    for (const pending of [...construction.pending()]) pending.release();
    expect([...construction.pending()]).toEqual([]);
    expect(calls).toEqual(['first', 'second', 'second', 'third custom']);

    construction.handOff();
    construction.acquired('after handoff', third);
    expect([...construction.pending()]).toEqual([]);
    construction.returnAcquired(third);
    expect(calls).toEqual(['first', 'second', 'second', 'third custom', 'third']);
  });
});

describe('光源・方眼・各層の作成と破棄の登録', () => {
  it('取得の順序と scene へ足す順序が Scene の元の順序のまま', () => {
    const scene = new THREE.Scene();
    const { layers, labels, assemblyAfter } = layersWithLabels(scene);
    expect(labels).toEqual(['sky light', 'key light', 'grid material', 'grid geometry', 'axis geometry', 'solidLayer',
      'interferenceLayer', 'analysisFieldLayer', 'analysisModeLayer', 'canvasLayer', 'sketchLayer', 'referenceLayer',
      'trackingLayer', 'constraintLayer', 'inferenceLayer', 'measureLayer', 'cylinderBasisLayer',
      'planar basis origin', 'planar basis x', 'planar basis y']);
    // 配置した部品の層は Scene 側が作って台帳へ入れる。呼ぶ位置は立体の層の直後。
    expect(assemblyAfter).toEqual(['solidLayer']);
    const expected: THREE.Object3D[] = [layers.skyLight, layers.keyLight, layers.gridGroup, layers.solidLayer.group,
      layers.assemblyLayer.group, layers.interferenceLayer.group, layers.analysisFieldLayer.group,
      layers.analysisModeLayer.group, layers.canvasLayer.group, layers.sketchLayer.group, layers.referenceLayer.group,
      layers.trackingLayer.group, layers.constraintLayer.group, layers.inferenceLayer.group, layers.measureLayer.group,
      layers.cylinderBasisLayer.group, ...layers.planarBasisLayers.map(layer => layer.group)];
    expect(scene.children).toHaveLength(expected.length);
    expected.forEach((object, index) => { expect(scene.children[index]).toBe(object); });
    expect(layers.gridGroup.children).toHaveLength(2);
    expect(layers.gridGroup.children[0]).toBe(layers.grid);
    expect(layers.gridGroup.children[1]).toBe(layers.axisLines);
    expect(layers.axisLines.renderOrder).toBe(1);
    expect(layers.cylinderBasisLayer.group.name).toBe('cylinder-basis-guide');
    expect(layers.planarBasisLayers.map(layer => layer.group.name))
      .toEqual(['planar-basis-origin', 'planar-basis-x', 'planar-basis-y']);
    disposeLayers(layers);
  });

  it('破棄は元のラベル順で 1 回ずつ行い、方眼と軸は登録した時点の形を返す', () => {
    const { layers } = layersWithLabels();
    const registered: string[] = [];
    const lifetime = createViewportLifetime();
    const recorder: ViewportLifetime = {
      get active() { return lifetime.active; },
      get pendingCount() { return lifetime.pendingCount; },
      get errors() { return lifetime.errors; },
      register(label, release) { registered.push(label); lifetime.register(label, release); },
      dispose() { lifetime.dispose(); },
    };
    let environmentDisposals = 0, rendererDisposals = 0, repairReturns = 0;
    const gridGeometry = layers.grid.geometry, axisGeometry = layers.axisLines.geometry;
    const returned: string[] = [];
    gridGeometry.addEventListener('dispose', () => { returned.push('grid'); });
    axisGeometry.addEventListener('dispose', () => { returned.push('axis'); });
    registerSceneLayerCleanup(recorder, layers, { dispose: () => { environmentDisposals += 1; } },
      { returnResources: () => { repairReturns += 1; return true; } }, { dispose: () => { rendererDisposals += 1; } });
    expect(registered).toEqual(['environment', 'reference repair preview', 'solid layer', 'assembly layer',
      'interference layer', 'analysis field layer', 'analysis mode layer', 'canvas images and textures', 'sketch layer',
      'reference layer', 'tracking layer', 'constraint layer', 'inference layer', 'measure layer', 'cylinder basis layer',
      'planar basis layer 0', 'planar basis layer 1', 'planar basis layer 2', 'grid geometry', 'axis geometry',
      'grid material', 'sky light', 'key light', 'renderer']);
    // 登録の後に差し替わった形は、この登録の相手ではない(元の主関数と同じ)。
    const replacement = new THREE.BufferGeometry();
    layers.grid.geometry = replacement;
    recorder.dispose();
    recorder.dispose();
    expect(lifetime.pendingCount).toBe(0);
    expect(returned).toEqual(['grid', 'axis']);
    expect([environmentDisposals, repairReturns, rendererDisposals]).toEqual([1, 1, 1]);
    replacement.dispose();
  });
});

describe('断面のクリッピング平面', () => {
  const handlePlane: ResolvedPlane = { origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0], normal: [0, 0, 1] };

  it('1 枚の平面を使い回し、枚数が 0↔1 で変わるときだけ 3 つの層へ配り直す', () => {
    const { layers } = layersWithLabels();
    const solid = vi.spyOn(layers.solidLayer, 'setSectionPlanes');
    const assembly = vi.spyOn(layers.assemblyLayer, 'setSectionPlanes');
    const interference = vi.spyOn(layers.interferenceLayer, 'setSectionPlanes');
    const handle = vi.spyOn(layers.solidLayer, 'updateSectionHandle');
    const clipping = createSectionClipping(layers);

    clipping.setSectionView(null);
    expect([solid.mock.calls.length, assembly.mock.calls.length, interference.mock.calls.length]).toEqual([0, 0, 0]);
    expect(handle.mock.calls).toEqual([[null]]);

    clipping.setSectionView({ plane: { normal: [0, 0, 1], constant: -1 }, handle: { plane: handlePlane, keep: 'positive' } });
    clipping.setSectionView({ plane: { normal: [0, 1, 0], constant: 2 }, handle: { plane: handlePlane, keep: 'negative' } });
    expect([solid.mock.calls.length, assembly.mock.calls.length, interference.mock.calls.length]).toEqual([1, 1, 1]);
    const [plane] = solid.mock.calls[0]?.[0] ?? [];
    expect(plane).toBeInstanceOf(THREE.Plane);
    expect(assembly.mock.calls[0]?.[0]?.[0]).toBe(plane);
    expect(interference.mock.calls[0]?.[0]?.[0]).toBe(plane);
    // 引いている最中は同じ平面の中身だけが変わる。
    expect(plane?.normal.toArray()).toEqual([0, 1, 0]);
    expect(plane?.constant).toBe(2);

    clipping.setSectionView(null);
    clipping.setSectionView(null);
    expect(solid.mock.calls.map(call => call[0].length)).toEqual([1, 0]);
    expect(assembly.mock.calls.map(call => call[0].length)).toEqual([1, 0]);
    expect(interference.mock.calls.map(call => call[0].length)).toEqual([1, 0]);
    expect(handle.mock.calls.map(call => call[0]?.keep ?? null)).toEqual([null, 'positive', 'negative', null, null]);
    disposeLayers(layers);
  });
});
