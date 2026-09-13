import {describe,expect,it} from 'vitest';
import {createEmptyPartDocument,createPointFeature,type FunctionPointReference} from '@pointercad/model';
import {parseDocument,serializeDocument} from './documentJson.js';
import {readPointReferenceItem,serializePointReference} from './codecs/coordinates.js';
type SurfacePointInput=Extract<FunctionPointReference['choice']['input'],{readonly kind:'parametric-surface'}>;
type StoredMathExpression=SurfacePointInput['outputs'][number];

const number=(value:number)=>({source:String(value),display:String(value),value});
function reference():FunctionPointReference {
  return {kind:'functionPoint',parent:{kind:'surface',featureId:'surface:1'},known:[{axis:'X',value:number(0)},{axis:'Y',value:number(0)}],
    choice:{input:{expression:{format:'pointercad-math/1',source:'Z^2-1',inputNotation:'text',angleUnit:'radian',
      expression:{kind:'operation',operation:'subtract',operands:[{kind:'operation',operation:'power',operands:[
        {kind:'symbol',reference:{role:'axis',name:'Z'}},{kind:'number',decimal:'2'}]},{kind:'number',decimal:'1'}]}},
      minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:0.001,coefficients:[],known:[{axis:'X',value:0},{axis:'Y',value:0}]},
      location:{kind:'implicit',axis:'Z',interval:{lower:1,upper:1}}}};
}
describe('関数上の点の選択条件を保存する',()=>{
  it('過去の係数の分数を保存しても丸めた小数へ置き換えず、未確定の軸を原式へ混入させない',()=>{
    const original=reference();
    const coefficient={id:'r',label:'r',decimal:'0.3333333333333333',exactExpression:{kind:'operation' as const,operation:'divide',
      operands:[{kind:'number' as const,decimal:'1'},{kind:'number' as const,decimal:'3'}]}};
    const base:FunctionPointReference={...original,choice:{...original.choice,input:{...original.choice.input,coefficients:[coefficient]}}};
    const encoded:unknown=JSON.parse(JSON.stringify(serializePointReference(base)));
    expect(readPointReferenceItem(encoded,'base')).toEqual({ok:true,value:base});
    for(const exactExpression of [{kind:'symbol',reference:{role:'axis',name:'X'}},{kind:'symbol',reference:{role:'parameter',name:'T'}}]){
      expect(readPointReferenceItem({...base,choice:{...base.choice,input:{...base.choice.input,
        coefficients:[{...coefficient,exactExpression}]}}},'base').ok).toBe(false);
    }
  });

  it('接線・法線の長さの原式、反転、起点を文書の保存往復で保持する',()=>{
    const document=createEmptyPartDocument(),sketch=document.sketches[0];
    const base:FunctionPointReference={...reference(),direction:{kind:'normal',length:{source:'2*5',display:'10',value:10},reverse:true,sourcePointId:'source-point'}};
    const point=createPointFeature(sketch,{mode:'relative',base,dx:number(0),dy:number(0),dz:number(0)});
    const input={...document,sketches:[{...sketch,features:[point]}]},result=parseDocument(serializeDocument(input));
    expect(result.ok).toBe(true);if(!result.ok)throw new Error(JSON.stringify(result.error));
    expect(result.document).toEqual(input);
    expect(readPointReferenceItem(JSON.parse(JSON.stringify(serializePointReference(base))),'base')).toEqual({ok:true,value:base});
  });
  it('不正な方向・長さ・起点・余分な保存座標を拒否する',()=>{
    const base=reference(),valid={kind:'normal',length:number(10),reverse:false,sourcePointId:'source-point'};
    for(const direction of [null,{...valid,kind:'guess'},...[-1,0,Infinity,NaN].map(value=>({...valid,length:number(value)})),
      {...valid,reverse:'false'},{...valid,sourcePointId:''},{...valid,sourcePointId:'x'.repeat(257)},{...valid,point:[1,2,3]}]){
      expect(readPointReferenceItem({...base,direction},'base').ok).toBe(false);
    }
  });
  it('媒介曲面のU/VとXYZ範囲・3式・2座標の枝を保存し、欠落や異なる種類の枝を拒否する',()=>{
    const U:StoredMathExpression={format:'pointercad-math/1',source:'U',inputNotation:'text',angleUnit:'degree',
      expression:{kind:'symbol',reference:{role:'parameter',name:'U'}}};
    const V:StoredMathExpression={...U,source:'V',expression:{kind:'symbol',reference:{role:'parameter',name:'V'}}};
    const zero:StoredMathExpression={...U,source:'0',expression:{kind:'number',decimal:'0'}};
    const base:FunctionPointReference={kind:'functionPoint',parent:{kind:'surface',featureId:'surface:uv'},known:[{axis:'X',value:number(1)},{axis:'Y',value:number(2)}],
      choice:{input:{kind:'parametric-surface',independent:['U','V'],outputs:[U,V,zero],lower:[-3,-4],upper:[3,4],minimum:[-2,-3,-1],maximum:[2,3,1],
        tolerance:1e-7,budget:{maximumSamples:100,maximumCells:100,maximumTriangles:100,maximumDepth:10},coefficients:[],known:[{axis:'X',value:1},{axis:'Y',value:2}]},
        location:{kind:'parametric-surface',box:[{lower:1,upper:1},{lower:2,upper:2}]}}};
    expect(readPointReferenceItem(JSON.parse(JSON.stringify(serializePointReference(base))),'base')).toEqual({ok:true,value:base});
    for(const key of ['lower','upper','outputs','minimum','maximum','budget']){
      expect(readPointReferenceItem({...base,choice:{...base.choice,input:{...base.choice.input,[key]:undefined}}},'base').ok).toBe(false);
    }
    for(const location of [{kind:'curve',independent:'T',interval:{lower:1,upper:1},direct:false},
      {kind:'parametric-surface',box:[{lower:1,upper:1},{lower:5,upper:5}]},
      {kind:'parametric-surface',box:[{lower:1,upper:1},{lower:2,upper:2}],cachedPoint:[1,2,0]}]){
      expect(readPointReferenceItem({...base,choice:{...base.choice,location}},'base').ok).toBe(false);
    }
  });
  it('媒介曲線の3式・TとXYZの別々の範囲を往復し、欠落と別形式の枝を拒否する',()=>{
    const T:StoredMathExpression={format:'pointercad-math/1',source:'T',inputNotation:'text',angleUnit:'degree',
      expression:{kind:'symbol',reference:{role:'parameter',name:'T'}}};
    const zero:StoredMathExpression={...T,source:'0',expression:{kind:'number',decimal:'0'}};
    const squared:StoredMathExpression={...T,source:'T^2',expression:{kind:'operation',operation:'power',operands:[T.expression,{kind:'number',decimal:'2'}]}};
    const base:FunctionPointReference={kind:'functionPoint',parent:{kind:'curve',sketchId:'sketch:1',featureId:'curve:1'},known:[{axis:'X',value:number(1)}],
      choice:{input:{kind:'curve',independent:'T',outputs:[squared,T,zero],lower:-3,upper:3,minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:1e-7,
        coefficients:[],known:[{axis:'X',value:1}]},location:{kind:'curve',independent:'T',interval:{lower:1,upper:1},direct:false}}};
    const serialized=serializePointReference(base),result=readPointReferenceItem(JSON.parse(JSON.stringify(serialized)),'base');
    expect(result).toEqual({ok:true,value:base});
    for(const key of ['lower','upper','outputs','minimum','maximum']) {
      expect(readPointReferenceItem({...base,choice:{...base.choice,input:{...base.choice.input,[key]:undefined}}},'base').ok).toBe(false);
    }
    expect(readPointReferenceItem({...base,choice:{...base.choice,location:{kind:'implicit',axis:'X',interval:{lower:1,upper:1}}}},'base').ok).toBe(false);
  });
  it('文書を往復し、選択枝と既知座標の原式が残る',()=>{
    const document=createEmptyPartDocument(),sketch=document.sketches[0],base=reference();
    const point=createPointFeature(sketch,{mode:'relative',base,dx:number(0),dy:number(0),dz:number(0)});
    const input={...document,sketches:[{...sketch,features:[point]}]},text=serializeDocument(input),result=parseDocument(text);
    expect(result.ok).toBe(true);if(!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.document).toEqual(input);expect(text).not.toContain('candidate');
    expect(readPointReferenceItem(JSON.parse(JSON.stringify(serializePointReference(base))),'base')).toEqual({ok:true,value:base});
  });
  it.each([NaN,Infinity,-Infinity])('選択時の非有限境界%sを拒否する',value=>{
    const input=reference();expect(readPointReferenceItem({...input,choice:{...input.choice,input:{...input.choice.input,minimum:[value,-2,-2]}}},'base').ok).toBe(false);
  });
  it.each(['minimum','maximum','expression','known'] as const)('選択時の必須%sが欠けると拒否する',key=>{
    const input=reference();expect(readPointReferenceItem({...input,choice:{...input.choice,input:{...input.choice.input,[key]:undefined}}},'base').ok).toBe(false);
  });
  it('巨大な既知座標一覧・軸の重複・選択時と異なる既知軸を拒否する',()=>{
    const input=reference(),item=input.known[0];
    for(const known of [Array.from({length:10000},()=>item),[item,item],[{axis:'Z',value:number(0)}]]) {
      expect(readPointReferenceItem({...input,known},'base').ok).toBe(false);
    }
  });
  it('未定義の親・親の余分な保存座標・範囲外の選択区間を拒否する',()=>{
    const input=reference();
    for(const parent of [{kind:'surface',featureId:''},{kind:'mesh',featureId:'f'},{...input.parent,position:[0,0,1]}]) {
      expect(readPointReferenceItem({...input,parent},'base').ok).toBe(false);
    }
    expect(readPointReferenceItem({...input,choice:{...input.choice,location:{kind:'implicit',axis:'Z',interval:{lower:3,upper:3}}}},'base').ok).toBe(false);
  });
  it('曲線の親スケッチIDを保持し、読み取った履歴条件は呼出し元と共有しない',()=>{
    const base=reference(),input={...base,parent:{kind:'curve',sketchId:'sketch:1',featureId:'curve:1'}},result=readPointReferenceItem(input,'base');
    expect(result.ok).toBe(true);if(!result.ok || result.value.kind!=='functionPoint') throw new Error('Expected function point');
    expect(result.value.parent).toEqual(input.parent);expect(result.value.choice.input).not.toBe(input.choice.input);
    expect(Object.isFrozen(result.value.choice.input)).toBe(true);
  });
});
