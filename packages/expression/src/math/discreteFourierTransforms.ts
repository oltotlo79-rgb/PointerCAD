/** Forward exp(-2πijk/N), inverse exp(+2πijk/N)/N; never pad or reorder input. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const DISCRETE_FOURIER_DEFINITIONS = [
  ['dft', 'DFT'], ['idft', 'IDFT'], ['fft', 'FFT'], ['ifft', 'IFFT'],
] as const;
const IDS = new Set<string>(DISCRETE_FOURIER_DEFINITIONS.map(([id]) => id));

/** Preserve all source entries before a component or outer zero can erase one. */
export function containsDiscreteFourier(source: MathNode): boolean {
  const pending = [source];
  let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '離散変換を含む式が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (IDS.has(node.operation)) return true;
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper);
          if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}
