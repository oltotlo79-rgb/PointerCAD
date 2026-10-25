import type { SolidModalInput, SolidModalResult } from '@pointercad/fem';
import { sameSolidModeSource, type SolidModeResult } from './solidModeView.js';

/**
 * Pairs a modal result (which carries source, nodes, fixed and modes but no elements) with the exact request that
 * produced it, so the display can draw the analysed connectivity. The pairing is refused (null) unless the result
 * provably belongs to that request: same document, revision and mesh key; the same node coordinates bit for bit;
 * the fixed rows the request's constraints define; the applicability the constraints imply; one shape row per node.
 * Connectivity is never invented: the elements are the request's own.
 */
export function solidModeResultFor(input: SolidModalInput, result: SolidModalResult): SolidModeResult | null {
  if (!sameSolidModeSource(input.source, result.source)) return null;
  const count = input.nodes.length;
  if (result.nodes.length !== count || result.fixed.length !== count) return null;
  for (let node = 0; node < count; node += 1) {
    const expected = input.nodes[node], actual = result.nodes[node];
    if (actual.length !== 3 || actual[0] !== expected[0] || actual[1] !== expected[1] || actual[2] !== expected[2]) return null;
  }
  const fixed = expectedFixedRows(input);
  if (fixed === null) return null;
  for (let node = 0; node < count; node += 1) {
    const expected = fixed[node], actual = result.fixed[node];
    if (actual.length !== 3 || actual.some((flag, axis) => flag !== expected[axis])) return null;
  }
  if (result.applicability !== (input.constraints.length === 0 ? 'free-free' : 'supported')) return null;
  if (result.modes.some(mode => mode.massNormalizedShapePerSqrtT.length !== count)) return null;
  return {
    source: result.source,
    nodes: result.nodes,
    elements: input.elements,
    fixed: result.fixed,
    modes: result.modes.map(mode => ({
      number: mode.number,
      frequencyHz: mode.frequencyHz,
      normalizedResidual: mode.normalizedResidual,
      massNormalizedShapePerSqrtT: mode.massNormalizedShapePerSqrtT,
    })),
  };
}

/** Fixed rows of the request: all false, then each constraint's flags on its node; null for a repeated or bad node. */
function expectedFixedRows(input: SolidModalInput): readonly (readonly [boolean, boolean, boolean])[] | null {
  const rows: (readonly [boolean, boolean, boolean])[] = input.nodes.map(() => [false, false, false]);
  const seen = new Set<number>();
  for (const constraint of input.constraints) {
    const { node } = constraint;
    if (!Number.isInteger(node) || node < 0 || node >= rows.length || seen.has(node)) return null;
    seen.add(node);
    rows[node] = constraint.fixed;
  }
  return rows;
}
