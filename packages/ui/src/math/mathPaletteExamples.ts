import { MATH_PALETTE_DRAFT } from './mathPalette.js';

/** Shared runnable examples: the browser palette and its real-engine acceptance use exactly the same templates. */
export const MATH_PALETTE_EXAMPLES: readonly {
  readonly id: string; readonly selection: string; readonly slots: readonly string[];
  readonly expected: number | 'complex' | 'matrix' | 'vector' | 'boolean';
}[] = [
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
  {"id": "integer-quotient", "selection": "-7", "slots": ["3"], "expected": -3},
  {"id": "integer-remainder", "selection": "-7", "slots": ["-3"], "expected": 2},
  {"id": "divides", "selection": "4", "slots": ["20"], "expected": "boolean"},
  {"id": "congruent-modulo", "selection": "-1", "slots": ["5", "3"], "expected": "boolean"},
  {"id": "is-prime", "selection": "13", "slots": [], "expected": "boolean"},
  {"id": "next-prime", "selection": "97", "slots": [], "expected": 101},
  {"id": "prime-factors", "selection": "360", "slots": [], "expected": "matrix"},
  {"id": "divisors", "selection": "36", "slots": [], "expected": "vector"},
  {"id": "euler-totient", "selection": "36", "slots": [], "expected": 12},
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
  {"id": "mean", "selection": "[1,2,6]", "slots": [], "expected": 3},
  {"id": "median", "selection": "[9,1,3,5]", "slots": [], "expected": 4},
  {"id": "modes", "selection": "[1,1,2,2,3]", "slots": [], "expected": "vector"},
  {"id": "quantile", "selection": "[0,10,20,30]", "slots": ["0.25"], "expected": 7.5},
  {"id": "population-variance", "selection": "[1,2,3]", "slots": [], "expected": 0.6666666666666666},
  {"id": "sample-variance", "selection": "[1,2,3]", "slots": [], "expected": 1},
  {"id": "population-standard-deviation", "selection": "[1,3]", "slots": [], "expected": 1},
  {"id": "sample-standard-deviation", "selection": "[1,3]", "slots": [], "expected": 1.4142135623730951},
  {"id": "population-covariance", "selection": "[1,2,3]", "slots": ["[2,4,6]"], "expected": 1.3333333333333333},
  {"id": "sample-covariance", "selection": "[1,2,3]", "slots": ["[2,4,6]"], "expected": 2},
  {"id": "correlation", "selection": "[1,2,3]", "slots": ["[6,4,2]"], "expected": -1},
  {"id": "regression-slope", "selection": "[1,2,3]", "slots": ["[3,5,7]"], "expected": 2},
  {"id": "regression-intercept", "selection": "[1,2,3]", "slots": ["[3,5,7]"], "expected": 1},
  {"id": "r-squared", "selection": "[1,2,3]", "slots": ["[3,5,7]"], "expected": 1},
  { id: 'reciprocal', selection: '4', slots: [], expected: 0.25 },
  { id: 'double-factorial', selection: '5', slots: [], expected: 15 },
  { id: 'permutations', selection: '5', slots: ['3'], expected: 60 },
  { id: 'clamp', selection: '8', slots: ['1', '5'], expected: 5 },
  { id: 'arccot', selection: '-1', slots: [], expected: 135 },
  { id: 'arcsec', selection: '2', slots: [], expected: 60 },
  { id: 'arccsc', selection: '2', slots: [], expected: 30 },
  { id: 'atan2', selection: '1', slots: ['-1'], expected: 135 },
  { id: 'coth', selection: String.raw`\ln(3)`, slots: [], expected: 1.25 },
  { id: 'sech', selection: '0', slots: [], expected: 1 },
  { id: 'csch', selection: String.raw`\ln(3)`, slots: [], expected: 0.75 },
  { id: 'arcoth', selection: '2', slots: [], expected: Math.log(3)/2 },
  { id: 'arsech', selection: '1', slots: [], expected: 0 },
  { id: 'arcsch', selection: '1', slots: [], expected: Math.log(1+Math.sqrt(2)) },
  { id: 'component', selection: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, slots: ['2', '1'], expected: 3 },
  { id: 'fraction', selection: '3', slots: ['2'], expected: 1.5 },
  { id: 'power', selection: '2', slots: ['3'], expected: 8 },
  { id: 'square-root', selection: '9', slots: [], expected: 3 },
  { id: 'nth-root', selection: '8', slots: ['3'], expected: 2 },
  { id: 'factorial', selection: '5', slots: [], expected: 120 },
  { id: 'absolute', selection: '-3', slots: [], expected: 3 },
  { id: 'sin', selection: '30', slots: [], expected: 0.5 },
  { id: 'cos', selection: '60', slots: [], expected: 0.5 },
  { id: 'tan', selection: '45', slots: [], expected: 1 },
  { id: 'arcsin', selection: '0.5', slots: [], expected: 30 },
  { id: 'log-natural', selection: '\\exponentialE', slots: [], expected: 1 },
  { id: 'log-ten', selection: '100', slots: [], expected: 2 },
  { id: 'log-base', selection: '8', slots: ['2'], expected: 3 },
  { id: 'sinh', selection: '0', slots: [], expected: 0 },
  { id: 'sum', selection: 'i^2', slots: ['3'], expected: 14 },
  { id: 'product', selection: 'i', slots: ['4'], expected: 24 },
  { id: 'integral', selection: 'x^2', slots: ['0', '3'], expected: 9 },
  { id: 'matrix', selection: '', slots: ['1', '2', '3', '4'], expected: 'matrix' },
  { id: 'pi', selection: '', slots: [], expected: Math.PI },
  { id: 'imaginary-unit', selection: '', slots: [], expected: 'complex' },
];

export const MATH_INPUT_PALETTE = MATH_PALETTE_EXAMPLES.map(example => {
  const item = MATH_PALETTE_DRAFT.find(item => item.id === example.id);
  if (item === undefined) throw new Error(`Missing math palette template: ${example.id}`);
  return { ...item, acceptanceIds: [`mathPaletteExamples:${example.id}`] };
});

export function mathPaletteExampleSource(example: typeof MATH_PALETTE_EXAMPLES[number]): string {
  const item = MATH_INPUT_PALETTE.find(item => item.id === example.id);
  if (item === undefined) throw new Error(`Missing math palette example: ${example.id}`);
  let slot = 0;
  const source = item.template.replaceAll('#0', example.selection).replace(/#\?/gu, () => {
    const value = example.slots[slot++];
    if (value === undefined) throw new Error(`Missing math palette argument: ${example.id}`);
    return value;
  });
  if (slot !== example.slots.length) throw new Error(`Unused math palette argument: ${example.id}`);
  return source;
}
