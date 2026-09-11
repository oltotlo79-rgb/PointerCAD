import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendFeature, absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { addSketch, createEmptyPartDocument, createSketchFor, replaceSketch } from '../part/createPartDocument.js';
import { applyScriptCommands } from './scriptCommands.js';
import { createScriptSnapshot } from './scriptSnapshot.js';
import type { ScriptCommand } from './scriptTypes.js';
import type { PartDocument } from '../part/types.js';

const stack='at <eval> (user-script.js:1:1)', sources=new Map([['user-script.js','console.log(42);']]);
const fields: Extract<ScriptCommand,{readonly kind:'solid.box'}>['fields']={origin:['0','0','0'],axis:'z',x:'10',y:'20',z:'30'};
function box(id: string, x='10'): ScriptCommand {return {kind:'solid.box',resultId:id,callStack:stack,fields:{...fields,x}};}
describe('スクリプト命令から不可変のCAD定義を作る',()=>{
  it('寸法の式と座標を保持し、元文書の定義を変えない',()=>{
    const initial=createEmptyPartDocument();
    const document:PartDocument={...initial,parameters:[{name:'厚み',value:expressionValueFromNumber(3),unit:'mm',description:''}]};
    const result=applyScriptCommands(document,[box('run:1','厚み*2')],new Map(),'run','mm',sources);
    expect(result.ok).toBe(true);if(!result.ok)return;
    expect(document.solids).toEqual([]);
    expect(result.document.solids[0]).toMatchObject({kind:'primitive',shape:{kind:'box',sizeX:{source:'厚み*2',value:6}}});
  });
  it('途中の未知の式で全体を断り、部分的な文書を返さない',()=>{
    const document=createEmptyPartDocument();
    const result=applyScriptCommands(document,[box('run:1'),box('run:2','未知')],new Map(),'run','mm',sources);
    expect(result.ok).toBe(false);expect(document.solids).toHaveLength(0);expect('document' in result).toBe(false);
  });
  it('パラメータを変更すると既存の立体の式が追い、循環は拒否する',()=>{
    const initial=createEmptyPartDocument();
    const commands:ScriptCommand[]=[{kind:'parameter.set',resultId:null,callStack:stack,fields:{name:'厚み',source:'3',unit:'mm'}},box('run:1','厚み*2'),
      {kind:'parameter.set',resultId:null,callStack:stack,fields:{name:'厚み',source:'5',unit:null}}];
    const result=applyScriptCommands(initial,commands,new Map(),'run','mm',sources);expect(result.ok).toBe(true);if(!result.ok)return;
    expect(result.document.solids[0]).toMatchObject({shape:{sizeX:{source:'厚み*2',value:10}}});
    const circular:ScriptCommand={kind:'parameter.set',resultId:null,callStack:stack,fields:{name:'厚み',source:'厚み+1',unit:null}};
    expect(applyScriptCommands(result.document,[circular],new Map(),'next','mm',sources).ok).toBe(false);
  });
  it('inchで入力しても式を明示したmm表現として保存する',()=>{
    const result=applyScriptCommands(createEmptyPartDocument(),[box('run:1','1')],new Map(),'run','inch',sources);
    expect(result.ok).toBe(true);if(!result.ok)return;
    expect(result.document.solids[0]).toMatchObject({shape:{sizeX:{value:25.4}}});
  });
  it('同じpoint-1を持つ別スケッチを異なるaliasにし、JSON変更を元へ戻さない',()=>{
    const initial=createEmptyPartDocument();
    const first=appendFeature(initial.sketches[0],{kind:'point',id:'point-1',name:'点1',planeId:'xy',at:absoluteCoordinate(0,0,0)});
    const document=replaceSketch(initial,first);
    const second=appendFeature(createSketchFor(document),{kind:'point',id:'point-1',name:'点1',planeId:'xy',at:absoluteCoordinate(10,0,0)});
    const full=addSketch(document,second), snapshot=createScriptSnapshot(full,'generation-a','mm');
    const points=[...snapshot.references].filter(([,reference])=>reference.kind==='point');
    expect(points).toHaveLength(2);expect(points[0][0]).not.toBe(points[1][0]);
    expect(points[0][1].featureId).toBe(points[1][1].featureId);expect(points[0][1].sketchId).not.toBe(points[1][1].sketchId);
    expect(snapshot.json).toContain('generation-a');expect(createScriptSnapshot(full,'generation-b','mm').json).not.toBe(snapshot.json);
  });
});
