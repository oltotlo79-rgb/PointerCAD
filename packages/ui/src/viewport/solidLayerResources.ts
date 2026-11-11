import * as THREE from 'three';

import type { SubShapeEmphasis, SubShapeHighlightBatch, SubShapeHighlightBundle } from './buildSubShapeGeometry.js';
import { createViewportLifetime, createViewportConstructionOwner, type ViewportLifetime } from './viewportLifetime.js';

export const SUB_SHAPE_EMPHASES: readonly SubShapeEmphasis[] = ['hovered', 'selected'];

export type SubShapeFaceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
export type SubShapeLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
export type SubShapePoints = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;

/** 部分形状 1 強調度(ホバー or 選択)ぶんの重ね描き 3 本(§0.a-0.7)。 */
export interface SubShapeOverlay {
  readonly group: THREE.Group;
  readonly faces: SubShapeFaceMesh;
  readonly edges: SubShapeLines;
  readonly vertices: SubShapePoints;
}


/** Owns body overlays and retryable update cleanup; template materials remain with the layer. */
export function createSolidSubShapeResources(
  group: THREE.Group,
  subShapeOverlays: Readonly<Record<SubShapeEmphasis, SubShapeOverlay>>,
  createSubShapeOverlay: (color: number, shared: SubShapeOverlay,
    parent: ReturnType<typeof createViewportConstructionOwner>) => SubShapeOverlay,
  applySubShapeOverlay: (overlay: SubShapeOverlay, batch: SubShapeHighlightBatch) => void,
  borrowedGeometryRelease: (geometry: THREE.BufferGeometry) => () => void,
) {
  const subShapeBodyOverlays: Readonly<Record<SubShapeEmphasis, Map<string, SubShapeOverlay>>> = {
    hovered: new Map(), selected: new Map(),
  };
  let pendingUpdateCleanup: ViewportLifetime[] = [];
  function retryUpdateCleanup(): void {
    for (const owner of pendingUpdateCleanup) owner.dispose();
    pendingUpdateCleanup = pendingUpdateCleanup.filter(owner => owner.pendingCount !== 0);
    if (pendingUpdateCleanup.length !== 0) throw new Error('Solid overlay cleanup is pending');
  }
  function prepareSubShapeOverlays(emphasis: SubShapeEmphasis, batches: readonly SubShapeHighlightBatch[],
    candidate: ReturnType<typeof createViewportConstructionOwner>): { publish(): void; retire(): void } {
    const active = subShapeBodyOverlays[emphasis];
    const keys = new Set(batches.map((batch) => batch.featureId));
    const additions = new Map<string, SubShapeOverlay>();
    for (const batch of batches) {
      const existing = active.get(batch.featureId);
      if (existing !== undefined) { applySubShapeOverlay(existing, batch); continue; }
      if (additions.has(batch.featureId)) continue;
      const overlay = createSubShapeOverlay(0, subShapeOverlays[emphasis], candidate);
      applySubShapeOverlay(overlay, batch);
      additions.set(batch.featureId, overlay);
    }
    const removed = [...active].filter(([key]) => !keys.has(key));
    return { publish(): void {
    // Retirement waits until both publications succeed; rollback still owns all old assets.
    for (const [key, overlay] of additions) { active.set(key, overlay); group.add(overlay.group); }
    for (const [key, overlay] of removed) {
      group.remove(overlay.group);
      active.delete(key);
    }
    }, retire(): void {
    for (const [, overlay] of removed) {
      const retired = createViewportLifetime();
      for (const geometry of [overlay.faces.geometry, overlay.edges.geometry, overlay.vertices.geometry]) {
        retired.register('retired overlay geometry', borrowedGeometryRelease(geometry));
      }
      retired.dispose();
      if (retired.pendingCount !== 0) pendingUpdateCleanup.push(retired);
    }
    } };
  }
  function checkpointSubShapeOverlays(): ViewportLifetime {
    const overlays = SUB_SHAPE_EMPHASES.flatMap(emphasis => [...subShapeBodyOverlays[emphasis].values()]);
    const groups = overlays.map(overlay => ({ object: overlay.group,
      position: overlay.group.position.clone(), matrix: overlay.group.matrix.clone(),
      world: overlay.group.matrixWorld.clone(), worldDirty: overlay.group.matrixWorldNeedsUpdate }));
    const objects = overlays.flatMap(overlay => [overlay.faces, overlay.edges, overlay.vertices]);
    const visibility = objects.map(object => ({ object, visible: object.visible }));
    const geometries = objects.map(object => {
      const geometry = object.geometry;
      const attributes = { ...geometry.attributes }, index = geometry.index;
      const values = [...Object.values(attributes), ...(index === null ? [] : [index])]
        .filter((value): value is THREE.BufferAttribute => value instanceof THREE.BufferAttribute)
        .map(value => ({ value, array: value.array, version: value.version }));
      return { geometry, attributes, index, values, box: geometry.boundingBox,
        boxValue: geometry.boundingBox?.clone(), sphere: geometry.boundingSphere,
        sphereValue: geometry.boundingSphere?.clone() };
    });
    const previousChildren = [...group.children];
    const previousMaps = SUB_SHAPE_EMPHASES.map(emphasis => ({ active: subShapeBodyOverlays[emphasis],
      entries: [...subShapeBodyOverlays[emphasis]] }));
    const recovery = createViewportLifetime();
    recovery.register('restore overlay membership', () => {
      // Restore actual membership without reentering failed add/remove event callbacks.
      for (const child of group.children) if (!previousChildren.includes(child) && child.parent === group) child.parent = null;
      group.children.splice(0, group.children.length, ...previousChildren);
      for (const child of previousChildren) child.parent = group;
      for (const state of previousMaps) {
        Map.prototype.clear.call(state.active);
        for (const [key, overlay] of state.entries) Map.prototype.set.call(state.active, key, overlay);
      }
    });
    for (const state of groups) recovery.register('restore overlay transform', () => {
        state.object.position.copy(state.position); state.object.matrix.copy(state.matrix);
        state.object.matrixWorld.copy(state.world); state.object.matrixWorldNeedsUpdate = state.worldDirty;
    });
    for (const state of visibility) recovery.register('restore overlay visibility', () => { state.object.visible = state.visible; });
    for (const state of geometries) recovery.register('restore overlay geometry', () => {
        state.geometry.attributes = state.attributes; state.geometry.index = state.index;
        for (const value of state.values) { value.value.array = value.array; value.value.version = value.version; }
        if (state.box !== null && state.boxValue !== undefined) state.box.copy(state.boxValue);
        if (state.sphere !== null && state.sphereValue !== undefined) state.sphere.copy(state.sphereValue);
        state.geometry.boundingBox = state.box; state.geometry.boundingSphere = state.sphere;
    });
    return recovery;
  }
  let lastSubShapeBundle: SubShapeHighlightBundle | null = null;
  return {
    bodyOverlays: subShapeBodyOverlays,
    get pendingCleanup(): readonly ViewportLifetime[] { return pendingUpdateCleanup; },
    update(bundle: SubShapeHighlightBundle): void {
      retryUpdateCleanup();
      if (bundle === lastSubShapeBundle) {
        return;
      }
      const candidate = createViewportConstructionOwner();
      const restore = checkpointSubShapeOverlays();
      let hovered: ReturnType<typeof prepareSubShapeOverlays>, selected: ReturnType<typeof prepareSubShapeOverlays>;
      try {
        hovered = prepareSubShapeOverlays('hovered', bundle.hovered.batches, candidate);
        selected = prepareSubShapeOverlays('selected', bundle.selected.batches, candidate);
        hovered.publish(); selected.publish();
      } catch (error) {
        restore.dispose();
        if (restore.pendingCount !== 0) pendingUpdateCleanup.push(restore);
        const failure = candidate.fail(error);
        if (failure.cleanup.pendingCount !== 0) pendingUpdateCleanup.push(failure.cleanup);
        throw failure;
      }
      candidate.handoff();
      lastSubShapeBundle = bundle;
      hovered.retire(); selected.retire();
    },
    clear(): void {
      pendingUpdateCleanup = [];
      for (const emphasis of SUB_SHAPE_EMPHASES) subShapeBodyOverlays[emphasis].clear();
      lastSubShapeBundle = null;
    },
  };
}
