import {createMathWorkerGroup} from '../math/mathWorkerGroup.js';
import {createBrowserMathWorker} from '../math/browserMathWorker.js';
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import type {FunctionPointReference} from '@pointercad/model';
import type {FunctionPointDirectionKind} from '@pointercad/expression/math/contracts';
import {useAppStore} from '../store/useAppStore.js';
import {createBrowserMathClient} from '../math/createBrowserMathClient.js';
import {createBrowserFunctionPointClient,createBrowserFunctionPointContinuationClient} from '../math/createBrowserFunctionClient.js';
import {MathExpressionDialog} from '../math/MathExpressionDialog.js';
import {evaluateFunctionDirection,functionDirectionKinds,type FunctionDirectionPreview} from './functionDirectionDraft.js';
import {editFunctionField,type FunctionScalarDraft} from './functionPlotDraft.js';
import {t} from '../i18n/t.js';
import {FunctionPointPreview} from './FunctionPointPreview.js';
import './functionPlot.css';

export function FunctionDirectionDialog({pointId,reference,onClose,lineId}:{readonly pointId:string;readonly reference:FunctionPointReference;readonly onClose:()=>void;readonly lineId?:string}):React.JSX.Element {
  const owner=useRef(useAppStore.getState()).current,close=useRef(onClose).current,id=useId(),dialog=useRef<HTMLDialogElement>(null);
  const kinds=functionDirectionKinds(reference.choice.input);
  const input=reference.choice.input;
  const normalHint='kind' in input?(input.kind==='parametric-surface'?'functionDirection.surfaceHint':'functionDirection.normalHint'):'functionDirection.implicitHint';
  const initial=reference.direction;
  const [kind,setKind]=useState<FunctionPointDirectionKind>(initial?.kind??kinds[0]),[length,setLength]=useState<FunctionScalarDraft>(initial
    ?{source:initial.length.source,angleUnit:initial.length.mathDefinition?.angleUnit??'degree',accepted:initial.length}:{source:'10',angleUnit:'degree'});
  const [reverse,setReverse]=useState(initial?.reverse??false),[prepared,setPrepared]=useState(owner.document),[preview,setPreview]=useState<FunctionDirectionPreview|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[editor,setEditor]=useState(false);
  const running=useRef<AbortController|null>(null),mounted=useRef(true);
  const parent=reference.parent;
  const parentCurves=useMemo(()=>prepared===owner.document&&parent.kind==='curve'&&parent.sketchId===owner.sketch.id
    ?owner.resolvedSketch.splines.filter(curve=>curve.featureId===parent.featureId):[],[owner,parent,prepared]);
  const parentBody=prepared===owner.document&&parent.kind==='surface'?owner.bodies.find(body=>body.featureId===parent.featureId):undefined;
  const isCurrent=()=>mounted.current&&useAppStore.getState().document===owner.document&&useAppStore.getState().documentVersion===owner.documentVersion;
  useEffect(()=>{
    mounted.current=true;const element=dialog.current,previous=document.activeElement;element?.showModal();
    const unsubscribe=useAppStore.subscribe(state=>{if(state.document!==owner.document||state.documentVersion!==owner.documentVersion){running.current?.abort();close();}});
    return()=>{mounted.current=false;running.current?.abort();unsubscribe();element?.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  },[owner,close]);
  const invalidate=()=>{running.current?.abort();setBusy(false);setPreview(null);setMessage('');};
  const calculate=async()=>{
    if(!isCurrent()||busy)return;
    const workers=createMathWorkerGroup(createBrowserMathWorker);
    const abort=new AbortController(),client=createBrowserMathClient(workers.createPort),points=createBrowserFunctionPointClient(workers.createPort),continuations=createBrowserFunctionPointContinuationClient(workers.createPort);
    running.current=abort;setBusy(true);setPreview(null);setMessage('');
    const current=()=>isCurrent()&&!abort.signal.aborted&&running.current===abort;
    try{const result=await evaluateFunctionDirection(prepared,owner.documentVersion,pointId,kind,length,reverse,client,points,continuations,abort.signal,current,lineId);
      if(current()&&result)setPreview(result);
    }catch(error){if(current())setMessage(error instanceof Error?error.message:t('math.workerFailed'));}
    finally{client.dispose();points.dispose();continuations.dispose();workers.dispose();if(running.current===abort){running.current=null;if(mounted.current)setBusy(false);}}
  };
  return <><dialog ref={dialog} className="pcad-function-dialog" aria-labelledby={`${id}-title`} data-help-topic="function-point"
    onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>event.stopPropagation()}>
    <h2 id={`${id}-title`}>{t(lineId?'functionDirection.edit':'functionDirection.title')}</h2><p>{t('functionDirection.hint')}</p>
    <form onSubmit={event=>{event.preventDefault();void calculate();}}>
      <fieldset disabled={busy}><legend>{t('functionDirection.kind')}</legend>{kinds.map(value=><label key={value} className="pcad-function-point-choice">
        <input title={t('functionPlot.control.directionKind')} type="radio" name={`${id}-kind`} checked={kind===value} onChange={()=>{invalidate();setKind(value);}}/>{t(`functionDirection.${value}`)}
      </label>)}</fieldset>
      <fieldset disabled={busy}><legend>{t('functionDirection.length')}</legend><div className="pcad-function-field">
        <input title={t('functionPlot.control.directionLength')} aria-label={t('functionDirection.length')} required value={length.source} onChange={event=>{invalidate();setLength(editFunctionField(length,event.target.value));}}/>
        <button title={t('functionPlot.control.mathEditor')} type="button" aria-label={`${t('functionDirection.length')}: ${t('math.open')}`} onClick={()=>setEditor(true)}>ƒ</button>
      </div><label><input title={t('functionPlot.control.reverseDirection')} type="checkbox" checked={reverse} onChange={event=>{invalidate();setReverse(event.target.checked);}}/>{t('functionDirection.reverse')}</label></fieldset>
      <p>{t(normalHint)}</p>
      {message?<p role="alert">{message}</p>:null}{busy?<p role="status">{t('functionDirection.calculating')}</p>:null}
      {preview?<section aria-label={t('functionDirection.result')}><p role="status">{t('functionDirection.ready')}</p><dl>
        <dt>{t('functionDirection.from')}</dt><dd>{preview.from.map((value,axis)=>`${['X','Y','Z'][axis]} = ${value}`).join(', ')} mm</dd>
        <dt>{t('functionDirection.to')}</dt><dd>{preview.to.map((value,axis)=>`${['X','Y','Z'][axis]} = ${value}`).join(', ')} mm</dd>
      </dl>{prepared!==owner.document?<p>{t('functionDirection.lineOnly')}</p>:null}<FunctionPointPreview minimum={preview.minimum} maximum={preview.maximum} body={parentBody} curves={parentCurves}
        candidates={[]} selected={null} onSelect={()=>undefined} direction={preview}/></section>:null}
      <div className="pcad-function-actions"><button title={t('functionPlot.control.cancelDirection')} type="button" onClick={close}>{t('math.cancel')}</button>
        {busy?<button title={t('functionPlot.control.stopDirection')} type="button" onClick={invalidate}>{t('functionPlot.stop')}</button>:<button title={t('functionPlot.control.previewDirection')} type="submit">{t('functionDirection.preview')}</button>}
        <button title={t('functionPlot.control.applyDirection')} type="button" disabled={busy||!preview} onClick={()=>{if(isCurrent()&&!busy&&preview){useAppStore.getState().applyDocument(preview.document);close();}}}>{t(lineId?'functionDirection.update':'functionDirection.apply')}</button>
      </div>
    </form>
  </dialog>{editor?<MathExpressionDialog document={prepared} documentVersion={owner.documentVersion} isCurrent={isCurrent}
    initialAngleUnit={length.angleUnit} initialValue={length.accepted??{...number(0),source:length.source}} unitLabel="mm" onClose={()=>setEditor(false)}
    onApply={(value,document,signal)=>{if(!isCurrent()||signal.aborted)return Promise.resolve({ok:false,message:t('math.operation.cancelled')});
      invalidate();setPrepared(document);setLength({source:value.source,angleUnit:value.mathDefinition?.angleUnit??length.angleUnit,accepted:value});return Promise.resolve({ok:true});}}/>:null}</>;
}
