import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createFunctionMathSource, createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { decodeMathWorkReply, type MathNode } from '@pointercad/expression/math/contracts';
import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from '../functionGeometry/functionDefinitionTypes.js';
import { checkGeometryDerivedOperations, mathGeometryOperationMessage } from './mathGeometryCoefficients.js';
import { checkGeometryDerivedFunctionOperations } from './mathGeometryFunctionOperations.js';

const backend = createMathBackend();
const coefficients = [{ id: 'coefficient:1', label: 'R', decimal: '10' }];
const derived = new Set(['coefficient:1']);
function expression(source: string): MathNode {
  const request = { source, coefficients, notation: 'text' as const, angleUnit: 'degree' as const,
    identity: { documentId: 'integrals', documentVersion: 1, editorId: 'test', inputRevision: 1 } };
  const reply = decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: backend.operationsById, coefficientIds: derived, declaredIds: new Set() }).result;
  if (reply.definition === null) throw new Error(JSON.stringify(reply.evaluation));
  return reply.definition.expression;
}
function plot(source: string): FunctionDefinition {
  const parse = (input: string) => createFunctionMathSource(input, 'text', 'degree', { axes: ['X'], parameters: [], coefficients }, backend);
  const bounds = { min: expressionValueFromNumber(0), max: expressionValueFromNumber(1) };
  return { format: FUNCTION_DEFINITION_FORMAT, bounds: { X: bounds, Y: bounds, Z: bounds }, tolerance: expressionValueFromNumber(0.01),
    formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: parse(source), Z: parse('0') } } };
}

const accepted = [
  'lineintegral(coef("R"),[x],[t],t,0,1)',
  'lineintegral(1,[x],[coef("R")*t],t,0,1)',
  'lineintegral(1,[x],[t],t,coef("R"),2*coef("R"))',
  'lineintegral(coef("R")*R,[R],[R],R,0,1)',
  'circulation([coef("R"),0],[x,y],[t,0],t,0,1)',
  'surfaceintegral(coef("R"),[x,y,z],[u,v,0],[u,v],[0,0],[1,1])',
  'surfaceintegral(1,[x,y,z],[coef("R")*u,v,0],[u,v],[0,0],[1,1])',
  'surfaceintegral(1,[x,y,z],[u,v,0],[u,v],[coef("R"),0],[2*coef("R"),1])',
  'fluxintegral([0,0,coef("R")],[x,y,z],[u,v,0],[u,v],[0,0],[1,1])',
  'volumeintegral(1,[x,y,z],[coef("R")*u,v,w],[u,v,w],[0,0,0],[1,1,1])',
  'closedlineintegral(coef("R"),[x,y],[cos(t),sin(t)],t,0,360)',
  'closedcirculation([-y,x],[x,y],[coef("R")*cos(t),coef("R")*sin(t)],t,0,360)',
  'closedsurfaceintegral(coef("R"),[x,y,z],[sin(u)*cos(v),sin(u)*sin(v),cos(u)],[u,v],[0,0],[180,360])',
  'closedfluxintegral([0,0,coef("R")],[x,y,z],[sin(u)*cos(v),sin(u)*sin(v),cos(u)],[u,v],[0,0],[180,360])',
  'lineintegral(surfaceintegral(coef("R"),[x,y,z],[u,v,0],[u,v],[0,0],[1,1]),[x],[t],t,0,1)',
];
describe('Q10: 積分の場と座標式だけに局所関数を許可する', () => {
  it.each(accepted)('%s を係数の式と関数の式の同じ規則で受理する', source => {
    expect(checkGeometryDerivedOperations(expression(source))).toBeNull();
    expect(checkGeometryDerivedFunctionOperations(plot(`${source}+X`), derived)).toBeNull();
  });

  it.each([
    ['lineintegral(floor(coef("R")),[x],[t],t,0,1)', 'floor', 'floor'],
    ['lineintegral(1,[x],[round(coef("R"))*t],t,0,1)', 'round', 'round'],
    ['lineintegral(1,[x],[t],t,ceil(coef("R")),20)', 'ceiling', 'ceil'],
    ['lineintegral(1,[x],[t],t,0,floor(coef("R")))', 'floor', 'floor'],
    ['lineintegral(floor(x),[x],[coef("R")*t],t,0,1)', 'floor', 'floor'],
    ['lineintegral(1,[x],[floor(t)],t,0,coef("R"))', 'floor', 'floor'],
    ['surfaceintegral(floor(x),[x,y,z],[coef("R")*u,v,0],[u,v],[0,0],[1,1])', 'floor', 'floor'],
    ['surfaceintegral(1,[x,y,z],[u,v,0],[u,v],[0,0],[round(coef("R")),1])', 'round', 'round'],
    ['lineintegral(sum(coef("R")*k,k,1,3),[x],[t],t,0,1)', 'sum', 'sum'],
    ['lineintegral(1,[x],[t],t,0,surfaceintegral(floor(coef("R")),[x,y,z],[u,v,0],[u,v],[0,0],[1,1]))', 'floor', 'floor'],
  ])('%s の不連続演算を積分内でも隠さない', (source, operation, name) => {
    const issue = { operation, message: mathGeometryOperationMessage(name) };
    expect(checkGeometryDerivedOperations(expression(source))).toEqual(issue);
    expect(checkGeometryDerivedFunctionOperations(plot(`${source}+X`), derived)).toEqual({ ...issue, output: 'Y' });
  });

  it('関数作図の座標だけの不連続演算と、測定値の不連続演算を混同しない', () => {
    expect(checkGeometryDerivedFunctionOperations(plot('floor(X)+lineintegral(coef("R"),[x],[t],t,0,1)'), derived)).toBeNull();
    expect(checkGeometryDerivedFunctionOperations(plot('sum(X^k,k,1,3)+coef("R")'), derived)).toBeNull();
    expect(checkGeometryDerivedFunctionOperations(plot('floor(lineintegral(coef("R"),[x],[t],t,0,1))+X'), derived))
      .toEqual({ operation: 'floor', message: mathGeometryOperationMessage('floor'), output: 'Y' });
  });

  it('局所関数を単独・上下限・異なる束縛の場所へ移しても許可しない', () => {
    const integral = expression(accepted[0]);
    if (integral.kind !== 'operation' || integral.operands[0].kind !== 'binder') throw new Error('Expected an integral with a field');
    const field = integral.operands[0];
    expect(checkGeometryDerivedOperations(field)?.operation).toBe('lambda');
    expect(checkGeometryDerivedOperations({ ...integral, operands: [...integral.operands.slice(0, 3), field] })?.operation).toBe('lambda');
    const ranged = { ...field, bindings: field.bindings.map(binding => ({ ...binding,
      domain: { kind: 'range' as const, lower: { kind: 'number' as const, decimal: '0' },
        upper: { kind: 'number' as const, decimal: '1' }, step: null } })) };
    expect(checkGeometryDerivedOperations({ ...integral, operands: [ranged, ...integral.operands.slice(1)] })?.operation).toBe('line-integral');
    expect(checkGeometryDerivedOperations({ ...integral, operands: integral.operands.slice(0, 3) })?.operation).toBe('line-integral');
  });
});
