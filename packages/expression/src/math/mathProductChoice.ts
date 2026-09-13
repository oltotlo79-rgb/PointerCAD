/** Resolve visible multiplication symbols from explicit types, never from the spelling of a variable. */
export type MathProductShape =
  | { readonly kind: 'scalar'; readonly field: 'real' | 'complex' }
  | { readonly kind: 'vector'; readonly length: number; readonly field: 'real' | 'complex' }
  | { readonly kind: 'matrix'; readonly rows: number; readonly columns: number; readonly field: 'real' | 'complex' }
  | { readonly kind: 'unknown' | 'non-numeric' };
export type ProductChoice =
  | { readonly status: 'resolved'; readonly operation: 'multiply' | 'dot' | 'cross' }
  | { readonly status: 'needs-type'; readonly operands: readonly ('left' | 'right')[] }
  | { readonly status: 'invalid'; readonly reason: 'non-numeric' | 'dimension' | 'complex-dot-convention' | 'matrix-dot' };

export function chooseMathProduct(token: 'dot' | 'times', left: MathProductShape, right: MathProductShape): ProductChoice {
  if(left.kind==='unknown'||right.kind==='unknown')return{status:'needs-type',operands:
    [...(left.kind==='unknown'?['left' as const]:[]),...(right.kind==='unknown'?['right' as const]:[])]};
  if(left.kind==='non-numeric'||right.kind==='non-numeric')return{status:'invalid',reason:'non-numeric'};
  if(left.kind==='scalar'||right.kind==='scalar')return{status:'resolved',operation:'multiply'};
  if(left.kind==='vector'&&right.kind==='vector'){
    if(left.length!==right.length || token==='times' && left.length!==3)return{status:'invalid',reason:'dimension'};
    if(token==='dot'&&(left.field==='complex'||right.field==='complex'))return{status:'invalid',reason:'complex-dot-convention'};
    return{status:'resolved',operation:token==='dot'?'dot':'cross'};
  }
  if(token==='dot')return{status:'invalid',reason:'matrix-dot'};
  if(left.kind==='matrix'&&right.kind==='matrix')return left.columns===right.rows
    ?{status:'resolved',operation:'multiply'}:{status:'invalid',reason:'dimension'};
  if(left.kind==='matrix'&&right.kind==='vector')return left.columns===right.length
    ?{status:'resolved',operation:'multiply'}:{status:'invalid',reason:'dimension'};
  // Row versus column is not inferred from an un-oriented vector. The user can transpose an explicit matrix.
  return{status:'invalid',reason:'dimension'};
}
