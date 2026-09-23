/** Taylor coefficients in amplitude of parameter-differentiated Legendre integrands.
 * Coefficients enclose f^(k)/k! throughout the supplied box. No divided m/n
 * recurrence is used: m=0 and n=0 retain their ordinary analytic values.
 */
import { type Range,ONE,ZERO,point,add,sub,mul,div,root,neg,sq,UnprovedEllipticRange } from './ellipticJetArithmetic.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';
import { trigonometricInterval } from './trigonometricIntervals.js';

type Series=readonly Range[];
export type EllipticFamily='K'|'E'|'Pi';
export const MAX_ELLIPTIC_PARTIAL_ORDER=17;
const constant=(value:Range,order:number):Series=>[value,...Array<Range>(order).fill(ZERO)];
function multiply(a:Series,b:Series):Series {
  return a.map((_,k)=>{
    let result=ZERO;
    for(let j=0;j<=k;j++)result=add(result,mul(a[j],b[k-j]));
    return result;
  });
}
const scale=(a:Series,value:Range):Series=>a.map(x=>mul(x,value));
function inverse(a:Series):Series {
  const output=[div(ONE,a[0])];
  for(let k=1;k<a.length;k++) {
    let sum=ZERO;for(let j=1;j<=k;j++)sum=add(sum,mul(a[j],output[k-j]));
    output.push(neg(mul(output[0],sum)));
  }
  return output;
}
function squareRoot(a:Series):Series {
  if(a[0].lower<=0)throw new UnprovedEllipticRange();
  const output=[root(a[0])],denominator=mul(point(2),output[0]);
  for(let k=1;k<a.length;k++) {
    let sum=ZERO;for(let j=1;j<k;j++)sum=add(sum,mul(output[j],output[k-j]));
    output.push(div(sub(a[k],sum),denominator));
  }
  return output;
}
function power(a:Series,exponent:number):Series {
  let output=constant(ONE,a.length-1),base=a,remaining=exponent;
  while(remaining>0) {
    if(remaining%2===1)output=multiply(output,base);
    remaining=Math.floor(remaining/2);if(remaining>0)base=multiply(base,base);
  }
  return output;
}
export function ellipticFactorial(order:number):bigint {
  if(!Number.isSafeInteger(order)||order<0||order>MAX_ELLIPTIC_PARTIAL_ORDER)throw new UnprovedEllipticRange();
  let result=1n;for(let k=2;k<=order;k++)result*=BigInt(k);return result;
}
function rational(numerator:bigint,denominator=1n):Range {
  const result=exactDoubleInterval({numerator,denominator});
  if(result===null)throw new UnprovedEllipticRange();return result;
}
function sineCoefficients(phi:Range,order:number,degree:boolean):Series {
  const sine=trigonometricInterval(phi,false,degree),cosine=trigonometricInterval(phi,true,degree);
  if(sine.status!=='range'||cosine.status!=='range')throw new UnprovedEllipticRange();
  const cycle=[sine.interval,cosine.interval,neg(sine.interval),neg(cosine.interval)];
  return Array.from({length:order+1},(_,k)=>mul(cycle[k%4],rational(1n,ellipticFactorial(k))));
}
/** p in m and q in n; coefficients include 1/k! and differentiate in radians.
 * degree affects only the input angle; its chain factor is applied by callers. */
export function ellipticIntegrand(family:EllipticFamily,m:Range,n:Range,phi:Range,p:number,q:number,order:number,degree=false):Series {
  if(![p,q,order].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=MAX_ELLIPTIC_PARTIAL_ORDER)
    ||p+q>MAX_ELLIPTIC_PARTIAL_ORDER)throw new UnprovedEllipticRange();
  if(q>0&&family!=='Pi')return constant(ZERO,order);
  const sine=sineCoefficients(phi,order,degree),squared=multiply(sine,sine),s2=[sq(sine[0]),...squared.slice(1)];
  const a=scale(s2,neg(m)).map((x,k)=>k===0?add(ONE,x):x);
  const b=scale(s2,neg(n)).map((x,k)=>k===0?add(ONE,x):x);
  const r=squareRoot(a);
  let result:Series;
  let coefficient=1n;
  if(family==='E'&&p===0)result=r;
  else {
    const exponent=family==='E'?p-1:p;
    result=multiply(inverse(r),power(inverse(a),exponent));
    for(let i=0;i<p;i++)coefficient*=BigInt(family==='E'?2*i-1:2*i+1);
  }
  if(family==='Pi') {
    if(b[0].lower<=0)throw new UnprovedEllipticRange();
    result=multiply(result,power(inverse(b),q+1));
    coefficient*=ellipticFactorial(q);
  }
  if(p+q>0)result=multiply(result,power(s2,p+q));
  return scale(result,rational(coefficient,1n<<BigInt(p)));
}
