/** Keep both the original text and its meaning: the Worker verifies the composed equation again. */
import {validateMathSource,type MathAxis,type StoredMathExpression} from './mathInputContract.js';

export function functionCoordinateEquation(definition:StoredMathExpression,output:MathAxis):StoredMathExpression {
  const source=definition.inputNotation==='latex'?`${output}-\\left(${definition.source}\\right)`:`${output}-(${definition.source})`;
  validateMathSource(source);
  return {...definition,source,expression:{kind:'operation',operation:'subtract',operands:[
    {kind:'symbol',reference:{role:'axis',name:output}},definition.expression,
  ]}};
}
