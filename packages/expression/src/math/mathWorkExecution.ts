/** Synchronous Worker-owned evaluation. The outer client separately enforces termination deadlines. */
export { executeFunctionPointContinuationWork } from './functionPointContinuationWorkExecution.js';
import {MathInputProblem,type MathNode,type MathEvaluation,type MathOperationDefinition,type StoredMathExpression,MATH_INPUT_FORMAT} from './mathInputContract.js';
import {decodeMathWorkEnvelope} from './mathWorkRequest.js';
import {parseMathText} from './mathTextSyntax.js';
import {decodeMathJson} from './decodeMathJson.js';
import {decodeStoredMath} from './decodeStoredMath.js';
import {convertMathNotation,displayMathJson,type DisplayMathJson} from './mathNotationConversion.js';
import {formatMathText} from './formatMathText.js';
import {prepareMathCalculation} from './prepareMathCalculation.js';
import {type MathBackendBox} from './numericMathBoundary.js';
import {evaluatePreparedScalarMath} from './evaluatePreparedScalarMath.js';
import type {EngineMathJson} from './encodeMathJson.js';
import type {MathWorkRequest} from './mathWorkerClient.js';
import {renameMathCoefficient} from './mathExpressionReferences.js';
import {coefficientExpressionMap,substituteCoefficientExpressions} from './mathCoefficientExpression.js';

export interface MathExecutionBackend {
  /** Parse raw LaTeX only. No canonicalization, evaluation, bindings, or ambient name assignment. */
  readonly parseLatex:(source:string)=>unknown;
  readonly serializeLatex:(expression:DisplayMathJson)=>string;
  readonly operations:ReadonlyMap<string,MathOperationDefinition>;
  readonly operationsById:ReadonlyMap<string,MathOperationDefinition>;
  /** Backend is configured for JIT off, radians, finite precision/iteration/recursion before use. */
  readonly box:(expression:EngineMathJson)=>MathBackendBox;
  readonly withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T)=>T;
}
export interface MathExecutionReply {
  readonly kind:'math-result';readonly serial:number;readonly identity:MathWorkRequest['identity'];
  readonly source:string;readonly notation:MathWorkRequest['notation'];readonly angleUnit:MathWorkRequest['angleUnit'];
  readonly expression:MathNode|null;readonly evaluation:MathEvaluation;
  readonly presentation?: StoredMathExpression | null;
  readonly renamedDefinition?: StoredMathExpression | null;
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
    ...(request.renameCoefficient === undefined ? {} : { renamedDefinition })});
  try {
    return backend.withinDeadline(()=>{
      const names={axes:new Set(request.functionScope?.axes??[]),parameters:new Set(request.functionScope?.parameters??[]),declared:[],
        coefficients:request.coefficients.map(coefficient=>({role:'coefficient' as const,id:coefficient.id,label:coefficient.label}))};
      const options={names,operations:backend.operations,scalarCoefficientIds:new Set(request.coefficients.map(coefficient=>coefficient.id))};
      const parseSource=(source:string,notation:'text'|'latex'):MathNode=>notation==='text'?parseMathText(source,options)
        :decodeMathJson(backend.parseLatex(source),{...options,allowRenderedProducts:true,
          // No blanket multiply inference: the type-directed product UI must supply any ambiguous choice.
        });
      expression=request.definition===undefined?parseSource(request.source,request.notation)
        :decodeStoredMath(request.definition,{operationsById:backend.operationsById,
          coefficientIds:new Set(request.coefficients.map(coefficient=>coefficient.id)),declaredIds:new Set(),parseSource}).expression;
      if (request.renameCoefficient !== undefined && request.definition !== undefined) {
        const rename = request.renameCoefficient;
        const renamedOptions = { ...options, names: { ...names, coefficients: names.coefficients.map(coefficient =>
          coefficient.id === rename.id ? { ...coefficient, label: rename.label } : coefficient) } };
        renamedDefinition = renameMathCoefficient({ ...request.definition, expression }, rename.id, rename.label, {
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
          angleUnit: request.angleUnit, expression: converted.expression };
      }
      const substituted=substituteCoefficientExpressions(expression,coefficientExpressionMap(request.coefficients,request.angleUnit));
      const prepared=prepareMathCalculation(substituted,{angleUnit:request.angleUnit,resolve:()=>null});
      if(request.functionScope!==undefined)return reply({status:'value',kind:'function',expression});
      if(prepared.status==='unresolved')return reply({status:'unresolved',reason:'missing-condition',names:prepared.operations});
      const started=performance.now();
      return reply(evaluatePreparedScalarMath(prepared.expression,expression,{backend,angleUnit:request.angleUnit,
        shouldStop:()=>performance.now()-started>=200?'deadline':undefined}));
    });
  }catch(error) {
    if(error instanceof MathInputProblem) {
      if(error.code==='budget')return reply({status:'stopped',reason:'budget'});
      return reply({status:'invalid',reason:error.code==='forbidden'?'unsupported':error.code,detail:error.message});
    }
    return reply({status:'invalid',reason:'unsupported',detail:'この式の結果を決定できませんでした。入力と条件を確認してください。'});
  }
}
