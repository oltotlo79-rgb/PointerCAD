/** exact duplication identities plus differentiated integral tail bounds. */
import { type Range,type Jet,point,constant,factor,add,mul,div,neg,root,ONE,ZERO,
  sum,scale,product,square,squareRoot,reciprocal,UnprovedEllipticRange } from './ellipticJetArithmetic.js';

function chain(args:readonly Jet[],value:Range,gradient:readonly Range[],hessian:readonly (readonly Range[])[]):Jet {
  const first=[ZERO,ZERO],second=[ZERO,ZERO,ZERO];
  const slots=[[0,0],[0,1],[1,1]] as const;
  for(let i=0;i<args.length;i++) {
    for(let axis=0;axis<2;axis++)first[axis]=add(first[axis],mul(gradient[i],args[i].first[axis]));
    for(let k=0;k<3;k++) {
      second[k]=add(second[k],mul(gradient[i],args[i].second[k]));
      for(let j=0;j<args.length;j++)second[k]=add(second[k],mul(hessian[i][j],mul(args[i].first[slots[k][0]],args[j].first[slots[k][1]])));
    }
  }
  return {value,first:[first[0],first[1]],second:[second[0],second[1],second[2]]};
}
function tail(args:readonly Jet[],third:boolean):Jet {
  const a=Math.min(...args.map(x=>x.value.lower)),b=Math.max(...args.map(x=>x.value.upper));
  if(a<=0)throw new UnprovedEllipticRange();
  const bounds={lower:a,upper:b},inverse=div(ONE,bounds),inverseRoot=div(ONE,root(bounds));
  const value=third?mul(inverse,inverseRoot):inverseRoot;
  const slope=mul(value,inverse),curvature=mul(slope,inverse);
  const gradient=args.map((_,i)=>neg(mul(slope,third?factor(3,i===3?5:10):factor(1,6))));
  const hessian=args.map((_,i)=>args.map((__,j)=>mul(curvature,third?
    i===3&&j===3?factor(6,7):i===3||j===3?factor(3,14):i===j?factor(9,28):factor(3,28)
    :i===j?factor(3,20):factor(1,20))));
  return chain(args,value,gradient,hessian);
}
function validate(args:readonly Jet[],p?:Jet):void {
  if(args.some(x=>x.value.lower<0)||args.filter(x=>x.value.lower===0).length>1||(p!==undefined&&p.value.lower<=0))throw new UnprovedEllipticRange();
}
function duplicated(x:Jet,y:Jet,z:Jet) {
  const rx=squareRoot(x),ry=squareRoot(y),rz=squareRoot(z);
  return {rx,ry,rz,lambda:sum(sum(product(rx,ry),product(ry,rz)),product(rz,rx))};
}
const quarter=(x:Jet)=>scale(x,point(.25));
// At a fixed input, 24 duplications reduce argument differences by 2^-48.
// The returned width includes both that tail and every arithmetic rounding.
// Wider input ranges remain rigorous even when they do not become narrow.
export function carlsonRFJet(a:Jet,b:Jet,c:Jet):Jet {
  validate([a,b,c]);let x=a,y=b,z=c;
  for(let k=0;k<24;k++) {
    const low=Math.min(x.value.lower,y.value.lower,z.value.lower),high=Math.max(x.value.upper,y.value.upper,z.value.upper);
    if(low>0&&(high-low)<low*1e-13)return tail([x,y,z],false);
    const {lambda}=duplicated(x,y,z);
    x=quarter(sum(x,lambda));y=quarter(sum(y,lambda));z=quarter(sum(z,lambda));
  }
  return tail([x,y,z],false);
}
export function carlsonRJJet(a:Jet,b:Jet,c:Jet,parameter:Jet):Jet {
  validate([a,b,c],parameter);let x=a,y=b,z=c,p=parameter,total=constant(ZERO),power=1;
  // Identity, not equal point values: the parameter derivatives must match too.
  const rd=parameter===c;
  for(let k=0;k<24;k++) {
    const {rx,ry,rz,lambda}=duplicated(x,y,z);
    const alpha=sum(product(p,sum(sum(rx,ry),rz)),product(product(rx,ry),rz));
    const beta=product(p,square(sum(p,lambda)));
    const correction=rd?reciprocal(product(rz,sum(z,lambda))):carlsonRFJet(square(alpha),beta,beta);
    total=sum(total,scale(correction,point(3*power)));power*=.25;
    x=quarter(sum(x,lambda));y=quarter(sum(y,lambda));z=quarter(sum(z,lambda));p=quarter(sum(p,lambda));
  }
  return sum(total,scale(tail([x,y,z,p],true),point(power)));
}
