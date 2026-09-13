/** Changing notation is explicit and transactional: keep the original source unless the parsed meaning agrees. */
import {MathInputProblem,MATH_INPUT_LIMITS,validateMathSource,type MathNode,type MathOperationDefinition} from './mathInputContract.js';
import {rationalOfExpression} from './exactRational.js';

export type DisplayMathJson=string|{readonly num:string}|{readonly str:string}|readonly [string,...DisplayMathJson[]];
const CONSTANTS:Readonly<Record<Extract<MathNode,{kind:'constant'}>['name'],string>>={pi:'Pi',e:'ExponentialE',
  'imaginary-unit':'ImaginaryUnit',infinity:'PositiveInfinity',true:'True',false:'False','real-numbers':'RealNumbers',
  'complex-numbers':'ComplexNumbers',integers:'Integers',naturals:'NonNegativeIntegers',rationals:'RationalNumbers','empty-set':'EmptySet'};
export function displayMathJson(source:MathNode,byId:ReadonlyMap<string,MathOperationDefinition>):DisplayMathJson {
  let remaining=MATH_INPUT_LIMITS.nodes;
  function visit(node:MathNode,depth:number):DisplayMathJson {
    if(--remaining<0||depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','表示する数式が複雑すぎます。');
    if(node.kind==='number')return {num:node.decimal};
    if(node.kind==='constant')return CONSTANTS[node.name];
    if(node.kind==='symbol') {
      const reference=node.reference;
      if(reference.role==='coefficient')return ['PcadCoefficient',{str:reference.label}];
      return reference.role==='axis'||reference.role==='parameter'?reference.name:reference.label;
    }
    const operation=byId.get(node.operation);
    if(!operation)throw new MathInputProblem('unsupported','演算の表示定義を確認できません。');
    if(node.kind==='operation')return [node.operation==='multiply'?'PcadTimesToken':operation.engineHead,...node.operands.map(child=>visit(child,depth+1))];
    const body=visit(node.body,depth+1);
    if(node.operation==='for-all'||node.operation==='exists') {
      const binding=node.bindings[0];
      if(node.bindings.length!==1||binding.domain.kind!=='set')throw new MathInputProblem('syntax','量化記号の範囲を確認してください。');
      return [operation.engineHead,['Element',binding.variable.label,visit(binding.domain.value,depth+1)],body];
    }
    const bindings=node.bindings.map((binding):DisplayMathJson=>{
      const domain=binding.domain;
      if(domain.kind==='unrestricted')return binding.variable.label;
      if(domain.kind==='set')return ['Tuple',binding.variable.label,visit(domain.value,depth+1)];
      return ['Tuple',binding.variable.label,visit(domain.lower,depth+1),visit(domain.upper,depth+1),
        ...(domain.step===null?[]:[visit(domain.step,depth+1)])];
    });
    return [operation.engineHead,body,...bindings];
  }
  return visit(source,0);
}
/** Local variable IDs come from parser positions, so a representation change compares their lexical correspondence. */
export function sameMathMeaning(left:MathNode,right:MathNode):boolean {
  let remaining=MATH_INPUT_LIMITS.nodes;
  const explicitLogBase=(node:MathNode):MathNode=>node.kind==='operation'&&(node.operation==='log-two'||node.operation==='log-ten')
    ?{kind:'operation',operation:'log-base',operands:[...node.operands,{kind:'number',decimal:node.operation==='log-two'?'2':'10'}]}:node;
  function same(a:MathNode,b:MathNode,bindings:ReadonlyMap<string,string>,depth:number):boolean {
    if(--remaining<0||depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','入力方式の比較が複雑すぎます。');
    a=explicitLogBase(a);b=explicitLogBase(b);
    if(a.kind!==b.kind)return false;
    if(a.kind==='number'&&b.kind==='number') {
      const x=rationalOfExpression(a),y=rationalOfExpression(b);
      return x!==null&&y!==null&&x.numerator===y.numerator&&x.denominator===y.denominator;
    }
    if(a.kind==='constant'&&b.kind==='constant')return a.name===b.name;
    if(a.kind==='symbol'&&b.kind==='symbol') {
      const x=a.reference,y=b.reference;
      if(x.role!==y.role)return false;
      if(x.role==='bound'&&y.role==='bound')return bindings.get(x.id)===y.id;
      if((x.role==='axis'&&y.role==='axis')||(x.role==='parameter'&&y.role==='parameter'))return x.name===y.name;
      return 'id' in x&&'id' in y&&x.id===y.id;
    }
    if(a.kind==='operation'&&b.kind==='operation')return a.operation===b.operation&&a.operands.length===b.operands.length
      &&a.operands.every((child,index)=>same(child,b.operands[index],bindings,depth+1));
    if(a.kind!=='binder'||b.kind!=='binder'||a.operation!==b.operation||a.bindings.length!==b.bindings.length)return false;
    const nested=new Map(bindings);
    for(let index=0;index<a.bindings.length;index+=1) {
      const x=a.bindings[index],y=b.bindings[index],p=x.domain,q=y.domain;
      if(p.kind!==q.kind)return false;
      if(p.kind==='set'&&q.kind==='set'&&!same(p.value,q.value,nested,depth+1))return false;
      if(p.kind==='range'&&q.kind==='range') {
        if(!same(p.lower,q.lower,nested,depth+1)||!same(p.upper,q.upper,nested,depth+1)
          ||(p.step===null)!==(q.step===null)||(p.step!==null&&q.step!==null&&!same(p.step,q.step,nested,depth+1)))return false;
      }
      nested.set(x.variable.id,y.variable.id);
    }
    return same(a.body,b.body,nested,depth+1);
  }
  return same(left,right,new Map(),0);
}
export function convertMathNotation(expression:MathNode,format:(expression:MathNode)=>string,parse:(source:string)=>MathNode):{
  readonly source:string;readonly expression:MathNode;
} {
  const source=format(expression);validateMathSource(source);
  const parsed=parse(source);
  if(!sameMathMeaning(expression,parsed))throw new MathInputProblem('unsupported','入力方式を変えると式の意味が変わるため、元の式を保持しました。');
  return {source,expression:parsed};
}
