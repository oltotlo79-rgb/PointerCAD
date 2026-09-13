/** Bounded exact coordinate polynomials. No variable division, cancellation of domains, or approximate zero. */
import {decimalRational,rational,rationalOfExpression,type ExactRational} from './exactRational.js';
import {MATH_INPUT_LIMITS,type MathNode} from './mathInputContract.js';

export type CoordinatePolynomial=ReadonlyMap<string,ExactRational>;
export const EXACT_ZERO:ExactRational={numerator:0n,denominator:1n};
export const EXACT_ONE:ExactRational={numerator:1n,denominator:1n};
export function exactAdd(a:ExactRational,b:ExactRational):ExactRational|null{return rational(a.numerator*b.denominator+b.numerator*a.denominator,a.denominator*b.denominator);}
export function exactMultiply(a:ExactRational,b:ExactRational):ExactRational|null{return rational(a.numerator*b.numerator,a.denominator*b.denominator);}
export function exactDivide(a:ExactRational,b:ExactRational):ExactRational|null{return rational(a.numerator*b.denominator,a.denominator*b.numerator);}
export function exactNegative(a:ExactRational):ExactRational{return {numerator:-a.numerator,denominator:a.denominator};}
export function sameExact(a:ExactRational,b:ExactRational):boolean{return a.numerator===b.numerator && a.denominator===b.denominator;}
const CONSTANT='0,0,0';
function constant(value:ExactRational):CoordinatePolynomial{return new Map(value.numerator===0n?[]:[[CONSTANT,value]]);}

export function exactCoordinatePolynomial(expression:MathNode,coefficients:ReadonlyMap<string,string|MathNode>,shouldStop:()=>boolean):CoordinatePolynomial|null {
  let operations=20_000,nodes=MATH_INPUT_LIMITS.nodes;
  const insert=(target:Map<string,ExactRational>,key:string,value:ExactRational):boolean=>{
    if(--operations<0 || shouldStop()) return false;
    const previous=target.get(key)??EXACT_ZERO,total=exactAdd(previous,value);if(total===null) return false;
    if(total.numerator===0n) target.delete(key);else target.set(key,total);return target.size<=35;
  };
  const add=(a:CoordinatePolynomial,b:CoordinatePolynomial):CoordinatePolynomial|null=>{
    const result=new Map(a);for(const [key,value] of b) if(!insert(result,key,value)) return null;return result;
  };
  const multiply=(a:CoordinatePolynomial,b:CoordinatePolynomial):CoordinatePolynomial|null=>{
    const result=new Map<string,ExactRational>();
    for(const [first,left] of a) for(const [second,right] of b){
      const a=first.split(',').map(Number),b=second.split(',').map(Number),powers=a.map((value,axis)=>value+b[axis]);
      if(powers.reduce((sum,value)=>sum+value,0)>4) return null;
      const coefficient=exactMultiply(left,right);if(coefficient===null || !insert(result,powers.join(','),coefficient)) return null;
    }
    return result;
  };
  function visit(node:MathNode,depth:number):CoordinatePolynomial|null {
    if(--nodes<0 || depth>MATH_INPUT_LIMITS.depth || shouldStop()) return null;
    if(node.kind==='number'){const value=decimalRational(node.decimal);return value===null?null:constant(value);}
    if(node.kind==='symbol'){
      if(node.reference.role==='axis') return new Map([[node.reference.name==='X'?'1,0,0':node.reference.name==='Y'?'0,1,0':'0,0,1',EXACT_ONE]]);
      if(node.reference.role!=='coefficient') return null;
      const source=coefficients.get(node.reference.id);
      const value=source===undefined?null:typeof source==='string'?decimalRational(source):rationalOfExpression(source);
      return value===null?null:constant(value);
    }
    if(node.kind!=='operation') return null;
    // Visit all operands even when a zero factor is present. Undefined/divergent subexpressions cannot vanish here.
    const operands:CoordinatePolynomial[]=[];
    for(const operand of node.operands){const result=visit(operand,depth+1);if(result===null) return null;operands.push(result);}
    const [first,second]=operands;
    if(node.operation==='add' || node.operation==='multiply'){
      let result:CoordinatePolynomial=node.operation==='add'?constant(EXACT_ZERO):constant(EXACT_ONE);
      for(const operand of operands){const next=node.operation==='add'?add(result,operand):multiply(result,operand);if(next===null) return null;result=next;}
      return result;
    }
    if(node.operation==='negate' && first && operands.length===1) return new Map([...first].map(([key,value])=>[key,exactNegative(value)]));
    if(node.operation==='subtract' && first && second && operands.length===2) return add(first,new Map([...second].map(([key,value])=>[key,exactNegative(value)])));
    if(node.operation==='divide' && first && second && operands.length===2 && second.size===1){
      const denominator=second.get(CONSTANT);if(denominator===undefined || denominator.numerator===0n) return null;
      const inverse=exactDivide(EXACT_ONE,denominator);return inverse===null?null:multiply(first,constant(inverse));
    }
    if(first && (node.operation==='square' && operands.length===1 || node.operation==='power' && operands.length===2)){
      if(first.size===0 || first.size===1 && first.has(CONSTANT)) {
        const value=rationalOfExpression(node, symbol=>{
          if(symbol.reference.role!=='coefficient') return null;
          const source=coefficients.get(symbol.reference.id);
          return source===undefined?null:typeof source==='string'?decimalRational(source):rationalOfExpression(source);
        });
        return value===null?null:constant(value);
      }
      const exponent=node.operation==='square'?{numerator:2n,denominator:1n}:second?.get(CONSTANT);
      if(exponent===undefined || exponent.denominator!==1n || exponent.numerator<1n || exponent.numerator>4n || (second && second.size!==1)) return null;
      let result:CoordinatePolynomial=first;
      for(let index=1;index<Number(exponent.numerator);index++){const next=multiply(result,first);if(next===null) return null;result=next;}
      return result;
    }
    return null;
  }
  return visit(expression,0);
}
