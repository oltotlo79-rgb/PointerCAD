import { useState } from 'react';
import type { SketchFunctionCurveFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { FunctionPlotDialog } from './FunctionPlotDialog.js';
import { FunctionPointDialog } from './FunctionPointDialog.js';
import { FunctionCoefficientSliders } from './FunctionCoefficientSliders.js';
import { useAppStore } from '../store/useAppStore.js';
import { functionPlotDraft, FUNCTION_AXES, activeFunctionOutputs } from './functionPlotDraft.js';

export function FunctionCurveProperties({ feature }: { readonly feature: SketchFunctionCurveFeature }): React.JSX.Element {
  const [open, setOpen] = useState(false), draft = functionPlotDraft(feature);
  const [pointOpen,setPointOpen]=useState(false);
  const sketchId=useAppStore(state=>state.document.sketches.find(sketch=>sketch.features.some(item=>item.id===feature.id))?.id);
  return <section className="pcad-section" data-help-topic="function-curve">
    <h3 className="pcad-section__title">{t('functionPlot.curveTitle')}</h3>
    {draft.form==='implicit' ? <><p>{draft.equation.source} = 0</p><p>{draft.fixedAxis} = {draft.scalars.fixedCoordinate.source} mm</p></>
      : activeFunctionOutputs(draft).map(axis => <p key={axis}>{axis} = {draft.outputs[axis].source}</p>)}
    <dl>{FUNCTION_AXES.map(axis => <div key={axis}><dt>{axis} (mm)</dt><dd>{feature.definition.bounds[axis].min.source}{t('display.rangeSeparator')}{feature.definition.bounds[axis].max.source}</dd></div>)}</dl>
    <button title={t('controlGuide.button.functionEdit')} type="button" onClick={() => setOpen(true)}>{t('functionPlot.edit')}</button>
    <FunctionCoefficientSliders definition={feature.definition} />
    {sketchId?<button title={t('controlGuide.button.functionPoint')} type="button" onClick={()=>setPointOpen(true)}>{t('functionPoint.title')}</button>:null}
    {pointOpen&&sketchId?<FunctionPointDialog parent={{kind:'curve',sketchId,featureId:feature.id}} onClose={()=>setPointOpen(false)}/>:null}
    {open ? <FunctionPlotDialog featureId={feature.id} onClose={() => setOpen(false)} /> : null}
  </section>;
}
