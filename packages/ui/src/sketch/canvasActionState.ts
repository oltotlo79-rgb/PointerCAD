import type { PartDocument } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { CanvasPixelSize } from '../viewport/canvasLayer.js';

export interface CanvasImageOwner {
  readonly documentId: string;
  readonly bytes: Uint8Array;
  readonly request: object;
}

/** 復号した画像と同じ寿命の情報。文書や保存形式には入れない。 */
export type CanvasImageLoad = CanvasImageOwner & (
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly size: CanvasPixelSize }
);

interface CanvasActionSource {
  readonly document: PartDocument;
  readonly activeDocumentId: string;
  readonly assembly: object | null;
  readonly drawing: object | null;
  readonly canvases: ReadonlyMap<string, Uint8Array>;
  readonly canvasImageLoads: ReadonlyMap<string, CanvasImageLoad>;
}

export type CanvasActionState =
  | { readonly status: 'ready'; readonly reason: null; readonly size: CanvasPixelSize }
  | { readonly status: 'gone' | 'stale' | 'missing' | 'loading' | 'failed'; readonly reason: MessageKey };

/** 表示した時だけでなく操作直前にも、現在の文書と画像の一致を確認する。 */
export function canvasActionState(
  state: CanvasActionSource,
  canvasId: string,
  documentId = state.activeDocumentId,
  imageId?: string,
): CanvasActionState {
  if (documentId !== state.activeDocumentId || state.assembly !== null || state.drawing !== null) {
    return { status: 'stale', reason: 'propertyPanel.canvasReasonChanged' };
  }
  const canvas = state.document.canvases.find(item => item.id === canvasId);
  if (canvas === undefined) return { status: 'gone', reason: 'propertyPanel.canvasReasonGone' };
  if (imageId !== undefined && canvas.imageId !== imageId) return { status: 'stale', reason: 'propertyPanel.canvasReasonChanged' };
  const bytes = state.canvases.get(canvas.imageId);
  if (bytes === undefined) return { status: 'missing', reason: 'propertyPanel.canvasReasonMissing' };
  const load = state.canvasImageLoads.get(canvas.imageId);
  if (load === undefined) return { status: 'loading', reason: 'propertyPanel.canvasReasonLoading' };
  if (load.documentId !== state.activeDocumentId || load.bytes !== bytes) {
    return { status: 'stale', reason: 'propertyPanel.canvasReasonChanged' };
  }
  if (load.status === 'failed') return { status: 'failed', reason: 'propertyPanel.canvasReasonFailed' };
  if (load.status === 'loading') return { status: 'loading', reason: 'propertyPanel.canvasReasonLoading' };
  return { status: 'ready', reason: null, size: load.size };
}

/** 空欄・打ちかけ・範囲外を0へ変換しない。 */
export function canvasOpacityValue(source: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(source.trim())) return null;
  const value = Number(source);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
