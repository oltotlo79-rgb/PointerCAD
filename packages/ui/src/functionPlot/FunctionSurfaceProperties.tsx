import { Fragment, useState } from 'react';
import type { FunctionSurfaceFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { FunctionPlotDialog } from './FunctionPlotDialog.js';
import { FunctionPointDialog } from './FunctionPointDialog.js';
import { FunctionCoefficientSliders } from './FunctionCoefficientSliders.js';
import { functionSurfaceDetails } from './functionSurfaceSummary.js';
import { FunctionSectionDialog } from './FunctionSectionDialog.js';

export function FunctionSurfaceProperties({ feature }: { readonly feature: FunctionSurfaceFeature }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [pointOpen,setPointOpen]=useState(false);
  const supported = feature.definition.formula.kind === 'coordinate-surface' || feature.definition.formula.kind === 'parametric-surface'
    || feature.definition.formula.kind === 'implicit-surface';
  return <section className="pcad-section" data-help-topic="function-surface">
    <h3 className="pcad-section__title">{t('functionPlot.surfaceTitle')}</h3>
    <dl className="pcad-properties">{functionSurfaceDetails(feature).map(entry => <Fragment key={entry.labelKey}>
      <dt className="pcad-properties__key">{t(entry.labelKey)}</dt><dd className="pcad-properties__value">{entry.text}</dd>
    </Fragment>)}</dl>
    <button title={t('controlGuide.button.functionEdit')} type="button" disabled={!supported} onClick={() => setOpen(true)}>{t('functionPlot.edit')}</button>
    <FunctionCoefficientSliders definition={feature.definition} />
    <button title={t('controlGuide.button.functionSection')} type="button" disabled={feature.suppressed} onClick={() => setSectionOpen(true)}>{t('functionSection.title')}</button>
    {sectionOpen ? <FunctionSectionDialog parentId={feature.id} onClose={() => setSectionOpen(false)} /> : null}
    <button title={t('controlGuide.button.functionPoint')} type="button" disabled={feature.suppressed} onClick={()=>setPointOpen(true)}>{t('functionPoint.title')}</button>
    {pointOpen?<FunctionPointDialog parent={{kind:'surface',featureId:feature.id}} onClose={()=>setPointOpen(false)}/>:null}
    {open ? <FunctionPlotDialog featureId={feature.id} onClose={() => setOpen(false)} /> : null}
  </section>;
}
