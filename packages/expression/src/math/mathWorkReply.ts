import { isInfiniteBound } from './setBounds.js';
import { decodeNumericalRootIntervals } from './numericalRootResult.js';
import { decodeEquationSystem } from './equationSystems.js';
import { decodeOdeSolutions } from './differentialEquations.js';
import { decodeFourierSeries, fourierSeriesFunction } from './fourierSeries.js';
import { decodeIntegralTransform } from './integralTransforms.js';
/** The renderer accepts a bounded, typed result for exactly the active request. No parsing or evaluation here. */
import { decodeTaylorExpansion, taylorFunction } from './taylorExpansion.js';
import { MATH_INPUT_FORMAT, MATH_INPUT_LIMITS, MathInputProblem, validateMathDecimal, hasMathControlCharacters,
  type MathEvaluation, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { decodeStoredMathNode, decodeStoredMathStructure, type StoredMathContext } from './decodeStoredMath.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { decodeMathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity, type MathWorkRequest } from './mathWorkerClient.js';
import {collectMathCoefficients} from './mathExpressionReferences.js';
import {assertMathVariableScope} from './mathVariableScope.js';

export interface MathWorkResult {
  readonly definition: StoredMathExpression | null;
  readonly evaluation: MathEvaluation;
  readonly presentation?: StoredMathExpression | null;
  readonly renamedDefinition?: StoredMathExpression | null;
}
type NodeContext = Pick<StoredMathContext,'operationsById'|'coefficientIds'|'declaredIds'>;
function object(value: unknown, allowed: readonly string[]): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new MathInputProblem('syntax','数式の計算結果を読み取れません。');
  const prototype: unknown=Object.getPrototypeOf(value);
  const keys=Object.keys(value);
  if((prototype!==Object.prototype&&prototype!==null)||keys.length!==allowed.length||keys.some(key=>!allowed.includes(key))) {
    throw new MathInputProblem('syntax','数式の計算結果の項目が不正です。');
  }
  return value as Record<string,unknown>;
}
function text(value: unknown, maximum: number): string {
  if(typeof value!=='string'||value.length>maximum||hasMathControlCharacters(value, true)) {
    throw new MathInputProblem('syntax','数式の計算結果の文章が不正です。');
  }
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  const found=choices.find(choice=>choice===value);
  if(found===undefined)throw new MathInputProblem('syntax','数式の計算結果の種類が不正です。');
  return found;
}
/** Budget all returned ASTs together: 256 candidate roots must not each allocate 4096 nodes. */
function budgetNodes(value: unknown, remaining: { nodes: number }): void {
  const pending: {value:unknown;depth:number}[]=[{value,depth:0}];
  while(pending.length>0) {
    const item=pending.pop();if(!item)break;
    remaining.nodes-=1;
    if(remaining.nodes<0||item.depth>MATH_INPUT_LIMITS.depth*4)throw new MathInputProblem('budget','数式の計算結果が複雑すぎます。');
    if(item.value&&typeof item.value==='object') {
      const values=Object.values(item.value);
      if(values.length>MATH_INPUT_LIMITS.arguments)throw new MathInputProblem('budget','数式の計算結果の要素が多すぎます。');
      for(const child of values)pending.push({value:child,depth:item.depth+1});
    }
  }
}

export function decodeMathEvaluation(value: unknown, context: NodeContext,
  remaining={nodes:MATH_INPUT_LIMITS.nodes*8}): MathEvaluation {
  if(!value||typeof value!=='object'||!('status' in value))throw new MathInputProblem('syntax','数式の計算状態がありません。');
  const decodeNode=(raw:unknown):MathNode=>{budgetNodes(raw,remaining);return decodeStoredMathNode(raw,context);};
  switch(value.status) {
    case 'value': {
      if('kind' in value&&value.kind==='real') {
        const raw=object(value,['status','kind','exact','decimal','coordinate','approximation']);
        const decimal=text(raw.decimal,MATH_INPUT_LIMITS.literalDigits+16);validateMathDecimal(decimal);
        if(typeof raw.coordinate!=='number'||!Number.isFinite(raw.coordinate)||Number(decimal)!==raw.coordinate
          ||(raw.coordinate===0&&/[1-9]/u.test(decimal.split(/[eE]/u)[0]??''))) {
          throw new MathInputProblem('syntax','表示する数値と作図用の座標が一致しません。');
        }
        let approximation: Extract<MathEvaluation,{status:'value';kind:'real'}>['approximation']=null;
        if(raw.approximation!==null) {
          const hasEstimate=typeof raw.approximation==='object'&&Object.hasOwn(raw.approximation,'estimatedAbsoluteError');
          const approximate=object(raw.approximation,['absoluteError',...(hasEstimate?['estimatedAbsoluteError']:[])]);
          const error=approximate.absoluteError;
          if(error!==null&&(typeof error!=='number'||!Number.isFinite(error)||error<0))throw new MathInputProblem('syntax','数値の誤差が不正です。');
          if(hasEstimate) {
            const estimate=approximate.estimatedAbsoluteError;
            if(error!==null||typeof estimate!=='number'||!Number.isFinite(estimate)||estimate<0) {
              throw new MathInputProblem('syntax','数値の推定誤差を保証した上限へ読み替えることはできません。');
            }
            approximation={absoluteError:null,estimatedAbsoluteError:estimate};
          } else approximation={absoluteError:error};
        }
        return {status:'value',kind:'real',exact:raw.exact===null?null:decodeNode(raw.exact),decimal,
          coordinate:raw.coordinate,approximation};
      }
      if ('kind' in value && value.kind === 'root-intervals') {
        const raw = object(value, ['status', 'kind', 'expression', 'intervals']);
        const expression = decodeNode(raw.expression);
        return { status: 'value', kind: 'root-intervals', expression, intervals: decodeNumericalRootIntervals(raw.intervals, expression) };
      }
      if ('kind' in value && value.kind === 'equation-system') {
        const raw = object(value, ['status', 'kind', 'expression', 'solutions']);
        const expression = decodeNode(raw.expression);
        return { status: 'value', kind: 'equation-system', expression, solutions: decodeEquationSystem(raw.solutions, expression, decodeNode) };
      }
      if ('kind' in value && value.kind === 'ode-solutions') {
        const raw = object(value, ['status', 'kind', 'expression', 'solutions']);
        const expression = decodeNode(raw.expression);
        return { status: 'value', kind: 'ode-solutions', expression, solutions: decodeOdeSolutions(raw.solutions, expression, decodeNode) };
      }
      if ('kind' in value && value.kind === 'fourier-series') {
        const raw = object(value, ['status', 'kind', 'expression', 'series']);
        const expression = decodeNode(raw.expression);
        fourierSeriesFunction(expression);
        return { status: 'value', kind: 'fourier-series', expression, series: decodeFourierSeries(raw.series, decodeNode) };
      }
      if ('kind' in value && value.kind === 'transform') {
        const raw = object(value, ['status', 'kind', 'expression', 'transform']);
        const expression = decodeNode(raw.expression);
        return { status: 'value', kind: 'transform', expression, transform: decodeIntegralTransform(raw.transform, expression, decodeNode) };
      }
      if ('kind' in value && value.kind === 'series') {
        const raw = object(value, ['status', 'kind', 'expression', 'expansion']);
        const expression = decodeNode(raw.expression);
        if (expression.kind !== 'operation') throw new MathInputProblem('syntax', '級数の元の式がありません。');
        taylorFunction(expression);
        return { status: 'value', kind: 'series', expression, expansion: decodeTaylorExpansion(raw.expansion, decodeNode) };
      }
      if ('kind' in value && value.kind === 'infinite-bound') {
        const raw = object(value, ['status', 'kind', 'expression']);
        const expression = decodeNode(raw.expression);
        if (!isInfiniteBound(expression)) throw new MathInputProblem('syntax', '無限の上限・下限の形式が不正です。');
        return { status: 'value', kind: 'infinite-bound', expression };
      }
      const raw=object(value,['status','kind','expression']);
      const kind=oneOf(raw.kind,['complex','boolean','vector','matrix','tensor','set','interval','function','distribution','symbolic'] as const);
      return {status:'value',kind,expression:decodeNode(raw.expression)};
    }
    case 'unresolved': {
      const raw=object(value,['status','reason','names']);
      if(!Array.isArray(raw.names)||raw.names.length>256)throw new MathInputProblem('budget','未決定の名前が多すぎます。');
      return {status:'unresolved',reason:oneOf(raw.reason,['unknown-symbol','missing-condition','unevaluated'] as const),
        names:raw.names.map(name=>text(name,128))};
    }
    case 'invalid': {
      const raw=object(value,['status','reason','detail']);
      return {status:'invalid',reason:oneOf(raw.reason,['syntax','domain','non-finite','dimension','unit','unsupported','divergent','no-limit','empty-set','no-extremum'] as const),detail:text(raw.detail,4096)};
    }
    case 'multiple': {
      const raw=object(value,['status','candidates','exhaustive']);
      if(!Array.isArray(raw.candidates)||raw.candidates.length<1||raw.candidates.length>256||typeof raw.exhaustive!=='boolean') {
        throw new MathInputProblem('syntax','解の候補が不正です。');
      }
      return {status:'multiple',candidates:raw.candidates.map(decodeNode),exhaustive:raw.exhaustive};
    }
    case 'stopped': {
      const raw=object(value,['status','reason']);
      return {status:'stopped',reason:oneOf(raw.reason,['cancelled','deadline','budget'] as const)};
    }
    default: throw new MathInputProblem('syntax','数式の計算状態が不正です。');
  }
}

/** The Worker parses source and verifies its AST. The UI validates scope/shape and exact source identity. */
export function decodeMathWorkReply(value: unknown, request: MathWorkRequest, context: NodeContext): {
  readonly serial:number;readonly result:MathWorkResult;
} {
  const raw=object(value,['kind','serial','identity','source','notation','angleUnit','expression','evaluation',
    ...(request.presentationNotation === undefined ? [] : ['presentation']),
    ...(request.renameCoefficient === undefined ? [] : ['renamedDefinition'])]);
  if(raw.kind!=='math-result'||typeof raw.serial!=='number'||!Number.isSafeInteger(raw.serial)||raw.serial<1
    ||!sameMathIdentity(decodeMathRequestIdentity(raw.identity),request.identity)||raw.source!==request.source
    ||raw.notation!==request.notation||raw.angleUnit!==request.angleUnit) {
    throw new MathInputProblem('syntax','現在の入力と計算結果が一致しません。');
  }
  const remaining={nodes:MATH_INPUT_LIMITS.nodes*8};
  let definition:StoredMathExpression|null=null;
  if(raw.expression!==null) {
    budgetNodes(raw.expression,remaining);
    definition={format:MATH_INPUT_FORMAT,source:request.source,inputNotation:request.notation,angleUnit:request.angleUnit,
      expression:decodeStoredMathNode(raw.expression,context)};
  }
  const evaluation=decodeMathEvaluation(raw.evaluation,context,remaining);
  if (evaluation.status === 'value' && (evaluation.kind === 'series' || evaluation.kind === 'transform' || evaluation.kind === 'fourier-series' || evaluation.kind === 'equation-system' || evaluation.kind === 'root-intervals' || evaluation.kind === 'ode-solutions')
    && (definition === null || !sameMathMeaning(evaluation.expression, definition.expression))) {
    throw new MathInputProblem('syntax', '級数の元の式と現在の入力が一致しません。');
  }
  if(request.functionScope!==undefined) {
    if(definition!==null)assertMathVariableScope(definition.expression,request.functionScope);
    if(evaluation.status==='value'&&(evaluation.kind!=='function'||definition===null
      ||!sameMathMeaning(evaluation.expression,definition.expression))) {
      throw new MathInputProblem('syntax','関数の原式と確認した定義が一致しません。');
    }
  }
  if(definition===null&&evaluation.status!=='invalid'&&evaluation.status!=='stopped')throw new MathInputProblem('syntax','計算結果の元の式がありません。');
  let presentation: StoredMathExpression | null = null;
  if (request.presentationNotation !== undefined && raw.presentation !== null) {
    budgetNodes(raw.presentation, remaining);
    presentation = decodeStoredMathStructure(raw.presentation, context);
    if (definition === null || presentation.inputNotation !== request.presentationNotation
      || presentation.angleUnit !== request.angleUnit || !sameMathMeaning(definition.expression, presentation.expression)) {
      throw new MathInputProblem('syntax', '入力方式の変更前後で数式の意味が一致しません。');
    }
  }
  if (request.presentationNotation !== undefined && presentation === null && evaluation.status === 'value') {
    throw new MathInputProblem('syntax', '数式の変換結果がありません。');
  }
  let renamedDefinition: StoredMathExpression | null = null;
  if (request.renameCoefficient !== undefined && raw.renamedDefinition !== null) {
    budgetNodes(raw.renamedDefinition, remaining);
    renamedDefinition = decodeStoredMathStructure(raw.renamedDefinition, context);
    const rename = request.renameCoefficient;
    const expectedLabels = new Map(request.coefficients.map(coefficient =>
      [coefficient.id, coefficient.id === rename.id ? rename.label : coefficient.label]));
    if (definition === null || renamedDefinition.inputNotation !== request.notation
      || renamedDefinition.angleUnit !== request.angleUnit || !sameMathMeaning(definition.expression, renamedDefinition.expression)
      || collectMathCoefficients(renamedDefinition.expression).some(reference => expectedLabels.get(reference.id) !== reference.label)) {
      throw new MathInputProblem('syntax', '係数の改名前後で参照先または数式の意味が一致しません。');
    }
  }
  if (request.renameCoefficient !== undefined && evaluation.status === 'value') {
    throw new MathInputProblem('syntax', '係数の改名結果を作図用の数値として使用できません。');
  }
  return {serial:raw.serial,result:{definition,evaluation,
    ...(request.renameCoefficient === undefined ? {} : { renamedDefinition }),
    ...(request.presentationNotation === undefined ? {} : { presentation })}};
}
