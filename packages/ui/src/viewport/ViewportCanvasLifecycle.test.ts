import { Raycaster, Vector3 } from 'three';
import { startMate } from '../assembly/mateActions.js';
import type { PartDocument, SolidBody } from '@pointercad/model';
import type { ViewportScene } from './createViewportScene.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssemblyDocument, createEmptyPartDocument, DEFAULT_COMPONENT_PLACEMENT, IDENTITY_PLACEMENT, resolvePart } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import type { AppState } from '../store/appState.js';
import { bodyFor, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import { ViewportCanvas } from './ViewportCanvas.js';
import { createViewportRepairPreview } from './viewportRepairPreview.js';
import { createViewportLifetime } from './viewportLifetime.js';
import { createAssemblyLayer, EMPTY_ASSEMBLY_GEOMETRY, type AssemblyGeometryBundle } from './createAssemblyLayer.js';
import { AssemblyUiBackingLedger, type AssemblyMeshOwnership } from './assemblyMeshAdmission.js';
import type * as ImportedReactTypes from 'react';
import type * as ImportedUseAppStoreTypes from '../store/useAppStore.js';
import type * as ImportedCreateViewportSceneTypes from './createViewportScene.js';
import type * as ImportedAttachCameraControlsTypes from './attachCameraControls.js';
import type * as ImportedAttachAssemblyInteractionTypes from './attachAssemblyInteraction.js';
import type * as ImportedThemeColorsTypes from './themeColors.js';

type Effect = () => void | (() => void);
type SceneCalls = Record<string, ReturnType<typeof vi.fn>>;

const fixture = vi.hoisted(() => ({
  canvas: { clientWidth: 640, clientHeight: 480, width: 640, height: 480,
    focus: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    addEventListener: vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>(),
    removeEventListener: vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>() },
  realAssemblyInput: false,
  events: new EventTarget(),
  refs: 0,
  effects: [] as Effect[],
  scenes: [] as SceneCalls[],
  caches: [] as { sync: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
    decodePublish: () => void }[],
  controls: [] as { detach: ReturnType<typeof vi.fn>; changed: () => void; interactive: (active: boolean) => void }[],
  assembly: [] as { detach: ReturnType<typeof vi.fn>; cancelDrag: ReturnType<typeof vi.fn> }[],
  sketch: [] as { detach: ReturnType<typeof vi.fn> }[],
  quads: [] as ReturnType<typeof vi.fn>[],
  observers: [] as { disconnect: ReturnType<typeof vi.fn>; changed: () => void }[],
  subscriptions: [] as { changed: (next: AppState, previous: AppState) => void; unsubscribe: ReturnType<typeof vi.fn> }[],
  frames: [] as { id: number; draw: FrameRequestCallback }[],
  cancelledFrames: [] as number[],
  stateReaders: new Array<() => AppState>(),
  initializationFailure: null as 'scene' | 'factory-rollback' | 'input' | 'observer' | 'sync' | null,
  cleanupFailure: false,
  acquiredFactoryRelease: vi.fn(),
  failures: [] as unknown[],
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportedReactTypes>();
  return { ...actual,
    useCallback: (callback: (...args: never[]) => unknown) => callback,
    useEffect: (effect: Effect) => { fixture.effects.push(effect); },
    useRef: (initial: unknown) => {
      const index = fixture.refs++;
      return { current: index === 0 ? fixture.canvas : index === 1 ? null : initial };
    },
    useState: (initial: unknown) => [initial, vi.fn(value => { if (value instanceof Error) fixture.failures.push(value); })],
  };
});

vi.mock('../store/useAppStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportedUseAppStoreTypes>();
  const store = actual.useAppStore;
  const hook = Object.assign((selector: (state: AppState) => unknown) => selector(store.getState()), {
    getState: store.getState,
    // resetTestStore reads the store's initial values (tutorial checkpoint storage).
    getInitialState: store.getInitialState,
    setState: store.setState,
    subscribe: (changed: (next: AppState, previous: AppState) => void) => {
      const original = store.subscribe(changed);
      const unsubscribe = vi.fn(original);
      fixture.subscriptions.push({ changed, unsubscribe });
      return unsubscribe;
    },
  });
  return { useAppStore: hook };
});

vi.mock('./createViewportScene.js', async importOriginal => {
  const { ViewportSceneInitializationFailure } = await importOriginal<typeof ImportedCreateViewportSceneTypes>();
  return { ViewportSceneInitializationFailure,
  createViewportScene: (_canvas: unknown, options?: { readSolidMeshState: () => AppState }) => {
    if (fixture.initializationFailure === 'scene') throw new Error('Scene constructor failure');
    if (fixture.initializationFailure === 'factory-rollback') {
      const acquired = createViewportLifetime();
      acquired.register('actual acquired factory resource', () => { fixture.acquiredFactoryRelease(); });
      acquired.dispose();
      throw new ViewportSceneInitializationFailure(new Error('Factory configuration failure'), acquired);
    }
    if (options !== undefined) fixture.stateReaders.push(options.readSolidMeshState);
    const repair = createViewportRepairPreview({ add: vi.fn(), remove: vi.fn() }, new AssemblyUiBackingLedger(), {}, () => undefined);
    const calls: SceneCalls = {};
    const scene = new Proxy(calls, { get(target, property) {
      if (typeof property !== 'string') return undefined;
      if (property === 'setReferenceRepairPreview') {
        target[property] ??= vi.fn<ViewportScene['setReferenceRepairPreview']>(repair.setReferenceRepairPreview);
        return target[property];
      }
      target[property] ??= vi.fn(() => {
        if (property === 'resize' && fixture.initializationFailure === 'sync') throw new Error('Initial sync failure');
        if (property === 'dispose' && fixture.cleanupFailure) throw new Error('Actual scene cleanup failure');
        if (property === 'captureThumbnail') return Uint8Array.of(1, 2, 3);
        if (property === 'capturePrintFrame') return 'print-frame';
        if (property === 'fullyFramedBodyIds') return ['body-1'];
        if (property === 'meshReservation') return { displayCopyBytes: 24, gpuMeshBytes: 48,
          assemblySourceBackingBytes: 12, assemblyInstanceBytes: 64, uncovered: ['textures'] };
        return undefined;
      });
      return target[property];
    } });
    fixture.scenes.push(scene);
    return scene;
  },
  };
});

vi.mock('./createCanvasImageCache.js', () => ({
  createCanvasImageCache: (options: { publish: (images: ReadonlyMap<string, object>) => void }) => {
    const cache = { sync: vi.fn(() => options.publish(new Map())), dispose: vi.fn(), cleanupPending: () => false,
      decodePublish: () => options.publish(new Map()) };
    fixture.caches.push(cache);
    return cache;
  },
}));

vi.mock('./attachCameraControls.js', async importOriginal => {
  const actual = await importOriginal<typeof ImportedAttachCameraControlsTypes>();
  return { attachCameraControls: (...args: Parameters<typeof actual.attachCameraControls>) => {
    const [, changed, interactive = () => {}] = args;
    const real = fixture.realAssemblyInput ? actual.attachCameraControls(...args) : undefined;
    const controls = { detach: vi.fn(() => real?.detach()), changed, interactive, cancelDrag: vi.fn(),
      getOrbit: vi.fn(() => real?.getOrbit() ?? ({})), isDragging: vi.fn(() => real?.isDragging() ?? false),
      goHome: vi.fn(() => real?.goHome()), setOrbit: vi.fn() };
    // Preserve the real control setters, including the ViewportCanvas onChange callback.
    const result = real === undefined ? controls : { ...controls, setOrbit: (...values: Parameters<typeof real.setOrbit>) => real.setOrbit(...values) };
    fixture.controls.push(result);
    return result;
  } };
});
vi.mock('./attachAssemblyInteraction.js', async importOriginal => {
  const actual = await importOriginal<typeof ImportedAttachAssemblyInteractionTypes>();
  return { ...actual, attachAssemblyInteraction: (...args: Parameters<typeof actual.attachAssemblyInteraction>) => {
    const real = fixture.realAssemblyInput ? actual.attachAssemblyInteraction(...args) : undefined;
    const interaction = { detach: vi.fn(() => real?.detach()), cancelDrag: vi.fn(() => real?.cancelDrag()) };
    fixture.assembly.push(interaction);
    return interaction;
  } };
});
vi.mock('./attachSketchInteraction.js', () => ({
  attachSketchInteraction: () => {
    if (fixture.initializationFailure === 'input') throw new Error('Sketch attachment failure');
    const interaction = { detach: vi.fn() };
    fixture.sketch.push(interaction);
    return interaction;
  },
}));
vi.mock('./attachQuadInput.js', () => ({
  attachQuadInput: () => {
    const detach = vi.fn();
    fixture.quads.push(detach);
    return detach;
  },
}));
vi.mock('./themeColors.js', async importOriginal => ({
  ...await importOriginal<typeof ImportedThemeColorsTypes>(), readThemeColors: () => ({}),
}));

function mount() {
  fixture.refs = 0;
  ViewportCanvas();
  const effect = fixture.effects.pop();
  if (effect === undefined) throw new Error('Viewport effect missing');
  const cleanup = effect();
  if (typeof cleanup !== 'function') throw new Error('Viewport cleanup missing');
  const index = fixture.scenes.length - 1;
  return { cleanup, scene: fixture.scenes[index], cache: fixture.caches[index],
    controls: fixture.controls[index], assembly: fixture.assembly[index],
    sketch: fixture.sketch[index], observer: fixture.observers[index],
    quad: fixture.quads[index], subscription: fixture.subscriptions[index] };
}

function drawingFixture(): DrawingDocument {
  return { id: 'drawing-D', name: '図面', schemaVersion: 1,
    source: { sourceRef: 'part-D', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '2026-10-05T00:00:00Z' },
    sheet: { paperSizeId: 'A4', orientation: 'landscape', scale: 1, projectionMethod: 'third', frame: { visible: false },
      titleBlock: { title: '', drawingNumber: '', revision: '', author: '', date: '', material: '' } },
    views: [], dimensions: [], annotations: [], tables: [], balloons: [], datums: [], gdtFrames: [], weldSymbols: [], layers: [], parameters: [] };
}

beforeEach(() => {
  resetTestStore();
  fixture.realAssemblyInput = false;
  fixture.events = new EventTarget();
  fixture.canvas.addEventListener.mockImplementation((type, listener) => fixture.events.addEventListener(type, listener));
  fixture.canvas.removeEventListener.mockImplementation((type, listener) => fixture.events.removeEventListener(type, listener));
  fixture.scenes.length = 0; fixture.caches.length = 0; fixture.controls.length = 0;
  fixture.assembly.length = 0; fixture.sketch.length = 0; fixture.quads.length = 0;
  fixture.observers.length = 0; fixture.subscriptions.length = 0;
  fixture.frames.length = 0; fixture.cancelledFrames.length = 0; fixture.effects.length = 0;
  fixture.stateReaders.length = 0;
  fixture.initializationFailure = null; fixture.cleanupFailure = false; fixture.failures.length = 0;
  fixture.acquiredFactoryRelease.mockReset();
  fixture.canvas.addEventListener.mockClear(); fixture.canvas.removeEventListener.mockClear();
  vi.stubGlobal('window', {});
  vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  vi.stubGlobal('ResizeObserver', class {
    readonly disconnect = vi.fn();
    readonly observe = vi.fn(() => { if (fixture.initializationFailure === 'observer') throw new Error('Observer configuration failure'); });
    constructor(readonly changed: () => void) { fixture.observers.push(this); }
  });
  vi.stubGlobal('requestAnimationFrame', (draw: FrameRequestCallback) => {
    const id = fixture.frames.length + 1;
    fixture.frames.push({ id, draw });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { fixture.cancelledFrames.push(id); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetTestStore(); });

describe('ViewportCanvas effect の所有と破棄', () => {
  it('reports retired and admitted viewport owners separately through failure and retry', () => {
    vi.useFakeTimers();
    const active = mount();
    const read = window.pcadViewportRetiredCleanups;
    expect(read?.()).toMatchObject({ pendingCount: 0, ownerCount: 0, admittedOwnerCount: 1, waitingCount: 0, owners: [] });
    let fail = true;
    active.scene.dispose.mockImplementation(() => { if (fail) throw new Error('scene release failure'); });
    active.cleanup();
    expect(read?.()).toMatchObject({ pendingCount: 1, ownerCount: 1, admittedOwnerCount: 1 });
    expect(read?.().owners).toHaveLength(1);
    fail = false;
    vi.advanceTimersByTime(250);
    expect(read?.()).toMatchObject({ pendingCount: 0, ownerCount: 0, admittedOwnerCount: 0, owners: [] });
    const next = mount();
    expect(window.pcadViewportRetiredCleanups?.()).toMatchObject({ ownerCount: 0, admittedOwnerCount: 1 });
    next.cleanup();
  });
  it('interference progress-only updates do not request a frame for an unchanged display', async () => {
    const current = mount();
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const frame = fixture.frames.at(-1);
      if (frame === undefined) throw new Error('Initial frame missing');
      frame.draw(0);
      const count = fixture.frames.length;
      useAppStore.setState({ assemblyInterferenceProgress: { requestId: 'progress-only', phase: 'prepare',
        completedPairs: 0, totalPairs: 499500, completedComponents: 1, totalComponents: 1000 } });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(fixture.frames).toHaveLength(count);
      expect(useAppStore.getState().assemblyInterferenceProgress?.completedComponents).toBe(1);
      useAppStore.setState({ assemblyInterferenceProgress: null, selection: ['changed-selection'] });
      expect(fixture.frames).toHaveLength(count + 1);
      expect(current.scene.setBodyHighlight).toHaveBeenLastCalledWith(null, ['changed-selection']);
    } finally { current.cleanup(); }
  });

  it('offers no stale history meshes while awaiting a new assembly publication, then uses the exact new body map', () => {
    const assembly: ReturnType<typeof createAssemblyDocument> = { ...createAssemblyDocument('first'), components: [{
      id: 'component-1', name: 'part', source: { kind: 'part', partRef: 'part-1' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false,
    }] };
    const bodies = new Map([['part-1', [bodyFor('body-1')]]]);
    const view = { sourceDocument: assembly, bodies, appearances: new Map(), diagnosis: null,
      mateTargetErrors: new Map(), resolved: { parts: new Map(), placements: new Map([['component-1', IDENTITY_PLACEMENT]]),
        partKeys: new Map([['component-1', 'part-1']]), errors: [] } };
    useAppStore.setState({ assembly, assemblyView: view, drawing: null,
      requestedGeneration: 7, completedGeneration: 7, recomputeCancelled: false });
    const current = mount();
    try {
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(expect.objectContaining({ sourceDocument: assembly, sourceBodies: bodies }));
      const replacement = { ...assembly, name: 'history edit' };
      useAppStore.setState({ assembly: replacement, documentVersion: useAppStore.getState().documentVersion + 1 });
      expect(useAppStore.getState().assemblyView).toBe(view);
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(EMPTY_ASSEMBLY_GEOMETRY);
      useAppStore.setState({ requestedGeneration: 8 });
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(EMPTY_ASSEMBLY_GEOMETRY);
      const replacementBodies = new Map([['part-1', [bodyFor('body-2')]]]);
      const published = { ...view, sourceDocument: replacement, bodies: replacementBodies };
      useAppStore.setState({ assemblyView: published, completedGeneration: 8 });
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(expect.objectContaining({ sourceDocument: replacement, sourceBodies: replacementBodies }));
      useAppStore.setState({ requestedGeneration: 9 });
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(EMPTY_ASSEMBLY_GEOMETRY);
      useAppStore.setState({ completedGeneration: 9, recomputeCancelled: true });
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(EMPTY_ASSEMBLY_GEOMETRY);
    } finally { current.cleanup(); }
  });

  it('offers empty displays for both notifications when an earlier subscriber synchronously starts another request', () => {
    const assembly: ReturnType<typeof createAssemblyDocument> = { ...createAssemblyDocument('nested notification'), components: [{
      id: 'component-1', name: 'part', source: { kind: 'part', partRef: 'part-1' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false,
    }] };
    const view = { sourceDocument: assembly, bodies: new Map([['part-1', [bodyFor('body-1')]]]),
      appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), resolved: { parts: new Map(),
        placements: new Map([['component-1', IDENTITY_PLACEMENT]]), partKeys: new Map([['component-1', 'part-1']]), errors: [] } };
    useAppStore.setState({ assembly, assemblyView: view, drawing: null,
      requestedGeneration: 7, completedGeneration: 7, recomputeCancelled: false });
    let invalidate = false;
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (invalidate && next.assemblyView !== previous.assemblyView) {
        invalidate = false;
        useAppStore.setState({ requestedGeneration: 8 });
      }
    });
    const current = mount();
    try {
      current.scene.setAssembly.mockClear();
      invalidate = true;
      useAppStore.setState({ assemblyView: { ...view } });
      expect(useAppStore.getState().requestedGeneration).toBe(8);
      expect(current.scene.setAssembly).toHaveBeenCalledTimes(2);
      expect(current.scene.setAssembly).toHaveBeenNthCalledWith(1, EMPTY_ASSEMBLY_GEOMETRY);
      expect(current.scene.setAssembly).toHaveBeenNthCalledWith(2, EMPTY_ASSEMBLY_GEOMETRY);
    } finally { unsubscribe(); current.cleanup(); }
  });

  it.each(['scene', 'input', 'observer', 'sync'] as const)('returns acquired %s initialization resources and permits the boundary retry mount', stage => {
    fixture.initializationFailure = stage;
    const before = useAppStore.getState();
    const failed = mount();
    expect(fixture.failures).toHaveLength(1);
    expect(window.pcadViewportRetiredCleanups).toBeUndefined();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().selection).toBe(before.selection);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().undoStack.future).toBe(before.undoStack.future);
    expect(useAppStore.getState().canRedo).toBe(before.canRedo);
    expect(useAppStore.getState().captureThumbnail).toBeNull();
    expect(useAppStore.getState().capturePrintFrame).toBeNull();
    for (const cache of fixture.caches) expect(cache.dispose).toHaveBeenCalledTimes(1);
    for (const controls of fixture.controls) expect(controls.detach).toHaveBeenCalledTimes(1);
    for (const input of fixture.assembly) expect(input.detach).toHaveBeenCalledTimes(1);
    for (const observer of fixture.observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
    fixture.initializationFailure = null;
    const retry = mount();
    const newGetter = window.pcadViewportMeshObservation;
    const newProducer = useAppStore.getState().captureThumbnail;
    failed.cleanup();
    expect(window.pcadViewportMeshObservation).toBe(newGetter);
    expect(useAppStore.getState().captureThumbnail).toBe(newProducer);
    expect(retry.scene.resize).toHaveBeenCalled();
    retry.cleanup();
  });

  it('uses the typed actual factory rollback lifetime until its failed resource returns, then permits a fresh mount', () => {
    vi.useFakeTimers();
    fixture.initializationFailure = 'factory-rollback';
    let failedReturn = true;
    fixture.acquiredFactoryRelease.mockImplementation(() => { if (failedReturn) throw new Error('Factory resource return failure'); });
    const failed = mount();
    const retired = window.pcadViewportRetiredCleanups;
    expect(retired?.()).toMatchObject({ pendingCount: 1, ownerCount: 1 });
    expect(retired?.().owners[0]).toMatchObject({ pendingCount: 1, hostDisplayCopyBytes: null, observationActive: true });
    failed.cleanup();
    fixture.initializationFailure = null;
    const retry = mount();
    expect(fixture.scenes).toHaveLength(0);
    failedReturn = false;
    vi.advanceTimersByTime(250);
    expect(fixture.scenes).toHaveLength(1);
    const successfulReleaseCount = fixture.acquiredFactoryRelease.mock.calls.length;
    failed.cleanup();
    expect(fixture.acquiredFactoryRelease).toHaveBeenCalledTimes(successfulReleaseCount);
    retry.cleanup();
    expect(retired?.()).toMatchObject({ pendingCount: 0, ownerCount: 0, scheduled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains only an actual failed initialization resource, recovers through the scheduler, and mounts again', () => {
    vi.useFakeTimers();
    fixture.initializationFailure = 'observer'; fixture.cleanupFailure = true;
    const failed = mount();
    const retired = window.pcadViewportRetiredCleanups;
    expect(retired?.()).toMatchObject({ ownerCount: 1, pendingCount: 1, scheduled: true });
    expect(retired?.().owners[0]).toMatchObject({ pendingCount: 1, observationActive: true,
      hostDisplayCopyBytes: 24, hostGpuAttributeBytes: 48 });
    expect(failed.cache.dispose).toHaveBeenCalledTimes(1);
    expect(failed.controls.detach).toHaveBeenCalledTimes(1);
    failed.cleanup();
    fixture.initializationFailure = null;
    const retry = mount();
    expect(fixture.scenes).toHaveLength(1);
    fixture.cleanupFailure = false;
    vi.advanceTimersByTime(250);
    expect(fixture.scenes).toHaveLength(2);
    expect(failed.scene.dispose).toHaveBeenCalledTimes(3);
    expect(failed.cache.dispose).toHaveBeenCalledTimes(1);
    const newGetter = window.pcadViewportMeshObservation;
    failed.cleanup();
    expect(window.pcadViewportMeshObservation).toBe(newGetter);
    retry.cleanup();
    expect(retired?.()).toMatchObject({ ownerCount: 0, pendingCount: 0, scheduled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['observer', 'images', 'sketch', 'scene'] as const)('retains one unmounted %s owner and recovers through the real scheduler without a second cleanup call', kind => {
    vi.useFakeTimers();
    const current = mount();
    const observation = window.pcadViewportMeshObservation;
    const before = useAppStore.getState();
    let fail = true;
    const operation = kind === 'observer' ? current.observer.disconnect : kind === 'images' ? current.cache.dispose
      : kind === 'sketch' ? current.sketch.detach : current.scene.dispose;
    operation.mockImplementation(() => { if (fail) throw new Error('owner return failure'); });
    current.cleanup();
    const retired = window.pcadViewportRetiredCleanups;
    expect(retired?.()).toMatchObject({ pendingCount: 1, ownerCount: 1, scheduled: true });
    expect(retired?.().owners[0]).toMatchObject({ pendingCount: 1, observationActive: true });
    expect(observation?.().active).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(operation).toHaveBeenCalledTimes(2); expect(retired?.().pendingCount).toBe(1);
    fail = false; vi.advanceTimersByTime(500);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(retired?.()).toMatchObject({ pendingCount: 0, ownerCount: 0, scheduled: false });
    expect(observation?.().active).toBe(false); expect(vi.getTimerCount()).toBe(0);
    expect(window.pcadViewportRetiredCleanups).toBeUndefined();
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(after.undoStack.future).toBe(before.undoStack.future); expect(after.canRedo).toBe(before.canRedo); expect(after.selection).toBe(before.selection);
  });

  it('does not create a Scene for an ended waiting mount and preserves the next mount getters', () => {
    vi.useFakeTimers();
    const old = mount(); let fail = true;
    old.scene.dispose.mockImplementation(() => { if (fail) throw new Error('scene return'); });
    old.cleanup();
    mount().cleanup();
    expect(fixture.scenes).toHaveLength(1);
    const next = mount();
    expect(fixture.scenes).toHaveLength(1);
    fail = false; vi.advanceTimersByTime(250);
    expect(fixture.scenes).toHaveLength(2);
    const newGetter = window.pcadViewportRenderStats;
    expect(newGetter).toBeDefined(); expect(window.pcadViewportRetiredCleanups?.().scheduled).toBe(false);
    expect(old.scene.dispose).toHaveBeenCalledTimes(2);
    next.cleanup();
    expect(window.pcadViewportRenderStats).toBeUndefined();
    expect(window.pcadViewportRetiredCleanups).toBeUndefined();
  });
  it.each(['observer', 'images', 'sketch', 'scene'] as const)('retains failed %s cleanup while attempting every other owner and blocking late work', kind => {
    const current = mount();
    const readStats = window.pcadViewportRenderStats;
    const before = useAppStore.getState();
    const documentBytes = JSON.stringify(before.document);
    const failure = kind === 'observer' ? current.observer.disconnect
      : kind === 'images' ? current.cache.dispose : kind === 'sketch' ? current.sketch.detach : current.scene.dispose;
    failure.mockImplementation(() => { throw new Error('owner cleanup failed'); });
    current.cleanup();
    expect(readStats?.().cleanupStatus).toBe('pending');
    expect(current.controls.detach).toHaveBeenCalledTimes(1);
    expect(current.assembly.detach).toHaveBeenCalledTimes(1);
    expect(current.sketch.detach).toHaveBeenCalledTimes(1);
    expect(current.quad).toHaveBeenCalledTimes(1);
    expect(current.cache.dispose).toHaveBeenCalledTimes(1);
    expect(current.observer.disconnect).toHaveBeenCalledTimes(1);
    expect(current.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(current.scene.dispose).toHaveBeenCalledTimes(1);
    const rendered = current.scene.render.mock.calls.length;
    current.controls.changed(); current.cache.decodePublish(); current.observer.changed();
    expect(current.scene.render).toHaveBeenCalledTimes(rendered);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(JSON.stringify(useAppStore.getState().document)).toBe(documentBytes);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    failure.mockImplementation(() => undefined);
    current.cleanup(); current.cleanup();
    expect(failure).toHaveBeenCalledTimes(2);
    expect(readStats?.().cleanupStatus).toBe('complete');
    expect(current.controls.detach).toHaveBeenCalledTimes(1);
    expect(current.subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(['request', 'completion', 'outcome', 'cancel', 'document', 'session', 'history', 'receipt', 'assembly', 'drawing'] as const)(
    'body参照を変えない%sもsceneへ通知し、readerは現在状態を返す', scenario => {
      const bodies = [bodyFor('same-body')];
      useAppStore.setState({ bodies, requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success' });
      const current = mount(), previous = useAppStore.getState();
      const beforeCalls = current.scene.setBodies.mock.calls.length;
      try {
        if (scenario === 'request') useAppStore.setState({ requestedGeneration: 8 });
        if (scenario === 'completion') useAppStore.setState({ completedGeneration: 6 });
        if (scenario === 'outcome') useAppStore.setState({ lastOutcome: 'failed' });
        if (scenario === 'cancel') useAppStore.getState().cancelRecompute();
        if (scenario === 'document') useAppStore.setState({ document: { ...previous.document, id: 'other-model' } });
        if (scenario === 'session') useAppStore.setState({ activeDocumentId: 'other-session' });
        if (scenario === 'history') useAppStore.setState({ timelineIndex: 0 });
        if (scenario === 'assembly') useAppStore.setState({ assembly: createAssemblyDocument('組立') });
        if (scenario === 'drawing') useAppStore.setState({ drawing: drawingFixture() });
        if (scenario === 'receipt') useAppStore.setState({ meshJsAccounting: { document: previous.document, timelineIndex: previous.timelineIndex, outcome: 'success',
          activeDocumentId: previous.activeDocumentId, bodies, bodyLayouts: bodies.map(captureMeshBodyLayout),
          receipt: { documentId: previous.document.id, partId: 'part', generation: 7,
            reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 0, cacheRetiredBytes: 0,
              cacheProtectedBytes: 0, retainedReplyBytes: 0, requestPeakReservedBytes: 0 } } } });
        expect(useAppStore.getState().bodies).toBe(bodies);
        expect(current.scene.setBodies).toHaveBeenCalledTimes(beforeCalls + 1);
        expect(current.scene.setBodies).toHaveBeenLastCalledWith(scenario === 'assembly' || scenario === 'drawing' ? [] : bodies);
        expect(fixture.stateReaders[0]()).toBe(useAppStore.getState());
        expect(fixture.stateReaders[0]()).not.toBe(previous);
      } finally { current.cleanup(); }
    },
  );

  it('100 寿命で同じ closure の資源を一度ずつ解放し最後に公開口を残さない', () => {
    for (let life = 0; life < 100; life += 1) {
      const current = mount();
      expect(useAppStore.getState().captureThumbnail?.()).toEqual(Uint8Array.of(1, 2, 3));
      expect(useAppStore.getState().capturePrintFrame?.()).toBe('print-frame');
      expect(window.pcadViewportFramedBodies?.()).toEqual(['body-1']);
      current.cleanup(); current.cleanup();
      expect(current.scene.dispose).toHaveBeenCalledTimes(1);
      expect(current.controls.detach).toHaveBeenCalledTimes(1);
      expect(current.assembly.detach).toHaveBeenCalledTimes(1);
      expect(current.sketch.detach).toHaveBeenCalledTimes(1);
      expect(current.quad).toHaveBeenCalledTimes(1);
      expect(current.cache.dispose).toHaveBeenCalledTimes(1);
      expect(current.observer.disconnect).toHaveBeenCalledTimes(1);
      expect(current.subscription.unsubscribe).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().captureThumbnail).toBeNull();
      expect(useAppStore.getState().capturePrintFrame).toBeNull();
      expect(useAppStore.getState().viewCameraController).toBeNull();
      expect(window.pcadViewportRenderStats).toBeUndefined();
      expect(window.pcadViewportFramedBodies).toBeUndefined();
      expect(window.pcadViewportMemoryStats).toBeUndefined();
    }
    expect(fixture.canvas.addEventListener).toHaveBeenCalledTimes(100);
    expect(fixture.canvas.removeEventListener).toHaveBeenCalledTimes(100);
    expect(fixture.cancelledFrames).toHaveLength(100);
  });

  it('A/B 重複装着の旧 A 解除が現 B の保存・印刷・統計口を消さない', () => {
    const a = mount();
    const staleCapture = useAppStore.getState().captureThumbnail;
    const b = mount();
    const currentCapture = useAppStore.getState().captureThumbnail;
    const currentPrint = useAppStore.getState().capturePrintFrame;
    const currentStats = window.pcadViewportRenderStats;
    a.cleanup();
    expect(useAppStore.getState().captureThumbnail).toBe(currentCapture);
    expect(useAppStore.getState().capturePrintFrame).toBe(currentPrint);
    expect(window.pcadViewportRenderStats).toBe(currentStats);
    expect(staleCapture?.()).toBeNull();
    expect(currentCapture?.()).toEqual(Uint8Array.of(1, 2, 3));
    expect(currentPrint?.()).toBe('print-frame');
    expect(window.pcadViewportFramedBodies?.()).toEqual(['body-1']);
    const currentFrame = fixture.frames.at(-1);
    if (currentFrame === undefined) throw new Error('current frame missing');
    currentFrame.draw(0);
    expect(b.scene.render).toHaveBeenCalledTimes(1);
    expect(window.pcadViewportRenderStats?.().completedRenders).toBe(1);
    b.cleanup();
    expect(useAppStore.getState().captureThumbnail).toBeNull();
    expect(useAppStore.getState().capturePrintFrame).toBeNull();
    expect(window.pcadViewportRenderStats).toBeUndefined();
  });

  it('解除後の保存済み RAF・observer・復号 publish・購読 callback は scene と文書を変えない', () => {
    const current = mount();
    const before = useAppStore.getState();
    const frame = fixture.frames.at(-1);
    if (frame === undefined) throw new Error('frame missing');
    const rendered = current.scene.render.mock.calls.length;
    const canvases = current.scene.setCanvases.mock.calls.length;
    const resized = current.scene.resize.mock.calls.length;
    current.cleanup();
    frame.draw(0);
    current.observer.changed();
    current.cache.decodePublish();
    current.subscription.changed(useAppStore.getState(), before);
    current.controls.changed(); current.controls.interactive(true);
    expect(current.scene.render).toHaveBeenCalledTimes(rendered);
    expect(current.scene.setCanvases).toHaveBeenCalledTimes(canvases);
    expect(current.scene.resize).toHaveBeenCalledTimes(resized);
    expect(fixture.frames).toHaveLength(1);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('メモリー観測は生きた世代だけを読み、旧解除は別所有者の口を消さない', () => {
    const a = mount();
    const stale = window.pcadViewportMemoryStats;
    expect(stale?.()).toEqual({ displayCopyBytes: 24, gpuMeshBytes: 48,
      assemblySourceBackingBytes: 12, assemblyInstanceBytes: 64, uncovered: ['textures'] });
    const b = mount();
    const current = window.pcadViewportMemoryStats;
    a.cleanup();
    expect(window.pcadViewportMemoryStats).toBe(current);
    const oldReads = a.scene.meshReservation.mock.calls.length;
    expect(stale?.()).toBeNull();
    expect(a.scene.meshReservation).toHaveBeenCalledTimes(oldReads);
    expect(current?.()?.gpuMeshBytes).toBe(48);
    b.cleanup();
    expect(window.pcadViewportMemoryStats).toBeUndefined();
    expect(current?.()).toBeNull();
  });
});

// Issued UI metadata fixture only: actual Store/RAF consumer paths, not Worker/native/DOM proof.
function refreshableAssemblyFixture(
  sourceBody: SolidBody = bodyFor('body-1'), part?: PartDocument, componentId = 'component-1',
) {
  const before = useAppStore.getState();
  const sourceDocument = part ?? before.document;
  const library = part === undefined ? before.assemblyLibrary
    : { ...before.assemblyLibrary, parts: new Map([['part-1', part]]) };
  const resolvedParts = part === undefined ? new Map<string, ReturnType<typeof resolvePart>>()
    : new Map([['part-1', resolvePart(part, { importedShapes: new Map([['body-shape', Uint8Array.of(1)]]) })]]);
  const assembly = { ...createAssemblyDocument('fresh publication'), components: [{
    id: componentId, name: 'part', source: { kind: 'part' as const, partRef: 'part-1' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false,
  }] };
  const sourceBodies = [sourceBody], bodies = new Map([['part-1', sourceBodies]]);
  const displayOwner = { dispatchId: 'fixture-current', partId: 'part-1', generation: 7,
    kind: 'display' as const, steps: [] };
  let settle: (value: AssemblyMeshOwnership | null) => void = () => { throw new Error('deferred owner not initialized'); };
  let reject: (reason: Error) => void = () => { throw new Error('deferred owner not initialized'); };
  const pending = new Promise<AssemblyMeshOwnership | null>((resolve, fail) => { settle = resolve; reject = fail; });
  const refresh = vi.fn<NonNullable<AssemblyMeshOwnership['refreshOwnership']>>(() => pending);
  const owner: AssemblyMeshOwnership = {
    document: assembly, library, activeDocumentId: assembly.id,
    documentVersion: before.documentVersion + 1, generation: 7, outcome: 'success', timelineIndex: null,
    cancelRequestCount: before.cancelRequestCount, bodies,
    sources: new Map([['part-1', { document: sourceDocument, attachments: undefined,
      result: { bodies: sourceBodies, sketches: [], errors: [], cacheHits: 0, cancelled: false, generation: 7 },
      bodies: sourceBodies, layouts: sourceBodies.map(captureMeshBodyLayout), displayOwner, hiddenOwners: [], current: () => true }]]),
    receipt: { status: 'known', observationId: 'fixture-issued-old', hostEpoch: 1, workerEpochs: [],
      owners: [displayOwner], limitBytes: 512 * 1024 * 1024, workerRetainedBackingBytes: 0,
      hostRetainedBackingBytes: 1040, pendingCloneReservedBytes: 0, admittedBoundBytes: 1040,
      coverage: 'registered-solid-mesh-backings-only', unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] },
    backingInspection: { status: 'known', hostEpoch: 1, inputBackingBytes: 0, additionalBackingBytes: 0,
      sameSourceBackings: [], coverage: 'registered-main-solid-backings-only', unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] },
    uiSnapshot: { epoch: 0, buffers: [] }, receiptCurrent: () => false, backingInspectionCurrent: () => false,
    publicationCurrent: () => useAppStore.getState().assemblyView?.meshOwnership === owner,
    refreshOwnership: refresh,
  };
  const view = { sourceDocument: assembly, bodies, appearances: new Map(), diagnosis: null,
    mateTargetErrors: new Map(), meshOwnership: owner, resolved: { parts: resolvedParts,
      placements: new Map([[componentId, IDENTITY_PLACEMENT]]), partKeys: new Map([[componentId, 'part-1']]), errors: [] } };
  useAppStore.setState({ assembly, assemblyLibrary: library, drawing: null, activeDocumentId: assembly.id,
    documentVersion: owner.documentVersion, requestedGeneration: 7, completedGeneration: 7,
    lastOutcome: 'success', timelineIndex: null, recomputeCancelled: false, assemblyView: view });
  const snapshot = useAppStore.getState();
  const fresh: AssemblyMeshOwnership = { ...owner, receipt: { ...owner.receipt, observationId: 'fixture-issued-fresh' },
    receiptCurrent: () => true, backingInspectionCurrent: () => true,
    publicationCurrent: () => useAppStore.getState().assemblyView?.meshOwnership === fresh };
  return { owner, fresh, bodies, snapshot, refresh, settle, reject,
    publish: () => { useAppStore.setState({ assemblyView: { ...view, meshOwnership: fresh } }); settle(fresh); } };
}

describe('exact published Assembly receipt recovery consumer', () => {
  it('keeps receipt invalidation checks on interference progress-only notifications', async () => {
    const source = refreshableAssemblyFixture();
    source.publish();
    const current = mount();
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const frame = fixture.frames.at(-1);
      if (frame === undefined) throw new Error('Initial frame missing');
      frame.draw(0);
      const count = fixture.frames.length;
      const progress = { requestId: 'progress-receipt', phase: 'prepare' as const,
        completedPairs: 0, totalPairs: 499500, completedComponents: 1, totalComponents: 1000 };
      useAppStore.setState({ assemblyInterferenceProgress: progress });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(fixture.frames).toHaveLength(count);
      const receipt = vi.spyOn(source.fresh, 'receiptCurrent').mockReturnValue(false);
      useAppStore.setState({ assemblyInterferenceProgress: { ...progress, completedComponents: 2 } });
      expect(receipt).toHaveBeenCalled();
      expect(fixture.frames).toHaveLength(count + 1);
      expect(useAppStore.getState().assemblyInterferenceProgress?.completedComponents).toBe(2);
    } finally { current.cleanup(); }
  });

  it('deduplicates pending Store/draw/save entrances and redraws only the freshly published same bodies', async () => {
    const source = refreshableAssemblyFixture(), current = mount();
    try {
      expect(current.scene.setAssembly).not.toHaveBeenCalled();
      current.scene.setAssembly.mockClear(); current.scene.render.mockClear();
      useAppStore.setState({ selection: ['component-1'] });
      const pendingCapture = useAppStore.getState().captureThumbnail?.();
      expect(pendingCapture).toBeInstanceOf(Promise);
      expect(current.scene.captureThumbnail).not.toHaveBeenCalled();
      fixture.frames.at(-1)?.draw(1);
      expect(current.scene.render).not.toHaveBeenCalled();
      expect(window.pcadViewportRenderStats?.()?.completedRenders).toBe(0);
      await Promise.resolve();
      expect(source.refresh).toHaveBeenCalledTimes(1);
      expect(source.refresh).toHaveBeenCalledWith(source.owner);
      source.publish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(await pendingCapture).toEqual(Uint8Array.of(1, 2, 3));
      expect(useAppStore.getState().assemblyView?.meshOwnership).toBe(source.fresh);
      expect(current.scene.setAssembly).toHaveBeenLastCalledWith(expect.objectContaining({ sourceBodies: source.bodies }));
      const after = useAppStore.getState();
      expect(after.document).toBe(source.snapshot.document); expect(after.assembly).toBe(source.snapshot.assembly);
      expect(after.undoStack).toBe(source.snapshot.undoStack); expect(after.assemblyUndoStack).toBe(source.snapshot.assemblyUndoStack); expect(after.documentVersion).toBe(source.snapshot.documentVersion);
      expect(after.requestedGeneration).toBe(7); expect(after.completedGeneration).toBe(7);
      fixture.frames.at(-1)?.draw(2);
      expect(current.scene.render).toHaveBeenCalledTimes(1);
      expect(window.pcadViewportRenderStats?.()?.completedRenders).toBe(1);
      expect(useAppStore.getState().captureThumbnail?.()).toEqual(Uint8Array.of(1, 2, 3));
    } finally { source.settle(null); current.cleanup(); }
  });
  it.each(['null', 'throw', 'unmount', 'new-owner'] as const)('refuses %s late acquisition without old reoffer or new-owner cleanup', async scenario => {
    const source = refreshableAssemblyFixture(), current = mount();
    try {
      current.scene.setAssembly.mockClear();
      useAppStore.setState({ selection: ['component-1'] }); await Promise.resolve();
      expect(source.refresh).toHaveBeenCalledTimes(1);
      if (scenario === 'unmount') current.cleanup();
      if (scenario === 'new-owner') useAppStore.setState({ assembly: { ...source.owner.document, name: 'new request' }, requestedGeneration: 8 });
      const live = useAppStore.getState(); current.scene.setAssembly.mockClear();
      if (scenario === 'throw') source.reject(new Error('actual producer refusal'));
      else source.settle(scenario === 'null' ? null : source.fresh);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(current.scene.setAssembly).not.toHaveBeenCalled();
      expect(useAppStore.getState().assembly).toBe(live.assembly);
      expect(useAppStore.getState().assemblyView).toBe(live.assemblyView);
      if (scenario !== 'unmount') {
        useAppStore.setState({ selection: [] }); await Promise.resolve();
        expect(source.refresh).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState().captureThumbnail?.()).toBeNull();
      }
    } finally { source.settle(null); current.cleanup(); }
  });
});


// The real ViewportCanvas callback and real input/addMateTarget run against a real
// CPU raycast. Only the graphics renderer and receipt issuer are fixtures.
function deferredMateViewport() {
  const template = bodyFor('body-1');
  const body: SolidBody = { ...template, mesh: { ...template.mesh,
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
  }, faces: [{ index: 0, surfaceKind: 'plane', area: 0.5, centroid: [1 / 3, 1 / 3, 0],
    axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 }] };
  const part: PartDocument = { ...createEmptyPartDocument(), solids: [{
    id: body.featureId, name: 'input face', kind: 'importedSolid', suppressed: false,
    shapeRef: 'body-shape', bodyKind: 'solid',
    source: { format: 'step', fileName: 'input-face.step', unit: 'mm', byteLength: 1 },
  }] };
  const source = refreshableAssemblyFixture(body, part);
  expect(source.snapshot.assemblyView?.resolved.parts.get('part-1')?.liveBodyIds).toEqual(['body-1']);
  startMate('coincident');
  fixture.realAssemblyInput = true;
  const current = mount();
  const layer = createAssemblyLayer(undefined, { uiBackings: new AssemblyUiBackingLedger() });
  current.scene.setAssembly.mockImplementation((bundle: AssemblyGeometryBundle) => layer.update(bundle, 'shadedWithEdges'));
  current.scene.pickAssemblyFace.mockImplementation((x: number, y: number) => layer.pickMateFace(
    new Raycaster(new Vector3(x, y, 5), new Vector3(0, 0, -1))));
  const send = (type = 'pointerdown', properties: object = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: 0.2, clientY: 0.2, button: 0, buttons: 0, altKey: false, pointerId: 1, ...properties,
    });
    fixture.events.dispatchEvent(event);
  };
  return { ...current, source, send, close: () => { source.settle(null); current.cleanup(); layer.dispose(); } };
}

async function finishOwnershipMicrotasks(): Promise<void> {
  // Drain producer assimilation, admission, catch/finally, and the one input continuation.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('ownership refresh preserves one fenced real mate input', () => {
  it('does not pick the stale scene and applies the original click once after exact publication', async () => {
    const f = deferredMateViewport();
    try {
      const undo = useAppStore.getState().assemblyUndoStack;
      f.send(); f.send('pointerup');
      expect(f.scene.pickAssemblyFace).not.toHaveBeenCalled();
      expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(0);
      await Promise.resolve();
      expect(f.source.refresh).toHaveBeenCalledExactlyOnceWith(f.source.owner);
      f.source.publish(); await finishOwnershipMicrotasks();
      expect(f.scene.pickAssemblyFace).toHaveBeenCalledExactlyOnceWith(0.2, 0.2, expect.any(Object));
      expect(f.scene.pickAssemblyFace).toHaveReturnedWith({
        componentId: 'component-1', partKey: 'part-1', bodyFeatureId: 'body-1', faceIndex: 0,
        occurrencePath: ['component-1'],
      });
      expect(useAppStore.getState().assemblyMateDraft?.targets).toMatchObject([
        { kind: 'subShape', componentId: 'component-1',
          ref: { bodyFeatureId: 'body-1', index: 0 } },
      ]);
      expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickAssemblyFace).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it.each(['assembly', 'document', 'active-id', 'library', 'version', 'requested', 'completed', 'cancel',
    'cancelled', 'outcome', 'timeline', 'computing', 'resolved', 'bodies', 'draft', 'kind', 'filter',
    'selection', 'projection', 'quad-camera', 'camera', 'wheel', 'home', 'resize', 'pointercancel', 'escape', 'unmount'] as const)(
    'discards the old click permanently when %s changes, including change-and-return', async change => {
      const f = deferredMateViewport();
      try {
        f.send(); await Promise.resolve();
        expect(f.source.refresh).toHaveBeenCalledTimes(1);
        const before = useAppStore.getState();
        const view = before.assemblyView;
        if (view === null) throw new Error('fixture view missing');
        switch (change) {
          case 'assembly': useAppStore.setState({ assembly: { ...f.source.owner.document } }); break;
          case 'document': useAppStore.setState({ document: { ...before.document } }); break;
          case 'active-id': useAppStore.setState({ activeDocumentId: 'another' }); break;
          case 'library': useAppStore.setState({ assemblyLibrary: { ...before.assemblyLibrary } }); break;
          case 'version': useAppStore.setState({ documentVersion: before.documentVersion + 1 }); break;
          case 'requested': useAppStore.setState({ requestedGeneration: 8 }); break;
          case 'completed': useAppStore.setState({ completedGeneration: 8 }); break;
          case 'cancel': useAppStore.setState({ cancelRequestCount: before.cancelRequestCount + 1 }); break;
          case 'cancelled': useAppStore.setState({ recomputeCancelled: true }); break;
          case 'outcome': useAppStore.setState({ lastOutcome: 'idle' }); break;
          case 'timeline': useAppStore.setState({ timelineIndex: 0 }); break;
          case 'computing': useAppStore.setState({ isComputing: true }); break;
          case 'resolved': useAppStore.setState({ assemblyView: { ...view, resolved: { ...view.resolved } } }); break;
          case 'bodies': useAppStore.setState({ assemblyView: { ...view, bodies: new Map(view.bodies) } }); break;
          case 'draft': startMate('distance'); break;
          case 'kind': useAppStore.setState({ selectionKind: 'edge' }); break;
          case 'filter': useAppStore.setState({ displaySettings: { ...before.displaySettings,
            selectionFilter: { ...before.displaySettings.selectionFilter, face: false } } }); break;
          case 'selection': useAppStore.setState({ selection: [] }); break;
          case 'projection': useAppStore.setState({ projection: before.projection === 'orthographic' ? 'perspective' : 'orthographic' }); break;
          case 'quad-camera': useAppStore.getState().setQuadViewEnabled(true); break;
          case 'camera': f.controls.changed(); break;
          case 'wheel': f.send('wheel', { deltaMode: 0, deltaY: 100, shiftKey: false, ctrlKey: false, metaKey: false }); break;
          case 'home': f.send('keydown', { key: 'Home', isComposing: false }); break;
          case 'resize': f.observer.changed(); break;
          case 'pointercancel': f.send('pointercancel'); break;
          case 'escape': f.send('keydown', { key: 'Escape', isComposing: false }); break;
          case 'unmount': f.cleanup(); break;
        }
        if (change !== 'unmount') useAppStore.setState(before);
        f.source.publish(); await finishOwnershipMicrotasks();
        expect(f.scene.pickAssemblyFace).not.toHaveBeenCalled();
        expect(useAppStore.getState().assemblyMateDraft?.targets ?? []).toHaveLength(0);
      } finally { f.close(); }
    });

  it('keeps ready input synchronous and performs only one pick', async () => {
    const f = deferredMateViewport();
    try {
      await Promise.resolve(); f.source.publish(); await finishOwnershipMicrotasks();
      f.scene.pickAssemblyFace.mockClear();
      f.send();
      expect(f.scene.pickAssemblyFace).toHaveBeenCalledTimes(1);
      expect(f.scene.pickAssemblyFace).toHaveReturnedWith({
        componentId: 'component-1', partKey: 'part-1', bodyFeatureId: 'body-1', faceIndex: 0,
        occurrencePath: ['component-1'],
      });
      expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(1);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickAssemblyFace).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it.each(['null', 'throw'] as const)('does not resend after refresh %s', async result => {
    const f = deferredMateViewport();
    try {
      f.send(); await Promise.resolve();
      if (result === 'throw') f.source.reject(new Error('issuer failed'));
      else f.source.settle(null);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickAssemblyFace).not.toHaveBeenCalled();
      expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(0);
      expect(f.source.refresh).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it('supersedes an older waiting click without another refresh or another pick', async () => {
    const f = deferredMateViewport();
    try {
      f.send('pointerdown', { clientX: 50 });
      f.send('pointerdown', { clientX: 0.2 });
      await Promise.resolve();
      f.source.publish(); await finishOwnershipMicrotasks();
      expect(f.source.refresh).toHaveBeenCalledTimes(1);
      expect(f.scene.pickAssemblyFace).toHaveBeenCalledExactlyOnceWith(0.2, 0.2, expect.any(Object));
      expect(f.scene.pickAssemblyFace).toHaveReturnedWith({
        componentId: 'component-1', partKey: 'part-1', bodyFeatureId: 'body-1', faceIndex: 0,
        occurrencePath: ['component-1'],
      });
      expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe('thumbnail reason getter lifetime', () => {
  it('old teardown preserves the new token and copy getter performs no capture', () => {
    const old = mount(), current = mount();
    const reader = window.pcadThumbnailCaptureReasons;
    if (reader === undefined) throw new Error('Actual Canvas reason getter missing');
    try {
      old.cleanup(); expect(window.pcadThumbnailCaptureReasons).toBe(reader);
      current.scene.captureThumbnail.mockClear();
      const first = reader(); const second = reader();
      expect(first).toEqual(second); expect(first).not.toBe(second);
      expect(current.scene.captureThumbnail).not.toHaveBeenCalled();
      expect(useAppStore.getState().captureThumbnail?.()).toEqual(Uint8Array.of(1, 2, 3));
      expect(current.scene.captureThumbnail).toHaveBeenCalledTimes(1);
      expect(reader().entries.map(entry => entry.reason)).toContain('consumer:admitted');
    } finally { current.cleanup(); old.cleanup(); }
    expect(window.pcadThumbnailCaptureReasons).toBeUndefined();
  });
});

describe('waiting thumbnail diagnostic acquisition', () => {
  it('never publishes a reason getter for a cancelled waiting mount and preserves the next initialized owner', () => {
    vi.useFakeTimers();
    const previous = mount(); let fail = true;
    previous.scene.dispose.mockImplementation(() => { if (fail) throw new Error('pending scene return'); });
    let waiting: ReturnType<typeof mount> | null = null;
    let current: ReturnType<typeof mount> | null = null;
    try {
      previous.cleanup(); expect(window.pcadThumbnailCaptureReasons).toBeUndefined();
      waiting = mount(); expect(fixture.scenes).toHaveLength(1);
      expect(window.pcadThumbnailCaptureReasons).toBeUndefined();
      waiting.cleanup(); expect(window.pcadThumbnailCaptureReasons).toBeUndefined();
      current = mount(); expect(window.pcadThumbnailCaptureReasons).toBeUndefined();
      fail = false; vi.advanceTimersByTime(250);
      expect(fixture.scenes).toHaveLength(2);
      const reader = window.pcadThumbnailCaptureReasons;
      if (reader === undefined) throw new Error('Actual initialized owner getter missing');
      waiting.cleanup(); previous.cleanup(); expect(window.pcadThumbnailCaptureReasons).toBe(reader);
      expect(useAppStore.getState().captureThumbnail?.()).toEqual(Uint8Array.of(1, 2, 3));
      expect(reader().entries.map(entry => entry.reason)).toContain('consumer:admitted');
    } finally {
      fail = false; waiting?.cleanup(); current?.cleanup(); previous.cleanup(); vi.advanceTimersByTime(250);
    }
    expect(window.pcadThumbnailCaptureReasons).toBeUndefined();
  });
});

describe('thumbnail capture waits for the same publication without borrowing a stale frame', () => {
  it('joins one pending receipt refresh and captures only after the fresh same-generation publication', async () => {
    const source = refreshableAssemblyFixture(), current = mount();
    try {
      const capture = useAppStore.getState().captureThumbnail;
      if (capture === null) throw new Error('viewport capture not installed');
      const first = capture(), second = capture();
      expect(first).toBeInstanceOf(Promise);
      expect(second).toBeInstanceOf(Promise);
      expect(current.scene.captureThumbnail).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(source.refresh).toHaveBeenCalledExactlyOnceWith(source.owner);
      source.publish();
      expect(await first).toEqual(Uint8Array.of(1, 2, 3));
      expect(await second).toEqual(Uint8Array.of(1, 2, 3));
      expect(current.scene.captureThumbnail).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().assemblyView?.meshOwnership).toBe(source.fresh);
      expect(useAppStore.getState().documentVersion).toBe(source.snapshot.documentVersion);
      expect(useAppStore.getState().cancelRequestCount).toBe(source.snapshot.cancelRequestCount);
    } finally { source.settle(null); current.cleanup(); }
  });

  it.each(['null', 'throw', 'unmount', 'document', 'assembly', 'library', 'active-id', 'version',
    'requested', 'completed', 'cancel', 'cancelled', 'outcome', 'timeline', 'computing', 'resolved', 'bodies'] as const)(
    'rejects %s during preparation, including change-and-return, without ever capturing', async change => {
      const source = refreshableAssemblyFixture(), current = mount();
      try {
        const capture = useAppStore.getState().captureThumbnail;
        if (capture === null) throw new Error('viewport capture not installed');
        const pending = capture();
        expect(pending).toBeInstanceOf(Promise);
        await Promise.resolve();
        expect(source.refresh).toHaveBeenCalledTimes(1);
        const before = useAppStore.getState(), view = before.assemblyView;
        if (view === null) throw new Error('fixture view missing');
        switch (change) {
          case 'null': source.settle(null); break;
          case 'throw': source.reject(new Error('source refused receipt')); break;
          case 'unmount': current.cleanup(); break;
          case 'document': useAppStore.setState({ document: { ...before.document } }); break;
          case 'assembly': useAppStore.setState({ assembly: { ...source.owner.document } }); break;
          case 'library': useAppStore.setState({ assemblyLibrary: { ...before.assemblyLibrary } }); break;
          case 'active-id': useAppStore.setState({ activeDocumentId: 'new-document' }); break;
          case 'version': useAppStore.setState({ documentVersion: before.documentVersion + 1 }); break;
          case 'requested': useAppStore.setState({ requestedGeneration: 8 }); break;
          case 'completed': useAppStore.setState({ completedGeneration: 8 }); break;
          case 'cancel': useAppStore.setState({ cancelRequestCount: before.cancelRequestCount + 1 }); break;
          case 'cancelled': useAppStore.setState({ recomputeCancelled: true }); break;
          case 'outcome': useAppStore.setState({ lastOutcome: 'idle' }); break;
          case 'timeline': useAppStore.setState({ timelineIndex: 0 }); break;
          case 'computing': useAppStore.setState({ isComputing: true }); break;
          case 'resolved': useAppStore.setState({ assemblyView: { ...view, resolved: { ...view.resolved } } }); break;
          case 'bodies': useAppStore.setState({ assemblyView: { ...view, bodies: new Map(view.bodies) } }); break;
        }
        if (change !== 'unmount' && change !== 'null' && change !== 'throw') useAppStore.setState(before);
        if (change !== 'null' && change !== 'throw') source.publish();
        expect(await pending).toBeNull();
        expect(current.scene.captureThumbnail).not.toHaveBeenCalled();
      } finally { source.settle(null); current.cleanup(); }
    });
});

/** 原台本の脚6/8、始点20、長さ18.5から独立に作る第2ビードの斜面。 */
function deferredBeadBodyViewport() {
  const positions = Float32Array.of(21.5, 8, 20, 40, 8, 20, 40, 14, 28, 21.5, 14, 28);
  const template = bodyFor('bead-body');
  const body: SolidBody = { ...template, mesh: { ...template.mesh, positions,
    normals: Float32Array.of(0, -0.8, 0.6, 0, -0.8, 0.6, 0, -0.8, 0.6, 0, -0.8, 0.6),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3), triangleCount: 2,
  }, faces: [{ index: 0, surfaceKind: 'plane', area: 185, centroid: [30.75, 11, 24],
    axis: [0, -0.8, 0.6], radius: null, triangleOffset: 0, triangleCount: 2 }] };
  const part: PartDocument = { ...createEmptyPartDocument(), solids: [{
    id: body.featureId, name: '第2ビードの独立斜面', kind: 'importedSolid', suppressed: false,
    shapeRef: 'body-shape', bodyKind: 'solid',
    source: { format: 'step', fileName: 'bead-face.step', unit: 'mm', byteLength: 1 },
  }] };
  const source = refreshableAssemblyFixture(body, part, 'component-4');
  useAppStore.setState({ selectionKind: 'body', selection: [] });
  fixture.realAssemblyInput = true;
  const current = mount();
  const layer = createAssemblyLayer(undefined, { uiBackings: new AssemblyUiBackingLedger() });
  current.scene.setAssembly.mockImplementation((bundle: AssemblyGeometryBundle) => layer.update(bundle, 'shadedWithEdges'));
  // 入力のx/yはこの検査では世界座標。ブラウザーの投影やGPU描画を通した証拠ではない。
  current.scene.pickComponent.mockImplementation((x: number, y: number) => {
    const eye = new Vector3(200 / Math.sqrt(3), -200 / Math.sqrt(3), 200 / Math.sqrt(3));
    return layer.pickComponent(new Raycaster(eye, new Vector3(x, y, 24).sub(eye).normalize()));
  });
  current.scene.screenToPlanePoint.mockReturnValue(null);
  const send = (type = 'pointerdown', properties: object = {}) => {
    fixture.events.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
      clientX: 30.75, clientY: 11, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      altKey: false, shiftKey: false, pointerId: 1, ...properties,
    }));
  };
  return { ...current, source, positions, send,
    close: () => { source.settle(null); current.cleanup(); layer.dispose(); } };
}

describe('部品の所有更新中も第2ビードの1クリックを保つ', () => {
  it('斜面内の固定点を更新後に1回だけ選び、解放後のドラッグと文書・履歴変更は起こさない', async () => {
    const f = deferredBeadBodyViewport();
    try {
      const before = useAppStore.getState();
      f.send(); f.send('pointerup');
      expect(f.scene.pickComponent).not.toHaveBeenCalled();
      expect(useAppStore.getState().selection).toEqual([]);
      await Promise.resolve();
      expect(f.source.refresh).toHaveBeenCalledExactlyOnceWith(f.source.owner);
      f.source.publish(); await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent).toHaveBeenCalledExactlyOnceWith(30.75, 11, expect.any(Object));
      expect(f.scene.pickComponent).toHaveReturnedWith('component-4');
      expect(useAppStore.getState().selection).toEqual(['component-4']);
      expect(useAppStore.getState().assemblyDrag).toBeNull();
      expect(fixture.canvas.setPointerCapture).not.toHaveBeenCalled();
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it('用意済みの部品は面フィルターが無効でも同期で1回だけ選ぶ', async () => {
    const f = deferredBeadBodyViewport();
    try {
      const state = useAppStore.getState();
      useAppStore.setState({ displaySettings: { ...state.displaySettings,
        selectionFilter: { ...state.displaySettings.selectionFilter, face: false } } });
      await Promise.resolve(); f.source.publish(); await finishOwnershipMicrotasks();
      f.scene.pickComponent.mockClear();
      f.send();
      expect(f.scene.pickComponent).toHaveBeenCalledExactlyOnceWith(30.75, 11, expect.any(Object));
      expect(useAppStore.getState().selection).toEqual(['component-4']);
    } finally { f.close(); }
  });

  it.each(['document', 'active-id', 'bodies', 'placement', 'target', 'selection', 'camera', 'move',
    'pointercancel', 'escape', 'unmount', 'detached-mesh'] as const)(
    '%sで失効した入力は更新が戻っても採用しない', async change => {
      const f = deferredBeadBodyViewport();
      try {
        f.send(); await Promise.resolve();
        const before = useAppStore.getState();
        const view = before.assemblyView;
        if (view === null || before.assembly === null) throw new Error('検査用表示がありません。');
        switch (change) {
          case 'document': useAppStore.setState({ assembly: { ...before.assembly } }); break;
          case 'active-id': useAppStore.setState({ activeDocumentId: '別の文書' }); break;
          case 'bodies': useAppStore.setState({ assemblyView: { ...view, bodies: new Map(view.bodies) } }); break;
          case 'placement': useAppStore.setState({ assemblyMotionPlacements: new Map() }); break;
          case 'target': useAppStore.setState({ selectionKind: 'face' }); break;
          case 'selection': useAppStore.setState({ selection: ['component-1'] }); break;
          case 'camera': f.controls.changed(); break;
          case 'move': f.send('pointermove', { clientX: 56 }); break;
          case 'pointercancel': f.send('pointercancel'); break;
          case 'escape': f.send('keydown', { key: 'Escape', isComposing: false }); break;
          case 'unmount': f.cleanup(); break;
          case 'detached-mesh': {
            const buffer = f.positions.buffer;
            if (!(buffer instanceof ArrayBuffer)) throw new Error('専用の配列で検査します。');
            structuredClone(buffer, { transfer: [buffer] });
            break;
          }
        }
        if (change !== 'unmount') useAppStore.setState(before);
        f.source.publish(); await finishOwnershipMicrotasks();
        expect(f.scene.pickComponent).not.toHaveBeenCalled();
        expect(useAppStore.getState().selection).toEqual([]);
        expect(useAppStore.getState().assembly).toBe(before.assembly);
        expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      } finally { f.close(); }
    });

  it.each(['null', 'reject'] as const)('更新の%sを再試行や空選択に変えない', async result => {
    const f = deferredBeadBodyViewport();
    try {
      useAppStore.setState({ selection: ['component-1'] });
      f.send(); await Promise.resolve();
      if (result === 'reject') f.source.reject(new Error('所有証明の取得失敗'));
      else f.source.settle(null);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent).not.toHaveBeenCalled();
      expect(useAppStore.getState().selection).toEqual(['component-1']);
      expect(f.source.refresh).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
});

/*
 * CI run 43102593955 の EX-18 Electron B/e: 受領が失効した表示の hover の拾いは表示を片付けて null を返し、
 * store が変わらないので取り直しも拾い直しも起きなかった。ViewportCanvas の hover の口が押下と同じ取り直しを共有し、
 * 公開の後に同じ点で 1 回だけ拾い直すこと(refresh-spent では拾い直さず、理由は観測口に出ること)を実配線で確かめる。
 */
describe('受領が失効した表示の hover を、取り直しの公開の後に同じ点で 1 回だけ拾い直す', () => {
  function invalidatedHoverViewport() {
    const f = deferredBeadBodyViewport();
    // 片付いた表示(scene の印)は作り直し(setAssembly)まで続き、その間の拾いは null。作り直した後は実の層で拾う
    // (deferredBeadBodyViewport と同じ視線。入力の x/y は世界座標で、ブラウザーの投影を通した証拠ではない)。
    const display = { invalidated: true };
    const layer = createAssemblyLayer(undefined, { uiBackings: new AssemblyUiBackingLedger() });
    f.scene.setAssembly.mockImplementation((bundle: AssemblyGeometryBundle) => {
      display.invalidated = false;
      layer.update(bundle, 'shadedWithEdges');
    });
    f.scene.pickComponent.mockImplementation((x: number, y: number): string | null => {
      if (display.invalidated) return null;
      const eye = new Vector3(200 / Math.sqrt(3), -200 / Math.sqrt(3), 200 / Math.sqrt(3));
      return layer.pickComponent(new Raycaster(eye, new Vector3(x, y, 24).sub(eye).normalize()));
    });
    f.scene.assemblyDisplayInvalidated.mockImplementation(() => display.invalidated);
    const hover = () => { f.send('pointermove', { buttons: 0 }); };
    return { ...f, display, hover, close: () => { f.close(); layer.dispose(); } };
  }

  it('取り直しの公開の後に同じ点を 1 回だけ拾い直して光らせ、選択・文書・履歴は変えない', async () => {
    const f = invalidatedHoverViewport();
    try {
      const before = useAppStore.getState();
      f.hover();
      expect(useAppStore.getState().hoveredElementId).toBeNull();
      await Promise.resolve();
      expect(f.source.refresh).toHaveBeenCalledExactlyOnceWith(f.source.owner);
      f.source.publish(); await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent.mock.calls).toEqual([[30.75, 11], [30.75, 11]]);
      expect(f.scene.pickComponent).toHaveLastReturnedWith('component-4');
      expect(useAppStore.getState().hoveredElementId).toBe('component-4');
      expect(useAppStore.getState().selection).toEqual([]);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent).toHaveBeenCalledTimes(2);
      expect(f.source.refresh).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it('所有が今のまま表示だけ片付いた時は、今の形で作り直して同じ点を 1 回だけ拾い直す(取り直しは頼まない)', async () => {
    const f = invalidatedHoverViewport();
    try {
      await Promise.resolve(); f.source.publish(); await finishOwnershipMicrotasks();
      expect(f.display.invalidated).toBe(false);
      const rebuilds = f.scene.setAssembly.mock.calls.length;
      f.display.invalidated = true;
      f.hover();
      expect(f.scene.setAssembly).toHaveBeenCalledTimes(rebuilds + 1);
      await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent.mock.calls).toEqual([[30.75, 11], [30.75, 11]]);
      expect(useAppStore.getState().hoveredElementId).toBe('component-4');
      expect(f.source.refresh).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it('取り直しが使い切り(refresh-spent)なら拾い直さず、次の hover も繰り返さず、理由は観測口に出る', async () => {
    const f = invalidatedHoverViewport();
    try {
      f.hover(); await Promise.resolve();
      f.source.settle(null); await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent).toHaveBeenCalledTimes(1);
      f.hover(); await finishOwnershipMicrotasks();
      expect(f.scene.pickComponent).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().hoveredElementId).toBeNull();
      expect(f.source.refresh).toHaveBeenCalledTimes(1);
      expect(window.pcadViewportAssemblyOwner?.()?.assemblyReadyRefusal).toBe('refresh-spent');
    } finally { f.close(); }
  });
});

/** 公開口から取り出すだけで、製品Storeや入力には書かない。 */
function observedPickInputs(): readonly unknown[] {
  const read = window.pcadViewportAssemblyOwner;
  if (read === undefined) throw new Error('部品選択の観測口がありません。');
  const inputs: unknown = read()?.mateInputs;
  if (!Array.isArray(inputs)) throw new Error('入力の観測が配列ではありません。');
  return inputs;
}

describe('部品pick観測の保留・上限・破棄', () => {
  it.each(['apply', 'move'] as const)('以前の第2ビード選択を新しい保留クリックの成功に数えない: %s', async outcome => {
    const f = deferredBeadBodyViewport();
    try {
      // 編集の取消・保存後と同じ境界: 前回の選択は残るが、受領の更新はまだ終わっていない。
      useAppStore.setState({ selection: ['component-4'] });
      const before = useAppStore.getState();
      f.send();
      expect(useAppStore.getState().selection).toEqual(['component-4']);
      expect(f.scene.pickComponent).not.toHaveBeenCalled();
      expect(observedPickInputs()).toEqual([expect.objectContaining({ waiting: true, componentPick: {} })]);
      if (outcome === 'move') f.send('pointermove', { clientX: 31 });
      else f.send('pointerup');
      await Promise.resolve();
      expect(f.source.refresh).toHaveBeenCalledExactlyOnceWith(f.source.owner);
      f.source.publish(); await finishOwnershipMicrotasks();
      // 行の選択だけなら両方が同じ。今回のhitと保留の採否を別に検証しなければ取り違える。
      expect(useAppStore.getState().selection).toEqual(['component-4']);
      if (outcome === 'move') {
        expect(f.scene.pickComponent).not.toHaveBeenCalled();
        expect(observedPickInputs()).toEqual([expect.objectContaining({ waiting: false,
          deferred: 'discarded', deferredReason: 'moved', componentPick: {} })]);
      } else {
        expect(f.scene.pickComponent).toHaveBeenCalledExactlyOnceWith(30.75, 11, expect.any(Object));
        expect(f.scene.pickComponent).toHaveReturnedWith('component-4');
        expect(observedPickInputs()).toEqual([expect.objectContaining({ waiting: false,
          inputGate: 'accepted', deferred: 'applied', readiness: { ready: 'refresh-pending', refresh: 'applied' } })]);
      }
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(useAppStore.getState().assemblyDrag).toBeNull();
    } finally { f.close(); }
  });

  it('同じ保留入力を更新し2回分として数えず、bodyには座標や文書を記録しない', async () => {
    const f = deferredBeadBodyViewport();
    try {
      const before = useAppStore.getState();
      f.send(); f.send('pointerup');
      expect(observedPickInputs()).toEqual([{ inputGate: undefined, deferred: undefined, waiting: true, componentPick: {},
        readiness: { ready: 'refresh-pending', refresh: 'unsettled' } }]);
      expect(f.scene.pickComponent).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(f.source.refresh).toHaveBeenCalledExactlyOnceWith(f.source.owner);
      f.source.publish(); await finishOwnershipMicrotasks();
      expect(observedPickInputs()).toEqual([{ inputGate: 'accepted', deferred: 'applied', waiting: false, componentPick: {},
        readiness: { ready: 'refresh-pending', refresh: 'applied' } }]);
      expect(useAppStore.getState().selection).toEqual(['component-4']);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(useAppStore.getState().assemblyDrag).toBeNull();
    } finally { f.close(); }
  });

  it('同期入力の記録は最後2件だけで、読み出しても入力・文書・履歴を変えない', async () => {
    const f = deferredBeadBodyViewport();
    try {
      f.source.publish(); await finishOwnershipMicrotasks();
      const before = useAppStore.getState();
      f.send(); f.send('pointerup'); f.send(); f.send('pointerup'); f.send(); f.send('pointerup');
      expect(observedPickInputs()).toHaveLength(2);
      const record = observedPickInputs()[0];
      expect(record).toEqual({ inputGate: 'accepted', deferred: undefined, waiting: undefined, componentPick: {},
        readiness: { ready: 'ready', refresh: null } });
      const calls = f.scene.pickComponent.mock.calls.length;
      observedPickInputs(); observedPickInputs();
      expect(f.scene.pickComponent).toHaveBeenCalledTimes(calls);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    } finally { f.close(); }
  });

  it('文書切替後の保留完了とdisposeは旧記録を復活させない', async () => {
    const f = deferredBeadBodyViewport();
    const retained = window.pcadViewportAssemblyOwner;
    try {
      f.send(); await Promise.resolve();
      expect(observedPickInputs()).toHaveLength(1);
      useAppStore.setState({ activeDocumentId: '別の文書' });
      expect(observedPickInputs()).toEqual([]);
      f.source.settle(null); await finishOwnershipMicrotasks();
      expect(observedPickInputs()).toEqual([]);
    } finally { f.close(); }
    expect(window.pcadViewportAssemblyOwner).toBeUndefined();
    expect(retained?.()).toBeNull();
  });
});

describe('部品pickの未実行と失効を混同しない', () => {
  it.each(['null', 'reject', 'target'] as const)('%sではowner/camera/hitを捏造しない', async reason => {
    const f = deferredBeadBodyViewport();
    try {
      const before = useAppStore.getState();
      f.send(); await Promise.resolve();
      if (reason === 'target') useAppStore.setState({ selectionKind: 'face' });
      else if (reason === 'reject') f.source.reject(new Error('検査用の所有取得拒否'));
      else f.source.settle(null);
      await finishOwnershipMicrotasks();
      expect(observedPickInputs()).toEqual([{ inputGate: undefined,
        deferred: reason === 'target' ? 'discarded' : 'refused',
        deferredReason: reason === 'target' ? 'store:selectionKind' : 'not-ready', waiting: false, componentPick: {},
        readiness: { ready: 'refresh-pending',
          refresh: reason === 'target' ? 'unsettled' : reason === 'reject' ? 'threw' : 'none' } }]);
      expect(f.scene.pickComponent).not.toHaveBeenCalled();
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    } finally { f.close(); }
  });
});

/** canvas への登録と解除を [種類, 受け手] の組で突き合わせ、解除されずに残った登録と、登録の無い解除を返す。 */
function unmatchedCanvasListeners(added: readonly (readonly unknown[])[], removed: readonly (readonly unknown[])[]) {
  const remaining = [...removed];
  const leaked = added.filter(([type, listener]) => {
    const index = remaining.findIndex(([removedType, removedListener]) => removedType === type && removedListener === listener);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  return { leaked: leaked.map(([type]) => type), unpaired: remaining.map(([type]) => type) };
}

/** 模擬の scene が受けた呼び出しを、呼ばれた順に 1 行ずつの文字へ写す(重い引数は種類だけにする)。 */
function sceneCallLog(scene: SceneCalls): string[] {
  const entries: { readonly order: number; readonly text: string }[] = [];
  for (const [name, spy] of Object.entries(scene)) {
    spy.mock.calls.forEach((args: readonly unknown[], index: number) => {
      const order = spy.mock.invocationCallOrder[index] ?? 0;
      if (name === 'setAssembly') entries.push({ order, text: `setAssembly(${args[0] === EMPTY_ASSEMBLY_GEOMETRY ? 'empty' : 'bundle'})` });
      else if (name === 'setSketch') entries.push({ order, text: `setSketch(${args[1] === null ? 'no-mesh' : 'mesh'})` });
      else if (['setSketchHighlight', 'setBodyHighlight', 'setSubShapeHighlight', 'setInteractiveRendering', 'resize',
        'setActivePane', 'render', 'setSphereGrid', 'setCutPreview', 'setSectionView', 'setPrintability'].includes(name)) {
        entries.push({ order, text: `${name}${JSON.stringify(args)}` });
      } else entries.push({ order, text: name });
    });
  }
  return entries.sort((a, b) => a.order - b.order).map(entry => entry.text);
}

function clearSceneCalls(scene: SceneCalls): void {
  for (const spy of Object.values(scene)) spy.mockClear();
}

describe('作り直しの基準: 装着と破棄の資源の差、選択・ドラッグ・取消の受け渡し', () => {
  it('実の視点・組立の入力を結んだ 100 回の装着と破棄で、イベントの登録・画像・表示・購読・描画予約・公開口の差が毎回 0', () => {
    fixture.realAssemblyInput = true;
    let listenersPerLife = -1;
    for (let life = 0; life < 100; life += 1) {
      const addsBefore = fixture.canvas.addEventListener.mock.calls.length;
      const removesBefore = fixture.canvas.removeEventListener.mock.calls.length;
      const subscriptionsBefore = fixture.subscriptions.length;
      const framesBefore = fixture.frames.length;
      const cancelledBefore = fixture.cancelledFrames.length;
      const current = mount();
      const added = fixture.canvas.addEventListener.mock.calls.slice(addsBefore);
      if (listenersPerLife < 0) listenersPerLife = added.length;
      expect(added).toHaveLength(listenersPerLife);
      expect(Object.keys(window).length).toBeGreaterThan(0);
      current.cleanup(); current.cleanup();
      const removed = fixture.canvas.removeEventListener.mock.calls.slice(removesBefore);
      expect(unmatchedCanvasListeners(added, removed)).toEqual({ leaked: [], unpaired: [] });
      expect(fixture.scenes).toHaveLength(life + 1);
      expect(current.scene.dispose).toHaveBeenCalledTimes(1);
      expect(current.cache.dispose).toHaveBeenCalledTimes(1);
      expect(current.sketch.detach).toHaveBeenCalledTimes(1);
      expect(current.quad).toHaveBeenCalledTimes(1);
      expect(current.observer.disconnect).toHaveBeenCalledTimes(1);
      const subscriptions = fixture.subscriptions.slice(subscriptionsBefore);
      expect(subscriptions.length).toBeGreaterThan(0);
      for (const subscription of subscriptions) expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
      expect(fixture.frames.length - framesBefore).toBe(fixture.cancelledFrames.length - cancelledBefore);
      expect(Object.keys(window)).toEqual([]);
      expect(useAppStore.getState().captureThumbnail).toBeNull();
      expect(useAppStore.getState().capturePrintFrame).toBeNull();
      expect(useAppStore.getState().viewCameraController).toBeNull();
    }
    expect(listenersPerLife).toBeGreaterThan(2);
  });

  it('選択・ドラッグ・取消の系列で、ストアの更新と scene への受け渡しが基準の並びと同じ', () => {
    // 前の検査が残す受領の控えに依らず、取消の段の更新の組を決める。
    useAppStore.setState({ meshJsAccounting: null });
    const current = mount();
    const transitions: string[][] = [];
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      transitions.push(Object.keys(next).filter(key => !Object.is(Reflect.get(next, key), Reflect.get(previous, key))).sort());
    });
    let lastDrawnFrame = 0;
    // 1 段ごとに、操作 → 受け渡しの記録 → 予約された描画を 1 回だけ実行(その描画の受け渡しも同じ段に入れる)。
    const step = (action: () => void) => {
      clearSceneCalls(current.scene);
      transitions.length = 0;
      const framesBefore = fixture.frames.length;
      action();
      const frames = fixture.frames.length - framesBefore;
      const pending = fixture.frames.at(-1);
      if (pending !== undefined && pending.id > lastDrawnFrame) { lastDrawnFrame = pending.id; pending.draw(0); }
      return { scene: sceneCallLog(current.scene), store: [...transitions], frames };
    };
    try {
      const before = useAppStore.getState();
      const initial = sceneCallLog(current.scene);
      const firstDraw = step(() => undefined);
      const select = step(() => { useAppStore.setState({ hoveredElementId: 'body-1', selection: ['body-1'] }); });
      const sketchDrag = step(() => { useAppStore.getState().setDragResolved({ ...useAppStore.getState().resolvedSketch }); });
      const cameraDrag = step(() => { current.controls.interactive(true); current.controls.changed(); current.controls.interactive(false); });
      const assemblyDrag = step(() => {
        useAppStore.setState({ assemblyDragOverlay: { document: createAssemblyDocument('drag overlay'),
          library: useAppStore.getState().assemblyLibrary, documentId: 'drag-document', version: 1, generation: 1,
          placements: new Map(), validatedIds: [] } });
      });
      const cancel = step(() => {
        useAppStore.getState().endSketchDrag(false);
        useAppStore.setState({ assemblyDragOverlay: null });
        useAppStore.getState().cancelRecompute();
        useAppStore.setState({ hoveredElementId: null, selection: [] });
      });
      const idle = step(() => undefined);
      expect({ initial, firstDraw, select, sketchDrag, cameraDrag, assemblyDrag, cancel, idle }).toEqual(BASELINE_VIEWPORT_CANVAS_SERIES);
      expect(current.assembly.cancelDrag).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { unsubscribe(); current.cleanup(); }
  });
});

const SERIES_RENDER = 'render[{},"perspective","shadedWithEdges",true,100]';
/**
 * 作り直しの前の版(ViewportCanvas が 1 つの関数だった時)で記録した、選択・ドラッグ・取消の系列の
 * ストアの更新と scene への受け渡しの並び。作り直しの後もこの期待を変えずに通ることを、境界を動かしても
 * 動きが同じことの証拠にする。
 */
const BASELINE_VIEWPORT_CANVAS_SERIES = {
  initial: ['resize[640,480]', 'setSketch(no-mesh)', 'setSketchHighlight[null,[]]', 'setBodies', 'setAssembly(empty)',
    'setInterference', 'setAppearance', 'setBodyHighlight[null,[]]', 'setSubShapeHighlight[null,[]]', 'setReferenceRepairPreview',
    'setWorkPlane', 'setWorkPlaneVisible', 'setConstructionIds', 'setConstrainedFeatureIds', 'setReferences', 'setEditPreview',
    'setTracking', 'setConstraintMarks', 'setSelectedConstraint', 'setInferredConstraintMarks', 'setMeasurement',
    'setCutPreview[null]', 'setSphereGrid[null]', 'setCylinderBasisGuide', 'setPlanarBasisGuide', 'setSectionView[null]',
    'setPrintability[null]', 'setAnalysisField', 'setAnalysisMode', 'setCanvases'],
  firstDraw: { frames: 0, scene: ['setThemeColors', SERIES_RENDER], store: [] },
  select: { frames: 1, scene: ['setReferenceRepairPreview', 'setSketchHighlight["body-1",["body-1"]]',
    'setBodyHighlight["body-1",["body-1"]]', 'setSubShapeHighlight["body-1",["body-1"]]', 'setAssembly(empty)',
    'setCutPreview[null]', 'setCylinderBasisGuide', 'setPlanarBasisGuide', 'setSphereGrid[null]', SERIES_RENDER],
  store: [['hoveredElementId', 'selection']] },
  sketchDrag: { frames: 1, scene: ['setReferenceRepairPreview', 'setSketch(no-mesh)', SERIES_RENDER], store: [['dragResolved']] },
  cameraDrag: { frames: 1, scene: ['setInteractiveRendering[true]', 'setInteractiveRendering[false]', SERIES_RENDER], store: [] },
  assemblyDrag: { frames: 1, scene: ['setReferenceRepairPreview', 'setAssembly(empty)', SERIES_RENDER],
    store: [['assemblyDragOverlay']] },
  cancel: { frames: 1, scene: ['setReferenceRepairPreview', 'setSketch(no-mesh)', 'setReferenceRepairPreview', 'setAssembly(empty)',
    'setReferenceRepairPreview', 'setBodies', 'setCylinderBasisGuide', 'setPlanarBasisGuide', 'setReferenceRepairPreview',
    'setSketchHighlight[null,[]]', 'setBodyHighlight[null,[]]', 'setSubShapeHighlight[null,[]]', 'setAssembly(empty)',
    'setCutPreview[null]', 'setCylinderBasisGuide', 'setPlanarBasisGuide', 'setSphereGrid[null]', SERIES_RENDER],
  store: [['dragResolved'], ['assemblyDragOverlay'], ['cancelRequestCount'], ['hoveredElementId', 'selection']] },
  idle: { frames: 0, scene: [], store: [] },
};
