import { createThumbnailCaptureReasonJournal } from '../file/thumbnail.js';
import { ViewportSceneInitializationFailure, type ViewportMeshReservation } from './createViewportScene.js';
import { sketchDragTimingForE2E } from './sketchDragTiming.js';
import { LOCAL_DISPLAY_GPU_MESH_BUDGET } from './solidMeshAdmission.js';
import { createViewportLifetime, createViewportCleanupQueue, type ViewportLifetime } from './viewportLifetime.js';
import { createViewportMeshObservation } from './viewportMeshObservation.js';

/*
 * ViewportCanvas の装着の寿命(1 回の useEffect)。装着ごとに持ち主の名前・片付けの台帳・メッシュの観測を作り、
 * 前の装着の片付けが残っている間は順番を待ってから初期化する。外した後に片付けが残ったものは、アプリ全体の
 * 待ち行列(retiredViewports)が時間を置いて返し直し、その間の予約は診断の口から読める。
 */

let nextViewportOwner = 0;
const retiredViewports = createViewportCleanupQueue((retry, delayMs) => {
  const timer = globalThis.setTimeout(retry, delayMs);
  return () => { globalThis.clearTimeout(timer); };
});
const readRetiredViewports = () => {
  const owners = retiredViewports.snapshot();
  return { pendingCount: retiredViewports.pendingCount, ownerCount: owners.length,
    admittedOwnerCount: retiredViewports.ownerCount, waitingCount: retiredViewports.waitingCount,
    scheduled: retiredViewports.scheduled, sharedGpuPoolReservedBytes: LOCAL_DISPLAY_GPU_MESH_BUDGET.reservedBytes(), owners };
};

/** 片付けを待つ画面の「やり直す」から、残った片付けをすぐ試す。 */
export function retryRetiredViewports(): void {
  retiredViewports.retryNow();
}

/** 1 回の装着の初期化が受け取るもの。 */
export interface ViewportMount {
  readonly canvas: HTMLCanvasElement;
  readonly viewportOwnerId: string;
  readonly lifetime: ViewportLifetime;
  readonly observation: ReturnType<typeof createViewportMeshObservation>;
  readonly sketchTiming: ReturnType<typeof sketchDragTimingForE2E>;
  readonly thumbnailReasons: ReturnType<typeof createThumbnailCaptureReasonJournal>;
  readonly readRetiredViewports: typeof readRetiredViewports;
  readonly isAlive: () => boolean;
  readonly disposeViewport: () => void;
  /** 片付けが残った時の診断に、scene の予約の読み出しを渡す。 */
  readonly setSceneReservation: (read: () => ViewportMeshReservation) => void;
}

/** 装着がコンポーネントから借りるもの。 */
interface ViewportMountHooks {
  readonly canvasRef: { readonly current: HTMLCanvasElement | null };
  readonly setCleanupWaiting: (waiting: boolean) => void;
  readonly setMountFailure: (failure: Error) => void;
  readonly initialize: (mount: ViewportMount) => void;
}

/** useEffect の本体。canvas が無ければ何もしない。返すのは外す関数。 */
export function mountViewportCanvas(hooks: ViewportMountHooks): (() => void) | undefined {
  const canvas = hooks.canvasRef.current;
  if (canvas === null) {
    return;
  }
  const mountedCanvas = canvas;
  const viewportOwnerId = `viewport-${++nextViewportOwner}`;
  let mountEnded = false;
  let disposeMounted: (() => void) | null = null;
  const lifetime = createViewportLifetime();
  const observation = createViewportMeshObservation(viewportOwnerId);
  let alive = true;
  const sketchTiming = sketchDragTimingForE2E(import.meta.env.VITE_PCAD_E2E === '1', mountedCanvas);
  if (sketchTiming !== undefined) lifetime.register('sketch timing', () => { sketchTiming.dispose(); });
  const thumbnailReasons = createThumbnailCaptureReasonJournal();
  let readSceneReservation: (() => ViewportMeshReservation) | null = null;
  function disposeViewport(): void {
    alive = false;
    lifetime.dispose();
    if (lifetime.pendingCount === 0) {
      observation.close(viewportOwnerId);
      retiredViewports.returned(viewportOwnerId);
      if (retiredViewports.ownerCount === 0 && retiredViewports.waitingCount === 0
        && window.pcadViewportRetiredCleanups === readRetiredViewports) delete window.pcadViewportRetiredCleanups;
    } else {
      retiredViewports.retain(viewportOwnerId, {
        retry: () => { disposeViewport(); return lifetime.pendingCount === 0; },
        read: () => {
          const reading = readSceneReservation?.();
          return { viewportOwnerId, pendingCount: lifetime.pendingCount, errors: lifetime.errors,
            hostDisplayCopyBytes: reading?.displayCopyBytes ?? null, hostGpuAttributeBytes: reading?.gpuMeshBytes ?? null,
            unknown: [...(reading?.uncovered ?? ['viewportInitializationResources']), 'viewportBindings', 'nativeMemory', 'driverGpuActual'],
            observationActive: observation.snapshot().active };
        },
      });
    }
  }
  const mount: ViewportMount = { canvas: mountedCanvas, viewportOwnerId, lifetime, observation, sketchTiming, thumbnailReasons,
    readRetiredViewports, isAlive: () => alive, disposeViewport,
    setSceneReservation: (read) => { readSceneReservation = read; } };
  function initializeViewport(): void {
    if (mountEnded || hooks.canvasRef.current !== mountedCanvas) { retiredViewports.returned(viewportOwnerId); return; }
    hooks.setCleanupWaiting(false);
    hooks.initialize(mount);
    disposeMounted = disposeViewport;
  }
  hooks.setCleanupWaiting(retiredViewports.pendingCount !== 0 || retiredViewports.ownerCount >= 16);
  window.pcadViewportRetiredCleanups = readRetiredViewports;
  const cancelWaiting = retiredViewports.whenAvailable(viewportOwnerId, () => {
    try { initializeViewport(); }
    catch (error) {
      if (error instanceof ViewportSceneInitializationFailure) {
        lifetime.register('scene initialization rollback', () => {
          error.cleanup.dispose();
          if (error.cleanup.pendingCount !== 0) throw new Error('Scene initialization cleanup remains pending');
        });
      }
      disposeMounted = disposeViewport;
      disposeViewport();
      if (!mountEnded) hooks.setMountFailure(error instanceof Error ? error : new Error('Viewport initialization failed'));
    }
  });
  return () => { mountEnded = true; cancelWaiting(); disposeMounted?.(); };
}
