/** DLMF 19.26.18,20,22,23. Duplication plus monotonic integral bounds.
 * A remaining RF with arguments in [a,b] lies in [1/sqrt(b),1/sqrt(a)];
 * RD/RJ lie in [b^(-3/2),a^(-3/2)]. No truncated asymptotic polynomial.
 */
import { MathInputProblem } from './mathInputContract.js';
import { FIXED_ZERO, FIXED_ONE, fixedAdd, fixedSubtract, fixedMultiply, fixedDivide, fixedTimesRational,
  fixedWiden, ceilQuotient, type BesselFixedRange as Range } from './besselFixedRange.js';
import { ellipticSqrt,ellipticSquare } from './ellipticFixed.js';

const GUARD=10n**110n;
function narrow(value:Range):boolean { return value.lower>0n&&(value.upper-value.lower)*GUARD<=value.lower; }
function remaining(args:readonly Range[],third:boolean,check:()=>void):Range|null {
  const lower=args.reduce((a,b)=>a<b.lower?a:b.lower,args[0].lower);
  const upper=args.reduce((a,b)=>a>b.upper?a:b.upper,args[0].upper);
  if(lower<=0n)return null;
  const bounds={lower,upper},root=ellipticSqrt(bounds,check);
  return fixedDivide(FIXED_ONE,third?fixedMultiply(bounds,root):root);
}
function validate(args:readonly Range[],p?:Range):void {
  if(args.some(x=>x.lower<0n||x.lower>x.upper)||args.filter(x=>x.lower===0n).length>1
    ||(p!==undefined&&(p.lower<=0n||p.lower>p.upper))) {
    throw new MathInputProblem('domain','楕円積分の対称形には非負の引数と正の分母が必要です。');
  }
}
const divideFour=(a:Range)=>fixedTimesRational(a,1n,4n);
function rootsAndLambda(x:Range,y:Range,z:Range,check:()=>void) {
  const rx=ellipticSqrt(x,check),ry=ellipticSqrt(y,check),rz=ellipticSqrt(z,check);
  const lambda=fixedAdd(fixedAdd(fixedMultiply(rx,ry),fixedMultiply(ry,rz)),fixedMultiply(rz,rx));
  return {rx,ry,rz,lambda};
}
export function carlsonRF(a:Range,b:Range,c:Range,check:()=>void):Range {
  check();validate([a,b,c]);let x=a,y=b,z=c;
  for(let k=0;k<512;k++) {
    check();const enclosure=remaining([x,y,z],false,check);
    if(enclosure!==null&&narrow(enclosure))return enclosure;
    const {lambda}=rootsAndLambda(x,y,z,check);
    x=divideFour(fixedAdd(x,lambda));y=divideFour(fixedAdd(y,lambda));z=divideFour(fixedAdd(z,lambda));
  }
  throw new MathInputProblem('budget','第一種の楕円積分を必要な桁数で確定できません。');
}
/** Before the series, duplication makes |u| at most 1/RC_SERIES_RATIO. */
const RC_SERIES_RATIO=16n;
/** RC(x,y)=y^(-1/2)*sum_n c_n*u^n with u=1-x/y, c_n=binomial(2n,n)/(4^n*(2n+1)) (arcsin(s)/s for u=s^2,
 * arsinh(s)/s for u=-s^2; DLMF §19.2). Since 0<c_{n+1}<=c_n, the omitted tail after the term a_n*u^n
 * (a_n=binomial(2n,n)/4^n) is at most |a_n*u^n|*|u|/((2n+3)*(1-|u|)); that bound is added to the enclosure.
 */
function rcSeries(x:Range,y:Range,check:()=>void):Range|null {
  if(y.lower<=0n)return null;
  const u=fixedDivide(fixedSubtract(y,x),y),magnitude=-u.lower>u.upper?-u.lower:u.upper;
  if(magnitude*RC_SERIES_RATIO>FIXED_ONE.upper)return null;
  const scale=fixedDivide(FIXED_ONE,ellipticSqrt(y,check));
  let term=FIXED_ONE,sum=FIXED_ONE;
  for(let n=1n;n<=512n;n++) {
    check();
    term=fixedTimesRational(fixedMultiply(term,u),2n*n-1n,2n*n);
    sum=fixedAdd(sum,fixedTimesRational(term,1n,2n*n+1n));
    const size=-term.lower>term.upper?-term.lower:term.upper;
    const tail=ceilQuotient(size*magnitude,(2n*n+3n)*(FIXED_ONE.upper-magnitude));
    const enclosure=fixedMultiply(fixedWiden(sum,tail),scale);
    if(narrow(enclosure))return enclosure;
  }
  return null;
}
function carlsonRC(a:Range,b:Range,check:()=>void):Range {
  validate([a,b,b]);let x=a,y=b;
  for(let k=0;k<512;k++) {
    check();const series=rcSeries(x,y,check);
    if(series!==null)return series;
    const enclosure=remaining([x,y],false,check);
    if(enclosure!==null&&narrow(enclosure))return enclosure;
    const lambda=fixedAdd(fixedTimesRational(fixedMultiply(ellipticSqrt(x,check),ellipticSqrt(y,check)),2n),y);
    x=divideFour(fixedAdd(x,lambda));y=divideFour(fixedAdd(y,lambda));
  }
  throw new MathInputProblem('budget','第三種の楕円積分の補助値を必要な桁数で確定できません。');
}
export function carlsonRJ(a:Range,b:Range,c:Range,parameter:Range,check:()=>void):Range {
  check();validate([a,b,c],parameter);
  let x=a,y=b,z=c,p=parameter,sum=FIXED_ZERO,power=1n;
  const rd=parameter.lower===c.lower&&parameter.upper===c.upper;
  for(let k=0;k<512;k++) {
    check();const tail=remaining([x,y,z,p],true,check);
    if(tail!==null) {
      const enclosure=fixedAdd(sum,fixedTimesRational(tail,1n,power));
      if(narrow(enclosure))return enclosure;
    }
    const {rx,ry,rz,lambda}=rootsAndLambda(x,y,z,check);
    let correction:Range;
    if(rd)correction=fixedDivide(FIXED_ONE,fixedMultiply(rz,fixedAdd(z,lambda)));
    else {
      const alpha=fixedAdd(fixedMultiply(p,fixedAdd(fixedAdd(rx,ry),rz)),fixedMultiply(fixedMultiply(rx,ry),rz));
      const betaSquared=fixedMultiply(p,ellipticSquare(fixedAdd(p,lambda)));
      correction=carlsonRC(ellipticSquare(alpha),betaSquared,check);
    }
    sum=fixedAdd(sum,fixedTimesRational(correction,3n,power));power*=4n;
    x=divideFour(fixedAdd(x,lambda));y=divideFour(fixedAdd(y,lambda));
    z=divideFour(fixedAdd(z,lambda));p=divideFour(fixedAdd(p,lambda));
  }
  throw new MathInputProblem('budget','第三種の楕円積分を必要な桁数で確定できません。');
}
export const carlsonRD=(x:Range,y:Range,z:Range,check:()=>void):Range=>carlsonRJ(x,y,z,z,check);
