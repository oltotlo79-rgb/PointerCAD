import { checkCanvasImage, type CanvasImageFormat, type SketchCanvas } from '@pointercad/model';
import { decodeCanvasImage, type DecodedCanvasImage } from '../file/canvasFile.js';
import type { CanvasImageLoad, CanvasImageOwner } from '../sketch/canvasActionState.js';
import { createViewportLifetime, type ViewportLifetime } from './viewportLifetime.js';

export interface CanvasImageSource {
  readonly documentId: string;
  readonly canvases: readonly Pick<SketchCanvas, 'imageId'>[];
  readonly images: ReadonlyMap<string, Uint8Array>;
  readonly retries: ReadonlyMap<string, number>;
}

interface ImageRequest extends CanvasImageOwner {
  readonly retry: number;
}

interface ReadyImage extends ImageRequest {
  readonly image: DecodedCanvasImage;
}

export interface CanvasImageCacheOptions {
  readonly readSource: () => CanvasImageSource;
  readonly publish: (images: ReadonlyMap<string, DecodedCanvasImage>) => void;
  readonly setLoad: (imageId: string, owner: CanvasImageOwner, load: CanvasImageLoad | null) => void;
  readonly reportInvalid: (message: string) => void;
  readonly decode?: (bytes: Uint8Array, format: CanvasImageFormat) => Promise<DecodedCanvasImage>;
  readonly onCleanupSettled?: () => void;
}

/**
 * 画像の持ち主。文書・画像ID・不変のバイト列が一致する間だけ復号結果を使う。
 * 要求オブジェクト自身を札にして、古い完了が新しい要求を消すことも防ぐ。
 */
export function createCanvasImageCache(options: CanvasImageCacheOptions) {
  const ready = new Map<string, ReadyImage>();
  const pending = new Map<string, ImageRequest>();
  const failed = new Map<string, ImageRequest>();
  const decode = options.decode ?? decodeCanvasImage;
  let disposed = false;
  const cleanup = new Set<ViewportLifetime>();
  const closing = new WeakSet<DecodedCanvasImage>();
  const inFlight = new Set<ImageRequest>();
  let notificationFailed = false;

  function queueRelease(label: string, release: () => void): void {
    const owner = createViewportLifetime();
    owner.register(label, release);
    cleanup.add(owner);
  }

  function queueImageClose(image: DecodedCanvasImage): void {
    if (closing.has(image)) return;
    closing.add(image);
    queueRelease('decoded image', () => { image.close?.(); });
  }

  function attemptCleanup(): void {
    for (const owner of cleanup) {
      owner.dispose();
      if (owner.pendingCount === 0) cleanup.delete(owner);
    }
  }

  function notifySettled(): void {
    if (!disposed || inFlight.size !== 0 || cleanup.size !== 0) return;
    try { options.onCleanupSettled?.(); notificationFailed = false; }
    catch { notificationFailed = true; }
  }

  function belongsTo(source: CanvasImageSource, imageId: string, request: ImageRequest): boolean {
    return source.documentId === request.documentId && source.images.get(imageId) === request.bytes
      && (source.retries.get(imageId) ?? 0) === request.retry
      && source.canvases.some((canvas) => canvas.imageId === imageId);
  }

  function publish(): void {
    options.publish(new Map([...ready].map(([id, entry]) => [id, entry.image])));
  }

  function removeReady(imageId: string, entry: ReadyImage): void {
    ready.delete(imageId);
    if (![...ready.values()].some(other => other.image === entry.image)) queueImageClose(entry.image);
    queueRelease('image load owner', () => { options.setLoad(imageId, entry, null); });
  }

  function clearEntries(): void {
    const entries = new Map([...ready, ...pending, ...failed]);
    const images = [...ready.values()];
    ready.clear();
    pending.clear();
    failed.clear();
    for (const { image } of images) queueImageClose(image);
    for (const [id, owner] of entries) queueRelease('image load owner', () => { options.setLoad(id, owner, null); });
    attemptCleanup();
  }

  function sync(): void {
    attemptCleanup();
    if (disposed) { notifySettled(); return; }
    const source = options.readSource();
    for (const [id, entry] of ready) {
      if (!belongsTo(source, id, entry)) removeReady(id, entry);
    }
    for (const [id, request] of pending) {
      if (!belongsTo(source, id, request)) {
        pending.delete(id);
        queueRelease('image load owner', () => { options.setLoad(id, request, null); });
      }
    }
    for (const [id, request] of failed) {
      if (!belongsTo(source, id, request)) {
        failed.delete(id);
        queueRelease('image load owner', () => { options.setLoad(id, request, null); });
      }
    }
    for (const { imageId } of source.canvases) {
      const bytes = source.images.get(imageId);
      if (bytes === undefined || ready.has(imageId) || pending.has(imageId) || failed.has(imageId)) continue;
      const request = { documentId: source.documentId, bytes, retry: source.retries.get(imageId) ?? 0, request: {} };
      const checked = checkCanvasImage(bytes);
      if (!checked.ok) {
        failed.set(imageId, request);
        const load: CanvasImageLoad = { ...request, status: 'failed' };
        options.setLoad(imageId, load, load);
        options.reportInvalid(checked.message);
        continue;
      }
      pending.set(imageId, request);
      const loading: CanvasImageLoad = { ...request, status: 'loading' };
      options.setLoad(imageId, loading, loading);
      inFlight.add(request);
      void decode(bytes, checked.format).then((image) => {
        inFlight.delete(request);
        const currentRequest = pending.get(imageId) === request;
        if (currentRequest) pending.delete(imageId);
        let belongs = false;
        try { belongs = !disposed && currentRequest && belongsTo(options.readSource(), imageId, request); }
        catch { /* The decoded asset still belongs to this request and must be returned. */ }
        if (!belongs || closing.has(image)) {
          if (currentRequest) queueRelease('image load owner', () => { options.setLoad(imageId, request, null); });
          queueImageClose(image);
          attemptCleanup(); notifySettled();
          return;
        }
        ready.set(imageId, { ...request, image });
        const load: CanvasImageLoad = { ...request, status: 'ready', size: { width: image.width, height: image.height } };
        options.setLoad(imageId, load, load);
        publish();
      }, () => {
        inFlight.delete(request);
        if (disposed) { notifySettled(); return; }
        if (pending.get(imageId) !== request) return;
        pending.delete(imageId);
        let belongs = false;
        try { belongs = belongsTo(options.readSource(), imageId, request); }
        catch { /* A failed source read must still release this request's loading state. */ }
        if (!belongs) {
          queueRelease('image load owner', () => { options.setLoad(imageId, request, null); });
          attemptCleanup(); notifySettled();
          return;
        }
        failed.set(imageId, request);
        const load: CanvasImageLoad = { ...request, status: 'failed' };
        options.setLoad(imageId, load, load);
      }).catch(() => {
        // Consumer callbacks may throw after decoding. Retain the ready image
        // for ordinary cleanup and never leak an unhandled Promise rejection.
        inFlight.delete(request);
        attemptCleanup(); notifySettled();
      });
    }
    attemptCleanup();
    publish();
  }

  return {
    sync,
    clear(): void {
      if (disposed) { attemptCleanup(); notifySettled(); return; }
      clearEntries();
      publish();
    },
    dispose(): void {
      if (!disposed) { disposed = true; clearEntries(); }
      else attemptCleanup();
    },
    cleanupPending(): boolean { return cleanup.size !== 0 || inFlight.size !== 0 || notificationFailed; },
  };
}
