import { createPrimitiveFeature, recomputePart, type AssemblyDocument, type RigidPlacement, type KernelBridge,
  type PartRecomputeResult } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from '../solid/referenceRepairFixture.js';
import { currentRepairSlots } from '../solid/referenceRepairContext.js';
import { beginReferenceRepair, hoverReferenceRepair, cancelReferenceRepair } from '../solid/referenceRepair.js';
import { currentReferenceRepairPreview } from '../solid/referenceRepairPreview.js';
import { appearanceFromPreset, createAssemblyDocument, DEFAULT_APPEARANCE, DEFAULT_COMPONENT_PLACEMENT,
  IDENTITY_PLACEMENT, WORK_PLANES, type SolidBody } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import type { Camera, Scene } from 'three';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { HOME_ORBIT } from './cameraMath.js';
import * as thumbnail from '../file/thumbnail.js';
import type { AppearanceInput } from './buildSolidGeometry.js';
import { createViewportScene as createScene, ViewportSceneInitializationFailure, type ViewportSceneOptions } from './createViewportScene.js';
import { AssemblyUiBackingLedger, type AssemblyMeshOwnership } from './assemblyMeshAdmission.js';
import { createQuadCameraState } from './quadCamera.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';
import type { AppState } from '../store/appState.js';
import { bodyFor, resultFor } from '../store/testing/createTestStore.js';
import { accountingSnapshot, captureMeshBodyLayout, captureStagedSolidOwnership, type PartStager,
  type StagedSolidState } from '../store/recomputeSlice.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';
import { createGpuMeshBudget, solidBodiesForAdmission, type GpuMeshBudget } from './solidMeshAdmission.js';
import { buildAssemblyGeometry, EMPTY_ASSEMBLY_GEOMETRY } from './createAssemblyLayer.js';
import { createViewportMeshObservation } from './viewportMeshObservation.js';
import { createViewportCleanupQueue } from './viewportLifetime.js';
import type { SolidFieldMesh } from '../solidAnalysis/solidFieldView.js';

/** Each historical single-Scene fixture owns an independent host lifetime; shared tests pass one ledger explicitly. */
function createViewportScene(canvas: HTMLCanvasElement, options: ViewportSceneOptions = {}): ViewportScene {
  const sceneOptions: ViewportSceneOptions = { uiBackings: new AssemblyUiBackingLedger() };
  Object.defineProperties(sceneOptions, Object.getOwnPropertyDescriptors(options));
  return createScene(canvas, sceneOptions);
}

const boundary = vi.hoisted((): { overlayFailure: boolean; solidBuildCalls: number;
  beforeBuild: (() => void) | null; afterLayerUpdate: (() => void) | null } => ({
  overlayFailure: false, solidBuildCalls: 0, beforeBuild: null, afterLayerUpdate: null,
}));
vi.mock('./buildSolidGeometry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./buildSolidGeometry.js')>();
  return { ...actual, buildSolidGeometry: (...args: Parameters<typeof actual.buildSolidGeometry>) => {
    boundary.solidBuildCalls += 1;
    boundary.beforeBuild?.();
    return actual.buildSolidGeometry(...args);
  } };
});
vi.mock('./buildSubShapeGeometry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./buildSubShapeGeometry.js')>();
  return { ...actual, buildSubShapeGeometry: (...args: Parameters<typeof actual.buildSubShapeGeometry>) => {
    if (boundary.overlayFailure) throw new Error('overlay candidate failed');
    return actual.buildSubShapeGeometry(...args);
  } };
});
vi.mock('./createSolidLayer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./createSolidLayer.js')>();
  return { ...actual, createSolidLayer: () => {
    const layer = actual.createSolidLayer();
    return { ...layer, update: (...args: Parameters<typeof layer.update>) => {
      layer.update(...args);
      boundary.afterLayerUpdate?.();
    } };
  } };
});

function stateWithBodies(previous: AppState, bodies: readonly SolidBody[]): AppState {
  const limit = bodies.find(body => body.coordinateFrame !== undefined)?.coordinateFrame?.maximumLiveMeshBytes ?? 1000000;
  return { ...previous, bodies, assembly: null, drawing: null, timelineIndex: null, sheetMetalPreview: null,
    sheetMetalTool: null, recomputeCancelled: false, requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success',
    meshJsAccounting: { document: previous.document, timelineIndex: null, outcome: 'success', activeDocumentId: previous.activeDocumentId, bodies, bodyLayouts: bodies.map(captureMeshBodyLayout),
      receipt: { documentId: previous.document.id, partId: 'part-fixture', generation: 7,
        reading: { status: 'known', limitBytes: limit, cacheActiveBytes: 0, cacheRetiredBytes: 0,
          cacheProtectedBytes: 0, retainedReplyBytes: 0, requestPeakReservedBytes: 0 },
        final: { status: 'known', limitBytes: limit, cacheActiveBytes: 0, cacheRetiredBytes: 0,
          cacheProtectedBytes: 0, displayBackingBytes: 0, replyBackingBytes: 0, retainedBackingBytes: 0,
          replyCloneReservedBytes: 0 } } } };
}

/** The same receipt with a kernel post-token union of `retainedBackingBytes` (all cache). */
function withFinalRetained(state: AppState, retainedBackingBytes: number): AppState {
  const accounting = state.meshJsAccounting;
  const final = accounting?.receipt.final;
  if (accounting === null || final === undefined) throw new Error('fixture receipt requires a final union');
  return { ...state, meshJsAccounting: { ...accounting, receipt: { ...accounting.receipt,
    final: { ...final, cacheActiveBytes: retainedBackingBytes, retainedBackingBytes } } } };
}

function controlledViewport(canvas: HTMLCanvasElement, gpuMeshBudget?: GpuMeshBudget,
  observation?: ReturnType<typeof createViewportMeshObservation>) {
  let current = stateWithBodies(useAppStore.getState(), []);
  const viewport = createViewportScene(canvas, { readSolidMeshState: () => current,
    ...(gpuMeshBudget === undefined ? {} : { gpuMeshBudget }),
    ...(observation === undefined ? {} : { observation, viewportOwnerId: 'viewport-test' }) });
  // ViewportCanvas sizes the renderer from its ResizeObserver before any pointer pick.
  viewport.resize(canvas.width, canvas.height);
  return { viewport, read: () => current, replace: (state: AppState) => { current = state; },
    adopt: (bodies: readonly SolidBody[]) => { current = stateWithBodies(current, bodies); viewport.setBodies(bodies); } };
}

function testViewport(canvas: HTMLCanvasElement): ViewportScene {
  const controlled = controlledViewport(canvas);
  return { ...controlled.viewport, setBodies: controlled.adopt };
}

function drawingFixture(): DrawingDocument {
  return { id: 'drawing-D', name: '図面', schemaVersion: 1,
    source: { sourceRef: 'part-D', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '2026-10-05T00:00:00Z' },
    sheet: { paperSizeId: 'A4', orientation: 'landscape', scale: 1, projectionMethod: 'third', frame: { visible: false },
      titleBlock: { title: '', drawingNumber: '', revision: '', author: '', date: '', material: '' } },
    views: [], dimensions: [], annotations: [], tables: [], balloons: [], datums: [], gdtFrames: [], weldSymbols: [], layers: [], parameters: [] };
}

const lifecycle = vi.hoisted(() => ({
  initializationFailure: false,
  initializationCleanupFailure: false,
  recordGeometry: false,
  lateInitializationFailure: false,
  attributeFailure: false,
  earlyGeometryFailure: false,
  geometries: [] as { geometry: THREE.BufferGeometry; attempts: number; returned: number }[],
  instances: [] as { renderCalls: number; disposeCalls: number; renderedScene: Scene | null;
    modelViewTranslations: number[][]; disposeFailure: boolean }[],
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    BufferGeometry: class extends actual.BufferGeometry {
      private readonly acquisition = { geometry: this, attempts: 0, returned: 0 };
      constructor() { super(); if (lifecycle.recordGeometry) lifecycle.geometries.push(this.acquisition); }
      override setAttribute(name: string, attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): this {
        if (lifecycle.attributeFailure && name === 'position' && attribute.count > 1000) {
          throw new Error('Initial grid attribute failure');
        }
        return super.setAttribute(name, attribute);
      }
      override dispose(): void {
        this.acquisition.attempts += 1;
        if (lifecycle.earlyGeometryFailure && this === lifecycle.geometries[0]?.geometry) {
          throw new Error('Initial geometry early return failed');
        }
        super.dispose(); this.acquisition.returned += 1;
      }
    },
    WebGLRenderer: class {
      readonly state = { renderCalls: 0, disposeCalls: 0, renderedScene: null as Scene | null,
        modelViewTranslations: [] as number[][], disposeFailure: false };
      private pixelRatio = 1;

      constructor() { this.state.disposeFailure = lifecycle.initializationCleanupFailure; lifecycle.instances.push(this.state); }
      setPixelRatio(ratio: number): void { this.pixelRatio = ratio; }
      getPixelRatio(): number { return this.pixelRatio; }
      setClearColor(): void { if (lifecycle.initializationFailure) throw new Error('Renderer configuration failure'); }
      setSize(): void { /* The scene owns its logical size. */ }
      setScissorTest(): void { /* Single-pane rendering in this test. */ }
      setViewport(): void { /* Single-pane rendering in this test. */ }
      setScissor(): void { /* Single-pane rendering in this test. */ }
      render(scene: Scene, camera: Camera): void {
        this.state.renderCalls += 1;
        this.state.renderedScene = scene;
        scene.updateMatrixWorld(true);
        scene.traverse((object) => {
          if (!(object instanceof actual.Mesh) || !(object.geometry instanceof actual.BufferGeometry)) return;
          const attribute: unknown = object.geometry.getAttribute('position');
          if (!(attribute instanceof actual.BufferAttribute) || attribute.count !== 3
            || !Array.isArray(object.material)) return;
          const matrix = new actual.Matrix4().multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
          this.state.modelViewTranslations.push(matrix.elements.slice(12, 15));
        });
      }
      dispose(): void {
        this.state.disposeCalls += 1;
        if (this.state.disposeFailure) throw new Error('renderer cleanup failed');
      }
    },
  };
});

vi.mock('./createEnvironment.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./createEnvironment.js')>();
  return { ...actual, createEnvironmentStore: (...args: Parameters<typeof actual.createEnvironmentStore>) => {
    if (lifecycle.lateInitializationFailure) throw new Error('Environment acquisition after initial grid failed');
    return actual.createEnvironmentStore(...args);
  } };
});

function localFace(originX: number): SolidBody {
  return {
    featureId: 'face',
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      triangleCount: 1,
    },
    coordinateFrame: { space: 'local', origin: [originX, 0, 0], maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000000 },
    volume: 0,
    isValid: true,
    faces: [{ index: 0, surfaceKind: 'plane', area: 0.5, centroid: [originX + 0.3, 0.3, 0],
      axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 }],
    edges: [], vertices: [], threadMarks: [],
  };
}

function worldAssemblyFace(): SolidBody {
  const body = localFace(0);
  const { coordinateFrame: frame, ...world } = body;
  if (frame === undefined) throw new Error('fixture requires local source');
  return world;
}

function isInstancedMesh(object: THREE.Object3D): object is THREE.InstancedMesh {
  return object instanceof THREE.InstancedMesh;
}

function assemblyFixture(previous: AppState, body: SolidBody) {
  const assembly = { ...createAssemblyDocument('assembly lifetime fixture'), components: [{ id: 'component-1', name: 'part',
    source: { kind: 'part' as const, partRef: 'part-1' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: true, visible: true, suppressed: false }] };
  const bodies = new Map([['part-1', [body]]]);
  const placements = new Map([['component-1', IDENTITY_PLACEMENT]]);
  const partKeys = new Map([['component-1', 'part-1']]);
  const state: AppState = { ...previous, assembly, drawing: null, activeDocumentId: assembly.id,
    assemblyView: { sourceDocument: assembly, bodies, appearances: new Map(), diagnosis: null,
      mateTargetErrors: new Map(), resolved: { parts: new Map(), placements, partKeys, errors: [] } } };
  const input = { sourceDocument: assembly, components: assembly.components, bodies, placements, partKeys,
    hoveredComponentId: null, selectedComponentIds: [] };
  return { state, input, bundle: buildAssemblyGeometry(input) };
}

/** Existing typed mock-renderer canvas only; does not certify DOM/WebGL. */
function mockRendererCanvas(width: number, height: number): HTMLCanvasElement {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw new Error('Positive integer mock renderer dimensions required');
  const canvas = { width: 640, height: 480 } as HTMLCanvasElement;
  canvas.width = width; canvas.height = height;
  if (canvas.width !== width || canvas.height !== height) throw new Error('Mock renderer dimensions changed');
  return canvas;
}

describe('two real Scenes sharing registered UI backings', () => {
  it('returns a rejected overlay reservation even when allocation and finally registration both throw', () => {
    const ledger = new AssemblyUiBackingLedger(), pool = createGpuMeshBudget(1000000);
    const canvas = mockRendererCanvas(640, 480);
    const body = localFace(0), state = stateWithBodies(useAppStore.getState(), [body]);
    const viewport = createViewportScene(canvas, { uiBackings: ledger, gpuMeshBudget: pool, readSolidMeshState: () => state });
    viewport.resize(640, 480); viewport.setBodies(state.bodies);
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
    const before = viewport.meshReservation(), beforeGpu = pool.reservedBytes();
    const borrowers: ArrayBufferLike[] = [];
    let registrationFails = false;
    const adopt = ledger.adopt.bind(ledger), allocated = ledger.allocated.bind(ledger);
    const registration = vi.spyOn(ledger, 'adopt').mockImplementation(buffers => {
      if (registrationFails) throw new Error('actual candidate and final registration refused');
      adopt(buffers);
    });
    const acquisition = vi.spyOn(ledger, 'allocated').mockImplementation(buffer => {
      borrowers.push(buffer); registrationFails = true; allocated(buffer);
    });
    const retire = ledger.retire.bind(ledger); const retiredPeaks: number[] = [];
    const retirement = vi.spyOn(ledger, 'retire').mockImplementation(owner => { retiredPeaks.push(ledger.pending()); retire(owner); });
    try {
      expect(() => viewport.setSubShapeHighlight(null, ['face#face:0'])).toThrow('Actual display backing registration failed');
      expect(borrowers).toHaveLength(1); expect(borrowers[0].byteLength).toBe(36);
      expect(retiredPeaks.some(bytes => bytes > 0)).toBe(true);
      expect(ledger.pending()).toBe(0); expect(ledger.known()).toBe(false);
      expect(pool.reservedBytes()).toBe(beforeGpu);
      expect(viewport.meshReservation().gpuMeshBytes).toBe(before.gpuMeshBytes);
      expect(viewport.meshReservation().registeredUiBackingBytes).toBeNull();
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
      expect(state.bodies).toEqual([body]);
      expect(() => ledger.reserve({}, 0, 0, 1000000)).toThrow('registration is unknown');
      registrationFails = false; acquisition.mockRestore(); ledger.retryRegistration();
      expect(ledger.known()).toBe(true); expect(ledger.buffers()).toContain(borrowers[0]);
      expect(() => viewport.setSubShapeHighlight(null, ['face#face:0'])).not.toThrow();
      expect(ledger.pending()).toBe(0);
      viewport.dispose();
      expect(pool.reservedBytes()).toBe(0); expect(borrowers[0].byteLength).toBe(36);
      expect(ledger.bytes()).toBeGreaterThanOrEqual(borrowers[0].byteLength);
    } finally { registrationFails = false; acquisition.mockRestore(); registration.mockRestore(); retirement.mockRestore(); viewport.dispose(); }
  });

  it('retains exact independent UV allocations, failed geometry return and closed-owner borrowers', () => {
    const ledger = new AssemblyUiBackingLedger(), canvas = { width: 640, height: 480 } as HTMLCanvasElement;
    const body = localFace(0), sourceBuffers = new Set<ArrayBufferLike>([body.mesh.positions.buffer, body.mesh.normals.buffer,
      body.mesh.indices.buffer, body.mesh.edgePositions.buffer]);
    const firstState = stateWithBodies(useAppStore.getState(), [body]), secondState = stateWithBodies(useAppStore.getState(), [body]);
    const first = createViewportScene(canvas, { uiBackings: ledger, readSolidMeshState: () => firstState });
    const second = createViewportScene(canvas, { uiBackings: ledger, readSolidMeshState: () => secondState });
    let refuse = true, failedGeometry: THREE.BufferGeometry | null = null;
    const original = Reflect.get(THREE.BufferGeometry.prototype, 'dispose');
    const release = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry): void {
      if (this === failedGeometry && refuse) throw new Error('Actual shared-lifetime geometry return failed');
      original.call(this);
    });
    try {
      first.resize(640, 480); second.resize(640, 480);
      first.setBodies(firstState.bodies); second.setBodies(secondState.bodies);
      const borrowed = ledger.buffers();
      expect(borrowed).toHaveLength(2); expect(borrowed.every(buffer => !sourceBuffers.has(buffer))).toBe(true);
      expect(ledger.bytes()).toBe(48);
      expect(first.meshReservation().registeredUiBackingBytes).toBe(48);
      expect(second.meshReservation().registeredUiBackingBytes).toBe(48);
      const firstRenderer = lifecycle.instances.at(-2);
      if (firstRenderer === undefined) throw new Error('Actual first renderer');
      first.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
      firstRenderer.renderedScene?.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const geometry: unknown = object.geometry;
        if (!(geometry instanceof THREE.BufferGeometry)) return;
        const uv: unknown = geometry.getAttribute('uv');
        if (!(uv instanceof THREE.BufferAttribute || uv instanceof THREE.InterleavedBufferAttribute)) return;
        if (uv.array.buffer === borrowed[0]) failedGeometry = geometry;
      });
      if (failedGeometry === null) throw new Error('Actual borrowed UV geometry');
      first.dispose();
      expect(first.meshReservation().viewportCleanupStatus).toBe('pending');
      expect(ledger.buffers()).toContain(borrowed[0]); expect(ledger.bytes()).toBe(48);
      second.dispose();
      expect(second.meshReservation().viewportCleanupStatus).toBe('complete');
      expect(ledger.buffers()).toContain(borrowed[1]); expect(ledger.bytes()).toBe(48);
      refuse = false; first.dispose();
      expect(first.meshReservation().viewportCleanupStatus).toBe('complete');
      expect(borrowed.every(buffer => buffer.byteLength === 24)).toBe(true);
      expect(ledger.bytes()).toBe(48); // These exact external borrowers, not unrelated baseline bytes.
      expect(ledger.pending()).toBe(0);
    } finally { refuse = false; first.dispose(); second.dispose(); release.mockRestore(); }
  });
});

describe('Scene initialization acquisition rollback', () => {
  it('keeps an actual failed inner factory geometry through the application scheduler and then admits a fresh Scene', () => {
    lifecycle.geometries = []; lifecycle.recordGeometry = true;
    let failedGeometry: THREE.BufferGeometry | null = null, refuse = true;
    const values = Reflect.get(THREE.MeshBasicMaterial.prototype, 'setValues');
    const constructor = vi.spyOn(THREE.MeshBasicMaterial.prototype, 'setValues').mockImplementation(function (
      this: THREE.MeshBasicMaterial, input: Parameters<THREE.Material['setValues']>[0],
    ): void {
      const offset: unknown = input === undefined ? null : Reflect.get(input, 'polygonOffsetFactor');
      if (offset === -1) {
        failedGeometry = lifecycle.geometries.at(-1)?.geometry ?? null;
        throw new Error('actual Solid overlay constructor failed');
      }
      values.call(this, input);
    });
    const dispose = Reflect.get(THREE.BufferGeometry.prototype, 'dispose');
    const release = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry): void {
      if (this === failedGeometry && refuse) throw new Error('actual inner geometry return failed');
      dispose.call(this);
    });
    const scheduled: (() => void)[] = [];
    const queue = createViewportCleanupQueue(retry => { scheduled.push(retry); return () => undefined; });
    const published: { scene: ViewportScene | null } = { scene: null };
    try {
      const failure = initializationFailure();
      expect(failedGeometry).not.toBeNull();
      expect(failure.cleanup.pendingCount).toBe(1);
      const earlier = lifecycle.geometries.filter(entry => entry.geometry !== failedGeometry);
      expect(earlier.every(entry => entry.returned === 1)).toBe(true);
      queue.whenAvailable('failed-inner-Scene', () => undefined);
      queue.retain('failed-inner-Scene', { retry: () => {
        failure.cleanup.dispose(); return failure.cleanup.pendingCount === 0;
      }, read: () => ({ viewportOwnerId: 'failed-inner-Scene', pendingCount: failure.cleanup.pendingCount,
        errors: failure.cleanup.errors, hostDisplayCopyBytes: null, hostGpuAttributeBytes: null,
        unknown: ['actualInnerInitializationResources', 'driverGpuActual'], observationActive: false }) });
      queue.whenAvailable('fresh-inner-Scene', () => { published.scene = createViewportScene({} as HTMLCanvasElement); });
      expect(published.scene).toBeNull(); expect(queue.snapshot()[0].hostGpuAttributeBytes).toBeNull();
      scheduled[0](); expect(published.scene).toBeNull();
      expect(earlier.every(entry => entry.returned === 1)).toBe(true);
      constructor.mockRestore(); refuse = false;
      scheduled[1]();
      expect(queue.pendingCount).toBe(0); expect(published.scene).not.toBeNull();
      expect(earlier.every(entry => entry.returned === 1)).toBe(true);
      queue.returned('fresh-inner-Scene');
    } finally {
      constructor.mockRestore(); refuse = false;
      release.mockRestore();
      published.scene?.dispose(); lifecycle.recordGeometry = false;
    }
  });

  function captureGeometry(): void { lifecycle.geometries = []; lifecycle.recordGeometry = true; }
  function resetGeometryFailures(): void {
    lifecycle.recordGeometry = false; lifecycle.lateInitializationFailure = false;
    lifecycle.attributeFailure = false; lifecycle.earlyGeometryFailure = false;
  }
  function initializationFailure(): ViewportSceneInitializationFailure {
    try { createViewportScene({} as HTMLCanvasElement); }
    catch (error) { if (error instanceof ViewportSceneInitializationFailure) return error; throw error; }
    throw new Error('Expected an initialization failure');
  }

  it('hands current geometry to normal Scene disposal without disposing it during handoff', () => {
    captureGeometry();
    try {
      const viewport = createViewportScene({} as HTMLCanvasElement);
      const old = lifecycle.geometries.slice(0, 2);
      const current = lifecycle.geometries.filter(entry => entry.geometry.hasAttribute('color'));
      expect(old).toHaveLength(2); expect(current).toHaveLength(2);
      expect(old.map(entry => entry.returned)).toEqual([1, 1]);
      expect(current.map(entry => entry.attempts)).toEqual([0, 0]);
      viewport.dispose(); viewport.dispose();
      expect(lifecycle.geometries.every(entry => entry.returned === 1 && entry.attempts === 1)).toBe(true);
    } finally { resetGeometryFailures(); }
  });

  it('returns replacement geometry after a later environment acquisition throws without returning old geometry twice', () => {
    captureGeometry(); lifecycle.lateInitializationFailure = true;
    try {
      const failure = initializationFailure();
      expect(failure.cleanup.pendingCount).toBe(0);
      expect(lifecycle.geometries.filter(entry => entry.geometry.hasAttribute('color'))).toHaveLength(2);
      expect(lifecycle.geometries.every(entry => entry.returned === 1 && entry.attempts === 1)).toBe(true);
      failure.cleanup.dispose();
      expect(lifecycle.geometries.every(entry => entry.attempts === 1)).toBe(true);
    } finally { resetGeometryFailures(); }
    const next = createViewportScene({} as HTMLCanvasElement); next.dispose();
  });

  it('registers a newly returned geometry before its first attribute setting throws', () => {
    captureGeometry(); lifecycle.attributeFailure = true;
    try {
      const failure = initializationFailure();
      expect(failure.cleanup.pendingCount).toBe(0);
      expect(lifecycle.geometries.length).toBeGreaterThan(2);
      expect(lifecycle.geometries.every(entry => entry.returned === 1 && entry.attempts === 1)).toBe(true);
    } finally { resetGeometryFailures(); }
    const next = createViewportScene({} as HTMLCanvasElement); next.dispose();
  });

  it('retains only the early-return failure through a scheduled retry and then permits a fresh mount', () => {
    captureGeometry(); lifecycle.earlyGeometryFailure = true;
    let scheduled: (() => void) | null = null;
    const queue = createViewportCleanupQueue(callback => { scheduled = callback; return () => { scheduled = null; }; });
    try {
      const failure = initializationFailure();
      const failed = lifecycle.geometries[0];
      expect(failure.cleanup.pendingCount).toBe(1);
      expect(failed.returned).toBe(0);
      expect(lifecycle.geometries.slice(1).every(entry => entry.returned === 1)).toBe(true);
      queue.whenAvailable('failed-scene', () => {});
      queue.retain('failed-scene', { retry: () => { failure.cleanup.dispose(); return failure.cleanup.pendingCount === 0; },
        read: () => ({ viewportOwnerId: 'failed-scene', pendingCount: failure.cleanup.pendingCount,
          errors: failure.cleanup.errors, hostDisplayCopyBytes: null, hostGpuAttributeBytes: null,
          unknown: ['initializationResources'], observationActive: false }) });
      let next: ViewportScene | null = null;
      queue.whenAvailable('next-scene', () => { next = createViewportScene({} as HTMLCanvasElement); });
      expect(queue.snapshot()[0].hostGpuAttributeBytes).toBeNull();
      expect(queue.waitingCount).toBe(1);
      const runScheduled = (): void => { const callback = scheduled; if (callback === null) throw new Error('Missing retry'); callback(); };
      runScheduled();
      expect(queue.pendingCount).toBe(1); expect(failed.returned).toBe(0);
      const successful = lifecycle.geometries.slice(1).map(entry => entry.attempts);
      lifecycle.earlyGeometryFailure = false; lifecycle.recordGeometry = false;
      runScheduled();
      expect(queue.pendingCount).toBe(0); expect(queue.scheduled).toBe(false);
      expect(failed.returned).toBe(1);
      expect(lifecycle.geometries.slice(1).map(entry => entry.attempts)).toEqual(successful);
      expect(next).not.toBeNull();
      if (next === null) throw new Error('Fresh mount did not resume');
      (next as ViewportScene).dispose(); queue.returned('next-scene');
      expect(queue.ownerCount).toBe(0);
    } finally { resetGeometryFailures(); }
  });

  it('returns an acquired renderer after its configuration throws and permits a fresh scene', () => {
    lifecycle.initializationFailure = true;
    try {
      expect(() => createViewportScene({} as HTMLCanvasElement)).toThrow(ViewportSceneInitializationFailure);
      expect(lifecycle.instances.at(-1)?.disposeCalls).toBe(1);
    } finally { lifecycle.initializationFailure = false; }
    const next = createViewportScene({} as HTMLCanvasElement);
    next.dispose();
    expect(lifecycle.instances.at(-1)?.disposeCalls).toBe(1);
  });

  it('tries all acquired resources after a later layer add throws and retries only the actual failed renderer', () => {
    let adds = 0;
    const add = vi.spyOn(THREE.Scene.prototype, 'add').mockImplementation(function (this: THREE.Scene, ...objects) {
      if (++adds === 8) throw new Error('Later layer add failure');
      THREE.Object3D.prototype.add.apply(this, objects);
      return this;
    });
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    lifecycle.initializationCleanupFailure = true;
    let failure: ViewportSceneInitializationFailure | null = null;
    try { createViewportScene({} as HTMLCanvasElement); }
    catch (error) { if (!(error instanceof ViewportSceneInitializationFailure)) throw error; failure = error; }
    finally { add.mockRestore(); lifecycle.initializationCleanupFailure = false; }
    expect(failure).not.toBeNull();
    expect(failure?.cleanup.pendingCount).toBe(1);
    expect(geometryDispose.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(materialDispose.mock.calls.length).toBeGreaterThan(0);
    const successfulGeometries = geometryDispose.mock.calls.length;
    const successfulMaterials = materialDispose.mock.calls.length;
    const renderer = lifecycle.instances.at(-1);
    if (renderer === undefined) throw new Error('Acquired renderer missing');
    renderer.disposeFailure = false;
    failure?.cleanup.dispose();
    expect(failure?.cleanup.pendingCount).toBe(0);
    expect(renderer.disposeCalls).toBe(2);
    expect(geometryDispose).toHaveBeenCalledTimes(successfulGeometries);
    expect(materialDispose).toHaveBeenCalledTimes(successfulMaterials);
    geometryDispose.mockRestore(); materialDispose.mockRestore();
    const next = createViewportScene({} as HTMLCanvasElement); next.dispose();
    expect(lifecycle.instances.at(-1)?.disposeCalls).toBe(1);
  });
});

describe('assembly Scene owner and reservation lifetime', () => {
  it('rejects stale assembly captures repeatedly and permits only a freshly admitted display', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace());
    controlled.replace(fixture.state);
    const png = Uint8Array.of(1, 2, 3);
    const capture = vi.spyOn(thumbnail, 'captureThumbnailPng').mockReturnValue(png);
    try {
      controlled.viewport.setAssembly(fixture.bundle);
      controlled.viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 },
        'perspective', 'shadedWithEdges', false, 100);
      expect(controlled.viewport.captureThumbnail()).toBe(png);
      controlled.replace({ ...fixture.state, requestedGeneration: fixture.state.requestedGeneration + 1 });
      capture.mockClear();
      expect(controlled.viewport.captureThumbnail()).toBeNull();
      expect(controlled.viewport.captureThumbnail()).toBeNull();
      expect(capture).not.toHaveBeenCalled();
      expect(controlled.viewport.pickComponent(320, 240)).toBeNull();
      expect(() => controlled.viewport.setAssembly(fixture.bundle)).toThrow(/owner.*unknown/);
      const next = assemblyFixture(controlled.read(), worldAssemblyFace());
      controlled.replace({ ...next.state, completedGeneration: next.state.requestedGeneration });
      // The real Canvas subscriber publishes the current empty solid owner before Assembly.
      controlled.viewport.setBodies(solidBodiesForAdmission(controlled.read()));
      controlled.viewport.setAssembly(next.bundle);
      expect(controlled.viewport.captureThumbnail()).toBe(png);
      expect(controlled.viewport.pickComponent(320, 240)).toBe('component-1');
    } finally { capture.mockRestore(); controlled.viewport.dispose(); }
  });

  it('rejects an assembly owner invalidated during the actual image read', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace());
    controlled.replace(fixture.state);
    const capture = vi.spyOn(thumbnail, 'captureThumbnailPng').mockImplementation(() => {
      controlled.replace({ ...fixture.state, cancelRequestCount: fixture.state.cancelRequestCount + 1 });
      return Uint8Array.of(1, 2, 3);
    });
    try {
      controlled.viewport.setAssembly(fixture.bundle);
      controlled.viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 },
        'perspective', 'shadedWithEdges', false, 100);
      expect(controlled.viewport.captureThumbnail()).toBeNull();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(controlled.viewport.captureThumbnail()).toBeNull();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(controlled.viewport.pickComponent(320, 240)).toBeNull();
    } finally { capture.mockRestore(); controlled.viewport.dispose(); }
  });

  it('retires an empty assembly display with stale accounting but continues rejecting nonempty unknown owners', () => {
    const ledger = new AssemblyUiBackingLedger(), pool = createGpuMeshBudget(100000);
    const fixture = assemblyFixture(useAppStore.getState(), worldAssemblyFace());
    let state = fixture.state;
    const viewport = createViewportScene({ width: 640, height: 480 } as HTMLCanvasElement,
      { uiBackings: ledger, gpuMeshBudget: pool, readSolidMeshState: () => state });
    try {
      viewport.resize(640, 480); viewport.setAssembly(fixture.bundle);
      viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 }, 'perspective', 'shadedWithEdges', false, 100);
      const borrowed = ledger.buffers();
      expect(borrowed.length).toBeGreaterThan(0);
      expect(pool.reservedBytes()).toBeGreaterThan(0);
      const view = state.assemblyView;
      if (view === null) throw new Error('published assembly fixture missing');
      const ownership: AssemblyMeshOwnership = { document: fixture.input.sourceDocument, library: state.assemblyLibrary,
        activeDocumentId: state.activeDocumentId, documentVersion: state.documentVersion,
        generation: state.requestedGeneration, outcome: state.lastOutcome, timelineIndex: state.timelineIndex,
        cancelRequestCount: state.cancelRequestCount, bodies: view.bodies, sources: new Map(),
        receipt: { status: 'unknown', observationId: 'stale-retirement-fixture', reason: 'fixture-unavailable' },
        backingInspection: { status: 'unknown', reason: 'fixture-unavailable' },
        backingInspectionCurrent: () => false, receiptCurrent: () => false, publicationCurrent: () => false,
        uiSnapshot: { epoch: ledger.epoch(), buffers: [] } };
      state = { ...state, requestedGeneration: state.requestedGeneration + 1,
        assemblyView: { ...view, meshOwnership: ownership } };
      expect(() => viewport.setAssembly(EMPTY_ASSEMBLY_GEOMETRY)).not.toThrow();
      expect(pool.reservedBytes()).toBe(0);
      expect(viewport.meshReservation().assemblyInstanceBytes).toBe(0);
      expect(viewport.pickComponent(320, 240)).toBeNull();
      expect(viewport.pointerRay(320, 240)).not.toBeNull();
      expect(borrowed.every(buffer => ledger.buffers().includes(buffer))).toBe(true);
      expect(ledger.bytes()).toBeGreaterThan(0);
      expect(() => viewport.setAssembly(buildAssemblyGeometry(fixture.input))).toThrow(/owner.*unknown/);
      const next = assemblyFixture(state, worldAssemblyFace());
      state = { ...next.state, completedGeneration: next.state.requestedGeneration };
      expect(() => viewport.setAssembly(next.bundle)).not.toThrow();
      expect(pool.reservedBytes()).toBeGreaterThan(0);
    } finally { viewport.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
    expect(ledger.pending()).toBe(0);
  });

  it('invalidates an offered bundle on assembly generation changes while part timeline changes are independent', () => {
    const pool = createGpuMeshBudget(100000);
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace());
    controlled.replace(fixture.state);
    try {
      controlled.viewport.setAssembly(fixture.bundle);
      controlled.viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 }, 'perspective', 'shadedWithEdges', false, 100);
      const before = controlled.viewport.meshReservation();
      expect(controlled.viewport.pickComponent(320, 240)).toBe('component-1');
      controlled.replace({ ...fixture.state, timelineIndex: 1 });
      expect(controlled.viewport.pickComponent(320, 240)).toBe('component-1');
      expect(controlled.viewport.meshReservation()).toEqual(before);
      controlled.replace({ ...controlled.read(), requestedGeneration: fixture.state.requestedGeneration + 1 });
      expect(controlled.viewport.pickComponent(320, 240)).toBeNull();
      expect(pool.reservedBytes()).toBe(0);
      expect(() => controlled.viewport.setAssembly(fixture.bundle)).toThrow(/owner.*unknown/);
      expect(pool.reservedBytes()).toBe(0);
      expect(controlled.viewport.pointerRay(320, 240)).not.toBeNull();
    } finally { controlled.viewport.dispose(); }
  });

  it('keeps Scene and layer on the new generation after cleanup throws and retries debt on dispose', () => {
    const pool = createGpuMeshBudget(100000);
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace());
    controlled.replace(fixture.state);
    try {
      controlled.viewport.setAssembly(fixture.bundle);
      controlled.viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 }, 'perspective', 'shadedWithEdges', false, 100);
      const scene = lifecycle.instances.at(-1)?.renderedScene;
      if (scene === null || scene === undefined) throw new Error('fixture requires rendered scene');
      const faces: THREE.InstancedMesh[] = [];
      scene.traverse(object => { if (isInstancedMesh(object)) faces.push(object); });
      const oldGeometry = faces[0].geometry;
      const refusal = () => { throw new Error('Scene old geometry release refused'); };
      oldGeometry.addEventListener('dispose', refusal);
      const next = assemblyFixture(fixture.state, worldAssemblyFace());
      controlled.replace(next.state);
      expect(() => controlled.viewport.setAssembly(next.bundle)).not.toThrow();
      expect(controlled.viewport.meshReservation().assemblyCleanupStatus).toBe('pending');
      expect(controlled.viewport.meshReservation().assemblyCleanupReservedCpuBytes).toBeGreaterThan(0);
      expect(controlled.viewport.pickComponent(320, 240)).toBe('component-1');
      expect(() => controlled.viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 },
        'perspective', 'shadedWithEdges', false, 100)).not.toThrow();
      expect(pool.reservedBytes()).toBe(controlled.viewport.meshReservation().gpuMeshBytes);
      controlled.viewport.dispose();
      expect(pool.reservedBytes()).toBeGreaterThan(0);
      expect(controlled.viewport.meshReservation().assemblyCleanupStatus).toBe('pending');
      oldGeometry.removeEventListener('dispose', refusal);
      controlled.viewport.dispose();
      expect(controlled.viewport.meshReservation().assemblyCleanupStatus).toBe('complete');
      expect(controlled.viewport.meshReservation().assemblyCleanupReservedCpuBytes).toBe(0);
      expect(pool.reservedBytes()).toBe(0);
    } finally { controlled.viewport.dispose(); }
  });

  it('returns all assembly reservations over 100 updates and rejects a previous document bundle', () => {
    const pool = createGpuMeshBudget(100000);
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace());
    const saved = JSON.stringify(fixture.state.assembly);
    controlled.replace(fixture.state);
    try {
      controlled.viewport.setAssembly(fixture.bundle);
      controlled.viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
      const reading = controlled.viewport.meshReservation();
      expect(reading.assemblySourceBackingBytes).toBe(108);
      expect(reading.assemblyInstanceBytes).toBe(140);
      expect(pool.reservedBytes()).toBe(reading.gpuMeshBytes);
      for (let cycle = 0; cycle < 100; cycle += 1) {
        controlled.viewport.setAssembly(buildAssemblyGeometry({ ...fixture.input,
          placements: new Map([['component-1', { position: [cycle, 0, 0], rotation: IDENTITY_PLACEMENT.rotation }]]) }));
        expect(controlled.viewport.meshReservation()).toEqual(reading);
        expect(pool.reservedBytes()).toBe(reading.gpuMeshBytes);
      }
      expect(JSON.stringify(fixture.state.assembly)).toBe(saved);
      expect(controlled.read()).toBe(fixture.state);
      const replacement = assemblyFixture(fixture.state, worldAssemblyFace());
      controlled.replace(replacement.state);
      expect(() => controlled.viewport.setAssembly(fixture.bundle)).toThrow(/owner.*unknown/);
      expect(pool.reservedBytes()).toBe(0);
      expect(controlled.viewport.meshReservation().assemblyInstanceBytes).toBe(0);
      expect(controlled.viewport.pickComponent(320, 240)).toBeNull();
      expect(controlled.viewport.pointerRay(320, 240)).not.toBeNull();
      controlled.viewport.setAssembly(replacement.bundle);
      expect(pool.reservedBytes()).toBe(reading.gpuMeshBytes);
    } finally { controlled.viewport.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });

  it('rejects local assembly input without final accounting and keeps plane input available', () => {
    const pool = createGpuMeshBudget(100000);
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    const fixture = assemblyFixture(controlled.read(), localFace(1e9));
    controlled.replace(fixture.state);
    try {
      controlled.viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
      expect(() => controlled.viewport.setAssembly(fixture.bundle)).toThrow(/final accounting is unknown/);
      expect(pool.reservedBytes()).toBe(0);
      expect(controlled.viewport.pointerRay(320, 240)).not.toBeNull();
    } finally { controlled.viewport.dispose(); }
  });

  it('rolls back unpublished assembly assets when the owner changes during construction', () => {
    const pool = createGpuMeshBudget(100000);
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace());
    controlled.replace(fixture.state);
    boundary.beforeBuild = () => controlled.replace({ ...fixture.state,
      cancelRequestCount: fixture.state.cancelRequestCount + 1 });
    try {
      expect(() => controlled.viewport.setAssembly(fixture.bundle)).toThrow(/owner changed/);
      expect(pool.reservedBytes()).toBe(0);
      expect(controlled.viewport.meshReservation().assemblyInstanceBytes).toBe(0);
      expect(controlled.viewport.pickComponent(320, 240)).toBeNull();
    } finally { boundary.beforeBuild = null; controlled.viewport.dispose(); }
    expect(pool.reservedBytes()).toBe(0);
  });
});

describe('createViewportScene の描画・解放寿命(R07)', () => {
  it('applies the local result mesh-byte limit through public setBodies', () => {
    const body = localFace(1e9);
    const frame = body.coordinateFrame;
    if (frame === undefined) throw new Error('missing local frame');
    const mesh = body.mesh;
    const required = mesh.positions.byteLength + mesh.normals.byteLength
      + mesh.indices.byteLength + mesh.edgePositions.byteLength + mesh.indices.length * 36;
    const appearance: AppearanceInput = {
      defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['face', {
        bodyAppearance: appearanceFromPreset('wood'), faceAppearances: new Map(),
      }]]),
    };
    for (const [limit, shouldPass] of [[required - 1, false], [required, true]] as const) {
      const viewport = testViewport({ width: 640, height: 480 } as HTMLCanvasElement);
      try {
        viewport.setAppearance(appearance);
        const limited: SolidBody = { ...body, coordinateFrame: { ...frame, maximumLiveMeshBytes: limit } };
        if (shouldPass) {
          expect(() => viewport.setBodies([limited])).not.toThrow();
        } else {
          expect(() => viewport.setBodies([limited])).toThrow(/live-byte budget/);
        }
      } finally { viewport.dispose(); }
    }
    const legacy = testViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    try {
      legacy.setAppearance(appearance);
      expect(() => legacy.setBodies([body])).not.toThrow();
    } finally { legacy.dispose(); }
  });

  it('rebinds selected face overlays to current bodies in the same quad scene', () => {
    lifecycle.instances.length = 0;
    const viewport = testViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const a = localFace(1e9);
    const b: SolidBody = { ...localFace(-1e9), featureId: 'other' };
    const orbit = { ...HOME_ORBIT, target: [1e9, 0, 0] as const, distance: 20 };
    viewport.setBodies([a, b]);
    viewport.setSubShapeHighlight(null, ['face#face:0', 'other#face:0']);
    viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
    const scene = lifecycle.instances[0].renderedScene;
    if (scene === null) throw new Error('missing scene');
    const overlayOrigins = (): number[] => {
      const origins: number[] = [];
      scene.traverse((object) => {
        if (object instanceof THREE.Group
          && object.children.some((entry) => entry instanceof THREE.Points)
          && object.children.some((entry) => entry instanceof THREE.Mesh && entry.renderOrder > 0)) {
          origins.push(object.position.x);
        }
      });
      return origins;
    };
    expect(overlayOrigins()).toEqual([1e9, -1e9]);
    const quad = createQuadCameraState(orbit);
    viewport.renderQuad(quad, 'perspective', 'shadedWithEdges', false, 100);
    expect(lifecycle.instances[0].renderedScene).toBe(scene);
    viewport.setBodies([b]);
    expect(overlayOrigins()).toEqual([-1e9]);
    viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
    expect(overlayOrigins()).toEqual([-1e9]);
    viewport.setBodies([]);
    expect(overlayOrigins()).toEqual([]);
    viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
    expect(overlayOrigins()).toEqual([]);
    viewport.dispose();
  });
  it.each([0, 1e6, -1e9])('world X=%sで各quadカメラのmodelViewを小さい値に保ち、face indexをworldで選ぶ', (x) => {
    lifecycle.instances.length = 0;
    const viewport = testViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    viewport.resize(640, 480);
    viewport.setBodies([localFace(x)]);
    const orbit = { ...HOME_ORBIT, target: [x + 0.25, 0.25, 0] as const, distance: 20 };
    viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
    expect(viewport.fullyFramedBodyIds()).toContain('face');
    const pickedFace = viewport.pickFaceAt(320, 240);
    if (pickedFace === null) {
      const screen = viewport.worldToScreen([x + 0.25, 0.25, 0]);
      const pickedBody = viewport.pickBody(320, 240);
      throw new Error(`face pick missing at x=${x}: worldToScreen=${JSON.stringify(screen)}, pickBody=${pickedBody}, pickFace=${pickedFace}`);
    }
    expect(pickedFace).toEqual({ featureId: 'face', faceIndex: 0 });
    const renderer = lifecycle.instances.at(-1);
    expect(renderer?.modelViewTranslations).toHaveLength(1);
    const state = createQuadCameraState(orbit);
    viewport.renderQuad(state, 'perspective', 'shadedWithEdges', false, 100);
    expect(renderer?.modelViewTranslations).toHaveLength(5);
    for (const translation of renderer?.modelViewTranslations ?? []) {
      expect(translation.every((value) => Number.isFinite(value) && Math.abs(value) < 100)).toBe(true);
    }
    viewport.setBodies([]);
    expect(viewport.pickFaceAt(320, 240)).toBeNull();
    viewport.dispose();
  });

  it.each(['request', 'completion', 'cancel', 'document', 'session', 'history', 'receipt', 'outcome', 'assembly', 'drawing'] as const)(
    'rechecks %s with identical bodies at render/pick/capture/appearance/highlight entrances', scenario => {
      const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
      const viewport = controlled.viewport, body = localFace(0);
      const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
      try {
        controlled.adopt([body]);
        viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
        expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
        const state = controlled.read();
        if (scenario === 'request') controlled.replace({ ...state, requestedGeneration: 8 });
        if (scenario === 'completion') controlled.replace({ ...state, completedGeneration: 6 });
        if (scenario === 'cancel') controlled.replace({ ...state, meshJsAccounting: null, cancelRequestCount: state.cancelRequestCount + 1 });
        if (scenario === 'document') controlled.replace({ ...state, document: { ...state.document, id: 'model-E' } });
        if (scenario === 'session') controlled.replace({ ...state, activeDocumentId: 'session-E' });
        if (scenario === 'history') controlled.replace({ ...state, timelineIndex: 0 });
        if (scenario === 'receipt') controlled.replace({ ...state, meshJsAccounting: null });
        if (scenario === 'outcome') controlled.replace({ ...state, lastOutcome: 'failed' });
        if (scenario === 'assembly') controlled.replace({ ...state, assembly: createAssemblyDocument('組立') });
        if (scenario === 'drawing') controlled.replace({ ...state, drawing: drawingFixture() });
        const beforeBuilds = boundary.solidBuildCalls;
        expect(viewport.pickFaceAt(320, 240)).toBeNull();
        expect(viewport.captureThumbnail()).toBeNull();
        expect(viewport.capturePrintFrame()).toBeNull();
        viewport.setAppearance(null);
        viewport.setBodyHighlight('face', ['face']);
        viewport.setSubShapeHighlight(null, ['face#face:0']);
        expect(boundary.solidBuildCalls).toBe(beforeBuilds);
        viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
        expect(viewport.fullyFramedBodyIds()).toEqual([]);
      } finally { viewport.dispose(); }
    },
  );

  it.each(['local', 'world'] as const)('re-admits the same %s bodies after an ownership-only change without rebuilding', kind => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    const body: SolidBody = kind === 'local' ? localFace(0) : { ...localFace(0), coordinateFrame: undefined };
    const bodies = [body];
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    try {
      controlled.adopt(bodies);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      const before = boundary.solidBuildCalls;
      const state = controlled.read();
      // A name-only edit keeps the shape receipt valid; the subscription re-delivers the same array.
      controlled.replace({ ...state, document: { ...state.document, name: 'renamed' } });
      viewport.setBodies(bodies);
      expect(boundary.solidBuildCalls).toBe(before);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
      // A changed array is a new adoption and is built once.
      const rebuilt = [{ ...body }];
      controlled.adopt(rebuilt);
      expect(boundary.solidBuildCalls).toBe(before + 1);
    } finally { viewport.dispose(); }
  });

  it('reserves the published local copies and mesh attributes, and releases them when ownership ends', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    try {
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0 });
      controlled.adopt([localFace(0)]);
      // The UV (24) is the only display copy; GPU: positions 36 + normals 36 + UV 24 + indices 12 + edges 24.
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 24, gpuMeshBytes: 132 });
      for (const resource of ['textures', 'pmrem', 'materials', 'threadMarks', 'printOpenEdges']) {
        expect(viewport.meshReservation().uncovered).toContain(resource);
      }
      viewport.setSubShapeHighlight(null, ['face#face:0']);
      // The selected one-triangle face overlay adds 84 bytes to both.
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 108, gpuMeshBytes: 216 });
      viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 }, 'perspective', 'shadedWithEdges', false, 100);
      controlled.replace({ ...controlled.read(), requestedGeneration: 8 });
      expect(viewport.pickFaceAt(320, 240)).toBeNull();
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0 });
    } finally { viewport.dispose(); }
  });

  it('bounds UV and overlay copies by the kernel baseline and keeps the valid owner when only the overlay is refused', () => {
    const limit = 1000000;
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    const refused = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    try {
      const bodies = [localFace(0)];
      refused.replace(withFinalRetained(stateWithBodies(refused.read(), bodies), limit - 23));
      expect(() => refused.viewport.setBodies(bodies)).toThrow(/live-byte budget/);
      refused.viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(refused.viewport.pickFaceAt(320, 240)).toBeNull();
      expect(refused.viewport.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0 });
    } finally { refused.viewport.dispose(); }
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    try {
      const bodies = [localFace(0)];
      // 24 UV bytes fit exactly beside the baseline; an 84-byte overlay needs one byte more than remains.
      controlled.replace(withFinalRetained(stateWithBodies(controlled.read(), bodies), limit - 24 - 83));
      viewport.setBodies(bodies);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
      expect(() => viewport.setSubShapeHighlight(null, ['face#face:0'])).toThrow(/overlay exceeds/);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 24, gpuMeshBytes: 132 });
    } finally { viewport.dispose(); }
  });

  it('returns a refused candidate\'s copies to the published cache and keeps the published display', () => {
    const limit = 1000000;
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    try {
      const bodies = [{ ...localFace(0), featureId: 'a' }, { ...localFace(5), featureId: 'b' }];
      // Published: two plain UVs (48). One 108-byte patterned copy fits beside them; a second does not.
      controlled.replace(withFinalRetained(stateWithBodies(controlled.read(), bodies), limit - 48 - 108 - 107));
      viewport.setBodies(bodies);
      expect(viewport.meshReservation().displayCopyBytes).toBe(48);
      const patterned: AppearanceInput = { defaultAppearance: DEFAULT_APPEARANCE,
        byBody: new Map(['a', 'b'].map((id) => [id, { bodyAppearance: appearanceFromPreset('expandedMetal'),
          faceAppearances: new Map() }])) };
      expect(() => viewport.setAppearance(patterned)).toThrow(/live-byte budget/);
      // Without the return, the cache would still keep A's 108-byte patterned copy (156 in all).
      expect(viewport.meshReservation().displayCopyBytes).toBe(48);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'a', faceIndex: 0 });
    } finally { viewport.dispose(); }
  });

  it('refuses a local display that needs an environment map with no known reservation; world keeps it', () => {
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    const mirror = (id: string): AppearanceInput => ({ defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([[id, { bodyAppearance: appearanceFromPreset('mirror'), faceAppearances: new Map() }]]) });
    const local = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    try {
      local.adopt([localFace(0)]);
      local.viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(() => local.viewport.setAppearance(mirror('face'))).toThrow(/environment map/);
      expect(local.viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
      expect(local.viewport.meshReservation()).toMatchObject({ displayCopyBytes: 24, gpuMeshBytes: 132 });
    } finally { local.viewport.dispose(); }
    const world = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    try {
      world.adopt([{ ...localFace(0), coordinateFrame: undefined }]);
      // A world display goes on to create its environment map (this test renderer has no PMREM
      // support and may fail there); it is never refused by the local reservation rule.
      let thrown: unknown;
      try { world.viewport.setAppearance(mirror('face')); } catch (error) { thrown = error; }
      expect(String(thrown)).not.toMatch(/GPU reservation is unknown/);
    } finally { world.viewport.dispose(); }
  });

  it.each([1e9 + 1, -1e9 - 1])('draws a far sphere grid around its double center at x=%s', (x) => {
    lifecycle.instances.length = 0;
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    try {
      viewport.setSphereGrid({ center: [x, 0, 0], radius: 1, stepDegrees: 30 });
      viewport.render({ ...HOME_ORBIT, target: [x, 0, 0], distance: 20 }, 'perspective', 'shadedWithEdges', false, 100);
      const scene = lifecycle.instances[0]?.renderedScene;
      if (scene === null || scene === undefined) throw new Error('missing rendered scene');
      const grids: THREE.Object3D[] = [];
      scene.traverse((object) => {
        if (object instanceof THREE.LineSegments && object.visible && object.position.x === x) grids.push(object);
      });
      expect(grids).toHaveLength(1);
      const grid = grids[0];
      if (!(grid instanceof THREE.LineSegments)) throw new Error('missing sphere grid lines');
      const geometry: unknown = grid.geometry;
      if (!(geometry instanceof THREE.BufferGeometry)) throw new Error('missing grid geometry');
      const position: unknown = geometry.getAttribute('position');
      if (!(position instanceof THREE.BufferAttribute)) throw new Error('missing grid positions');
      const xs = Array.from({ length: position.count }, (_unused, index) => x + position.getX(index));
      // Radius 1 lifted by 0.2 % so the lines clear the sphere's chords: 2.004 mm wide at 1e9 mm.
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2.004, 4);
    } finally { viewport.dispose(); }
  });

  it('shares one GPU mesh budget across renderers: quad panes share a reservation, a second canvas can be refused', () => {
    const pool = createGpuMeshBudget(2 * 132 - 1);
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    const a = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    const b = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
    try {
      const bodies = [localFace(0)];
      a.adopt(bodies);
      expect(pool.reservedBytes()).toBe(132);
      a.viewport.renderQuad(createQuadCameraState(orbit), 'perspective', 'shadedWithEdges', false, 100);
      a.viewport.setBodyHighlight('face', ['face']);
      expect(pool.reservedBytes()).toBe(132);
      // The same CPU arrays on another canvas need that renderer's own GPU buffers.
      expect(() => b.adopt(bodies)).toThrow(/GPU budget/);
      expect(pool.reservedBytes()).toBe(132);
      b.viewport.dispose();
      expect(pool.reservedBytes()).toBe(132);
      a.viewport.dispose();
      expect(pool.reservedBytes()).toBe(0);
      const c = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool);
      try {
        c.adopt(bodies);
        expect(pool.reservedBytes()).toBe(132);
      } finally { c.viewport.dispose(); }
      expect(pool.reservedBytes()).toBe(0);
    } finally { a.viewport.dispose(); b.viewport.dispose(); }
  });

  it('keeps sketch plane points and rays independent of solid ownership, which only gates solid picks', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    const plane = WORK_PLANES.xy;
    try {
      controlled.adopt([localFace(0)]);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      controlled.replace({ ...controlled.read(), requestedGeneration: 8 });
      // A stale solid owner neither blocks sketch input nor is cleared by it.
      expect(viewport.screenToPlanePoint(320, 240, plane)).not.toBeNull();
      expect(viewport.pointerRay(320, 240)).not.toBeNull();
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 24, gpuMeshBytes: 132 });
      // A solid pick is gated and clears the stale display.
      expect(viewport.pickFaceAt(320, 240)).toBeNull();
      expect(viewport.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0 });
      expect(viewport.screenToPlanePoint(320, 240, plane)).not.toBeNull();
    } finally { viewport.dispose(); }
  });

  it('discards D when the live reader switches to E during the actual solid build', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const viewport = controlled.viewport;
    try {
      boundary.beforeBuild = () => {
        const state = controlled.read();
        controlled.replace({ ...state, document: { ...state.document, id: 'model-E' } });
      };
      controlled.adopt([localFace(0)]);
      boundary.beforeBuild = null;
      viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
      expect(viewport.fullyFramedBodyIds()).toEqual([]);
      expect(viewport.pickBody(320, 240)).toBeNull();
      expect(viewport.capturePrintFrame()).toBeNull();
    } finally { boundary.beforeBuild = null; viewport.dispose(); }
  });

  it('rechecks ownership after the actual layer update before publishing scene inputs', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    try {
      controlled.adopt([localFace(0)]);
      viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
      boundary.afterLayerUpdate = () => {
        boundary.afterLayerUpdate = null;
        controlled.replace({ ...controlled.read(), requestedGeneration: 8 });
      };
      viewport.setBodyHighlight('face', ['face']);
      expect(viewport.pickBody(320, 240)).toBeNull();
      expect(viewport.capturePrintFrame()).toBeNull();
      expect(viewport.fullyFramedBodyIds()).toEqual([]);
    } finally { boundary.afterLayerUpdate = null; viewport.dispose(); }
  });

  it('does not use the main receipt for a different local preview and preserves the world preview entrance', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    try {
      controlled.adopt([localFace(0)]);
      const state = controlled.read(), localBodies = [localFace(100)];
      const session: NonNullable<AppState['sheetMetalTool']> = { id: 'preview', kind: 'sheetBase',
        document: state.document, documentId: state.activeDocumentId };
      const preview: NonNullable<AppState['sheetMetalPreview']> = { session, candidate: state.document,
        bodies: localBodies, featureId: 'face', volume: 1 };
      controlled.replace({ ...state, sheetMetalTool: session, sheetMetalPreview: preview });
      const before = boundary.solidBuildCalls;
      viewport.setBodies(localBodies);
      expect(boundary.solidBuildCalls).toBe(before);
      const worldBodies = [bodyFor('world-preview')];
      controlled.replace({ ...controlled.read(), sheetMetalPreview: { ...preview, bodies: worldBodies } });
      viewport.setBodies(worldBodies);
      expect(boundary.solidBuildCalls).toBe(before + 1);
    } finally { viewport.dispose(); }
  });

  it('keeps valid old body and overlays when a new overlay candidate throws, then clears stale ownership', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const viewport = controlled.viewport;
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    try {
      controlled.adopt([localFace(0)]);
      viewport.setSubShapeHighlight(null, ['face#face:0']);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      const state = controlled.read();
      boundary.overlayFailure = true;
      expect(() => viewport.setSubShapeHighlight(null, [])).toThrow('overlay candidate failed');
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
      expect(controlled.read().bodies).toBe(state.bodies);
      controlled.replace({ ...state, requestedGeneration: 8 });
      expect(viewport.pickFaceAt(320, 240)).toBeNull();
      expect(viewport.capturePrintFrame()).toBeNull();
    } finally { boundary.overlayFailure = false; viewport.dispose(); }
  });

  it('refuses an unpaired body before building and preserves a valid current owner', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const viewport = controlled.viewport;
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    try {
      controlled.adopt([localFace(0)]);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      const beforeBuilds = boundary.solidBuildCalls;
      viewport.setBodies([localFace(100)]);
      expect(boundary.solidBuildCalls).toBe(beforeBuilds);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
    } finally { viewport.dispose(); }
  });

  it('keeps E when an older D body array is delivered in reverse document order', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement), viewport = controlled.viewport;
    const staleD = [{ ...localFace(100), featureId: 'D' }];
    const currentE = [{ ...localFace(0), featureId: 'E' }];
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    try {
      controlled.adopt(staleD);
      controlled.replace({ ...controlled.read(), document: { ...controlled.read().document, id: 'model-E' } });
      controlled.adopt(currentE);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      const before = boundary.solidBuildCalls;
      viewport.setBodies(staleD);
      expect(boundary.solidBuildCalls).toBe(before);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'E', faceIndex: 0 });
    } finally { viewport.dispose(); }
  });

  it('standalone world display remains available but standalone local bodies have no implicit receipt', () => {
    const viewport = createViewportScene({ width: 640, height: 480 } as HTMLCanvasElement);
    try {
      const beforeBuilds = boundary.solidBuildCalls;
      viewport.setBodies([localFace(0)]);
      expect(boundary.solidBuildCalls).toBe(beforeBuilds);
      const world = bodyFor('world');
      viewport.setBodies([world]);
      expect(boundary.solidBuildCalls).toBe(beforeBuilds + 1);
      viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
    } finally { viewport.dispose(); }
  });

  it('100回の生成→resize→render→下絵更新→解放でgrid資源を各1回解放し、解放後は描かない', () => {
    const lifecycleStartedAt = performance.now();
    lifecycle.instances.length = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const canvas = { width: 640, height: 480 } as HTMLCanvasElement;
      const viewport = createViewportScene(canvas);
      viewport.resize(640, 480);
      viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', true, 100);
      viewport.setCanvases([]);
      const renderer = lifecycle.instances[iteration];
      expect(renderer.renderCalls).toBe(1);
      const renderedScene = renderer.renderedScene;
      expect(renderedScene).toBeInstanceOf(THREE.Scene);
      if (renderedScene === null) throw new Error('描画されたシーンがありません。');
      const gridGroup = renderedScene.children[2];
      expect(gridGroup).toBeInstanceOf(THREE.Group);
      const grid = gridGroup.children[0];
      const axis = gridGroup.children[1];
      if (!(grid instanceof THREE.LineSegments) || !(axis instanceof THREE.LineSegments)) {
        throw new Error('方眼と軸が見つかりません。');
      }
      if (!(grid.geometry instanceof THREE.BufferGeometry) || !(axis.geometry instanceof THREE.BufferGeometry)) {
        throw new Error('方眼と軸の形状がありません。');
      }
      const oldGrid = grid.geometry;
      const oldAxis = axis.geometry;
      let oldGridDisposed = 0;
      let oldAxisDisposed = 0;
      oldGrid.addEventListener('dispose', () => { oldGridDisposed += 1; });
      oldAxis.addEventListener('dispose', () => { oldAxisDisposed += 1; });
      viewport.setThemeColors({ ...DEFAULT_THEME_COLORS, gridMinor: 0xffffff });
      expect(oldGridDisposed).toBe(1);
      expect(oldAxisDisposed).toBe(1);
      const currentGrid = grid.geometry;
      const currentAxis = axis.geometry;
      if (!(currentGrid instanceof THREE.BufferGeometry) || !(currentAxis instanceof THREE.BufferGeometry)) {
        throw new Error('更新後の方眼と軸の形状がありません。');
      }
      let currentGridDisposed = 0;
      let currentAxisDisposed = 0;
      currentGrid.addEventListener('dispose', () => { currentGridDisposed += 1; });
      currentAxis.addEventListener('dispose', () => { currentAxisDisposed += 1; });
      viewport.dispose();
      viewport.dispose();
      expect(renderer.disposeCalls).toBe(1);
      expect(currentGridDisposed).toBe(1);
      expect(currentAxisDisposed).toBe(1);
      viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', true, 100);
      expect(renderer.renderCalls).toBe(1);
    }
    expect(lifecycle.instances).toHaveLength(100);
    process.stdout.write(`[W19 measure] sceneLifetimes=100 totalMs=${(performance.now() - lifecycleStartedAt).toFixed(6)}\n`);
  });

  it.each(['solid', 'grid', 'renderer'] as const)('holds reservations after %s cleanup failure, attempts remaining owners and retries disposal', kind => {
    const observation = createViewportMeshObservation('viewport-test');
    const pool = createGpuMeshBudget(1000000);
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement, pool, observation);
    const viewport = controlled.viewport;
    controlled.adopt([localFace(0)]);
    viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', true, 100);
    const renderer = lifecycle.instances.at(-1);
    const renderedScene = renderer?.renderedScene;
    if (renderer === undefined || renderedScene === null || renderedScene === undefined) throw new Error('rendered owner missing');
    const gridGroup = renderedScene.children[2], solidGroup = renderedScene.children[3];
    if (!(gridGroup instanceof THREE.Group) || !(solidGroup instanceof THREE.Group)) throw new Error('owner groups missing');
    const grid = gridGroup.children[0], axis = gridGroup.children[1];
    const solid = solidGroup.children.find(object => object instanceof THREE.Mesh && Array.isArray(object.material));
    if (!(grid instanceof THREE.LineSegments) || !(axis instanceof THREE.LineSegments) || !(solid instanceof THREE.Mesh)) throw new Error('owner resources missing');
    const gridGeometry: unknown = grid.geometry, axisGeometry: unknown = axis.geometry, solidGeometry: unknown = solid.geometry;
    if (!(gridGeometry instanceof THREE.BufferGeometry) || !(axisGeometry instanceof THREE.BufferGeometry)
      || !(solidGeometry instanceof THREE.BufferGeometry)) throw new Error('owner geometries missing');
    let gridAttempts = 0, axisAttempts = 0, solidAttempts = 0;
    gridGeometry.addEventListener('dispose', () => { gridAttempts += 1; });
    axisGeometry.addEventListener('dispose', () => { axisAttempts += 1; });
    solidGeometry.addEventListener('dispose', () => { solidAttempts += 1; });
    const fail = (): never => { throw new Error('geometry cleanup failed'); };
    const failed = kind === 'solid' ? solidGeometry : gridGeometry;
    if (kind === 'renderer') renderer.disposeFailure = true;
    else failed.addEventListener('dispose', fail);
    const before = viewport.meshReservation();
    const publication = [...observation.snapshot().events].reverse().find(event => event.kind === 'publish-complete');
    expect(publication).toMatchObject({ documentId: controlled.read().activeDocumentId,
      generation: 7, preview: false, hostGpuAttributeBytes: before.gpuMeshBytes,
      hostDisplayCopyBytes: before.displayCopyBytes, hostGpuReservedBytes: null });
    const release = vi.spyOn(pool, 'release');
    expect(pool.reservedBytes()).toBeGreaterThan(0);
    viewport.dispose();
    expect(viewport.meshReservation().viewportCleanupStatus).toBe('pending');
    expect(viewport.meshReservation().gpuMeshBytes).toBe(before.gpuMeshBytes);
    expect(viewport.meshReservation().displayCopyBytes).toBe(before.displayCopyBytes);
    expect(pool.reservedBytes()).toBe(before.gpuMeshBytes);
    expect(viewport.meshReservation().uncovered).toContain('retiredViewportResources');
    expect(observation.snapshot().events.some(event => event.kind === 'release-complete'
      && event.resourceOwnerId === publication?.resourceOwnerId)).toBe(false);
    expect(gridAttempts).toBe(1); expect(axisAttempts).toBe(1); expect(solidAttempts).toBe(1);
    expect(renderer.disposeCalls).toBe(1);
    expect(viewport.pickFaceAt(320, 240)).toBeNull();
    const calls = renderer.renderCalls;
    viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', true, 100);
    expect(renderer.renderCalls).toBe(calls);
    renderer.disposeFailure = false;
    failed.removeEventListener('dispose', fail);
    viewport.dispose(); viewport.dispose();
    expect(viewport.meshReservation()).toMatchObject({ viewportCleanupStatus: 'complete', displayCopyBytes: 0, gpuMeshBytes: 0 });
    expect(pool.reservedBytes()).toBe(0);
    expect([...observation.snapshot().events].reverse().find(event => event.kind === 'release-complete')).toMatchObject({
      resourceOwnerId: publication?.resourceOwnerId, hostGpuAttributeBytes: 0,
      hostDisplayCopyBytes: 0, hostGpuReservedBytes: 0, reason: 'disposed',
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(new Set(release.mock.calls.map(([owner]) => owner)).size).toBe(2);
    expect(gridAttempts).toBe(kind === 'grid' ? 2 : 1);
    expect(solidAttempts).toBe(kind === 'solid' ? 2 : 1);
    expect(axisAttempts).toBe(1);
    expect(renderer.disposeCalls).toBe(kind === 'renderer' ? 2 : 1);
  });

  it.each(['replaced', 'shared'] as const)('records one hundred real Scene publications with %s attributes and retires host ownership only on disposal', mode => {
    const observation = createViewportMeshObservation('viewport-test');
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement,
      createGpuMeshBudget(1000000), observation);
    controlled.viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', true, 100);
    const sharedBodies = [localFace(0)];
    for (let generation = 1; generation <= 100; generation += 1) {
      const bodies = mode === 'shared' ? sharedBodies : [localFace(generation)];
      const state = stateWithBodies(controlled.read(), bodies), accounting = state.meshJsAccounting;
      if (accounting === null) throw new Error('current receipt missing');
      controlled.replace({ ...state, requestedGeneration: generation, completedGeneration: generation,
        meshJsAccounting: { ...accounting, receipt: { ...accounting.receipt, generation } } });
      controlled.viewport.setBodies(bodies);
    }
    const published = observation.snapshot();
    expect(published.events.filter(event => event.kind === 'publish-complete')).toHaveLength(100);
    expect(new Set(published.events.map(event => event.resourceOwnerId)).size).toBe(1);
    expect(new Set(published.events.filter(event => event.kind === 'publish-complete').map(event => event.publicationId)).size).toBe(100);
    expect(published).toMatchObject({ droppedRecords: 0, missingRecords: 0, missingStarts: 0,
      duplicateTerminals: 0, conflictingOwners: 0, unfinishedOwners: 0,
      retiredPublications: 99, livePublications: 1, hostReleasedOwners: 0 });
    controlled.viewport.dispose();
    expect(observation.snapshot()).toMatchObject({ droppedRecords: 0, livePublications: 0, hostReleasedOwners: 1 });
    expect(observation.snapshot().events.filter(event => event.kind === 'release-complete')).toHaveLength(1);
    expect(observation.snapshot().unobserved).toContain('driverGpuActual');
    observation.close('viewport-test');
    observation.record({ documentId: 'late', viewportOwnerId: 'viewport-test', resourceOwnerId: 'late', generation: 101, preview: false }, 'publish-complete');
    expect(observation.snapshot()).toMatchObject({ active: false, droppedRecords: 1, hostReleasedOwners: 1 });
  });
});

/** A synthetic issued-provider contract fixture; native Source evidence is tested in model, not inferred here. */
async function controlledRepairPreviewSource(assemblySource = false) {
  resetTestStore();
  const original = repairFixture();
  const fixture = assemblySource ? { ...original, document: { ...original.document,
    solids: original.document.solids.map(feature => feature.id === 'base'
      ? { ...createPrimitiveFeature(original.document, 'box'), id: feature.id, name: feature.name } : feature) } } : original;
  const body: SolidBody = { ...fixture.body, coordinateFrame: { space: 'local', origin: [0, 0, 0],
    maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 1024 * 1024 }, mesh: { ...fixture.body.mesh,
    edgePositions: new Float32Array([-5, 0, 0, 5, 0, 0, -20, 0, 0, 20, 0, 0]) } };
  const hiddenBodies = [body], displayBodies: readonly SolidBody[] = [];
  type Owner = NonNullable<ReturnType<NonNullable<KernelBridge['meshLedgerOwner']>>>;
  type Receipt = Awaited<ReturnType<NonNullable<KernelBridge['captureCurrentMeshLedger']>>>;
  type Inspection = Awaited<ReturnType<NonNullable<KernelBridge['inspectSourceMeshBackings']>>>;
  const owner: Owner = { dispatchId: 'hidden-preview-fixture', partId: 'preview-fixture', generation: 7,
    kind: 'hidden', steps: [{ id: 'base', key: 'base-key' }] };
  const receipts = new WeakSet<Receipt>(), inspections = new WeakMap<Inspection, Receipt>();
  const sourceBuffers = new Set([body.mesh.positions.buffer, body.mesh.normals.buffer, body.mesh.indices.buffer, body.mesh.edgePositions.buffer]);
  let providerCurrent = true, observations = 0, limit = 1024 * 1024;
  let delay: (() => Promise<void>) | null = null;
  function unused(): never { throw new Error('Unused geometry operation in controlled provider fixture'); }
  const bridge: KernelBridge = {
    tessellateSketchFaces: unused, offsetSketchCurves: unused, projectSketchCurves: unused,
    sectionSketchCurves: unused, measure: unused, exportShapes: unused, importShape: unused,
    inspectPrintability: unused, dispose() { providerCurrent = false; },
    recomputeSolids: () => Promise.resolve({ bodies: displayBodies, cacheHits: 0, cancelled: false, failures: [] }),
    meshLedgerOwner: bodies => bodies === hiddenBodies ? owner : null,
    readCachedBodies: () => Promise.resolve({ bodies: hiddenBodies, cacheHits: 1, cancelled: false, failures: [] }),
    releaseReferenceMeshLease: () => Promise.resolve({ released: true }),
    captureCurrentMeshLedger: async input => {
      observations++;
      if (delay !== null) await delay();
      if (!providerCurrent || input.owners.some(value => value !== owner)) return { status: 'unknown', observationId: input.observationId, reason: 'unissued-owner' };
      const bytes = [...sourceBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      const receipt: Receipt = { status: 'known', observationId: input.observationId, hostEpoch: 1,
        workerEpochs: [{ providerId: 1, connectionEpoch: 1, cache: 1, owners: 1 }], owners: input.owners,
        limitBytes: limit, workerRetainedBackingBytes: bytes, hostRetainedBackingBytes: bytes,
        pendingCloneReservedBytes: 0, admittedBoundBytes: bytes * 2, coverage: 'registered-solid-mesh-backings-only',
        unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
      receipts.add(receipt); return receipt;
    },
    currentMeshLedgerReceipt: receipt => providerCurrent && receipts.has(receipt),
    inspectSourceMeshBackings: (receipt, buffers) => new Promise<Inspection>(resolve => {
      if (!providerCurrent || !receipts.has(receipt)) { resolve({ status: 'unknown', reason: 'unissued-receipt' }); return; }
      const unique = new Set<ArrayBuffer>();
      for (const buffer of buffers) {
        if (!(buffer instanceof ArrayBuffer)) { resolve({ status: 'unknown', reason: 'unsupported' }); return; }
        try { new Uint8Array(buffer); } catch { resolve({ status: 'unknown', reason: 'detached' }); return; }
        unique.add(buffer);
      }
      const matched = [...unique].filter(buffer => sourceBuffers.has(buffer));
      const inspection: Inspection = { status: 'known', hostEpoch: 1,
        inputBackingBytes: [...unique].reduce((sum, buffer) => sum + buffer.byteLength, 0),
        additionalBackingBytes: [...unique].filter(buffer => !sourceBuffers.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0),
        sameSourceBackings: matched.map(buffer => new WeakRef(buffer)), coverage: 'registered-main-solid-backings-only',
        unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
      inspections.set(inspection, receipt); resolve(inspection);
    }),
    currentSourceMeshBackingInspection: (inspection, receipt) => providerCurrent && inspections.get(inspection) === receipt && receipts.has(receipt),
  };
  const result = await recomputePart(fixture.document, bridge, { generation: 7, partId: 'preview-fixture' });
  const scope = result.referenceMeshScope;
  if (scope === undefined || !scope.current) throw new Error('Real model-created current scope required for controlled provider');
  await scope.register(hiddenBodies);
  return { fixture, body, displayBodies, hiddenBodies, result, scope, owner, bridge,
    observations: () => observations, setLimit: (bytes: number) => { limit = bytes; },
    setDelay: (wait: (() => Promise<void>) | null) => { delay = wait; },
    invalidate: () => { providerCurrent = false; } };
}

async function controlledRepairPreview() {
  const source = await controlledRepairPreviewSource();
  const { fixture, body, displayBodies, hiddenBodies, result, scope, owner, bridge } = source;
  useAppStore.getState().applyDocument(fixture.document);
  useAppStore.setState({ bodies: displayBodies, partErrors: [], isComputing: false, requestedGeneration: 7,
    completedGeneration: 7, lastOutcome: 'success', recomputeCancelled: false, timelineIndex: null,
    referenceRepairBodies: { document: fixture.document, activeDocumentId: useAppStore.getState().activeDocumentId,
      generation: 7, bodies: hiddenBodies, displayBodies, scope } });
  const slot = currentRepairSlots(useAppStore.getState()).find(item => item.ownerId === 'blend');
  const session = slot === undefined ? null : beginReferenceRepair(slot.key);
  if (session === null || session.candidates.length !== 2) throw new Error('Exact current upstream candidates required');
  const hover = () => {
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    const preview = currentReferenceRepairPreview(useAppStore.getState());
    if (preview === null) throw new Error('Issued metadata required');
    return preview;
  };
  return { body, displayBodies, hiddenBodies, document: fixture.document, scope, session, hover, bridge,
    result: { ...result, referenceBodies: hiddenBodies }, hiddenOwner: owner,
    observations: source.observations, setLimit: source.setLimit, setDelay: source.setDelay, invalidate: source.invalidate,
    close: async () => { cancelReferenceRepair(session); await scope.close(); bridge.dispose(); resetTestStore(); } };
}


async function controlledAssemblyRepairPreview() {
  const source = await controlledRepairPreviewSource(true), state = useAppStore.getState();
  const part = { ...source, document: source.fixture.document, hiddenOwner: source.owner,
    result: { ...source.result, referenceBodies: source.hiddenBodies } };
  try {
  if (part.result.cancelled || part.result.generation !== 7) throw new Error('Assembly fixture source-result generation stage failed');
  if (part.result.errors.some(error => error.featureId === part.body.featureId))
    throw new Error(`Assembly fixture source-body errors stage failed: ${JSON.stringify(part.result.errors)}`);
  if (!part.scope.current || part.scope.document !== part.document || part.scope.context.generation !== part.result.generation
    || !part.scope.referenceBodyCurrent(part.body) || !part.result.referenceBodies.includes(part.body))
    throw new Error('Assembly fixture exact source-scope/body claim stage failed');
  const reference = source.fixture.reference;
  const assembly: AssemblyDocument = { ...createAssemblyDocument('preview assembly'),
    components: [{ id: 'component-1', name: 'source', source: { kind: 'part', partRef: 'part-key' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: false, suppressed: false }],
    mates: [{ id: 'repair-mate', name: 'repair', kind: 'parallel', suppressed: false, flipped: false,
      a: { kind: 'subShape', componentId: 'component-1', ref: reference },
      b: { kind: 'origin', componentId: 'component-1', element: 'x' } }] };
  const placement: RigidPlacement = { position: [900_000_000, 0, 0], rotation: [0, 0, 0, 1] };
  const bodies = new Map([['part-key', part.result.bodies]]);
  let sourceCurrent = true;
  const ownership: AssemblyMeshOwnership = { document: assembly, library: state.assemblyLibrary,
    activeDocumentId: assembly.id, documentVersion: state.documentVersion + 1, generation: 7,
    outcome: 'success', timelineIndex: null, cancelRequestCount: state.cancelRequestCount, bodies,
    sources: new Map([['part-key', { document: part.document, attachments: undefined,
      result: part.result, bodies: part.result.bodies, layouts: [], displayOwner: null,
      hiddenOwners: [part.hiddenOwner], current: () => sourceCurrent && part.scope.current }]]),
    receipt: { status: 'unknown', observationId: 'old-view-receipt-not-reused', reason: 'old-observation' },
    backingInspection: { status: 'unknown', reason: 'old-observation' },
    backingInspectionCurrent: () => false, receiptCurrent: () => false,
    publicationCurrent: () => sourceCurrent, uiSnapshot: { epoch: 0, buffers: [] } };
  useAppStore.setState({ assembly, drawing: null, activeDocumentId: assembly.id, documentVersion: ownership.documentVersion,
    requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success', isComputing: false,
    recomputeCancelled: false, timelineIndex: null,
    assemblyView: { sourceDocument: assembly, bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
      meshOwnership: ownership, resolved: { parts: new Map(), placements: new Map([['component-1', placement]]),
        partKeys: new Map([['component-1', 'part-key']]), errors: [] } } });
  const published = useAppStore.getState();
  if (published.assembly !== assembly || published.assemblyView?.sourceDocument !== assembly
    || published.assemblyView.meshOwnership !== ownership || ownership.library !== published.assemblyLibrary
    || published.activeDocumentId !== assembly.id || published.documentVersion !== ownership.documentVersion
    || published.requestedGeneration !== 7 || published.completedGeneration !== 7
    || published.isComputing || !part.scope.current) throw new Error('Assembly fixture published owner/context stage failed');
  const slot = currentRepairSlots(published).find(item => item.ownerId === 'repair-mate');
  if (slot === undefined || slot.componentId !== 'component-1' || slot.reference !== reference)
    throw new Error('Assembly fixture exact repair-slot/reference stage failed');
  if (slot.bodies.length !== 1 || slot.bodies[0] !== part.body)
    throw new Error(`Assembly fixture admitted source-body stage failed: ${slot.bodies.map(body => body.featureId).join(',')}`);
  const session = beginReferenceRepair(slot.key);
  if (session === null) throw new Error('Assembly fixture ready session stage failed');
  if (session.candidates.length !== 2) throw new Error(`Assembly fixture exact two-candidate stage failed: ${session.candidates.length}`);
  const hover = () => {
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    const descriptor = currentReferenceRepairPreview(useAppStore.getState());
    if (descriptor === null) throw new Error('Issued current Assembly preview required');
    return descriptor;
  };
  return { ...part, assembly, placement, ownership, session, hover,
    invalidateSource: () => { sourceCurrent = false; },
    close: async () => {
      try { cancelReferenceRepair(session); await part.scope.close(); }
      finally { try { part.bridge.dispose(); } finally { resetTestStore(); } }
    } };
  } catch (error) {
    try { await part.scope.close(); }
    finally { try { part.bridge.dispose(); } finally { resetTestStore(); } }
    throw error;
  }
}


describe('independent nonstored upstream repair preview layer', () => {
  it('records the actual unknown receipt reason without publishing or adding provider observations', async () => {
    const fixture = await controlledAssemblyRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024);
    const canvas = mockRendererCanvas(200, 200);
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(), gpuMeshBudget: gpu });
    const capture = vi.spyOn(fixture.bridge, 'captureCurrentMeshLedger').mockResolvedValue({
      status: 'unknown', observationId: 'diagnostic-unknown', reason: 'actual-provider-reason',
    });
    const current = vi.spyOn(fixture.bridge, 'currentMeshLedgerReceipt').mockReturnValue(true);
    try {
      const before = useAppStore.getState();
      await viewport.setReferenceRepairPreview(fixture.hover());
      expect(capture).toHaveBeenCalledTimes(1);
      expect(viewport.meshReservation().repairPreviewRejections?.at(-1)?.reason).toBe('scene-budget:2:receipt-unknown:actual-provider-reason');
      expect(viewport.meshReservation().displayCopyBytes).toBe(0);
      expect(gpu.reservedBytes()).toBe(0);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { capture.mockRestore(); current.mockRestore(); viewport.dispose(); await fixture.close(); }
  });
  it('records the absent post-capture state before attempting another borrow', async () => {
    const fixture = await controlledAssemblyRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024);
    let stateAvailable = true;
    const options: ViewportSceneOptions = {
      get readSolidMeshState() { return stateAvailable ? () => useAppStore.getState() : undefined; },
      gpuMeshBudget: gpu,
    };
    const delay = vi.fn(() => { stateAvailable = false; return Promise.resolve(); });
    fixture.setDelay(delay);
    const viewport = createViewportScene(mockRendererCanvas(200, 200), options);
    try {
      const observationsBefore = fixture.observations();
      expect(observationsBefore).toBe(0);
      expect(stateAvailable).toBe(true);
      expect(options.readSolidMeshState).toBeDefined();
      await viewport.setReferenceRepairPreview(fixture.hover());
      expect(delay).toHaveBeenCalledTimes(1);
      expect(stateAvailable).toBe(false);
      expect(options.readSolidMeshState).toBeUndefined();
      expect(fixture.observations() - observationsBefore).toBe(1);
      expect(viewport.meshReservation().repairPreviewRejections?.at(-1)?.reason).toBe('scene-budget:2:after-unavailable');
      expect(viewport.meshReservation().displayCopyBytes).toBe(0);
      expect(gpu.reservedBytes()).toBe(0);
    } finally { viewport.dispose(); await fixture.close(); }
  });
  it('keeps a hidden Assembly borrow separate and retires it when its actual Source owner changes', async () => {
    const fixture = await controlledAssemblyRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024);
    const canvas = mockRendererCanvas(200, 200); canvas.width = 200; canvas.height = 200;
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(), gpuMeshBudget: gpu });
    try {
      const state = useAppStore.getState(), saved = JSON.stringify(state.assembly);
      await viewport.setReferenceRepairPreview(fixture.hover());
      expect(fixture.observations()).toBe(2);
      expect(viewport.meshReservation().displayCopyBytes).toBe(24);
      expect(gpu.reservedBytes()).toBe(24);
      viewport.resize(200, 200); viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 1);
      const actualPreview = lifecycle.instances.at(-1)?.renderedScene?.children.at(-1);
      expect(actualPreview?.position.x).toBe(900_000_000);
      expect(actualPreview?.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      expect(viewport.pickBody(100, 100)).toBeNull();
      expect(viewport.pickComponent(100, 100)).toBeNull();
      expect(JSON.stringify(useAppStore.getState().assembly)).toBe(saved);
      expect(useAppStore.getState().undoStack).toBe(state.undoStack);
      expect(fixture.placement.position[0]).toBe(900_000_000);
      fixture.invalidateSource();
      await viewport.setReferenceRepairPreview(currentReferenceRepairPreview(useAppStore.getState()));
      expect(gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
      expect(currentRepairSlots(useAppStore.getState()).find(slot => slot.ownerId === 'repair-mate')?.bodies).toEqual([]);
    } finally { viewport.dispose(); await fixture.close(); }
  });
  it.each([47, 48])('respects other actual GPU attribute reservation at limit=%s without releasing it', async limit => {
    const fixture = await controlledRepairPreview(), gpu = createGpuMeshBudget(limit), other = Symbol('other-viewport');
    expect(gpu.reserve(other, 24)).toBe(true);
    const canvas = mockRendererCanvas(200, 200);
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(), gpuMeshBudget: gpu });
    try {
      await viewport.setReferenceRepairPreview(fixture.hover());
      expect(viewport.meshReservation().gpuMeshBytes).toBe(limit === 48 ? 24 : 0);
      expect(gpu.reservedBytes(other)).toBe(24);
      expect(gpu.reservedBytes()).toBe(limit === 48 ? 48 : 24);
      viewport.dispose();
      expect(gpu.reservedBytes(other)).toBe(24);
      expect(gpu.reservedBytes()).toBe(24);
      expect(fixture.scope.current).toBe(true);
    } finally { viewport.dispose(); gpu.release(other); await fixture.close(); }
  });

  it('publishes exact host overlay copies while ordinary bodies, picking and saved data stay separate', async () => {
    const fixture = await controlledRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024);
    const ui = new AssemblyUiBackingLedger(), observation = createViewportMeshObservation('preview-viewport');
    const canvas = mockRendererCanvas(200, 200); canvas.width = 200; canvas.height = 200;
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(),
      gpuMeshBudget: gpu, uiBackings: ui, observation, viewportOwnerId: 'preview-viewport' });
    try {
      const state = useAppStore.getState(), json = JSON.stringify(state.document), descriptor = fixture.hover();
      await viewport.setReferenceRepairPreview(descriptor);
      expect(fixture.observations()).toBe(2); // Fresh pre-copy and fresh pre-publication provider observations.
      expect(viewport.meshReservation().displayCopyBytes).toBe(24);
      expect(viewport.meshReservation().gpuMeshBytes).toBe(24); // Host attribute bytes, not actual driver GPU memory.
      expect(gpu.reservedBytes()).toBe(24);
      viewport.resize(200, 200); viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 1);
      expect(viewport.pickBody(100, 100)).toBeNull();
      expect(viewport.pickFaceAt(100, 100)).toBeNull();
      expect(viewport.pickComponent(100, 100)).toBeNull();
      expect(JSON.stringify(useAppStore.getState().document)).toBe(json);
      expect(useAppStore.getState().bodies).toBe(fixture.displayBodies);
      expect(useAppStore.getState().undoStack).toBe(state.undoStack);
      expect(observation.snapshot().events.filter(event => event.preview).map(event => event.kind))
        .toEqual(['build-start', 'build-complete', 'publish-start', 'publish-complete']);
      cancelReferenceRepair(fixture.session);
      await viewport.setReferenceRepairPreview(currentReferenceRepairPreview(useAppStore.getState()));
      expect(gpu.reservedBytes()).toBe(0);
      expect(viewport.meshReservation().displayCopyBytes).toBe(0);
      expect(fixture.scope.current).toBe(true); // Borrowed Source owner is not returned by preview cleanup.
      expect(observation.snapshot().unfinishedOwners).toBe(0);
      expect(observation.snapshot().missingRecords).toBe(0);
      expect(observation.snapshot().duplicateTerminals).toBe(0);
    } finally { viewport.dispose(); await fixture.close(); }
  });

  it('uses actual Source/UI intersection at the minus-one and exact registered union boundaries', async () => {
    const fixture = await controlledRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024), ui = new AssemblyUiBackingLedger();
    const source = fixture.body.mesh.positions.buffer;
    ui.adopt([source]); // Adversarial actual identity reuse; it must be counted once in the union.
    const sourceBytes = new Set([fixture.body.mesh.positions.buffer, fixture.body.mesh.normals.buffer,
      fixture.body.mesh.indices.buffer, fixture.body.mesh.edgePositions.buffer]);
    const baseline = [...sourceBytes].reduce((sum, buffer) => sum + buffer.byteLength, 0) * 2;
    const canvas = mockRendererCanvas(200, 200);
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(), gpuMeshBudget: gpu, uiBackings: ui });
    try {
      const descriptor = fixture.hover();
      fixture.setLimit(baseline + 24 - 1);
      await viewport.setReferenceRepairPreview(descriptor);
      expect(viewport.meshReservation().displayCopyBytes).toBe(0);
      expect(gpu.reservedBytes()).toBe(0);
      expect(ui.bytes()).toBe(source.byteLength);
      fixture.setLimit(baseline + 24);
      await viewport.setReferenceRepairPreview(descriptor);
      expect(viewport.meshReservation().displayCopyBytes).toBe(24);
      expect(gpu.reservedBytes()).toBe(24);
      expect(ui.bytes()).toBe(source.byteLength + 24);
    } finally { viewport.dispose(); await fixture.close(); }
  });

  it('retains only failed preview cleanup and its reservation until actual retry succeeds', async () => {
    const fixture = await controlledRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024);
    const canvas = mockRendererCanvas(200, 200); canvas.width = 200; canvas.height = 200;
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(), gpuMeshBudget: gpu });
    let restoreFailure: (() => void) | null = null;
    try {
      await viewport.setReferenceRepairPreview(fixture.hover());
      viewport.resize(200, 200); viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 1);
      const rendered = lifecycle.instances.at(-1)?.renderedScene;
      const preview = rendered?.children.at(-1);
      function normalGeometry(value: unknown): value is THREE.BufferGeometry {
        if (!(value instanceof THREE.BufferGeometry)) return false;
        const attributes: unknown = Reflect.get(value, 'attributes');
        return attributes !== null && typeof attributes === 'object'
          && Object.values(attributes).every((attribute: unknown) =>
            attribute instanceof THREE.BufferAttribute || attribute instanceof THREE.InterleavedBufferAttribute);
      }
      expect(normalGeometry({ attributes: {} })).toBe(false);
      const invalidGeometry = new THREE.BufferGeometry();
      Reflect.set(invalidGeometry.attributes, 'position', {});
      expect(normalGeometry(invalidGeometry)).toBe(false);
      invalidGeometry.dispose();
      const geometries: THREE.BufferGeometry[] = [];
      preview?.traverse(object => {
        if (object instanceof THREE.LineSegments) {
          const geometry: unknown = object.geometry;
          if (!normalGeometry(geometry)) return;
          const position = geometry.getAttribute('position');
          if (position instanceof THREE.BufferAttribute && position.array instanceof Float32Array
            && position.itemSize === 3 && position.count === 2 && position.array.byteLength === 24) geometries.push(geometry);
        }
      });
      const geometry = geometries[0];
      if (geometry === undefined) throw new Error('Actual preview attribute geometry required');
      const failed = vi.spyOn(geometry, 'dispose').mockImplementation(() => { throw new Error('preview actual return failure'); });
      restoreFailure = () => failed.mockRestore();
      await viewport.setReferenceRepairPreview(null);
      expect(preview?.visible).toBe(false);
      expect(viewport.meshReservation().viewportCleanupStatus).toBe('pending');
      expect(gpu.reservedBytes()).toBe(24);
      expect(fixture.scope.current).toBe(true);
      restoreFailure(); restoreFailure = null;
      await viewport.setReferenceRepairPreview(null);
      expect(viewport.meshReservation().viewportCleanupStatus).toBe('complete');
      expect(gpu.reservedBytes()).toBe(0);
    } finally { restoreFailure?.(); viewport.dispose(); await fixture.close(); }
  });

  it('a late provider observation after cancel or generation change cannot publish or release the borrowed Source', async () => {
    const fixture = await controlledRepairPreview(), gpu = createGpuMeshBudget(1024 * 1024);
    const canvas = mockRendererCanvas(200, 200);
    let sceneState: AppState | null = null;
    const viewport = createViewportScene(canvas, { readSolidMeshState: () => sceneState ?? useAppStore.getState(), gpuMeshBudget: gpu });
    let resolve!: () => void;
    const waiting = new Promise<void>(done => { resolve = done; });
    fixture.setDelay(() => waiting);
    try {
      const pending = viewport.setReferenceRepairPreview(fixture.hover());
      expect(fixture.observations()).toBe(1);
      cancelReferenceRepair(fixture.session);
      const cancelled = viewport.setReferenceRepairPreview(null);
      sceneState = { ...useAppStore.getState(), requestedGeneration: 8, completedGeneration: 8 };
      resolve(); await pending; await cancelled;
      expect(fixture.observations()).toBe(1);
      expect(gpu.reservedBytes()).toBe(0);
      expect(viewport.meshReservation().displayCopyBytes).toBe(0);
      expect(fixture.scope.current).toBe(true);
      useAppStore.setState({ requestedGeneration: 8, completedGeneration: 8 });
      expect(fixture.scope.current).toBe(false);
      expect(gpu.reservedBytes()).toBe(0);
      expect(viewport.meshReservation().displayCopyBytes).toBe(0);
    } finally { resolve(); viewport.dispose(); await fixture.close(); }
  });
});

describe('reason-only thumbnail diagnostics', () => {
  it('retains bounded primitive copies and old subscription cleanup leaves a new token active', () => {
    const journal = thumbnail.createThumbnailCaptureReasonJournal();
    const old = thumbnail.observeThumbnailCaptureReasons(journal.record);
    const current = thumbnail.observeThumbnailCaptureReasons(journal.record);
    old(); old();
    try {
      for (let index = 0; index < 70; index += 1) thumbnail.reportThumbnailCaptureReason('test:' + index);
      const copy = journal.snapshot();
      expect(copy.sequence).toBe(70); expect(copy.dropped).toBe(6); expect(copy.entries).toHaveLength(64);
      copy.entries[0].reason = 'mutated copy'; copy.entries.length = 0;
      expect(journal.snapshot().entries[0].reason).toBe('test:6');
      expect(journal.snapshot().entries).toHaveLength(64);
    } finally { current(); }
    thumbnail.reportThumbnailCaptureReason('after cleanup'); expect(journal.snapshot().sequence).toBe(70);
  });
  it('reports fit refusal without DOM acquisition and isolates a throwing sink', () => {
    const ownerDocument = vi.fn(() => { throw new Error('unexpected DOM boundary'); });
    const source = { width: 0, height: 0 } as HTMLCanvasElement;
    Object.defineProperty(source, 'ownerDocument', { get: ownerDocument });
    const reasons: string[] = [];
    expect(thumbnail.captureThumbnailPng(source, 256, reason => { reasons.push(reason); throw new Error('observer'); })).toBeNull();
    expect(reasons).toEqual(['png:fit-null']); expect(ownerDocument).not.toHaveBeenCalled();
  });
  it('keeps a single actual image call and rejects current owner loss after that call', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const fixture = assemblyFixture(controlled.read(), worldAssemblyFace()); controlled.replace(fixture.state);
    const capture = vi.spyOn(thumbnail, 'captureThumbnailPng').mockImplementation(() => {
      controlled.replace({ ...fixture.state, cancelRequestCount: fixture.state.cancelRequestCount + 1 });
      return Uint8Array.of(1, 2, 3);
    });
    const reasons: string[] = [];
    try {
      controlled.viewport.setAssembly(fixture.bundle);
      controlled.viewport.render({ ...HOME_ORBIT, target: [0.25, 0.25, 0], distance: 20 }, 'perspective', 'shadedWithEdges', false, 100);
      expect(controlled.viewport.captureThumbnail(undefined, reason => { reasons.push(reason); throw new Error('observer'); })).toBeNull();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(reasons.slice(0, 3)).toEqual(['scene:pre-redraw', 'scene:post-redraw', 'scene:post-image']);
      expect(reasons.at(-1)).toMatch(/^scene:(solid|assembly)-owner$/);
      expect(controlled.viewport.captureThumbnail()).toBeNull(); expect(capture).toHaveBeenCalledTimes(1);
    } finally { capture.mockRestore(); controlled.viewport.dispose(); }
  });
});

describe('staged extrusion preview is display-only for picking (EX-14)', () => {
  it('never returns preview-only body or face ids, and picks again once the same body is committed', () => {
    const controlled = controlledViewport({ width: 640, height: 480 } as HTMLCanvasElement);
    const viewport = controlled.viewport;
    const orbit = { ...HOME_ORBIT, target: [0.25, 0.25, 0] as const, distance: 20 };
    try {
      let owned: StagedSolidState | null = null;
      const stager: PartStager = { stage: () => null, confirm: () => 'refused', cancel: () => undefined,
        owns: (staged) => staged === owned };
      const open: AppState = { ...controlled.read(), partStager: stager,
        numericInput: createNumericInput('extrude', 'extrudeDistance') };
      const ownership = captureStagedSolidOwnership(open, stager, 1);
      if (ownership === null) throw new Error('An open part input must own staged work');
      // The committed display has no bodies; 'face' exists only in the staged preview.
      const preview = localFace(0);
      const result: PartRecomputeResult = { ...resultFor(open.document), generation: 9, bodies: [preview],
        meshJsAccounting: { documentId: open.document.id, partId: 'part-fixture', generation: 9,
          reading: { status: 'known', limitBytes: 1000000, cacheActiveBytes: 0, cacheRetiredBytes: 0,
            cacheProtectedBytes: 0, retainedReplyBytes: 0, requestPeakReservedBytes: 0 },
          final: { status: 'known', limitBytes: 1000000, cacheActiveBytes: 0, cacheRetiredBytes: 0,
            cacheProtectedBytes: 0, displayBackingBytes: 0, replyBackingBytes: 0, retainedBackingBytes: 0,
            replyCloneReservedBytes: 0 } } };
      const receipt = result.meshJsAccounting;
      if (receipt === undefined) throw new Error('fixture receipt');
      const staged: StagedSolidState = Object.freeze({ ownership, fingerprint: 'k', finalFeatureId: 'face',
        placement: { document: open.document, timelineIndex: null, inserted: false }, displayed: open.document,
        status: 'ready', result, accounting: accountingSnapshot(open.document, null, open.activeDocumentId, result, receipt),
        wholeGeneration: null, errors: [], errorMessage: null, failure: null, confirmRequested: false });
      owned = staged;
      controlled.replace({ ...open, stagedSolid: staged });
      viewport.setBodies(result.bodies);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(viewport.fullyFramedBodyIds()).toContain('face');
      expect(viewport.pickFaceAt(320, 240)).toBeNull();
      expect(viewport.pickBody(320, 240)).toBeNull();
      // Control: the identical body as the committed display is pickable again.
      owned = null;
      controlled.adopt([preview]);
      viewport.render(orbit, 'perspective', 'shadedWithEdges', false, 100);
      expect(viewport.pickFaceAt(320, 240)).toEqual({ featureId: 'face', faceIndex: 0 });
    } finally { viewport.dispose(); }
  });
});

describe('solid analysis field overlay ownership', () => {
  const field: SolidFieldMesh = { quantity: 'xx', deformationScale: 0,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0], triangleElements: [0, 1], elementValues: [-40, 100],
    legend: { minimumMPa: -40, maximumMPa: 100, constant: false } };
  /** Runtime check of the overlay mesh, its geometry and its material (a bare instanceof Mesh is Mesh<any, any, any>). */
  const isOverlayMesh = (object: THREE.Object3D): object is THREE.Mesh => object instanceof THREE.Mesh
    && object.name.startsWith('solid-analysis-field:') && object.geometry instanceof THREE.BufferGeometry
    && object.material instanceof THREE.Material;

  it('shows one owned overlay, disposes only its replaced geometry, removes it on null and releases all on Scene dispose', () => {
    const controlled = controlledViewport(mockRendererCanvas(640, 480));
    const viewport = controlled.viewport;
    const overlays = (): THREE.Mesh[] => {
      viewport.render(HOME_ORBIT, 'perspective', 'shadedWithEdges', false, 100);
      const scene = lifecycle.instances.at(-1)?.renderedScene;
      if (scene === null || scene === undefined) throw new Error('fixture requires rendered scene');
      const found: THREE.Mesh[] = [];
      scene.traverse(object => {
        if (isOverlayMesh(object)) found.push(object);
      });
      return found;
    };
    const only = (): THREE.Mesh => {
      const found = overlays();
      expect(found).toHaveLength(1);
      const mesh = found[0];
      if (mesh === undefined) throw new Error('overlay expected');
      return mesh;
    };
    try {
      expect(overlays()).toHaveLength(0);
      viewport.setAnalysisField(field);
      const first = only(), firstDisposed = vi.fn();
      first.geometry.addEventListener('dispose', firstDisposed);
      const material = first.material, materialDisposed = vi.fn();
      if (!(material instanceof THREE.Material)) throw new Error('single overlay material expected');
      material.addEventListener('dispose', materialDisposed);
      expect(first.geometry.getAttribute('position').count).toBe(6);

      viewport.setAnalysisField({ ...field, quantity: 'vonMises' });
      expect(firstDisposed).toHaveBeenCalledTimes(1);
      const second = only(), secondDisposed = vi.fn();
      expect(second.name).toBe('solid-analysis-field:vonMises');
      expect(second.material).toBe(material);
      second.geometry.addEventListener('dispose', secondDisposed);

      viewport.setAnalysisField(null);
      expect(overlays()).toHaveLength(0);
      expect(secondDisposed).toHaveBeenCalledTimes(1);
      expect(materialDisposed).not.toHaveBeenCalled();

      viewport.setAnalysisField(field);
      const third = only(), thirdDisposed = vi.fn();
      third.geometry.addEventListener('dispose', thirdDisposed);
      viewport.dispose();
      expect(thirdDisposed).toHaveBeenCalledTimes(1);
      expect(materialDisposed).toHaveBeenCalledTimes(1);
      expect(() => { viewport.setAnalysisField(field); }).not.toThrow();
      expect(materialDisposed).toHaveBeenCalledTimes(1);
    } finally { viewport.dispose(); }
  });
});
