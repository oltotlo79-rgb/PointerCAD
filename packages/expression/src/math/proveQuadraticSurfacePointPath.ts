/** A quadratic level's isolated extremum must stay on that level for the entire edit.
 * The exact identity 2 det(H) f = adj(H)[d,e]·[d,e] proves its critical value is zero.
 * A definite Hessian and its exact stationary-point formula prevent loss, splitting, or leaving U/V bounds.
 */
import {exactAdd,exactMultiply,exactDivide,exactNegative,EXACT_ZERO,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {coordinatePolynomialInterval} from './coordinatePolynomialInterval.js';
import type {proveBivariatePointPath} from './proveBivariatePointPath.js';
import {exactDouble,exactDoubleInterval} from './exactDoubleInterval.js';
import type {ExactRational} from './exactRational.js';
import {intervalDivide} from './mathInterval.js';

type Polynomial=readonly ExactRational[];
class Unproved extends Error {}

export function proveQuadraticSurfacePointPath(polynomial:CoordinatePolynomial,
  input:Parameters<typeof proveBivariatePointPath>[1],shouldStop:Parameters<typeof proveBivariatePointPath>[2]):boolean|'cancelled'|'deadline' {
  let remaining=16_384;
  function check(){if(--remaining<0||shouldStop()!==undefined)throw new Unproved();}
  function require(value:ExactRational|null):ExactRational {check();if(value===null)throw new Unproved();return value;}
  const trim=(values:ExactRational[]):Polynomial=>{while(values.length>0&&values[values.length-1].numerator===0n)values.pop();return values;};
  const add=(a:Polynomial,b:Polynomial):Polynomial=>trim(Array.from({length:Math.max(a.length,b.length)},(_,index)=>
    require(exactAdd(a[index]??EXACT_ZERO,b[index]??EXACT_ZERO))));
  const subtract=(a:Polynomial,b:Polynomial)=>add(a,b.map(exactNegative));
  function multiply(a:Polynomial,b:Polynomial):Polynomial {
    if(a.length===0||b.length===0)return [];
    if(a.length+b.length>14)throw new Unproved();
    const result:ExactRational[]=Array.from({length:a.length+b.length-1},()=>EXACT_ZERO);
    for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)result[i+j]=require(exactAdd(result[i+j],require(exactMultiply(a[i],b[j]))));
    return trim(result);
  }
  const twice=(a:Polynomial)=>add(a,a);
  try {
    const groups=new Map<string,ExactRational[]>();
    for(const [key,value] of polynomial){
      check();if(!/^[0-4],[0-4],[0-4]$/u.test(key))return false;
      const [u,v,t]=key.split(',').map(Number);if(u+v>2)return false;
      const name=`${u},${v}`,group=groups.get(name)??[];
      while(group.length<=t)group.push(EXACT_ZERO);group[t]=value;groups.set(name,group);
    }
    const [a,b,c,d,e,f]=['2,0','1,1','0,2','1,0','0,1','0,0'].map(key=>groups.get(key)??[]);
    const aa=twice(a),cc=twice(c),determinant=subtract(multiply(aa,cc),multiply(b,b));
    const correction=add(subtract(multiply(cc,multiply(d,d)),twice(multiply(b,multiply(d,e)))),multiply(aa,multiply(e,e)));
    if(subtract(twice(multiply(determinant,f)),correction).length!==0)return false;
    // Only the sign proof uses intervals. Exact cancellation above never relies on a small decimal residual.
    const progressPolynomial=(values:Polynomial):CoordinatePolynomial=>new Map(values.flatMap((value,index)=>
      value.numerator===0n?[]:[[ `0,0,${index}`,value] as const]));
    const leading=progressPolynomial(aa),det=progressPolynomial(determinant),zero={lower:0,upper:0};
    let definite=false;
    for(const slices of [1,4,16,64]){
      let sign=0,complete=true;
      for(let index=0;index<slices;index++){
        check();const progress={lower:index/slices,upper:(index+1)/slices};
        const first=coordinatePolynomialInterval(leading,[zero,zero,progress]);
        const second=coordinatePolynomialInterval(det,[zero,zero,progress]);
        const next=first===null?0:first.lower>0?1:first.upper<0?-1:0;
        if(next===0||second===null||second.lower<=0||sign!==0&&sign!==next){complete=false;break;}sign=next;
      }
      if(complete){definite=true;break;}
    }
    if(!definite)return false;
    const numerators=[subtract(multiply(b,e),multiply(cc,d)),subtract(multiply(b,d),multiply(aa,e))];
    const at=(values:Polynomial,endpoint:0|1):ExactRational=>endpoint===0?values[0]??EXACT_ZERO:
      values.reduce((total,value)=>require(exactAdd(total,value)),EXACT_ZERO);
    // Verify that both selected endpoint boxes contain this exact critical point.
    // A different rectangle-corner level point cannot authorize its continuation.
    for(const endpoint of [0,1] as const)for(const axis of [0,1] as const){
      const value=require(exactDivide(at(numerators[axis],endpoint),at(determinant,endpoint)));
      const range=exactDoubleInterval(value),anchor=(endpoint===0?input.before:input.after)[axis];
      if(range===null||range.lower<anchor.lower||range.upper>anchor.upper)return false;
    }
    // Correlated U/V terms cancel exactly in these numerators. An axis-by-axis
    // Newton prediction could instead needlessly widen a stationary V coordinate.
    const inequalities=numerators.flatMap((numerator,axis)=>{
      const low=require(exactDouble(input.domain[axis].lower)),high=require(exactDouble(input.domain[axis].upper));
      return [subtract(numerator,multiply([low],determinant)),subtract(multiply([high],determinant),numerator)].map(progressPolynomial);
    });
    for(const slices of [1,4,16,64]){
      let complete=true;
      for(let index=0;index<slices;index++){
        check();const progress={lower:index/slices,upper:(index+1)/slices};
        if(inequalities.some(polynomial=>{const range=coordinatePolynomialInterval(polynomial,[zero,zero,progress]);return range===null||range.lower<0;})){
          complete=false;break;
        }
        if(input.contains){
          const denominator=coordinatePolynomialInterval(det,[zero,zero,progress]);
          const bounds=numerators.map(numerator=>{
            const value=coordinatePolynomialInterval(progressPolynomial(numerator),[zero,zero,progress]);
            const divided=value===null||denominator===null?null:intervalDivide(value,denominator);
            return divided?.status==='range'?divided.interval:null;
          });
          const [u,v]=bounds;if(u===null||v===null||!input.contains([u,v],progress)){complete=false;break;}
        }
      }
      if(complete)return true;
    }
    return false;
  }catch(error){if(error instanceof Unproved)return shouldStop()??false;throw error;}
}
