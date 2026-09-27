import type { MathPaletteExample } from './mathPaletteGroups.js';

/**
 * mathPaletteCalculus.ts の項目の実例（公開パレットの受入）。selection は #0、slots は #? へ出現順に入れる。
 * mathPaletteExamples.test.ts が構造入力と同じ経路で実計算し、期待した数値・型と目録の欄を照合する。
 * 表示順は mathPaletteExamples.ts の MATH_PALETTE_DISPLAY_ORDER（新しい項目は既存の項目の後ろ）。
 */
export const MATH_PALETTE_CALCULUS_EXAMPLES: readonly MathPaletteExample[] = [
  { id: 'limit-supremum', selection: String.raw`\sin(1/x)`, slots: ['x', '0'], expected: 1, exact: true },
  { id: 'limit-infimum', selection: String.raw`\sin(1/x)`, slots: ['x', '0'], expected: -1, exact: true },
  { id: 'fourier-series', selection: 'x', slots: ['x', '-\\pi', '\\pi', '2'], expected: 'fourier-series', exact: true },
  { id: 'fourier-value', selection: String.raw`\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right)`, slots: ['\\pi/2'], expected: 2, exact: true },
  { id: 'fourier-cosine', selection: String.raw`\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right)`, slots: ['1'], expected: 0, exact: true },
  { id: 'fourier-sine', selection: String.raw`\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right)`, slots: ['2'], expected: -1, exact: true },
  { id: 'series-coefficient', selection: String.raw`\operatorname{taylor}\left(x^3,x,2,4\right)`, slots: ['1'], expected: 12, exact: true },
  { id: 'taylor', selection: 'x^3', slots: ['x', '1', '3'], expected: 'series', exact: true },
  { id: 'maclaurin', selection: '1/(1-x)', slots: ['x', '4'], expected: 'series', exact: true },
  {"id": "sequence-value", "selection": "n^2", "slots": ["n", "5"], "expected": 25, "exact": true},
  {"id": "difference-at", "selection": "n^2", "slots": ["n", "4", "1", "2"], "expected": 20, "exact": true},
  {"id": "recurrence-value", "selection": "a+b", "slots": ["[n,a,b]", "0", "[0,1]", "10"], "expected": 55, "exact": true},
  {"id": "svd-u", "selection": "[[3,0],[4,0]]", "slots": [], "expected": "matrix"},
  {"id": "svd-s", "selection": "[[3,0],[4,0]]", "slots": [], "expected": "matrix"},
  {"id": "svd-v", "selection": "[[3,0],[4,0]]", "slots": [], "expected": "matrix"},
  {"id": "eigenspace", "selection": "[[2,1],[0,2]]", "slots": ["2"], "expected": "matrix"},
  {"id": "tensor-product", "selection": "[1,2]", "slots": ["[3,4]"], "expected": "matrix"},
  {"id": "hadamard-product", "selection": "[[1,2],[3,4]]", "slots": ["[[2,3],[4,5]]"], "expected": "matrix"},
  {"id": "tensor-contract", "selection": "[[1,2],[3,4]]", "slots": ["1", "2"], "expected": 5},
  {"id": "tensor-permute", "selection": "[[1,2,3],[4,5,6]]", "slots": ["[2,1]"], "expected": "matrix"},
  {"id": "tensor-shape", "selection": "[[1,2,3],[4,5,6]]", "slots": [], "expected": "vector"},
  {"id": "tensor-element", "selection": "[[[1,2],[3,4]],[[5,6],[7,8]]]", "slots": ["[2,1,2]"], "expected": 6},
  {"id": "kronecker-delta", "selection": "2", "slots": ["2"], "expected": 1},
  {"id": "levi-civita", "selection": "[2,3,1]", "slots": [], "expected": 1},
  { id: 'singular-values', selection: '[[3,0],[0,4]]', slots: [], expected: 'vector' },
  { id: 'eigenvalues', selection: '[[2,1],[1,2]]', slots: [], expected: 'vector' },
  { id: 'row-reduce', selection: '[[1,2,3],[2,4,6]]', slots: [], expected: 'matrix' },
  { id: 'qr-q', selection: '[[3,0],[4,5]]', slots: [], expected: 'matrix' },
  { id: 'qr-r', selection: '[[3,0],[4,5]]', slots: [], expected: 'matrix' },
  { id: 'lu-p', selection: '[[0,2],[3,4]]', slots: [], expected: 'matrix' },
  { id: 'lu-l', selection: '[[1,1,1],[2,2,3],[4,5,6]]', slots: [], expected: 'matrix' },
  { id: 'lu-u', selection: '[[1,1,1],[2,2,3],[4,5,6]]', slots: [], expected: 'matrix' },
  { id: 'characteristic-coefficients', selection: '[[1,2],[3,4]]', slots: [], expected: 'vector' },
  { id: 'null-space', selection: '[[1,2,3],[2,4,6]]', slots: [], expected: 'matrix' },
  { id: 'column-space', selection: '[[1,2,3],[2,4,6]]', slots: [], expected: 'matrix' },
  { id: 'row-space', selection: '[[1,2,3],[2,4,6]]', slots: [], expected: 'matrix' },
  { id: 'linear-solve', selection: '[[2,1],[1,-1]]', slots: ['[5,1]'], expected: 'vector' },
  { id: 'linear-solution-space', selection: '[[1,2,3],[2,4,6]]', slots: ['[4,8]'], expected: 'matrix' },
  { id: 'component', selection: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, slots: ['2', '1'], expected: 3 },
  { id: 'sum', selection: 'i^2', slots: ['3'], expected: 14 },
  { id: 'product', selection: 'i', slots: ['4'], expected: 24 },
  { id: 'integral', selection: 'x^2', slots: ['0', '3'], expected: 9 },
  { id: 'matrix', selection: '', slots: ['1', '2', '3', '4'], expected: 'matrix' },
  // MC-02b: examples for drafts that previously had none (unpublished until now).
  // derivative/partial (plain D, via the \frac{d}{dx} fraction parser) resolve their variable in the caller's
  // scope and never bind a free name (MC-19b, Q4=A); they are published at the end with plotting examples.
  { id: 'limit', selection: '(x^2-4)/(x-2)', slots: ['2'], expected: 4, exact: true },
  // determinant/transpose/conjugate-transpose/inverse-matrix/trace: exact-runtime (exactRuntime/cas_input.py;
  // see the comment on the entries in mathPaletteCalculus.ts).
  { id: 'determinant', selection: '[[1,2],[3,4]]', slots: [], expected: -2, exact: true },
  // MC-02b: matrix basics.
  { id: 'transpose', selection: '[[1,2,3],[4,5,6]]', slots: [], expected: 'matrix', exact: true },
  { id: 'conjugate-transpose', selection: '[[1,2],[3,4]]', slots: [], expected: 'matrix', exact: true },
  { id: 'inverse-matrix', selection: '[[1,0],[0,2]]', slots: [], expected: 'matrix', exact: true },
  { id: 'trace', selection: '[[1,2],[3,4]]', slots: [], expected: 5, exact: true },
  { id: 'rank', selection: '[[1,2],[2,4]]', slots: [], expected: 1 },
  // MC-02b: vector calculus at an explicit point (math-input.md「指定した位置の勾配や行列を座標に使う」の例と同じ値).
  { id: 'gradient-at', selection: 'x^2*y', slots: ['[x,y]', '[2,3]'], expected: 'vector', exact: true },
  { id: 'divergence-at', selection: '[x*y,x^2]', slots: ['[x,y]', '[2,3]'], expected: 3, exact: true },
  { id: 'curl-at', selection: '[-y,x,0]', slots: ['[x,y,z]', '[2,3,4]'], expected: 'vector', exact: true },
  { id: 'laplacian-at', selection: 'x^2*y', slots: ['[x,y]', '[2,3]'], expected: 6, exact: true },
  { id: 'jacobian-at', selection: '[x*y,x^2]', slots: ['[x,y]', '[2,3]'], expected: 'matrix', exact: true },
  { id: 'hessian-at', selection: 'x^2*y', slots: ['[x,y]', '[2,3]'], expected: 'matrix', exact: true },
  // MC-02b: line/surface/volume integrals, circulation, flux (math-input.mdの例と同じ値).
  { id: 'line-integral', selection: 'x', slots: ['[x,y]', '[3*t,4*t]', 't', '0', '1'], expected: 7.5, exact: true },
  { id: 'circulation', selection: '[2*x,2*y]', slots: ['[x,y]', '[t,t^2]', 't', '0', '1'], expected: 2, exact: true },
  { id: 'surface-integral', selection: '1', slots: ['[x,y,z]', '[2*u,3*v,0]', '[u,v]', '[0,0]', '[1,1]'], expected: 6, exact: true },
  { id: 'flux-integral', selection: '[0,0,4]', slots: ['[x,y,z]', '[2*u,3*v,0]', '[u,v]', '[0,0]', '[1,1]'], expected: 24, exact: true },
  { id: 'volume-integral', selection: '1', slots: ['[x,y,z]', '[-2*u,3*v,4*w]', '[u,v,w]', '[0,0,0]', '[1,1,1]'], expected: 24, exact: true },
  // MC-02e (MC-19d): closed line/surface integrals, confirmed by closedIntegrals.test.ts's own analytic
  // values (unit circle circumference/circulation = 2π by Green's theorem, unit sphere area/outward flux = 4π
  // by the divergence theorem; the field equals the outward normal so the flux integrand is 1 everywhere).
  { id: 'closed-line-integral', selection: '1', slots: ['[x,y]', String.raw`[\cos(t),\sin(t)]`, 't', '0', '360'], expected: 2 * Math.PI, exact: true },
  { id: 'closed-circulation', selection: '[-y,x]', slots: ['[x,y]', String.raw`[\cos(t),\sin(t)]`, 't', '0', '360'], expected: 2 * Math.PI, exact: true },
  { id: 'closed-surface-integral', selection: '1', slots: ['[x,y,z]', String.raw`[\sin(u)*\cos(v),\sin(u)*\sin(v),\cos(u)]`, '[u,v]', '[0,0]', '[180,360]'], expected: 4 * Math.PI, exact: true },
  { id: 'closed-flux-integral', selection: '[x,y,z]', slots: ['[x,y,z]', String.raw`[\sin(u)*\cos(v),\sin(u)*\sin(v),\cos(u)]`, '[u,v]', '[0,0]', '[180,360]'], expected: 4 * Math.PI, exact: true },
  // MC-02b: value and order at a specified position (math-input.mdの derivativeat(t^3,t,2,3)=6 と同じ). exact-runtime:
  // requiresExactCalculus() (mathExactCalculus.ts) lists 'differentiate-at' explicitly.
  { id: 'derivative-at', selection: 't^3', slots: ['t', '2', '3'], expected: 6, exact: true },
  // MC-02b: infinite sum/product (existing sum/product examples stay finite; these publish the infinite-range form).
  { id: 'infinite-sum', selection: '1/k^2', slots: [], expected: Math.PI ** 2 / 6, exact: true },
  { id: 'infinite-product', selection: '4*k^2/(4*k^2-1)', slots: [], expected: Math.PI / 2, exact: true },
  // MC-03b: X/Y/Z and parameter roles are supplied explicitly; every component is sampled by the geometry runtime.
  { id: 'gradient', selection: 'X^2+3*Y^2+Z^3', slots: ['[X,Y,Z]'], expected: 'vector',
    functionContext: { axes: ['X', 'Y', 'Z'], parameters: [], samples: [
      { point: [2, 3, 4], components: [{ indices: [1], value: 4 }, { indices: [2], value: 18 }, { indices: [3], value: 48 }] },
    ] } },
  { id: 'divergence', selection: '[X^2,X*Y,Z^3]', slots: ['[X,Y,Z]'], expected: 54,
    functionContext: { axes: ['X', 'Y', 'Z'], parameters: [], samples: [
      { point: [2, 3, 4], components: [{ indices: [], value: 54 }] },
    ] } },
  { id: 'curl', selection: '[-Y,X,0]', slots: ['[X,Y,Z]'], expected: 'vector',
    functionContext: { axes: ['X', 'Y', 'Z'], parameters: [], samples: [
      { point: [2, 3, 4], components: [{ indices: [1], value: 0 }, { indices: [2], value: 0 }, { indices: [3], value: 2 }] },
    ] } },
  { id: 'laplacian', selection: 'X^2*Y+Z^3', slots: ['[X,Y,Z]'], expected: 30,
    functionContext: { axes: ['X', 'Y', 'Z'], parameters: [], samples: [
      { point: [2, 3, 4], components: [{ indices: [], value: 30 }] },
    ] } },
  { id: 'jacobian', selection: '[X^2*Y,Y*Z]', slots: ['[X,Y,Z]'], expected: 'matrix',
    functionContext: { axes: ['X', 'Y', 'Z'], parameters: [], samples: [
      { point: [2, 3, 4], components: [{ indices: [1, 1], value: 12 }, { indices: [1, 2], value: 4 },
        { indices: [1, 3], value: 0 }, { indices: [2, 1], value: 0 }, { indices: [2, 2], value: 4 }, { indices: [2, 3], value: 3 }] },
    ] } },
  { id: 'hessian', selection: 'T^3', slots: ['[T]'], expected: 'matrix',
    functionContext: { axes: [], parameters: ['T'], samples: [
      { point: [2, 0, 0], components: [{ indices: [1, 1], value: 12 }] },
      { point: [3, 0, 0], components: [{ indices: [1, 1], value: 18 }] },
    ] } },
  // MC-31: the public glyphs and the default norm reach actual exact values.
  { id: 'dot', selection: '[1,2,3]', slots: ['[4,5,6]'], expected: 32, exact: true },
  { id: 'cross', selection: '[1,0,0]', slots: ['[0,1,0]'], expected: 'vector', exact: true },
  { id: 'norm', selection: '[3,4]', slots: [], expected: 5, exact: true },
  // MC-19b: d/dT (T+2)³ = 3(T+2)², and ∂/∂X (X²Y+Z) = 2XY, sampled by the geometry runtime.
  { id: 'derivative', selection: '(T+2)^3', slots: ['T'], expected: 12,
    functionContext: { axes: [], parameters: ['T'], samples: [
      { point: [0, 0, 0], components: [{ indices: [], value: 12 }] },
      { point: [1, 0, 0], components: [{ indices: [], value: 27 }] },
    ] } },
  { id: 'partial', selection: 'X^2*Y+Z', slots: ['X'], expected: 12,
    functionContext: { axes: ['X', 'Y', 'Z'], parameters: [], samples: [
      { point: [2, 3, 4], components: [{ indices: [], value: 12 }] },
    ] } },
  // MC-02d: MC-16's exact vector projection, projection([1,2],[3,4])=[33/25,44/25].
  { id: 'projection', selection: '[1,2]', slots: ['[3,4]'], expected: 'vector', exact: true },
  // MC-02d: MC-18's identity/zero matrix constructors (identitymatrix(3), zeromatrix(2,3)).
  { id: 'identity-matrix', selection: '3', slots: [], expected: 'matrix', exact: true },
  { id: 'zero-matrix', selection: '2', slots: ['3'], expected: 'matrix', exact: true },
  // MC-02d: MC-30/MC-31b's total differential at a point (totaldifferentialat.test.ts):
  // totaldifferentialat(Function(x^2+y^2,x,y),[1,2],[1/10,1/5])=1. Rejected in function-plot use (MC-30 report).
  { id: 'total-differential-at', selection: 'x^2+y^2', slots: ['x', 'y', '[1,2]', '[1/10,1/5]'], expected: 1, exact: true },
  // MC-04c: integrate(t^2,t) with no bound, the same input exactIndefiniteIntegrals.test.ts's own 'square' case
  // uses, so the real exact-runtime reply (antiderivative 1/3*t^3, shown with +C by the editor) is proven, not a
  // hand-written stand-in. exact:true routes this through the fixed exact-runtime subprocess like the other
  // symbolic examples above.
  { id: 'indefinite-integral', selection: 't^2', slots: ['t'], expected: 'antiderivative', exact: true },
];
