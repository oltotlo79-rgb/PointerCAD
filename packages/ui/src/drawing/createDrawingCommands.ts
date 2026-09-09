import { autoScale, createPaperFrame, DEFAULT_TITLE_BLOCK_HEIGHT_MM, paperSizeOf, thirdAngleLayout, THIRD_ANGLE_DIRECTIONS, type DrawingView, type Vector3 } from '@pointercad/drawing';
import { applyPlacementToPoint, createDrawingDocument, drawingFromTemplate, embedDrawingSource, emptyDrawingSourceLibrary,
  IDENTITY_PLACEMENT, type DrawingTemplate, type DrawingSourceInput, type RigidPlacement, type SolidBody } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { flattenAssemblyGeometry } from '../viewport/createAssemblyLayer.js';

/** 現在の部品または組立と原本一式を抱き込み、配置済みの形から三面図を作る。 */
export async function createDrawingFromCurrentPart(template?: DrawingTemplate): Promise<boolean> {
  const state = useAppStore.getState();
  if (state.drawing !== null || state.isComputing) {
    useAppStore.setState({ fileMessage: { key: 'drawing.error.noSolid', failed: true } });
    return false;
  }
  try {
    const geometry: { body: SolidBody; placement: RigidPlacement }[] = [];
    const source: DrawingSourceInput = state.assembly === null
      ? { sourceKind: 'part', document: state.document, attachments: currentPcadAttachments() }
      : { sourceKind: 'assembly', document: state.assembly, library: state.assemblyLibrary };
    if (state.assembly === null) geometry.push(...state.bodies.map((body) => ({ body, placement: IDENTITY_PLACEMENT })));
    else {
      const view = state.assemblyView;
      if (view === null || view.sourceDocument !== state.assembly || view.diagnosis?.converged === false
        || view.diagnosis?.complete === false) throw new Error(t('drawing.error.assemblyConstraints'));
      const flat = flattenAssemblyGeometry(state.assembly, view.resolved);
      for (const component of flat.components) {
        if (!component.visible) continue;
        const ref = flat.partKeys.get(component.id), placement = flat.placements.get(component.id);
        if (ref === undefined || placement === undefined) throw new Error(t('drawing.error.selectSource'));
        for (const body of view.bodies.get(ref) ?? []) geometry.push({ body, placement });
      }
    }
    if (geometry.length === 0) throw new Error(t('drawing.error.noSolid'));
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source,
      (state.assembly === null ? state.fileName : state.assemblyFileName) ?? `${source.document.name}.${source.sourceKind === 'part' ? 'pcad' : 'pcada'}`, '');
    const current = useAppStore.getState();
    if (current.document !== state.document || current.assembly !== state.assembly || current.assemblyLibrary !== state.assemblyLibrary
      || current.activeDocumentId !== state.activeDocumentId || current.drawing !== null) return false;
    if (template !== undefined) {
      const created = drawingFromTemplate(template, `${source.document.name} - ${template.name}`, embedded.source);
      if (!created.ok) throw new Error(t('drawing.template.invalid'));
      state.openDrawing(created.document, { sources: embedded.library, importedShapes: state.importedShapes });
      return true;
    }
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (const { body, placement } of geometry) for (let index = 0; index < body.mesh.positions.length; index += 3) {
      const positions = body.mesh.positions;
      const point = applyPlacementToPoint(placement, [positions[index], positions[index + 1], positions[index + 2]]);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
    const extents: Vector3 = [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]];
    if (!extents.every(Number.isFinite)) throw new Error(t('drawing.error.noSolid'));
    const drawing = createDrawingDocument(`${source.document.name} - ${t('drawing.mode')}`, embedded.source);
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
    const current = useAppStore.getState();
    const reason = (['drawing.error.partTooLarge', 'drawing.error.assemblyConstraints',
      'drawing.error.selectSource', 'drawing.error.noSolid'] as const)
      .find((key) => error instanceof Error && error.message === t(key)) ?? 'drawing.error.viewFailed';
    if (current.document === state.document && current.assembly === state.assembly
      && current.activeDocumentId === state.activeDocumentId && current.drawing === null) useAppStore.setState({ fileMessage: {
      key: reason, failed: true } });
    return false;
  }
}
