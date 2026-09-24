/** Synchronous Worker-owned evaluation. The outer client separately enforces termination deadlines. */
export { executeFunctionPointContinuationWork } from './functionPointContinuationWorkExecution.js';
import {MathInputProblem,type MathNode,type MathEvaluation,type MathOperationDefinition,type StoredMathExpression,MATH_INPUT_FORMAT,MATH_INPUT_LIMITS} from './mathInputContract.js';
import {createMathWorkEnvelope, decodeMathWorkEnvelope} from './mathWorkRequest.js';
import {parseMathText} from './mathTextSyntax.js';
import {decodeMathJson} from './decodeMathJson.js';
import {decodeStoredMath} from './decodeStoredMath.js';
import {convertMathNotation,displayMathJson,type DisplayMathJson} from './mathNotationConversion.js';
import {formatMathText} from './formatMathText.js';
import {prepareMathCalculation,prepareExactMathCalculation} from './prepareMathCalculation.js';
import {type MathBackendBox} from './numericMathBoundary.js';
import {evaluatePreparedScalarMath} from './evaluatePreparedScalarMath.js';
import type {EngineMathJson} from './encodeMathJson.js';
import type {MathWorkRequest} from './mathWorkerClient.js';
import {renameMathCoefficient, renameMathDeclaration} from './mathExpressionReferences.js';
import {coefficientExpressionMap,substituteCoefficientExpressions} from './mathCoefficientExpression.js';
import {hasInfiniteDiscreteRange} from './discreteMathDomains.js';
import {requiresExactCalculus} from './mathExactCalculus.js';
import {prepareFunctionVectorCalculus} from './prepareFunctionCalculus.js';
import {resolveNumericalRoots} from './numericalRoots.js';
import type { PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { PreparedOdeFunction } from './odeFunctionLowering.js';
import { containsOdeProblem } from './odeFunctionLowering.js';
import { referencedMathDeclarations, scalarMathDeclarationIds } from './mathDeclarations.js';
import { assertMathDeclarationUsage } from './mathDeclarationUsage.js';
import { checkMathDeclaredValue, mathDeclaredValueRequest, parseMathDeclaredValue } from './mathDeclaredValues.js';
import { plusMinusEvaluation } from './plusMinus.js';
import { planMathCandidates } from './absoluteValueCandidates.js';

export interface MathExecutionBackend {
  /** Present only after this geometry request's ODEs have been solved and verified. */
  readonly prepareOdeFunction?: (source: MathNode, context: PreparedScalarMathContext) => PreparedOdeFunction;
  /** Parse raw LaTeX only. No canonicalization, evaluation, bindings, or ambient name assignment. */
  readonly parseLatex:(source:string)=>unknown;
  readonly serializeLatex:(expression:DisplayMathJson)=>string;
  readonly operations:ReadonlyMap<string,MathOperationDefinition>;
  readonly operationsById:ReadonlyMap<string,MathOperationDefinition>;
  /** Backend is configured for JIT off, radians, finite precision/iteration/recursion before use. */
  readonly box:(expression:EngineMathJson)=>MathBackendBox;
  /** Classify validated input before preparation; allowances remain relative to the current request. */
  readonly prepareDeadline?: (expression: MathNode) => void;
  readonly withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T)=>T;
}
export interface MathExecutionReply {
  readonly kind:'math-result';readonly serial:number;readonly identity:MathWorkRequest['identity'];
  readonly source:string;readonly notation:MathWorkRequest['notation'];readonly angleUnit:MathWorkRequest['angleUnit'];
  readonly expression:MathNode|null;readonly evaluation:MathEvaluation;
  readonly presentation?: StoredMathExpression | null;
  readonly renamedDefinition?: StoredMathExpression | null;
}
/** integrate(f,x) without bounds anywhere (MC-20): a family of functions F+C, never one plotted value. */
function containsIndefiniteIntegral(expression:MathNode):boolean {
  const pending=[expression];let remaining=MATH_INPUT_LIMITS.nodes;
  while(pending.length>0) {
    const node=pending.pop();if(node===undefined)break;
    if(--remaining<0)throw new MathInputProblem('budget','関数の式が大きすぎます。');
    if(node.kind==='operation')pending.push(...node.operands);
    else if(node.kind==='binder') {
      if(node.operation==='integrate'&&node.bindings.some(binding=>binding.domain.kind==='unrestricted'))return true;
      pending.push(node.body);
      for(const {domain} of node.bindings) {
        if(domain.kind==='set')pending.push(domain.value);
        else if(domain.kind==='range') { pending.push(domain.lower,domain.upper);if(domain.step!==null)pending.push(domain.step); }
      }
    }
  }
  return false;
}
/** Scalar editor scope. Geometry requests will explicitly supply axes/parameters with their own validated wire type. */
export function executeMathWorkRequest(value:unknown,backend:MathExecutionBackend):MathExecutionReply {
  const {request,serial}=decodeMathWorkEnvelope(value);
  let expression:MathNode|null=null;
  let presentation: StoredMathExpression | null = null;
  let renamedDefinition: StoredMathExpression | null = null;
  const reply=(evaluation:MathEvaluation):MathExecutionReply=>({kind:'math-result',serial,identity:request.identity,
    source:request.source,notation:request.notation,angleUnit:request.angleUnit,expression,evaluation,
    ...(request.presentationNotation === undefined ? {} : { presentation }),
    ...(request.renameCoefficient === undefined && request.renameDeclaration === undefined ? {} : { renamedDefinition })});
  try {
    return backend.withinDeadline(()=>{
      const declarations = request.declarations ?? [];
      const declaredIds = new Set(declarations.map(value => value.id));
      const names={axes:new Set(request.functionScope?.axes??[]),parameters:new Set(request.functionScope?.parameters??[]),
        declared:declarations.map(value=>({role:'declared' as const,id:value.id,label:value.label})),
        coefficients:request.coefficients.map(coefficient=>({role:'coefficient' as const,id:coefficient.id,label:coefficient.label}))};
      const options={names,operations:backend.operations,scalarCoefficientIds:new Set(request.coefficients.map(coefficient=>coefficient.id)),
        scalarDeclaredIds:scalarMathDeclarationIds(declarations)};
      const parseSource=(source:string,notation:'text'|'latex'):MathNode=>notation==='text'?parseMathText(source,options)
        :decodeMathJson(backend.parseLatex(source),{...options,allowRenderedProducts:true,
          // No blanket multiply inference: the type-directed product UI must supply any ambiguous choice.
        });
      expression=request.definition===undefined?parseSource(request.source,request.notation)
        :decodeStoredMath(request.definition,{operationsById:backend.operationsById,
          coefficientIds:new Set(request.coefficients.map(coefficient=>coefficient.id)),declaredIds,parseSource}).expression;
      backend.prepareDeadline?.(expression);
      const referencedDeclarations = referencedMathDeclarations(expression, declarations);
      const rename = request.renameCoefficient ?? request.renameDeclaration;
      if (rename !== undefined && request.definition !== undefined) {
        const renamedOptions = { ...options, names: { ...names,
          coefficients: names.coefficients.map(coefficient => request.renameCoefficient !== undefined && coefficient.id === rename.id
            ? { ...coefficient, label: rename.label } : coefficient),
          declared: names.declared.map(value => request.renameDeclaration !== undefined && value.id === rename.id
            ? { ...value, label: rename.label } : value) } };
        const renameDefinition = request.renameDeclaration === undefined ? renameMathCoefficient : renameMathDeclaration;
        renamedDefinition = renameDefinition({ ...request.definition, expression }, rename.id, rename.label, {
          format: (node, notation) => notation === 'text' ? formatMathText(node, backend.operationsById)
            : backend.serializeLatex(displayMathJson(node, backend.operationsById)),
          parse: (source, notation) => notation === 'text' ? parseMathText(source, renamedOptions)
            : decodeMathJson(backend.parseLatex(source), { ...renamedOptions, allowRenderedProducts: true }),
        });
        // Renaming proves syntax and identity only. Values are re-evaluated against the completed document separately.
        return reply({ status: 'unresolved', reason: 'missing-condition', names: [] });
      }
      const target = request.presentationNotation;
      if (target !== undefined) {
        const converted = target === request.notation ? { source: request.source, expression }
          : convertMathNotation(expression,
            node => target === 'text' ? formatMathText(node, backend.operationsById) : backend.serializeLatex(displayMathJson(node, backend.operationsById)),
            source => parseSource(source, target));
        presentation = { format: MATH_INPUT_FORMAT, source: converted.source, inputNotation: target,
          angleUnit: request.angleUnit, expression: converted.expression,
          ...(request.declarations === undefined ? {} : { declarations: request.declarations }) };
      }
      // Every referenced value is checked before substitution, including operands
      // that an enclosing zero/product/component might otherwise discard.
      let withValues = expression;
      if (referencedDeclarations.length > 0) {
        assertMathDeclarationUsage(expression, declarations);
        const missing = referencedDeclarations.filter(value => value.valueSource === undefined);
        if (missing.length > 0) {
          prepareExactMathCalculation(substituteCoefficientExpressions(expression,
            coefficientExpressionMap(request.coefficients, request.angleUnit)), { angleUnit: request.angleUnit, resolve: () => null });
          return reply({ status: 'unresolved', reason: 'missing-condition', names: missing.map(value => value.label) });
        }
        const values = new Map<string, MathNode>();
        for (const declaration of referencedDeclarations) {
          if (declaration.valueSource === undefined) continue;
          // Prime the enclosing request before the nested request captures its parent deadline.
          backend.prepareDeadline?.(parseMathDeclaredValue(declaration.valueSource));
          const value = executeMathWorkRequest(createMathWorkEnvelope(serial, mathDeclaredValueRequest(request, declaration.valueSource)), backend);
          if (value.expression === null) return reply(value.evaluation);
          const problem = checkMathDeclaredValue(declaration, value.expression, value.evaluation);
          if (problem !== null) return reply(problem);
          values.set(declaration.id, value.expression);
        }
        withValues = substituteCoefficientExpressions(expression, values, 'declared');
      }
      const substituted=substituteCoefficientExpressions(withValues,coefficientExpressionMap(request.coefficients,request.angleUnit));
      backend.prepareDeadline?.(substituted);
      // |x| is read from the substituted operand's type (a function plot keeps it as written);
      // a matrix |A| and each ± or ∓ leave candidates that are never merged into one value.
      const plan = planMathCandidates(substituted, request.angleUnit, request.functionScope === undefined);
      const candidates = plan.candidates;
      if (candidates !== null && request.functionScope !== undefined) {
        return reply({ status: 'invalid', reason: 'unsupported', detail: '±・∓の符号を選んでから関数の式に使ってください。' });
      }
      if (request.functionScope !== undefined && containsIndefiniteIntegral(substituted)) {
        return reply({ status: 'invalid', reason: 'unsupported',
          detail: '不定積分は積分定数が定まらない関数の集まりのため、関数の式には使えません。原始関数を式で書き、積分定数を決めてください（例 integrate(X^2,X) の代わりに X^3/3+1）。' });
      }
      const source = plan.rewritten ? plan.expression : expression;
      const evaluate = (candidate: MathNode): MathEvaluation => {
        let substituted = candidate;
        if(request.functionScope===undefined) {
          const numericalStarted = performance.now();
          const numerical=resolveNumericalRoots(substituted,candidates === null ? source : candidate,{backend,angleUnit:request.angleUnit,
            shouldStop:()=>performance.now()-numericalStarted>=200?'deadline':undefined});
          if(numerical.evaluation!==undefined)return numerical.evaluation;
          substituted=numerical.expression;
        }
        const vector = request.functionScope === undefined ? null : prepareFunctionVectorCalculus(substituted,
          [...request.functionScope.axes, ...request.functionScope.parameters], request.angleUnit);
        const prepare=request.functionScope!==undefined && containsOdeProblem(substituted)?prepareExactMathCalculation:prepareMathCalculation;
        const prepared=prepare(vector?.expression ?? substituted,{angleUnit:request.angleUnit,resolve:()=>null});
        if(request.functionScope!==undefined)return {status:'value',kind:'function',expression:source};
        if(prepared.status==='unresolved')return {status:'unresolved',reason:'missing-condition',names:prepared.operations};
        if(hasInfiniteDiscreteRange(prepared.expression)||requiresExactCalculus(prepared.expression))return {status:'unresolved',reason:'unevaluated',names:[]};
        // All branches remain inside the enclosing backend deadline; never renew it per candidate.
        const scalarStarted = performance.now();
        return evaluatePreparedScalarMath(prepared.expression,candidates === null ? source : candidate,{backend,angleUnit:request.angleUnit,
          shouldStop:()=>performance.now()-scalarStarted>=200?'deadline':undefined});
      };
      return reply(candidates === null ? evaluate(plan.expression)
        : plusMinusEvaluation(candidates.map(expression => ({ expression, evaluation: evaluate(expression) }))));
    });
  }catch(error) {
    if(error instanceof MathInputProblem) {
      if(error.code==='budget')return reply({status:'stopped',reason:'budget'});
      return reply({status:'invalid',reason:error.code==='forbidden'?'unsupported':error.code,detail:error.message});
    }
    return reply({status:'invalid',reason:'unsupported',detail:'この式の結果を決定できませんでした。入力と条件を確認してください。'});
  }
}
