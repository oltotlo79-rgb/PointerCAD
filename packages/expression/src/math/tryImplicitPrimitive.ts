import {readFunctionMathSource} from './functionMathSource.js';
import {exactCoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';
import {recognizeImplicitPrimitive} from './recognizeImplicitPrimitive.js';
import {implicitPrimitiveNumbers,type NumericImplicitPrimitive} from './implicitPrimitiveNumbers.js';
import type {FunctionImplicitWorkRequest} from './functionImplicitWorkRequest.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

export function tryImplicitPrimitive(request:FunctionImplicitWorkRequest,backend:MathExecutionBackend,shouldStop:()=>boolean):NumericImplicitPrimitive|null {
  if(request.nativePrimitives!==true || shouldStop()) return null;
  const source=backend.withinDeadline(()=>readFunctionMathSource(request.expression,{axes:['X','Y','Z'],parameters:[],coefficients:request.coefficients},backend));
  const polynomial=exactCoordinatePolynomial(source.expression,coefficientExpressionMap(request.coefficients),shouldStop);
  const recognized=polynomial===null?null:recognizeImplicitPrimitive(polynomial);
  return recognized===null || shouldStop()?null:implicitPrimitiveNumbers(recognized,request.tolerance);
}
