import Decimal from 'decimal.js';
import { beforeAll,describe,expect,it,vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest,type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { ELLIPTIC_REFERENCES } from './ellipticReferences.js';
import * as carlson from './carlsonSymmetric.js';
import { normalizeEllipticFunction } from './ellipticFunctions.js';
import { decimalRational } from './exactRational.js';
import { validateEllipticDomain } from './ellipticNumeric.js';

const D=Decimal.clone({precision:310,rounding:Decimal.ROUND_HALF_EVEN});
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
const names={K:'elliptick',E:'elliptice',F:'ellipticf',Einc:'ellipticeinc',Pi:'ellipticpi',Piinc:'ellipticpiinc'} as const;
function request(source:string,angleUnit:'degree'|'radian'='radian') {
  return {source,angleUnit,notation:'text' as const,coefficients:[],
    identity:{documentId:'elliptic-functions',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}
function evaluate(source:string,angleUnit:'degree'|'radian'='radian') {
  const input=request(source,angleUnit),raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
  return decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
}
describe('楕円積分の六つの入力を原式・角度・40桁表示へ接続する',()=>{
  it('元の条件の確認は対称積分の値を重複計算せず、途中の極も拒否する',()=>{
    const spies=[vi.spyOn(carlson,'carlsonRF'),vi.spyOn(carlson,'carlsonRD'),vi.spyOn(carlson,'carlsonRJ')];
    try {
      for(const [kind,args] of ELLIPTIC_REFERENCES)normalizeEllipticFunction({kind:'operation',operation:names[kind],
        operands:args.map(decimal=>({kind:'number',decimal}))},'radian');
      const exact=(source:string)=>{const value=decimalRational(source);if(value===null)throw new Error(source);return value;};
      expect(()=>validateEllipticDomain('Piinc',['2','3.14','0.5'].map(exact),()=>undefined)).toThrow('途中');
      expect(()=>validateEllipticDomain('Piinc',['2','1','0.5'].map(exact),()=>undefined)).toThrow('分母が0');
      for(const spy of spies)expect(spy).not.toHaveBeenCalled();
    } finally {for(const spy of spies)spy.mockRestore();}
  });
  it.each(ELLIPTIC_REFERENCES)('%s(%s)を通常入力で独立値と同じ表示にする',(kind,args,reference)=>{
    const source=`${names[kind]}(${args.join(',')})`,result=evaluate(source).evaluation;
    if(result.status!=='value'||result.kind!=='real')throw new Error(source+': '+JSON.stringify(result));
    expect(result.decimal).toBe(new D(reference).toSignificantDigits(40).toString());
    expect(result.coordinate).toBe(Number(result.decimal));
  },30_000);
  it.each(['elliptick(0.5)','elliptice(-1)','ellipticf(1,0.5)','ellipticeinc(-1,0.5)',
    'ellipticpi(0.25,0.5)','ellipticpiinc(0.25,1,0.5)'])('%sの表示切替と保存再開で元の意味を保つ',source=>{
    const input={...request(source),presentationNotation:'latex' as const};
    const raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
    const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
    if(raw.expression===null||raw.presentation===undefined||raw.presentation===null||result.definition===null)throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression,raw.presentation.expression)).toBe(true);expect(result.definition.source).toBe(source);
    const back=executeMathWorkRequest({kind:'evaluate-math',serial:2,request:{...input,notation:'latex',source:raw.presentation.source,definition:raw.presentation,presentationNotation:'text'}},backend);
    if(back.presentation===undefined||back.presentation===null)throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression,back.presentation.expression)).toBe(true);expect(back.evaluation).toEqual(raw.evaluation);
    const saved:unknown=JSON.parse(JSON.stringify({kind:'evaluate-math',serial:3,request:{...input,definition:result.definition}}));
    const reopened=executeMathWorkRequest(saved,backend);expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
  },30_000);
  it.each(['ellipticf','ellipticeinc','ellipticpiinc'])('%sの振幅にだけ度/ラジアンを適用し、piの境界を保つ',operation=>{
    const source=(phi:string)=>`${operation}(${operation==='ellipticpiinc'?'0.25,':''}${phi},0.5)`;
    const degree=evaluate(source('90'),'degree'),radian=evaluate(source('pi/2'));
    if(degree.evaluation.status!=='value'||degree.evaluation.kind!=='real'||radian.evaluation.status!=='value'||radian.evaluation.kind!=='real')throw new Error(JSON.stringify({degree,radian}));
    expect(degree.evaluation.decimal).toBe(radian.evaluation.decimal);
    expect(degree.definition?.source).toBe(source('90'));expect(degree.definition?.angleUnit).toBe('degree');
    expect(radian.definition?.source).toBe(source('pi/2'));expect(radian.definition?.angleUnit).toBe('radian');
    expect(degree.evaluation.exact).not.toEqual(radian.evaluation.exact);
  },30_000);
  it('振幅の境界で丸めにより発散が有限へ変わらず、第二種は値1を返す',()=>{
    for(const [source,angle] of [['ellipticf(90,1)','degree'],['ellipticf(pi/2,1)','radian'],
      ['ellipticpiinc(1,90,0.5)','degree'],['ellipticpiinc(1,pi/2,0.5)','radian']] as const) {
      expect(evaluate(source,angle).evaluation.status).not.toBe('value');
    }
    for(const [source,angle] of [['ellipticeinc(90,1)','degree'],['ellipticeinc(pi/2,1)','radian']] as const) {
      const result=evaluate(source,angle).evaluation;
      if(result.status!=='value'||result.kind!=='real')throw new Error(JSON.stringify(result));
      expect(result.decimal).toBe('1');
    }
    const degree=evaluate('elliptick(sin(30))','degree').evaluation,literal=evaluate('elliptick(0.5)').evaluation;
    if(degree.status!=='value'||degree.kind!=='real'||literal.status!=='value'||literal.kind!=='real')throw new Error(JSON.stringify({degree,literal}));
    expect(degree.decimal).toBe(literal.decimal);
  });
  it.each(['elliptick(1)','elliptice(1+1e-1000)','ellipticpi(1,0.5)','ellipticf(3.14,2)',
    'ellipticpiinc(2,3.14,0.5)','elliptick(i)','elliptice([1])','ellipticf(1/0,0.5)','elliptick(∞)'])(
    '%sの元の不成立を0倍や成分選択で隠せない',source=>{
      for(const formula of [source,`0*${source}`,`component([7,${source}],1)`])expect(evaluate(formula).evaluation.status,formula).not.toBe('value');
    });
});
