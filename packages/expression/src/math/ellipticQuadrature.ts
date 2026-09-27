/** Directed Simpson integration with a proved fourth derivative remainder.
 * f^(4)/4! is enclosed on every entire cell; width^5*|coefficient4|/120
 * equals the Simpson bound width^5*max|f^(4)|/2880. A comparison of two
 * numerical quadrature results is never used as an error certificate.
 */
import { ellipticIntegrand,type EllipticFamily } from './ellipticIntegrand.js';
import { type Range,point,ZERO,add,sub,mul,div,sq,neg,UnprovedEllipticRange } from './ellipticJetArithmetic.js';

export interface EllipticQuadratureOptions {
  readonly check:()=>void;
  readonly maximumCells?:number;
  readonly relativeTolerance?:number;
}
export function integrateEllipticParameter(family:EllipticFamily,m:number,n:number,from:number,to:number,p:number,q:number,
  options:EllipticQuadratureOptions):Range {
  options.check();
  const maximumCells=options.maximumCells??8192,tolerance=options.relativeTolerance??1e-11;
  if(![m,n,from,to,tolerance].every(Number.isFinite)||tolerance<=0||tolerance>1e-3
    ||!Number.isSafeInteger(maximumCells)||maximumCells<1||maximumCells>65536)throw new UnprovedEllipticRange();
  if(from===to)return ZERO;
  const negative=to<from,lower=Math.min(from,to),upper=Math.max(from,to),span=upper-lower;
  if(!Number.isFinite(span))throw new UnprovedEllipticRange();
  const mother=point(m),characteristic=point(n),values=new Map<string,Range>();
  function value(phi:Range):Range {
    const key=phi.lower+':'+phi.upper,known=values.get(key);if(known!==undefined)return known;
    options.check();const answer=ellipticIntegrand(family,mother,characteristic,phi,p,q,0)[0];
    values.set(key,answer);return answer;
  }
  function cell(a:number,b:number):Range {
    options.check();
    const width=sub(point(b),point(a)),midpoint=div(add(point(a),point(b)),point(2));
    const weighted=add(add(value(point(a)),mul(point(4),value(midpoint))),value(point(b)));
    const approximation=mul(div(width,point(6)),weighted);
    const coefficient=ellipticIntegrand(family,mother,characteristic,{lower:a,upper:b},p,q,4)[4];
    const magnitude=Math.max(Math.abs(coefficient.lower),Math.abs(coefficient.upper));
    const width5=mul(sq(sq(width)),width),error=div(mul(width5,point(magnitude)),point(120));
    return add(approximation,{lower:-error.upper,upper:error.upper});
  }
  const minimumMagnitude=(range:Range):number=>range.lower>0?range.lower:range.upper<0?-range.upper:0;
  // Judge the COMPLETE directed sum, not an estimated scale or independent
  // local relative errors. sin(phi)^30 can be tiny near the centre and large
  // near the end; requiring equal relative precision in both wastes cells.
  const target=(scale:number):number=>mul(point(tolerance),point(scale)).lower;
  interface Cell {a:number;b:number;depth:number;answer:Range;parent:Cell|null;children:readonly [Cell,Cell]|null}
  const whole:Cell={a:lower,b:upper,depth:0,answer:cell(lower,upper),parent:null,children:null};
  const width=(item:Cell):number=>sub(point(item.answer.upper),point(item.answer.lower)).upper;
  const pending:Cell[]=[whole];
  function push(item:Cell):void {
    let index=pending.length;pending.push(item);
    while(index>0) {
      const parent=Math.floor((index-1)/2);if(width(pending[parent])>=width(item))break;
      pending[index]=pending[parent];index=parent;
    }
    pending[index]=item;
  }
  function pop():Cell {
    const first=pending[0],last=pending.pop();
    if(first===undefined||last===undefined)throw new UnprovedEllipticRange();
    if(pending.length>0) {
      let index=0;
      while(2*index+1<pending.length) {
        let child=2*index+1;
        if(child+1<pending.length&&width(pending[child+1])>width(pending[child]))child++;
        if(width(last)>=width(pending[child]))break;
        pending[index]=pending[child];index=child;
      }
      pending[index]=last;
    }
    return first;
  }
  let cells=1;
  while(width(whole)>target(Math.max(1,minimumMagnitude(whole.answer)))) {
    options.check();const current=pop(),{a,b,depth}=current,middle=a/2+b/2;
    if(cells+2>maximumCells||depth>=40||middle<=a||middle>=b)throw new UnprovedEllipticRange();
    const left:Cell={a,b:middle,depth:depth+1,answer:cell(a,middle),parent:current,children:null};
    const right:Cell={a:middle,b,depth:depth+1,answer:cell(middle,b),parent:current,children:null};
    current.children=[left,right];cells+=2;push(left);push(right);
    // Recompute along the tree rather than subtracting an old interval from
    // the total, which would retain its old uncertainty forever.
    let changed:Cell|null=current;
    while(changed!==null&&changed.children!==null) {
      changed.answer=add(changed.children[0].answer,changed.children[1].answer);
      changed=changed.parent;
    }
  }
  return negative?neg(whole.answer):whole.answer;
}
