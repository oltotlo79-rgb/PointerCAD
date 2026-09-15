import {createMathWorkerGroup} from '../math/mathWorkerGroup.js';
import {createBrowserMathWorker} from '../math/browserMathWorker.js';
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import type {FunctionPointParent} from '@pointercad/model';
import type {PointCalculationCandidate} from '@pointercad/expression/math/contracts';
import {useAppStore} from '../store/useAppStore.js';
import {createBrowserMathClient} from '../math/createBrowserMathClient.js';
import {createBrowserFunctionPointClient} from '../math/createBrowserFunctionClient.js';
import {MathExpressionDialog} from '../math/MathExpressionDialog.js';
import {t} from '../i18n/t.js';
import {FUNCTION_AXES,editFunctionField} from './functionPlotDraft.js';
import {searchFunctionPoints,applyFunctionPointChoice,type FunctionPointFields,type FunctionPointSearch} from './functionPointDraft.js';
import './functionPlot.css';
import {FunctionPointPreview} from './FunctionPointPreview.js';

export function FunctionPointDialog({parent,pointId,onClose}:{readonly parent:FunctionPointParent;readonly pointId?:string;readonly onClose:()=>void}):React.JSX.Element {
  const owner=useRef(useAppStore.getState()).current,close=useRef(onClose).current,id=useId();
  const feature=parent.kind==='surface'?owner.document.solids.find(item=>item.id===parent.featureId)
    :owner.document.sketches.find(item=>item.id===parent.sketchId)?.features.find(item=>item.id===parent.featureId);
  const definition=feature?.kind==='functionCurve'||feature?.kind==='functionSurface'?feature.definition:undefined;
  const parentCurves=useMemo(()=>parent.kind==='curve'&&parent.sketchId===owner.sketch.id
    ?owner.resolvedSketch.splines.filter(curve=>curve.featureId===parent.featureId):[],[owner,parent]);
  const parentBody=parent.kind==='surface'?owner.bodies.find(body=>body.featureId===parent.featureId):undefined;
  const fixed=definition?.formula.kind==='implicit-curve'?definition.formula.fixedAxis:undefined;
  const parameterRanges=definition?.formula.kind==='parametric-curve'?[{name:'T',range:definition.formula.T}]
    :definition?.formula.kind==='parametric-surface'?[{name:'U',range:definition.formula.U},{name:'V',range:definition.formula.V}]:[];
  const previous=pointId===undefined?undefined:owner.document.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===pointId);
  const previousReference=previous?.kind==='point'&&previous.at.mode!=='absolute'&&previous.at.base.kind==='functionPoint'?previous.at.base:undefined;
  const [fields,setFields]=useState<FunctionPointFields>(()=>{
    const dependent=definition?.formula.kind==='coordinate-surface'?definition.formula.output:undefined;
    const available=FUNCTION_AXES.filter(axis=>axis!==fixed&&axis!==dependent);
    const first=definition?.formula.kind==='coordinate-curve'?definition.formula.independent:available[0],second=parent.kind==='surface'?available[1]:undefined;
    const field=(axis:typeof FUNCTION_AXES[number])=>{
      if(previousReference){const value=previousReference.known.find(item=>item.axis===axis)?.value;return value?{source:value.source,angleUnit:value.mathDefinition?.angleUnit??'degree',accepted:value}:null;}
      return axis===first||axis===second?{source:'',angleUnit:'degree' as const}:null;
    };
    return {X:field('X'),Y:field('Y'),Z:field('Z')};
  });
  const [prepared,setPrepared]=useState(owner.document),[search,setSearch]=useState<FunctionPointSearch|null>(null);
  const [selected,setSelected]=useState<PointCalculationCandidate|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [editor,setEditor]=useState<typeof FUNCTION_AXES[number]|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),running=useRef<AbortController|null>(null),mounted=useRef(true);
  const isCurrent=()=>mounted.current && useAppStore.getState().document===owner.document && useAppStore.getState().documentVersion===owner.documentVersion;
  useEffect(()=>{
    mounted.current=true;const element=dialog.current,previous=document.activeElement;element?.showModal();
    const unsubscribe=useAppStore.subscribe(state=>{if(state.document!==owner.document||state.documentVersion!==owner.documentVersion){running.current?.abort();close();}});
    return ()=>{mounted.current=false;running.current?.abort();unsubscribe();element?.close();if(previous instanceof HTMLElement&&previous.isConnected) previous.focus();};
  },[owner,close]);
  const change=(next:FunctionPointFields)=>{running.current?.abort();setFields(next);setBusy(false);setSearch(null);setSelected(null);setMessage('');};
  const calculate=async()=>{
    if(!isCurrent()||busy) return;
    const workers=createMathWorkerGroup(createBrowserMathWorker);
    const abort=new AbortController(),client=createBrowserMathClient(workers.createPort),points=createBrowserFunctionPointClient(workers.createPort);running.current=abort;
    const current=()=>isCurrent()&&!abort.signal.aborted&&running.current===abort;
    setBusy(true);setSearch(null);setSelected(null);setMessage('');
    try {
      const result=await searchFunctionPoints(prepared,owner.documentVersion,parent,fields,client,points,abort.signal,current);
      if(!current()||result.status==='cancelled') return;
      if(result.status==='failed') setMessage(result.message);else {
        setSearch(result.search);
        if(result.search.exhaustive&&result.search.unresolved===0&&result.search.candidates.length===1) setSelected(result.search.candidates[0]);
      }
    }catch(error){if(current()) setMessage(error instanceof Error?error.message:t('math.workerFailed'));}
    finally{client.dispose();points.dispose();workers.dispose();if(running.current===abort){running.current=null;if(mounted.current)setBusy(false);}}
  };
  const input=editor===null?null:fields[editor];
  const coordinateCount=FUNCTION_AXES.filter(axis=>fields[axis]!==null).length;
  return <>
    <dialog ref={dialog} className="pcad-function-dialog" aria-labelledby={`${id}-title`} data-help-topic="function-point" onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>event.stopPropagation()}>
      <h2 id={`${id}-title`}>{t('functionPoint.title')}</h2><p>{feature?.name}</p><p>{t('functionPoint.hint')}</p>
      {definition?<dl>{FUNCTION_AXES.map(axis=><div key={axis}><dt>{axis} (mm)</dt><dd>{definition.bounds[axis].min.source}{t('display.rangeSeparator')}{definition.bounds[axis].max.source}</dd></div>)}</dl>:null}
      {parameterRanges.length>0?<fieldset><legend>{t('functionPoint.parameter')}</legend><dl>{parameterRanges.map(({name,range})=>
        <div key={name}><dt>{name}</dt><dd>{range.min.source}{t('display.rangeSeparator')}{range.max.source}</dd></div>)}</dl></fieldset>:null}
      <form onSubmit={event=>{event.preventDefault();void calculate();}}>
        <fieldset disabled={busy}><legend>{t('functionPoint.known')}</legend>
          {FUNCTION_AXES.filter(axis=>axis!==fixed).map(axis=>{
            const field=fields[axis];return <div className="pcad-function-field" key={axis}>
              <label><input title={t('functionPlot.control.knownAxis')} type="checkbox" checked={field!==null} disabled={field===null&&coordinateCount>=2} onChange={event=>change({...fields,[axis]:event.target.checked?{source:'',angleUnit:'degree'}:null})}/>{axis} (mm)</label>
              {field===null?null:<><input title={t('functionPlot.control.knownCoordinate')} aria-label={`${axis} ${t('functionPoint.coordinate')}`} required value={field.source} onChange={event=>change({...fields,[axis]:editFunctionField(field,event.target.value)})}/>
                <button title={t('functionPlot.control.mathEditor')} type="button" aria-label={`${axis}: ${t('math.open')}`} onClick={()=>setEditor(axis)}>ƒ</button></>}
            </div>;
          })}
          {fixed&&definition?.formula.kind==='implicit-curve'?<p>{fixed} = {definition.formula.fixedCoordinate.source} mm</p>:null}
          {coordinateCount===2&&!fixed?<p>{t('functionPoint.twoCoordinates')}</p>:null}
        </fieldset>
        {message?<p role="alert">{message}</p>:null}
        {busy?<p role="status">{t('functionPoint.calculating')}</p>:null}
        {search?<fieldset><legend>{t('functionPoint.candidates')} ({search.candidates.length})</legend>
          {search.candidates.length===0&&search.exhaustive?<p>{t('functionPoint.empty')}</p>:search.candidates.map((candidate,index)=><label key={index} className="pcad-function-point-choice">
            <input title={t('functionPlot.control.pointCandidate')} type="radio" name={`${id}-candidate`} checked={selected===candidate} onChange={()=>setSelected(candidate)}/>
            {index+1}: {candidate.point.map((value,axis)=>`${FUNCTION_AXES[axis]} = ${String(value)}`).join(', ')} mm
            {candidate.location.kind==='curve'&&candidate.location.independent==='T'?<span> — {t('functionPoint.parameter')}: T = {candidate.location.interval.lower}{t('display.rangeSeparator')}{candidate.location.interval.upper}</span>:null}
            {candidate.location.kind==='parametric-surface'?<span> — {t('functionPoint.parameter')}: {candidate.location.box.map((range,axis)=>`${axis===0?'U':'V'} = ${range.lower}${t('display.rangeSeparator')}${range.upper}`).join(', ')}</span>:null}
          </label>)}
          {!search.exhaustive?<p role="status">{t('functionPoint.partial')} ({search.unresolved})</p>:null}
        </fieldset>:null}
        {search&&search.candidates.length>0?<FunctionPointPreview minimum={search.request.minimum} maximum={search.request.maximum}
          body={parentBody} curves={parentCurves} candidates={search.candidates} selected={selected} onSelect={setSelected}/>:null}
        <div className="pcad-function-actions">
          <button title={t('functionPlot.control.cancelPoint')} type="button" onClick={close}>{t('math.cancel')}</button>
            {busy?<button title={t('functionPlot.control.stopPoint')} type="button" onClick={()=>{running.current?.abort();setBusy(false);}}>{t('functionPlot.stop')}</button>:<button title={t('functionPlot.control.searchPoint')} type="submit" disabled={coordinateCount===0}>{t('functionPoint.search')}</button>}
            <button title={t('functionPlot.control.applyPoint')} type="button" disabled={busy||!search||!selected||!search.exhaustive||search.unresolved!==0} onClick={()=>{
            if(!isCurrent()||busy||!search||!selected)return;
            try{useAppStore.getState().applyDocument(applyFunctionPointChoice(search,selected,pointId));close();}
            catch(error){setMessage(error instanceof Error?error.message:t('functionPoint.changedChoice'));}
          }}>{t(pointId===undefined?'functionPoint.apply':'functionPoint.update')}</button>
        </div>
      </form>
    </dialog>
    {editor&&input?<MathExpressionDialog document={prepared} documentVersion={owner.documentVersion} isCurrent={isCurrent} onClose={()=>setEditor(null)}
      unitLabel="mm" initialAngleUnit={input.angleUnit} initialValue={input.accepted??{...number(0),source:input.source}}
      onApply={(value,document,signal)=>{
        if(!isCurrent()||signal.aborted)return Promise.resolve({ok:false,message:t('math.operation.cancelled')});
        setPrepared(document);change({...fields,[editor]:{source:value.source,angleUnit:value.mathDefinition?.angleUnit??input.angleUnit,accepted:value}});
        return Promise.resolve({ok:true});
      }}/>:null}
  </>;
}
