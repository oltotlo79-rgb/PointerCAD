/** Controlled editor view. The controller owns text, generations, calculation, and acceptance. */
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {attachMathField,type StructuredMathField} from './mathFieldHost.js';
import {searchMathPalette,type MathPaletteGroup,type MathPaletteItem} from './mathPalette.js';
import type {MathEditorInput} from './mathEditorSession.js';

export interface MathEditorViewController {
  readonly current:()=>MathEditorInput;
  readonly isCurrent:()=>boolean;
  readonly sourceChanged:(source:string)=>void;
  readonly apply:()=>void;
  readonly cancel:()=>void;
  readonly sourceLimit:()=>void;
  readonly moveOut:(direction:'forward'|'backward')=>void;
  /** Registers the mounted input. Cleanup must release only its own registration. */
  readonly bindInsertion:(insert:(latex:string)=>boolean)=>()=>void;
  /** If text mode is active, conversion must verify AST equivalence before inserting a LaTeX template. */
  readonly insert:(template:string)=>void;
  readonly requestNotation:(notation:'text'|'latex')=>void;
  readonly changeAngleUnit:(unit:'degree'|'radian')=>void;
}
export interface MathEditorControlHints {
  readonly text:string;readonly structured:string;readonly angleUnit:string;readonly category:string;
  readonly search:string;readonly apply:string;readonly cancel:string;readonly help:string;
}
export interface MathEditorLabels {
  readonly hints:MathEditorControlHints;
  readonly title:string;readonly text:string;readonly structured:string;readonly input:string;readonly angleUnit:string;
  readonly degree:string;readonly radian:string;readonly palette:string;readonly search:string;readonly noSymbols:string;
  readonly apply:string;readonly cancel:string;readonly help:string;readonly keyboardHint:string;readonly sourceTooLong:string;
  readonly category:string;readonly allCategories:string;readonly categories:Readonly<Record<MathPaletteGroup,string>>;
}
export interface MathInsertChoice {
  readonly id:string;readonly label:string;readonly meaning:string;readonly template:string;
}
export interface MathInsertGroup {
  readonly id:'axes'|'parameters'|'coefficients'|'constants';readonly label:string;readonly choices:readonly MathInsertChoice[];
}
export interface MathEditorSurfaceProps {
  readonly input:MathEditorInput;readonly controller:MathEditorViewController;
  readonly createField:()=>StructuredMathField;readonly labels:MathEditorLabels;
  readonly groups:readonly MathInsertGroup[];readonly palette:readonly MathPaletteItem[];
  readonly query:string;readonly onQuery:(query:string)=>void;
  readonly resultActions?:React.ReactNode;
  readonly resultMessage:string;readonly resultDetail:string;readonly hasError:boolean;readonly busy:boolean;
  readonly canApply:boolean;readonly canChangeNotation:boolean;readonly readOnly:boolean;
  readonly onHelp:()=>void;readonly maximumSourceLength:number;
}

function StructuredField({input,controller,createField,readOnly,maximumSourceLength,label,descriptionId,hint}:{
  readonly input:MathEditorInput;readonly controller:MathEditorViewController;readonly createField:()=>StructuredMathField;
  readonly readOnly:boolean;readonly maximumSourceLength:number;readonly label:string;readonly descriptionId:string;readonly hint:string;
}):React.JSX.Element {
  const container=useRef<HTMLDivElement>(null),binding=useRef<ReturnType<typeof attachMathField>|null>(null);
  // A layout effect, so that React runs the cleanup (dispose, which blurs the field) before it removes the
  // dialog's DOM. A passive cleanup ran after the removal: MathLive had already disposed the field in its
  // disconnectedCallback, blur() did nothing, and in Firefox (no blur event on removal) the next structured
  // field's focus() threw inside MathLive and React unmounted the app (ADD-17 and MC-27d, 2026-09-24).
  useLayoutEffect(()=>{
    if(container.current===null)return;
    const field=attachMathField(container.current,createField,{label,describedBy:descriptionId,
      initialSource:controller.current().source,maximumSourceLength,isCurrent:controller.isCurrent,
      onInput:controller.sourceChanged,onApply:source=>{controller.sourceChanged(source);controller.apply();},
      onCancel:controller.cancel,onMoveOut:controller.moveOut,onSourceLimit:controller.sourceLimit});
    field.element.title=hint;
    binding.current=field;
    const detach=controller.bindInsertion(field.insertTemplate);
    field.element.focus();
    return()=>{detach();field.dispose();binding.current=null;};
  },[controller,createField,maximumSourceLength,label,descriptionId,hint]);
  useEffect(()=>{binding.current?.updateSource(input.source);},[input.source]);
  useEffect(()=>{binding.current?.setReadOnly(readOnly);},[readOnly]);
  return <div className="pcad-math-editor__structured" ref={container}/>;
}

export function MathEditorSurface(props:MathEditorSurfaceProps):React.JSX.Element {
  const id=useId(),messageId=`${id}-message`,hintId=`${id}-hint`,textRef=useRef<HTMLTextAreaElement>(null);
  const {input,controller,labels}=props;
  const [category,setCategory]=useState<MathPaletteGroup|'all'>('all');
  const categories=[...new Set(props.palette.map(item=>item.group))];
  // The loading dialog initially focuses its cancel button. Replacing that button
  // must move focus into the ready input, so immediate typing/F1 stays in this dialog.
  useEffect(()=>{if(input.notation==='text')textRef.current?.focus();},[input.notation]);
  const palette=searchMathPalette(props.query,props.palette.filter(item=>category==='all'||item.group===category));
  const editingBlocked=props.readOnly;
  return <section className="pcad-math-editor" aria-labelledby={`${id}-title`}>
    <header className="pcad-math-editor__header"><h3 id={`${id}-title`}>{labels.title}</h3>
      <button type="button" className="pcad-button" onClick={props.onHelp} title={labels.hints.help}>{labels.help}</button>
    </header>
    <div className="pcad-math-editor__options">
      <div role="group" aria-label={labels.input}>
        <button type="button" title={labels.hints.text} aria-pressed={input.notation==='text'} disabled={!props.canChangeNotation||editingBlocked}
          onClick={()=>controller.requestNotation('text')}>{labels.text}</button>
        <button type="button" title={labels.hints.structured} aria-pressed={input.notation==='latex'} disabled={!props.canChangeNotation||editingBlocked}
          onClick={()=>controller.requestNotation('latex')}>{labels.structured}</button>
      </div>
      <label><span id={`${id}-angle-label`}>{labels.angleUnit}</span><select title={labels.hints.angleUnit} aria-labelledby={`${id}-angle-label`} value={input.angleUnit} disabled={editingBlocked}
        onChange={event=>controller.changeAngleUnit(event.currentTarget.value==='degree'?'degree':'radian')}>
        <option value="degree">{labels.degree}</option><option value="radian">{labels.radian}</option>
      </select></label>
    </div>
    <div className="pcad-math-editor__expression" aria-busy={props.busy}>
      {input.notation==='latex'?<StructuredField input={input} controller={controller} createField={props.createField}
        readOnly={editingBlocked} maximumSourceLength={props.maximumSourceLength} label={labels.input} descriptionId={`${messageId} ${hintId}`} hint={labels.keyboardHint}/>
        :<label>{labels.input}<textarea title={labels.keyboardHint} ref={textRef} value={input.source} spellCheck={false} readOnly={editingBlocked}
          aria-invalid={props.hasError} aria-describedby={`${messageId} ${hintId}`}
          onChange={event=>controller.sourceChanged(event.currentTarget.value)}
          onKeyDown={event=>{
            if(event.nativeEvent.isComposing||event.keyCode===229)return;
            if(event.key==='Enter') {
              event.stopPropagation();
              if(event.ctrlKey||event.metaKey){event.preventDefault();if(!editingBlocked)controller.apply();}
            }else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();controller.cancel();}
          }}/></label>}
    </div>
    <p id={hintId} className="pcad-math-editor__hint">{labels.keyboardHint}</p>
    <div className="pcad-math-editor__symbols">
      {props.groups.map(group=><fieldset key={group.id}><legend>{group.label}</legend>
        {group.choices.map(choice=><button type="button" key={choice.id} disabled={editingBlocked} title={choice.meaning}
          onClick={()=>controller.insert(choice.template)}>{choice.label}</button>)}
      </fieldset>)}
    </div>
    <details className="pcad-math-editor__palette"><summary>{labels.palette}</summary>
      <label><span id={`${id}-category-label`}>{labels.category}</span><select title={labels.hints.category} aria-labelledby={`${id}-category-label`} value={category} onChange={event=>{
        const value=event.currentTarget.value;
        setCategory(categories.find(group=>group===value)??'all');
      }}><option value="all">{labels.allCategories}</option>
        {categories.map(group=><option value={group} key={group}>{labels.categories[group]}</option>)}
      </select></label>
      <label>{labels.search}<input title={labels.hints.search} type="search" value={props.query} onChange={event=>props.onQuery(event.currentTarget.value)}
        autoComplete="off" spellCheck={false}/></label>
      {palette.length===0?<p>{labels.noSymbols}</p>:<ul>{palette.map(item=><li key={item.id}>
        <button type="button" disabled={editingBlocked} title={item.meaning} onClick={()=>controller.insert(item.template)}>
          <span aria-hidden="true">{item.symbol}</span> {item.label}
        </button><span className="pcad-math-editor__meaning">{item.meaning}</span>
      </li>)}</ul>}
    </details>
    <div id={messageId} className={props.hasError?'pcad-math-editor__result pcad-math-editor__result--error':'pcad-math-editor__result'}
      role="status" aria-live="polite" aria-atomic="true"><p>{props.resultMessage}</p>
      {props.resultDetail===''?null:<p>{props.resultDetail}</p>}</div>
    {props.resultActions}
    <footer className="pcad-math-editor__actions">
      <button type="button" className="pcad-button" title={labels.hints.cancel} onClick={controller.cancel}>{labels.cancel}</button>
      <button type="button" className="pcad-button pcad-button--primary" title={labels.hints.apply} disabled={!props.canApply||editingBlocked} onClick={controller.apply}>{labels.apply}</button>
    </footer>
  </section>;
}
