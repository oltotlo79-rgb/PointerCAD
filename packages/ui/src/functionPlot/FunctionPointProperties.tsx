import {useState} from 'react';
import type {FunctionPointReference} from '@pointercad/model';
import {FunctionPointDialog} from './FunctionPointDialog.js';
import {FunctionDirectionDialog} from './FunctionDirectionDialog.js';
import {t} from '../i18n/t.js';

export function FunctionPointProperties({pointId,reference}:{readonly pointId:string;readonly reference:FunctionPointReference}):React.JSX.Element {
  const [open,setOpen]=useState(false),[direction,setDirection]=useState(false);
  return <section className="pcad-section" data-help-topic="function-point">
    <h3 className="pcad-section__title">{t('functionPoint.base')}</h3><p>{t('functionPoint.follows')}</p>
    <dl>{reference.known.map(item=><div key={item.axis}><dt>{item.axis} (mm)</dt><dd>{item.value.source}</dd></div>)}</dl>
    <button type="button" onClick={()=>setOpen(true)}>{t('functionPoint.edit')}</button>
    {reference.direction===undefined?<button type="button" onClick={()=>setDirection(true)}>{t('functionDirection.title')}</button>:null}
    {open?<FunctionPointDialog parent={reference.parent} pointId={pointId} onClose={()=>setOpen(false)}/>:null}
    {direction?<FunctionDirectionDialog pointId={pointId} reference={reference} onClose={()=>setDirection(false)}/>:null}
  </section>;
}
