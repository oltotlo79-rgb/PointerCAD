import type { PartDocument, UndoStack } from '@pointercad/model';
import { partAssetReferences, retainAssetEntries } from '../file/referencedPartAttachments.js';
import type { AppState } from './appState.js';
import { canvasAssetRetention } from './canvasAssetRetention.js';

type RetainedPartAssets = Pick<AppState, 'importedShapes' | 'importedMeshes' | 'canvases' | 'canvasScale' | 'canvasRectification'
  | 'canvasImageLoads' | 'canvasImageRetries' | 'canvasPixelSizes'>;

/** 現在とUndoの全所有者が必要な原本だけを残す。進行中保存の旧Mapは独立に存続する。 */
export function partAssetRetention(state: AppState, next: PartDocument, stack: UndoStack<PartDocument>, replacesDocument: boolean): RetainedPartAssets {
  if ((!replacesDocument && (state.assembly !== null || state.drawing !== null))
    || (state.importedShapes.size === 0 && state.importedMeshes.size === 0 && state.canvases.size === 0)) {
    return { ...canvasAssetRetention(state, next, stack, replacesDocument),
      importedShapes: state.importedShapes, importedMeshes: state.importedMeshes };
  }
  const refs = partAssetReferences([next, ...stack.past, stack.present, ...stack.future]);
  return { ...canvasAssetRetention(state, next, stack, replacesDocument, refs.canvases),
    importedShapes: retainAssetEntries(state.importedShapes, refs.shapes),
    importedMeshes: retainAssetEntries(state.importedMeshes, refs.meshes) };
}
