/** Decode a pure engine result into our public value types; never coerce vectors or complex values into coordinates. */
import {MathInputProblem,MATH_INPUT_LIMITS,validateMathDecimal,type MathNode,type MathEvaluation,
  type MathSymbolReference,type MathOperationDefinition} from './mathInputContract.js';
import {engineSymbolOf} from './mathSymbolScope.js';

const CONSTANTS:ReadonlyMap<string,Extract<MathNode,{kind:'constant'}>['name']>=new Map([
  ['Pi','pi'],['ExponentialE','e'],['ImaginaryUnit','imaginary-unit'],['PositiveInfinity','infinity'],
  ['True','true'],['False','false'],['RealNumbers','real-numbers'],['ComplexNumbers','complex-numbers'],
  ['Integers','integers'],['NonNegativeIntegers','naturals'],['RationalNumbers','rationals'],['EmptySet','empty-set'],
]);
function op(operation:string,...operands:MathNode[]):MathNode{return {kind:'operation',operation,operands};}
export function mathResultSymbols(source:MathNode):ReadonlyMap<string,MathSymbolReference> {
  const symbols=new Map<string,MathSymbolReference>(),pending=[source];let remaining=MATH_INPUT_LIMITS.nodes;
  while(pending.length>0) {
    const item=pending.pop();if(!item)break;
    if(--remaining<0)throw new MathInputProblem('budget','結果の記号を照合する式が大きすぎます。');
    if(item.kind==='symbol') {
      // Bound identifiers cannot escape their domain as a newly declared free variable.
      if(item.reference.role!=='bound')symbols.set(engineSymbolOf(item.reference),item.reference);
    }else if(item.kind==='operation')pending.push(...item.operands);
    else if(item.kind==='binder') {
      pending.push(item.body);
      for(const binding of item.bindings) {
        if(binding.domain.kind==='set')pending.push(binding.domain.value);
        else if(binding.domain.kind==='range') {
          pending.push(binding.domain.lower,binding.domain.upper);
          if(binding.domain.step)pending.push(binding.domain.step);
        }
      }
    }
  }
  return symbols;
}
/** Output has a separate positive grammar. Engine-generated binders require an explicit scope decoder. */
export function decodeMathBackendNode(value:unknown,operations:ReadonlyMap<string,MathOperationDefinition>,
  symbols:ReadonlyMap<string,MathSymbolReference>=new Map()):MathNode {
  let remaining=MATH_INPUT_LIMITS.nodes;
  const number=(decimal:string):MathNode=>{validateMathDecimal(decimal);return {kind:'number',decimal};};
  function visit(raw:unknown,depth:number,endpoint=false):MathNode {
    if(--remaining<0||depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','数式の計算結果が複雑すぎます。');
    if(typeof raw==='number') {
      if(!Number.isFinite(raw))throw new MathInputProblem('domain','有限でない結果は座標へ変換できません。');
      return number(String(raw));
    }
    if(typeof raw==='string') {
      const constant=CONSTANTS.get(raw);if(constant)return {kind:'constant',name:constant};
      if(raw==='Half')return op('divide',number('1'),number('2'));
      const reference=symbols.get(raw);if(reference)return {kind:'symbol',reference};
      throw new MathInputProblem('unsupported','未評価の記号が結果に残っています。');
    }
    if(!raw||typeof raw!=='object')throw new MathInputProblem('syntax','計算結果の形式を確認できません。');
    if(!Array.isArray(raw)) {
      const prototype:unknown=Object.getPrototypeOf(raw);
      const keys=Object.keys(raw);
      if((prototype!==Object.prototype&&prototype!==null)||keys.length!==1)throw new MathInputProblem('syntax','計算結果に未知の項目があります。');
      const item=raw as Record<string,unknown>;
      if(typeof item.num==='string')return number(item.num);
      if(typeof item.sym==='string')return visit(item.sym,depth+1);
      if(Array.isArray(item.fn))return visit(item.fn,depth+1,endpoint);
      throw new MathInputProblem('unsupported','未評価の値が結果に残っています。');
    }
    if(raw.length===0||raw.length>MATH_INPUT_LIMITS.arguments+1||typeof raw[0]!=='string') {
      throw new MathInputProblem('budget','計算結果の要素数が上限を超えています。');
    }
    if(raw[0]==='Rational') {
      if(raw.length!==3)throw new MathInputProblem('syntax','有理数の結果が不正です。');
      const numerator=visit(raw[1],depth+1),denominator=visit(raw[2],depth+1);
      if(numerator.kind!=='number'||denominator.kind!=='number'||!/^[-+]?[0-9]+$/u.test(numerator.decimal)
        ||!/^[-+]?[0-9]+$/u.test(denominator.decimal)||BigInt(denominator.decimal)===0n) {
        throw new MathInputProblem('domain','有理数の分子・分母を確認できません。');
      }
      return op('divide',numerator,denominator);
    }
    if(raw[0]==='Open'&&endpoint&&raw.length===2)return op('open-endpoint',visit(raw[1],depth+1));
    const operation=operations.get(raw[0]);
    if(!operation||operation.structural||['sum','product','integrate','differentiate','limit','for-all','exists','lambda'].includes(operation.id)) {
      throw new MathInputProblem('unsupported','未評価の演算が結果に残っています。');
    }
    const count=raw.length-1;
    if(count<operation.minimumArguments||count>operation.maximumArguments)throw new MathInputProblem('syntax','計算結果の引数が不正です。');
    return op(operation.id,...raw.slice(1).map(child=>visit(child,depth+1,operation.id==='interval')));
  }
  return visit(value,0);
}

function decimalOf(raw:unknown):string|null {
  if(typeof raw==='number'&&Number.isFinite(raw))return String(raw);
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===1&&'num' in raw&&typeof raw.num==='string')return raw.num;
  return null;
}
function containsFreeSymbol(node:MathNode):boolean {
  return node.kind==='symbol'||node.kind==='binder'||(node.kind==='operation'&&node.operands.some(containsFreeSymbol));
}
function numericalShape(node:MathNode):readonly number[]|null {
  if(node.kind==='number'||(node.kind==='constant'&&node.name==='imaginary-unit')
    ||(node.kind==='operation'&&node.operation==='complex'&&node.operands.every(value=>value.kind==='number')))return [];
  if(node.kind!=='operation'||node.operation!=='list')return null;
  if(node.operands.length===0)return [0];
  const shapes=node.operands.map(numericalShape),first=shapes[0];
  if(first===null||shapes.some(shape=>shape===null||shape.length!==first.length||shape.some((size,index)=>size!==first[index])))return null;
  return [node.operands.length,...first];
}
export function mathBackendEvaluation(exact:unknown,numeric:unknown,source:MathNode,
  operations:ReadonlyMap<string,MathOperationDefinition>):MathEvaluation {
  const symbols=mathResultSymbols(source),decimal=decimalOf(numeric);
  if(decimal!==null) {
    validateMathDecimal(decimal);
    const coordinate=Number(decimal);
    if(!Number.isFinite(coordinate)||(coordinate===0&&/[1-9]/u.test(decimal.split(/[eE]/u)[0]??''))) {
      return {status:'invalid',reason:'non-finite',detail:'数値が作図に使用できる範囲を超えています。'};
    }
    let exactNode:MathNode|null=null;
    try{exactNode=decodeMathBackendNode(exact,operations,symbols);}
    catch(error){if(!(error instanceof MathInputProblem)||error.code!=='unsupported')throw error;}
    return {status:'value',kind:'real',exact:exactNode,decimal,coordinate,approximation:exactNode===null?{absoluteError:null}:null};
  }
  if(typeof numeric==='number'&&!Number.isFinite(numeric)||['NaN','ComplexInfinity','PositiveInfinity','NegativeInfinity'].includes(String(numeric))) {
    return {status:'invalid',reason:'non-finite',detail:'有限の数値を求められません。'};
  }
  let expression:MathNode;
  try{expression=decodeMathBackendNode(numeric,operations,symbols);}
  catch(error) {
    if(error instanceof MathInputProblem&&error.code==='unsupported')return {status:'unresolved',reason:'unevaluated',names:[]};
    throw error;
  }
  if(containsFreeSymbol(expression))return {status:'value',kind:'symbolic',expression};
  if(expression.kind==='constant') {
    if(expression.name==='true'||expression.name==='false')return {status:'value',kind:'boolean',expression};
    if(expression.name==='imaginary-unit')return {status:'value',kind:'complex',expression};
    if(['real-numbers','complex-numbers','integers','naturals','rationals','empty-set'].includes(expression.name))return {status:'value',kind:'set',expression};
  }
  if(expression.kind==='operation') {
    const operation=expression.operation;
    if(operation==='complex')return {status:'value',kind:'complex',expression};
    if(operation==='set')return {status:'value',kind:'set',expression};
    if(operation==='interval')return {status:'value',kind:'interval',expression};
    if(operation==='matrix')return {status:'value',kind:'matrix',expression};
    if(operation==='list') {
      const shape=numericalShape(expression);
      if(shape===null)return {status:'invalid',reason:'dimension',detail:'ベクトルや配列は各方向の成分数と数値の型を揃えてください。'};
      return {status:'value',kind:shape.length===1?'vector':shape.length===2?'matrix':'tensor',expression};
    }
  }
  return {status:'unresolved',reason:'unevaluated',names:[]};
}
