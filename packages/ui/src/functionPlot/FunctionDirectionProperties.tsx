import {useState} from 'react';
import type {SketchLineFeature} from '@pointercad/model';
import {FunctionDirectionDialog} from './FunctionDirectionDialog.js';
import {t} from '../i18n/t.js';

export function FunctionDirectionProperties({feature}:{readonly feature:SketchLineFeature}):React.JSX.Element|null {
  const [open,setOpen]=useState(false);
  if(feature.to.mode!=='relative'||feature.to.base.kind!=='functionPoint')return null;
  const reference=feature.to.base,direction=reference.direction;
  if(!direction?.sourcePointId)return null;
  return <section className="pcad-section" data-help-topic="function-point">
    <h3 className="pcad-section__title">{t('functionDirection.edit')}</h3>
    <p>{t(`functionDirection.${direction.kind}`)} · {direction.length.source} mm{direction.reverse?` · ${t('functionDirection.reverse')}`:''}</p>
    <button type="button" onClick={()=>setOpen(true)}>{t('functionDirection.edit')}</button>
    {open?<FunctionDirectionDialog pointId={direction.sourcePointId} reference={reference} lineId={feature.id} onClose={()=>setOpen(false)}/>:null}
  </section>;
}
