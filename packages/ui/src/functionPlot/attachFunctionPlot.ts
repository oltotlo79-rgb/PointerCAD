import { createEmptyPartDocument, type AssemblyKernelBridge } from '@pointercad/model';
import { recomputePartWithMath } from '../math/recomputePartWithMath.js';
import type { FunctionPlotComputer, FunctionSurfacePlotComputer } from '../store/functionPlotSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';

/** The preview follows the same worker path as saved geometry, with a separately released owner. */
export function attachFunctionPlot(bridge: AssemblyKernelBridge): () => void {
  let detached = false;
  const computer: FunctionPlotComputer = async (document, featureId, shouldCancel) => {
    const sketch = document.sketches.find(item => item.features.some(feature => feature.id === featureId));
    const feature = sketch?.features.find(item => item.id === featureId);
    if (!sketch || feature?.kind !== 'functionCurve') return { status: 'failed', message: t('functionPlot.missingCurve') };
    const partId = `function-preview:${crypto.randomUUID()}`;
    try {
      const result = await recomputePartWithMath({ ...createEmptyPartDocument(), id: document.id,
        parameters: document.parameters, activeSketchId: sketch.id, sketches: [{ ...sketch, features: [feature], constraints: [] }] }, bridge,
      { partId, shouldCancel: () => detached || shouldCancel() });
      if (detached || shouldCancel() || result.cancelled) return { status: 'cancelled' };
      const issue = result.errors.find(error => error.featureId === featureId);
      if (issue) return { status: 'failed', message: issue.message };
      const curves = result.sketches[0]?.resolved.splines ?? [];
      return curves.length === 0 ? { status: 'failed', message: t('functionPlot.empty') } : { status: 'ready', curves };
    } finally { await bridge.releasePart(partId); }
  };
  const surfaceComputer: FunctionSurfacePlotComputer = async (document, featureId, shouldCancel) => {
    const feature = document.solids.find(item => item.id === featureId);
    if (feature?.kind !== 'functionSurface') return { status: 'failed', message: t('functionPlot.missingSurface') };
    const partId = `function-surface-preview:${crypto.randomUUID()}`;
    try {
      const result = await recomputePartWithMath({ ...createEmptyPartDocument(), id: document.id,
        parameters: document.parameters, solids: [{ ...feature, suppressed: false }] }, bridge,
      { partId, measureAreas: true, shouldCancel: () => detached || shouldCancel() });
      if (detached || shouldCancel() || result.cancelled) return { status: 'cancelled' };
      const issue = result.errors.find(error => error.featureId === featureId);
      if (issue) return { status: 'failed', message: issue.message };
      const body = result.bodies.find(item => item.featureId === featureId);
      return body?.isValid ? { status: 'ready', body } : { status: 'failed', message: t('functionPlot.emptySurface') };
    } finally { await bridge.releasePart(partId); }
  };
  useAppStore.getState().setFunctionPlotComputer(computer);
  useAppStore.getState().setFunctionSurfacePlotComputer(surfaceComputer);
  return () => {
    detached = true;
    if (useAppStore.getState().functionPlotComputer === computer) useAppStore.getState().setFunctionPlotComputer(null);
    if (useAppStore.getState().functionSurfacePlotComputer === surfaceComputer) useAppStore.getState().setFunctionSurfacePlotComputer(null);
  };
}
