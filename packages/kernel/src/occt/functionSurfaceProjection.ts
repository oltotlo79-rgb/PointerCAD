/** Exact injectivity certificate for a triangulated disk with a simple planar projection.
 * For a point off the edges, oriented triangle winding numbers add to the boundary's winding
 * number: every internal edge cancels its opposite occurrence. A simple boundary has winding
 * 0 or 1 and all projected triangles have the same positive orientation. Thus two triangle
 * interiors cannot overlap. The manifold and boundary checks also exclude non-topological contacts.
 * Failure to establish this sufficient condition ALWAYS leaves the native intersection check on.
 */
import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';

type Point = readonly [bigint, bigint];
interface Edge { readonly a: number; readonly b: number; readonly face: number; uses: number }
const MARGIN = 1e-6;
const BRAND = Symbol('function-surface-projection');
export interface FunctionSurfaceProjectionCertificate { readonly [BRAND]: true; readonly shape: TopoDS_Shape }
const orient = (a: Point,b: Point,c: Point): bigint => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const sign = (value: bigint): number => value < 0n ? -1 : value > 0n ? 1 : 0;

function exactPoints(values: readonly (readonly [number,number])[]): readonly Point[] {
  const bits = new DataView(new ArrayBuffer(8));
  const decoded = values.map(point => point.map(value => {
    if (value === 0) return { n:0n,e:0 };
    bits.setFloat64(0,value);
    const raw=bits.getBigUint64(0),e=Number(raw>>52n&0x7ffn),fraction=raw&0xfffffffffffffn;
    return {n:(raw>>63n?-1n:1n)*(e===0?fraction:fraction|0x10000000000000n),e:e===0?-1074:e-1075};
  }));
  let exponent=0;
  for (const point of decoded) for (const value of point) if(value.n!==0n) exponent=Math.min(exponent,value.e);
  return decoded.map(point => [point[0].n<<BigInt(point[0].e-exponent),point[1].n<<BigInt(point[1].e-exponent)]);
}

function intersects(a:Point,b:Point,c:Point,d:Point): boolean {
  const between=(p:Point,q:Point,r:Point):boolean => r[0]>= (p[0]<q[0]?p[0]:q[0]) && r[0]<=(p[0]>q[0]?p[0]:q[0])
    && r[1]>=(p[1]<q[1]?p[1]:q[1]) && r[1]<=(p[1]>q[1]?p[1]:q[1]);
  const abC=sign(orient(a,b,c)),abD=sign(orient(a,b,d)),cdA=sign(orient(c,d,a)),cdB=sign(orient(c,d,b));
  return abC*abD<0 && cdA*cdB<0 || abC===0 && between(a,b,c) || abD===0 && between(a,b,d)
    || cdA===0 && between(c,d,a) || cdB===0 && between(c,d,b);
}

function simpleBoundary(boundary:readonly number[], exact:readonly Point[],
  points:readonly (readonly [number,number])[], cancelled:()=>boolean): boolean {
  const distance=(p:readonly number[],a:readonly number[],b:readonly number[]):number=>{
    const x=b[0]-a[0],y=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y)/(x*x+y*y)));
    return Math.hypot(p[0]-a[0]-t*x,p[1]-a[1]-t*y);
  };
  for(let i=0;i<boundary.length;i++) {
    if(cancelled()) return false;
    const a=boundary[i],b=boundary[(i+1)%boundary.length],p=boundary[(i+boundary.length-1)%boundary.length];
    if(orient(exact[p],exact[a],exact[b])===0n
      && (exact[a][0]-exact[p][0])*(exact[b][0]-exact[a][0])+(exact[a][1]-exact[p][1])*(exact[b][1]-exact[a][1])<=0n) return false;
    for(let j=i+2;j<boundary.length;j++) {
      if(i===0 && j===boundary.length-1) continue;
      const c=boundary[j],d=boundary[(j+1)%boundary.length];
      if([0,1].some(axis=>Math.max(points[a][axis],points[b][axis])+MARGIN<Math.min(points[c][axis],points[d][axis])
        || Math.max(points[c][axis],points[d][axis])+MARGIN<Math.min(points[a][axis],points[b][axis]))) continue;
      if(intersects(exact[a],exact[b],exact[c],exact[d])) return false;
      if(Math.min(distance(points[a],points[c],points[d]),distance(points[b],points[c],points[d]),
        distance(points[c],points[a],points[b]),distance(points[d],points[a],points[b]))<=MARGIN) return false;
    }
  }
  return true;
}

/** Internal: input has already passed checkedFunctionSurface after XYZ clipping. */
export function hasSimpleFunctionSurfaceProjection(spec: FunctionSurfaceGeometrySpec,
  cancelled:()=>boolean=()=>false): boolean {
  if(spec.triangles.length===0 || spec.triangles.length>20_000 || spec.vertices.length>10_000) return false;
  const edges=new Map<string,Edge>(), used=new Set<number>(), links=new Map<number,Map<number,number[]>>();
  const parents=spec.triangles.map((_,index)=>index);
  const root=(index:number):number=>{while(parents[index]!==index){parents[index]=parents[parents[index]];index=parents[index];}return index;};
  for(let face=0;face<spec.triangles.length;face++) {
    if(face%64===0 && cancelled()) return false;
    const triangle=spec.triangles[face];
    for(let i=0;i<3;i++) {
      const a=triangle[i],b=triangle[(i+1)%3],c=triangle[(i+2)%3];
      if(a===b || a===c || b===c || !spec.vertices[a]?.every(Number.isFinite)) return false;
      used.add(a);
      const key=`${Math.min(a,b)},${Math.max(a,b)}`,previous=edges.get(key);
      if(previous===undefined) edges.set(key,{a,b,face,uses:1});
      else {
        if(++previous.uses>2 || previous.a!==b || previous.b!==a) return false;
        parents[root(face)]=root(previous.face);
      }
      const link=links.get(a)??new Map<number,number[]>();
      link.set(b,[...(link.get(b)??[]),c]);link.set(c,[...(link.get(c)??[]),b]);links.set(a,link);
    }
  }
  if(used.size-edges.size+spec.triangles.length!==1 || parents.some((_,i)=>root(i)!==root(0))) return false;
  const next=new Map<number,number>(), incoming=new Set<number>();
  for(const edge of edges.values()) if(edge.uses===1) {
    if(next.has(edge.a)||incoming.has(edge.b)) return false;
    next.set(edge.a,edge.b);incoming.add(edge.b);
  }
  if(next.size<3 || next.size>1024) return false;
  const first=next.keys().next().value;
  if(first===undefined) return false;
  const boundary:number[]=[],seen=new Set<number>();let current:number|undefined=first;
  while(current!==undefined && !seen.has(current)) {seen.add(current);boundary.push(current);current=next.get(current);}
  if(current!==first || boundary.length!==next.size) return false;
  // Every interior vertex has one circular link; every boundary vertex has one interval link.
  for(const [vertex,link] of links) {
    let ends=0;
    for(const neighbours of link.values()) {if(neighbours.length===1) ends++;else if(neighbours.length!==2)return false;}
    if(ends!==(seen.has(vertex)?2:0)) return false;
    const start=link.keys().next().value;if(start===undefined)return false;
    const visited=new Set<number>(),pending=[start];
    while(pending.length){const item=pending.pop();if(item===undefined||visited.has(item))continue;visited.add(item);pending.push(...(link.get(item)??[]));}
    if(visited.size!==link.size) return false;
  }
  for(const [x,y] of [[0,1],[1,2],[2,0]]) {
    if(cancelled()) return false;
    const points:readonly (readonly [number,number])[]=spec.vertices.map(point=>[point[x],point[y]]);
    const positions=new Set<string>();let possible=true;
    for(const index of used) {
      const point=points[index],key=point.join(',');
      if(point.some(value=>Math.abs(value)>1e7)||positions.has(key)){possible=false;break;}positions.add(key);
    }
    if(!possible)continue;
    const exact=exactPoints(points);let direction=0;
    for(const [a,b,c] of spec.triangles) {
      const orientation=sign(orient(exact[a],exact[b],exact[c]));
      if(orientation===0 || direction!==0 && orientation!==direction){possible=false;break;}direction=orientation;
      // Tiny projected slivers stay with OCCT's tolerance-aware intersection analysis.
      const p=points[a],q=points[b],r=points[c],area=Math.abs((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]));
      const longest=Math.max(Math.hypot(q[0]-p[0],q[1]-p[1]),Math.hypot(r[0]-p[0],r[1]-p[1]),Math.hypot(r[0]-q[0],r[1]-q[1]));
      if(!(area/longest>MARGIN*8)){possible=false;break;}
    }
    if(possible && simpleBoundary(boundary,exact,points,cancelled)) return true;
  }
  return false;
}

/** Bind the exact proof to the shape just constructed from that same clipped input.
 * The owner passes it immediately to classification before exposing the shape to any caller.
 */
export function certifyFunctionSurfaceProjection(spec:FunctionSurfaceGeometrySpec,shape:TopoDS_Shape,
  cancelled:()=>boolean):FunctionSurfaceProjectionCertificate|undefined {
  return hasSimpleFunctionSurfaceProjection(spec,cancelled)?{[BRAND]:true,shape}:undefined;
}
export function hasFunctionSurfaceProjectionCertificate(proof:FunctionSurfaceProjectionCertificate|undefined,
  shape:TopoDS_Shape):boolean {return proof?.[BRAND]===true && proof.shape===shape;}
