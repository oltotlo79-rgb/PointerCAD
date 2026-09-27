/** A finite harmonic sum is a separately selected expression, never an error-certified value of f. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const FOURIER_SERIES_ID = 'fourier-series';
export const FOURIER_SERIES_SELECTORS = ['fourier-value', 'fourier-cosine', 'fourier-sine'] as const;
export interface FourierSeries {
  readonly lower: MathNode;
  readonly upper: MathNode;
  readonly degree: string;
  /** Constant term is a0/2; arrays contain a1..aN and b1..bN. */
  readonly constant: MathNode;
  readonly cosine: readonly MathNode[];
  readonly sine: readonly MathNode[];
  readonly convention: 'real-harmonics-radian';
  readonly convergence: 'piecewise-smooth' | 'unknown';
  readonly endpointMean: MathNode | null;
}
function invalid(): never { throw new MathInputProblem('syntax', 'フーリエ級数の式・区間・次数を確認してください。'); }
export function fourierSeriesFunction(source: MathNode): Extract<MathNode, { kind: 'binder' }> {
  if (source.kind !== 'operation' || source.operation !== FOURIER_SERIES_ID || source.operands.length !== 4) return invalid();
  const fn = source.operands[0];
  if (fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1
    || fn.bindings[0].domain.kind !== 'unrestricted') return invalid();
  return fn;
}
export function containsFourierSeries(source: MathNode): boolean {
  const pending = [source]; let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', 'フーリエ級数の式が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (node.operation === FOURIER_SERIES_ID || FOURIER_SERIES_SELECTORS.some(id => id === node.operation)) return true;
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}
const SCALARS = new Set(['add', 'subtract', 'multiply', 'divide', 'negate', 'power', 'absolute',
  'exponential', 'natural-log', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan',
  'arsinh', 'arcosh', 'artanh', 'conjugate', 'real-part', 'imaginary-part']);
export function decodeFourierSeries(value: unknown, decodeNode: (value: unknown) => MathNode): FourierSeries {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const keys = ['lower', 'upper', 'degree', 'constant', 'cosine', 'sine', 'convention', 'convergence', 'endpointMean'];
  const descriptors = Object.getOwnPropertyDescriptors(raw), prototype: unknown = Object.getPrototypeOf(raw);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))
    || typeof raw.degree !== 'string' || !/^(?:[0-9]|1[0-2])$/u.test(raw.degree)
    || raw.convention !== 'real-harmonics-radian'
    || (raw.convergence !== 'piecewise-smooth' && raw.convergence !== 'unknown')
    || (raw.convergence === 'piecewise-smooth') !== (raw.endpointMean !== null)) return invalid();
  let remaining = 4096;
  function scalar(value: unknown): MathNode {
    const node = decodeNode(value), pending = [node];
    while (pending.length > 0) {
      if (--remaining < 0) throw new MathInputProblem('budget', 'フーリエ係数が大きすぎます。');
      const item = pending.pop();
      if (item?.kind === 'operation' && SCALARS.has(item.operation)) pending.push(...item.operands);
      else if (item?.kind !== 'number' && !(item?.kind === 'constant' && ['pi', 'e', 'imaginary-unit'].includes(item.name))) invalid();
    }
    return node;
  }
  function array(value: unknown): readonly MathNode[] {
    if (!Array.isArray(value) || value.length !== Number(raw.degree) || Object.keys(value).length !== value.length) return invalid();
    return value.map(scalar);
  }
  return { lower: scalar(raw.lower), upper: scalar(raw.upper), degree: raw.degree,
    constant: scalar(raw.constant), cosine: array(raw.cosine), sine: array(raw.sine),
    convention: raw.convention, convergence: raw.convergence,
    endpointMean: raw.endpointMean === null ? null : scalar(raw.endpointMean) };
}
