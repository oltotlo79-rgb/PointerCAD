import { autoScale, createPaperFrame, DEFAULT_TITLE_BLOCK_HEIGHT_MM, paperSizeOf, thirdAngleLayout, THIRD_ANGLE_DIRECTIONS, type DrawingView, type Vector3 } from '@pointercad/drawing';
import { createDrawingDocument, embedDrawingSource, emptyDrawingSourceLibrary } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/** 現在の部品はストアに残し、その文書を抱き込んだ図面へ切り替える。 */
export async function createDrawingFromCurrentPart(): Promise<boolean> {
  const state = useAppStore.getState();
  if (state.drawing !== null || state.assembly !== null || state.isComputing || state.bodies.length === 0) {
    useAppStore.setState({ fileMessage: { key: 'drawing.error.noSolid', failed: true } });
    return false;
  }
  try {
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), { sourceKind: 'part', document: state.document },
      state.fileName ?? `${state.document.name}.pcad`, '');
    const current = useAppStore.getState();
    if (current.document !== state.document || current.activeDocumentId !== state.activeDocumentId || current.drawing !== null) return false;
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (const body of state.bodies) for (let index = 0; index < body.mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], body.mesh.positions[index + axis]);
        maximum[axis] = Math.max(maximum[axis], body.mesh.positions[index + axis]);
      }
    }
    const extents: Vector3 = [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]];
    if (!extents.every(Number.isFinite)) throw new Error(t('drawing.error.noSolid'));
    const drawing = createDrawingDocument(`${state.document.name} - ${t('drawing.mode')}`, embedded.source);
    const paper = paperSizeOf(drawing.sheet.paperSizeId);
    if (paper === undefined) throw new Error(t('drawing.error.viewFailed'));
    const scale = autoScale({ paperSizeId: paper.id, orientation: paper.orientation,
      titleBlockHeight: DEFAULT_TITLE_BLOCK_HEIGHT_MM, extents, gap: 30 });
    if (scale === null) throw new Error(t('drawing.error.partTooLarge'));
    const frame = createPaperFrame(paper);
    const layout = thirdAngleLayout({ extents, scale, gap: 30, sheet: { ...frame.inner, bottom: frame.inner.bottom + DEFAULT_TITLE_BLOCK_HEIGHT_MM } });
    const views = (['front', 'top', 'right'] as const).map((kind, index): DrawingView => ({
      id: `view-${index + 1}`, name: t(`drawing.view.${kind}`), kind, position: layout[kind], scale: null,
      direction: THIRD_ANGLE_DIRECTIONS[kind].normal, xDir: THIRD_ANGLE_DIRECTIONS[kind].xDir,
      showHidden: true, showCenterLines: true, layerId: 'layer-1',
    }));
    state.openDrawing({ ...drawing, sheet: { ...drawing.sheet, scale }, views }, {
      sources: embedded.library, importedShapes: state.importedShapes,
    });
    return true;
  } catch (error) {
    if (useAppStore.getState().document === state.document) useAppStore.setState({ fileMessage: {
      key: error instanceof Error && error.message === t('drawing.error.partTooLarge') ? 'drawing.error.partTooLarge' : 'drawing.error.viewFailed', failed: true } });
    return false;
  }
}
