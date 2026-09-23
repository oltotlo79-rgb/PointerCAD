import { compareDocuments } from '../diff/compareDocuments.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectMathCoefficients, expressionValueFromNumber, type StoredMathExpression } from '@pointercad/expression';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, MATH_INPUT_FORMAT } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createEmptyPartDocument } from './createPartDocument.js';
import { readUnresolvedMathProblems, setUnresolvedMathProblem, removeUnresolvedMathProblem } from './unresolvedMathProblems.js';
import { affectsShape } from './documentChange.js';
import { collectExpressionOwners, collectExpressionSources } from './reevaluatePart.js';
import { prepareDocumentMathIdentity } from './documentMathIdentity.js';
import { renameDocumentMathParameter } from './renameDocumentMathParameter.js';
import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import type { PartDocument } from './types.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend=createMathBackend(); });
const plain='pde([diff(u,t)=diff(u,x,x)],[x,t],[u],[[u,[0,t],0]])';
const coefficient='pde([diff(u,t)=coef("a")*diff(u,x,x)],[x,t],[u],[[u,[0,t],coef("a")]])';
const coefficients=[{id:'coefficient:7',label:'a',decimal:'2'}];
const identity={documentId:'problem',documentVersion:1,editorId:'problem',inputRevision:1};
function calculate(request: MathWorkRequest) {
  return decodeMathWorkReply(executeMathWorkRequest({kind:'evaluate-math',serial:1,request},backend),request,
    {operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(request.coefficients.map(value=>value.id)),declaredIds:new Set()}).result;
}
function definition(source=plain): StoredMathExpression {
  const raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:{identity,source,notation:'text',angleUnit:'degree',coefficients}},backend);
  if(raw.expression===null) throw new Error(JSON.stringify(raw.evaluation));
  return {format:MATH_INPUT_FORMAT,source,inputNotation:'text',angleUnit:'degree',expression:raw.expression};
}
function problem(source=plain) { return {id:'math-problem:1',name:'熱の式',status:'unresolved' as const,definition:definition(source)}; }
function context(document:PartDocument):DocumentMathContext {
  return {identity:{documentId:document.id,documentVersion:1},isCurrent:()=>true,
    client:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,result:calculate(request)})}};
}

describe('未解決の式は数値や形状に変えず、文書の式と条件として扱う',()=>{
  it('追加・編集・削除は文書の写しだけを変え、形の再計算を起こさない',()=>{
    const original=createEmptyPartDocument(), first=setUnresolvedMathProblem(original,problem());
    const replacement=problem(plain.replace('[0,t],0','[0,t],3'));
    const edited=setUnresolvedMathProblem(first,replacement), deleted=removeUnresolvedMathProblem(edited,replacement.id);
    expect(original.unresolvedMathProblems).toBeUndefined();
    expect(first.unresolvedMathProblems?.[0].definition.source).toBe(plain);
    expect(edited.unresolvedMathProblems).toEqual([replacement]);
    expect(deleted.unresolvedMathProblems).toEqual([]);
    expect(removeUnresolvedMathProblem(first,'math-problem:absent')).toBe(first);
    for(const document of [first,edited,deleted]) expect(affectsShape(original,document)).toBe(false);
    expect(JSON.stringify(first.unresolvedMathProblems)).not.toContain('"value":');
  });
  it('係数の利用元を式の名前付きで列挙し、削除済みの識別番号も再利用しない',()=>{
    const saved=setUnresolvedMathProblem(createEmptyPartDocument(),problem(coefficient));
    expect(collectExpressionSources(saved)).toContain(coefficient);
    expect(collectExpressionOwners(saved)).toContainEqual({source:coefficient,ownerId:'math-problem:1',ownerName:'熱の式',mathDefinition:problem(coefficient).definition});
    const prepared=prepareDocumentMathIdentity({...saved,parameters:[{name:'new',value:expressionValueFromNumber(1),unit:'none',description:''}]});
    expect(prepared.parameters[0].mathId).toBe('coefficient:8');
  });
  it('係数の改名では元の式・条件の参照を共に更新し、局所変数と未解決状態を保つ',async()=>{
    const saved=setUnresolvedMathProblem(createEmptyPartDocument(),problem(coefficient));
    const document:PartDocument={...saved,mathParameterSerial:7,parameters:[{name:'a',mathId:'coefficient:7',value:expressionValueFromNumber(2),unit:'none',description:''}]};
    const checked=await evaluateDocumentMath(document,context(document));
    if(!checked.ok) throw new Error(JSON.stringify(checked.failures));
    expect(checked.analysis.unused).not.toContain('a');
    const renamed=await renameDocumentMathParameter(document,'a','熱拡散',context(document));
    if(!renamed.ok) throw new Error(renamed.message);
    const entry=renamed.document.unresolvedMathProblems?.[0];
    if(entry===undefined) throw new Error('保存した式が消えました。');
    expect(entry.status).toBe('unresolved');
    expect(entry.definition.source).toContain('熱拡散');
    expect(collectMathCoefficients(entry.definition.expression)).toEqual([{role:'coefficient',id:'coefficient:7',label:'熱拡散'}]);
    expect(entry.definition.expression.kind==='operation' && entry.definition.expression.operation).toBe('partial-equations');
    expect(document.unresolvedMathProblems?.[0].definition.source).toBe(coefficient);
  });
  it('数値・解決済み・重複・壊れた条件・上限超過を保存しない',()=>{
    const valid=problem();
    for(const value of [null,{},[{...valid,status:'value'}],[{...valid,value:0}],[valid,valid],
      [{...valid,definition:definition('0')}],[{...valid,name:''}],Array.from({length:129},(_,index)=>({...valid,id:`math-problem:${index}`}))]) {
      expect(()=>readUnresolvedMathProblems(value)).toThrow();
    }
    const expression=valid.definition.expression;
    if(expression.kind!=='operation') throw new Error('式の種類が違います。');
    expect(()=>readUnresolvedMathProblems([{...valid,definition:{...valid.definition,expression:{...expression,operands:[]}}}])).toThrow();
  });
  it('追加・条件編集・削除を文書比較へ式の名前付きで表示する',()=>{
    const empty=createEmptyPartDocument(), saved=setUnresolvedMathProblem(empty,problem());
    const edited=setUnresolvedMathProblem(saved,problem(plain.replace('[0,t],0','[0,t],3')));
    const options={relationship:'versions' as const,beforeAttachmentsDigest:'same',afterAttachmentsDigest:'same'};
    const changes=(before:PartDocument,after:PartDocument)=>compareDocuments(before,after,options).changes;
    expect(changes(empty,saved)).toMatchObject([{group:'math-problem',status:'added',afterName:'熱の式'}]);
    const changed=changes(saved,edited);
    expect(changed).toMatchObject([{group:'math-problem',status:'changed',beforeName:'熱の式',afterName:'熱の式'}]);
    expect(changed[0].differences.some(value=>value.path.includes('source'))).toBe(true);
    expect(changes(saved,empty)).toMatchObject([{group:'math-problem',status:'removed',beforeName:'熱の式'}]);
  });
  it('読取り時に処理を呼ぶ保存項目を拒否し、コードを実行しない',()=>{
    let calls=0;
    const valid=problem(), source=Object.defineProperty({...valid.definition},'source',{get:()=>{calls++;return plain;}});
    expect(()=>readUnresolvedMathProblems([{...valid,definition:source}])).toThrow();
    expect(calls).toBe(0);
  });
});
