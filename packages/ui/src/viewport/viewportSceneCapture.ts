import type { AssemblyDocument } from '@pointercad/model';
import { capturePrintPng } from '../file/printView.js';
import { captureThumbnailPng, THUMBNAIL_SIZE, reportThumbnailCaptureReason, type ThumbnailCaptureReasonSink } from '../file/thumbnail.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import type { ViewportScene, ViewportSceneOptions } from './createViewportScene.js';

type CaptureMethods = Pick<ViewportScene, 'captureThumbnail' | 'capturePrintFrame'>;

/*
 * createViewportScene の保存・印刷の 1 コマ(FR-801・FR-810・FR-908)。最後の見せ方で描き直し、
 * 同じ同期処理の中で画素を読む。読む前・描き直した後・読んだ後の 3 回、立体と部品の表示の持ち主が
 * 今のままかを確かめ、途中で失効した絵は返さない(断った理由は理由の控えへ名前だけ書く)。
 */

/** 1 コマを撮る前後に確かめる、表示の持ち主と描画の控え。 */
interface SceneCaptureDependencies {
  readonly canvas: HTMLCanvasElement;
  readonly options: ViewportSceneOptions;
  readonly isDisposed: () => boolean;
  readonly frame: { rendered(): boolean; redraw(): void };
  readonly solid: { ensureCurrentOwner(): boolean; isInvalidated(): boolean };
  readonly assembly: { ensureCurrentOwner(): boolean; displayInvalidated(): boolean;
    showsSource(document: AssemblyDocument): boolean };
}

export function createSceneCapture(deps: SceneCaptureDependencies) {
  const { canvas, options, frame, solid, assembly } = deps;

  /** 保存用の再描画とピクセル取得は必ず同じ同期処理の中で行う。 */
  function captureOwnersCurrent(reasonSink?: ThumbnailCaptureReasonSink): boolean {
    if (!solid.ensureCurrentOwner()) { reportThumbnailCaptureReason('scene:solid-owner', reasonSink); return false; }
    if (solid.isInvalidated()) { reportThumbnailCaptureReason('scene:solid-invalidated', reasonSink); return false; }
    if (!assembly.ensureCurrentOwner()) { reportThumbnailCaptureReason('scene:assembly-owner', reasonSink); return false; }
    if (assembly.displayInvalidated()) { reportThumbnailCaptureReason('scene:assembly-invalidated', reasonSink); return false; }
    const state = options.readSolidMeshState?.();
    const active = state === undefined ? null : activeAssemblyDocument(state);
    // An empty interim display is not a proved image of the active assembly.
    const current = active === null || assembly.showsSource(active);
    if (!current) reportThumbnailCaptureReason('scene:assembly-source', reasonSink);
    return current;
  }

  function captureCurrentFrame<T>(capture: () => T, reasonSink?: ThumbnailCaptureReasonSink): T | null {
    if (deps.isDisposed() || !frame.rendered()) {
      reportThumbnailCaptureReason(deps.isDisposed() ? 'scene:disposed' : 'scene:not-rendered', reasonSink);
      return null;
    }
    reportThumbnailCaptureReason('scene:pre-redraw', reasonSink);
    if (!captureOwnersCurrent(reasonSink)) return null;
    frame.redraw();
    reportThumbnailCaptureReason('scene:post-redraw', reasonSink);
    if (!captureOwnersCurrent(reasonSink)) return null;
    const result = capture();
    reportThumbnailCaptureReason('scene:post-image', reasonSink);
    return captureOwnersCurrent(reasonSink) ? result : null;
  }

  const methods: CaptureMethods = {
    captureThumbnail(size = THUMBNAIL_SIZE, reasonSink?: ThumbnailCaptureReasonSink): Uint8Array | null {
      return captureCurrentFrame(() => captureThumbnailPng(canvas, size, reasonSink), reasonSink);
    },

    capturePrintFrame(): string | null {
      return captureCurrentFrame(() => capturePrintPng(canvas));
    },
  };
  return { methods };
}
