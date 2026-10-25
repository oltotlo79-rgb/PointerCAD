import type { PartDocument, UndoStack } from '@pointercad/model';
import type { AppState } from './appState.js';
import { retainAssetEntries } from '../file/referencedPartAttachments.js';

type RetainedCanvasState = Pick<AppState, 'canvases' | 'canvasPixelSizes' | 'canvasImageLoads'
  | 'canvasImageRetries' | 'canvasScale' | 'canvasRectification'>;
type RetentionSource = RetainedCanvasState & Pick<AppState, 'assembly' | 'drawing'>;

/** メモリー上の部品資産を選ぶ。現在文書だけを選ぶ保存用の処理とは寿命が異なる。 */
export function retainCanvasAssets(
  images: ReadonlyMap<string, Uint8Array>,
  next: PartDocument,
  stack: UndoStack<PartDocument>,
  knownReferences?: ReadonlySet<string>,
): ReadonlyMap<string, Uint8Array> {
  if (images.size === 0) return images;
  if (knownReferences !== undefined) return retainAssetEntries(images, knownReferences);
  const references = new Set<string>();
  for (const document of [next, ...stack.past, stack.present, ...stack.future]) {
    for (const canvas of document.canvases) references.add(canvas.imageId);
  }
  return retainAssetEntries(images, references);
}

/** 添付とその一時的な控えを同時に手放す。捕捉済みのMapや画像バイトは書き換えない。 */
export function canvasAssetRetention(
  state: RetentionSource,
  next: PartDocument,
  stack: UndoStack<PartDocument>,
  replacesDocument: boolean,
  references?: ReadonlySet<string>,
): RetainedCanvasState {
  const picking = state.canvasRectification;
  const canvasRectification = !replacesDocument && picking !== null
    && next.canvases.some(canvas => canvas.id === picking.canvasId && canvas.imageId === picking.imageId)
    ? picking : null;
  // 組立のlibrary・図面のsourcesは独立した所有者。背後の仮部品では回収しない。
  if (!replacesDocument && (state.assembly !== null || state.drawing !== null)) {
    return { canvases: state.canvases, canvasPixelSizes: state.canvasPixelSizes,
      canvasImageLoads: state.canvasImageLoads, canvasImageRetries: state.canvasImageRetries,
      canvasScale: state.canvasScale, canvasRectification };
  }
  const canvases = retainCanvasAssets(state.canvases, next, stack, references);
  if (canvases === state.canvases) {
    return { canvases, canvasPixelSizes: state.canvasPixelSizes,
      canvasImageLoads: state.canvasImageLoads, canvasImageRetries: state.canvasImageRetries,
      canvasScale: state.canvasScale, canvasRectification };
  }
  const ids = new Set(canvases.keys());
  return { canvases,
    canvasPixelSizes: retainAssetEntries(state.canvasPixelSizes, ids),
    canvasImageLoads: retainAssetEntries(state.canvasImageLoads, ids),
    canvasImageRetries: retainAssetEntries(state.canvasImageRetries, ids),
    canvasScale: state.canvasScale !== null && !ids.has(state.canvasScale.imageId) ? null : state.canvasScale,
    canvasRectification: canvasRectification !== null && ids.has(canvasRectification.imageId)
      ? canvasRectification : null };
}
