import { numericalRootFunction } from './numericalRootResult.js';
import { equationSystemFunction } from './equationSystems.js';
import { differentialEquationProblem } from './differentialEquations.js';
import { EQUATION_IDS, equationFunction } from './equationSolutions.js';
import { FOURIER_SERIES_ID, fourierSeriesFunction } from './fourierSeries.js';
import { INTEGRAL_TRANSFORM_IDS, transformFunction } from './integralTransforms.js';
import { TAYLOR_IDS, taylorFunction } from './taylorExpansion.js';
/** Changing notation is explicit and transactional: keep the original source unless the parsed meaning agrees. */
import { SEQUENCE_IDS, sequenceFunction } from './sequenceCalculations.js';
import {MathInputProblem,MATH_INPUT_LIMITS,validateMathSource,type MathNode,type MathOperationDefinition} from './mathInputContract.js';
import {rationalOfExpression} from './exactRational.js';
import {literalLimitDirection} from './mathExactCalculus.js';
import {VECTOR_CALCULUS_AT_IDS,vectorCalculusAtBounds} from './vectorCalculusAt.js';
import {LINE_INTEGRAL_IDS,validateLineIntegral} from './lineIntegrals.js';
import {REGION_INTEGRAL_IDS,validateRegionIntegral} from './regionIntegrals.js';
import {GENERAL_PROBABILITY_IDS,probabilityFunction} from './generalProbability.js';

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
    if(node.kind==='operation') {
      if (node.operation === 'solve-ode' || node.operation === 'partial-equations') {
        const problem = differentialEquationProblem(node), names = problem.fn.bindings.map(binding => binding.variable.label);
        const independent: DisplayMathJson = problem.independentCount === 1 ? names[0] : ['List', ...names.slice(0, problem.independentCount)];
        return [operation.engineHead, visit(problem.equations, depth + 1), independent,
          ['List', ...names.slice(problem.independentCount)], visit(problem.conditions, depth + 1)];
      }
      if(node.operation==='solve-system') {
        const fn=equationSystemFunction(node);
        return [operation.engineHead,visit(fn.body,depth+1),['List',...fn.bindings.map(binding=>binding.variable.label)],visit(node.operands[1],depth+1)];
      }
      if(EQUATION_IDS.has(node.operation)) {
        const fn=equationFunction(node);
        return [operation.engineHead,visit(fn.body,depth+1),fn.bindings[0].variable.label,visit(node.operands[1],depth+1)];
      }
      if(node.operation==='numerical-roots') {
        const fn=numericalRootFunction(node);
        return [operation.engineHead,visit(fn.body,depth+1),fn.bindings[0].variable.label,...node.operands.slice(1).map(item=>visit(item,depth+1))];
      }
      if(node.operation===FOURIER_SERIES_ID) {
        const fn=fourierSeriesFunction(node);
        return [operation.engineHead,visit(fn.body,depth+1),fn.bindings[0].variable.label,...node.operands.slice(1).map(item=>visit(item,depth+1))];
      }
      if(INTEGRAL_TRANSFORM_IDS.has(node.operation)) {
        const fn=transformFunction(node);
        return [operation.engineHead,visit(fn.body,depth+1),...fn.bindings.map(binding=>binding.variable.label)];
      }
      if(TAYLOR_IDS.has(node.operation)) {
        const fn=taylorFunction(node);
        return [operation.engineHead,visit(fn.body,depth+1),fn.bindings[0].variable.label,...node.operands.slice(1).map(child=>visit(child,depth+1))];
      }
      if(SEQUENCE_IDS.has(node.operation)) {
        const fn=sequenceFunction(node), names=fn.bindings.map(binding=>binding.variable.label);
        const variables:DisplayMathJson=node.operation==='recurrence-value'?['List',...names]:names[0];
        return [operation.engineHead,visit(fn.body,depth+1),variables,...node.operands.slice(1).map(child=>visit(child,depth+1))];
      }
      if(GENERAL_PROBABILITY_IDS.has(node.operation)) {
        const fn=probabilityFunction(node);
        if(fn.body.kind!=='operation')throw new MathInputProblem('syntax','確率の式一覧を指定してください。');
        return [operation.engineHead,...fn.body.operands.map(child=>visit(child,depth+1)),
          ['List',...fn.bindings.map(binding=>binding.variable.label)],visit(node.operands[1],depth+1)];
      }
      if(REGION_INTEGRAL_IDS.has(node.operation)) {
        validateRegionIntegral(node);
        const [field,mapping,lower,upper]=node.operands;
        if(field.kind!=='binder'||mapping.kind!=='binder')throw new MathInputProblem('syntax','場と座標式を指定してください。');
        return [operation.engineHead,visit(field.body,depth+1),['List',...field.bindings.map(binding=>binding.variable.label)],
          visit(mapping.body,depth+1),['List',...mapping.bindings.map(binding=>binding.variable.label)],
          visit(lower,depth+1),visit(upper,depth+1)];
      }
      if(LINE_INTEGRAL_IDS.has(node.operation)) {
        validateLineIntegral(node);
        const [field,path,lower,upper]=node.operands;
        if(field.kind!=='binder'||path.kind!=='binder')throw new MathInputProblem('syntax','場と曲線を指定してください。');
        return [operation.engineHead,visit(field.body,depth+1),['List',...field.bindings.map(binding=>binding.variable.label)],
          visit(path.body,depth+1),path.bindings[0].variable.label,visit(lower,depth+1),visit(upper,depth+1)];
      }
      if(VECTOR_CALCULUS_AT_IDS.has(node.operation)) {
        vectorCalculusAtBounds(node);
        const [fn,target]=node.operands;
        if(fn.kind!=='binder')throw new MathInputProblem('syntax','微分する変数を指定してください。');
        return [operation.engineHead,visit(fn.body,depth+1),['List',...fn.bindings.map(binding=>binding.variable.label)],visit(target,depth+1)];
      }
      if(node.operation==='differentiate-at') {
        const [fn,target,order]=node.operands;
        if(node.operands.length!==3||fn.kind!=='binder'||fn.operation!=='lambda'||fn.bindings.length!==1) {
          throw new MathInputProblem('syntax','微分する変数、位置、回数を確認してください。');
        }
        return ['DerivativeAt',visit(fn.body,depth+1),fn.bindings[0].variable.label,visit(target,depth+1),visit(order,depth+1)];
      }
      const operands=node.operands.map(child=>visit(child,depth+1));
      if(node.operation==='limit'&&operands.length===3) {
        const direction=literalLimitDirection(node.operands[2]);
        // The formatter recognizes a signed number, but silently drops Negate(1).
        if(direction!==null)operands[2]={num:String(direction)};
      }
      return [node.operation==='multiply'?'PcadTimesToken':operation.engineHead,...operands];
    }
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
    if(a.kind==='operation'&&b.kind==='operation'&&a.operation==='limit'&&b.operation==='limit'
      &&[2,3].includes(a.operands.length)&&[2,3].includes(b.operands.length)) {
      const x=literalLimitDirection(a.operands[2]),y=literalLimitDirection(b.operands[2]);
      if(x!==null&&y!==null)return x===y&&same(a.operands[0],b.operands[0],bindings,depth+1)
        &&same(a.operands[1],b.operands[1],bindings,depth+1);
    }
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
