import { appendSolid, createFunctionCurve, createFunctionSurface, replaceSketch, replaceSolid,
  type FunctionDefinition, type FunctionSurfaceFeature, type PartDocument, type SketchFunctionCurveFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';

export type EditableFunctionFeature = SketchFunctionCurveFeature | FunctionSurfaceFeature;
/** Build an undoable candidate. The store inserts new features at the current timeline cursor on apply. */
export function prepareFunctionPlot(document: PartDocument, geometry: 'curve' | 'surface', definition: FunctionDefinition,
  sketchId: string, previous?: EditableFunctionFeature): { readonly document: PartDocument; readonly feature: EditableFunctionFeature } {
  if (previous && (previous.kind === 'functionSurface') !== (geometry === 'surface')) throw new Error(t('functionPlot.changedKind'));
  if (geometry === 'surface') {
    const feature = previous?.kind === 'functionSurface' ? { ...previous, definition } : createFunctionSurface(document, definition);
    return { document: previous ? replaceSolid(document, previous.id, feature) : appendSolid(document, feature), feature };
  }
  const sketch = document.sketches.find(item => item.id === sketchId);
  if (!sketch) throw new Error(t('functionPlot.missingCurve'));
  const feature = previous?.kind === 'functionCurve' ? { ...previous, definition } : createFunctionCurve(sketch, definition);
  const features = previous ? sketch.features.map(item => item.id === previous.id ? feature : item) : [...sketch.features, feature];
  return { document: replaceSketch(document, { ...sketch, features }), feature };
}
