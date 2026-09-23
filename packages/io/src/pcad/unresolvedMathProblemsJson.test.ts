import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, setUnresolvedMathProblem, type AssemblyDocument, type UnresolvedMathProblem } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile, readPcadaFile, writePcadaFile } from './pcadFile.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';
import { isRecord } from './guards.js';

type Node = UnresolvedMathProblem['definition']['expression'];
const op = (operation: string, ...operands: Node[]): Node => ({kind:'operation',operation,operands});
const number = (decimal: string): Node => ({kind:'number',decimal});
const variables = ['x','t','u'].map((label,index)=>({role:'bound' as const,id:`bound:${index+1}`,label}));
const [x,t,u] = variables.map((reference):Node=>({kind:'symbol',reference}));
function sample() {
  const source='pde([diff(u,t)=diff(u,x,x)],[x,t],[u],[[u,[0,t],3]])';
  // The file boundary verifies the complete structure independently of the parser/worker.
  const expression=op('partial-equations',{kind:'binder',operation:'lambda',
    bindings:variables.map(variable=>({variable,domain:{kind:'unrestricted'}})),
    body:op('list',op('list',op('equal',op('differentiate',u,t),op('differentiate',u,x,x))),
      op('list',op('list',u,op('list',number('0'),t),number('3'))))},number('2'));
  return setUnresolvedMathProblem(createEmptyPartDocument(),{id:'math-problem:1',name:'未解決の熱の式',status:'unresolved',
    definition:{format:'pointercad-math/1',source,inputNotation:'text',angleUnit:'degree',expression}});
}
function envelope() {
  const raw:unknown=JSON.parse(serializeDocument(sample()));
  if(!isRecord(raw) || !isRecord(raw.document)) throw new Error('部品文書ではありません。');
  return {root:raw,body:raw.document};
}
describe('未解決の式と条件を版16の実ファイルに保存する',()=>{
  it('圧縮した部品ファイルを開き直して原式・条件・未解決状態を全て保持する',()=>{
    const original=sample(), decoded=readPcadFile(writePcadFile(original));
    if(!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.document).toEqual(original);
    expect(decoded.document.unresolvedMathProblems).not.toBe(original.unresolvedMathProblems);
  });
  it('組立に含まれる部品でも保存した式を欠落させない',async()=>{
    const original=sample(), savedAt='2026-09-23T00:00:00Z';
    const assembly:AssemblyDocument={...createAssemblyDocument('式付き部品'),components:[{
      id:'component-1',name:'式付き',source:{kind:'part',partRef:'part-1'},placement:DEFAULT_COMPONENT_PLACEMENT,fixed:true,visible:true,suppressed:false}]};
    const bytes=await writePcadaFile(assembly,{savedAt,parts:new Map([['part-1',original]]),partFiles:[{
      ref:'part-1',fileName:'式付き.pcad',path:'式付き.pcad',contentHash:'fixture',importedAt:savedAt}]});
    const decoded=await readPcadaFile(bytes);if(!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.parts.get('part-1')).toEqual(original);
  });
  it('版15は式を捏造せず、既存の形と数値を保持して移行する',()=>{
    const {root,body}=envelope();root.schema=15;body.schemaVersion=15;delete body.unresolvedMathProblems;
    const decoded=parseDocument(JSON.stringify(root));if(!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(decoded.document.unresolvedMathProblems).toBeUndefined();
    expect(decoded.document.sketches).toEqual(sample().sketches);
  });
  it.each([15,16])('版%sの不正な保存項目を読み捨てて成功にしない',version=>{
    const {root,body}=envelope();root.schema=version;body.schemaVersion=version;
    for(const invalid of [null,{},[{id:'math-problem:1',name:'式',status:'value',value:0}]]) {
      body.unresolvedMathProblems=invalid;
      expect(parseDocument(JSON.stringify(root))).toMatchObject({ok:false});
    }
  });
});
